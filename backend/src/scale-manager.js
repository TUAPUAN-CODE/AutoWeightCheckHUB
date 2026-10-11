'use strict';

const db = require('./db');
const dbWc = require('./db-wc');
const logger = require('./logger');
const shift = require('./shift');
const ScaleReader = require('./scale-reader');

class ScaleManager {
  constructor() {
    /** @type {Map<number, ScaleReader>} */
    this.readers = new Map();
  }

  /** โหลดเครื่องชั่งทั้งหมดจาก DB แล้วเปิดการเชื่อมต่อของเครื่องที่ enabled=1 */
  async init() {
    let rows = [];
    try {
      rows = await db.listScales();
    } catch (err) {
      logger.error(`โหลดรายการเครื่องชั่งจาก DB ไม่สำเร็จ: ${err.message}`);
      return;
    }

    for (const row of rows) {
      const reader = new ScaleReader(row);
      this.readers.set(row.id, reader);
      if (row.enabled) reader.start();
    }
    logger.info(`โหลดเครื่องชั่งทั้งหมด ${rows.length} เครื่อง (เปิดใช้งาน ${rows.filter((r) => r.enabled).length})`);

    // ถ้ามีเอกสารที่ค้างสถานะ "running" จากรอบก่อน (เช่น backend รีสตาร์ทกลางคัน) ให้ผูกกลับเข้ากับ reader
    try {
      for (const row of rows) {
        const running = await db.findRunningSessionByScale(row.id);
        if (running) {
          const reader = this.readers.get(row.id);
          if (reader) reader.attachSession(running.id, running.group_code, running.product_code, running.start_time);
        }
      }
    } catch (err) {
      logger.error(`กู้คืนเอกสารที่ค้าง running ไม่สำเร็จ: ${err.message}`);
    }
  }

  stopAll() {
    for (const reader of this.readers.values()) reader.stop();
  }

  get(scaleId) {
    return this.readers.get(Number(scaleId));
  }

  list() {
    return Array.from(this.readers.values()).map((r) => r.snapshot());
  }

  // ------------------------------------------------------------ CRUD เครื่องชั่ง
  async addScale({ name, ip, port, line, serialNo, note }) {
    const id = await db.createScale({ name, ip, port, line, serialNo, note });
    const rows = await db.listScales();
    const row = rows.find((r) => r.id === id);
    const reader = new ScaleReader(row);
    this.readers.set(id, reader);
    if (row.enabled) reader.start();
    return reader.snapshot();
  }

  async editScale(id, patch) {
    const existing = this.readers.get(Number(id));
    if (!existing) throw new Error('ไม่พบเครื่องชั่งนี้');
    await db.updateScale(id, {
      name: patch.name ?? existing.name,
      ip: patch.ip ?? existing.ip,
      port: patch.port ?? existing.port,
      line: patch.line ?? existing.line,
      serialNo: patch.serialNo ?? existing.serialNo,
      note: patch.note,
      enabled: patch.enabled ?? true,
    });
    const rows = await db.listScales();
    const row = rows.find((r) => r.id === Number(id));

    // ip/port เปลี่ยน หรือ enabled เปลี่ยน -> ต้องสร้าง reader ใหม่ (ปิดตัวเก่าก่อน)
    existing.stop();
    const reader = new ScaleReader(row);
    this.readers.set(row.id, reader);
    if (row.enabled) reader.start();
    return reader.snapshot();
  }

  async removeScale(id) {
    const existing = this.readers.get(Number(id));
    if (existing) existing.stop();

    try {
      await db.deleteScale(id);
      this.readers.delete(Number(id));
      return { deleted: true, disabled: false };
    } catch (err) {
      // มีประวัติเอกสาร/ค่าน้ำหนักผูกอยู่ (FK constraint) — ลบจริงไม่ได้ ให้ปิดใช้งานแทนเพื่อรักษาประวัติเดิม
      const isFkConflict = err.number === 547 || /REFERENCE constraint|FOREIGN KEY/i.test(err.message || '');
      if (!isFkConflict) throw err;

      const rows = await db.listScales();
      const row = rows.find((r) => r.id === Number(id)) || existing;
      if (!row) throw err;

      await db.updateScale(id, {
        name: row.name, ip: row.ip, port: row.port,
        line: row.line, serialNo: row.serial_no ?? row.serialNo, note: row.note, enabled: false,
      });
      this.readers.delete(Number(id));
      return { deleted: false, disabled: true };
    }
  }

  // ------------------------------------------------------------ เอกสาร (session)
  /** กด "เริ่ม" ในหน้า Monitor/Dashboard — เลือก scale + groupCode + productCode + ชื่อผู้ตรวจสอบ + หมายเหตุ แล้วเปิดเอกสารใหม่ */
  async startSession(scaleId, groupCode, productCode, inspectorName, remark) {
    const reader = this.get(scaleId);
    if (!reader) throw new Error('ไม่พบเครื่องชั่งนี้');
    if (reader.activeSessionId) throw new Error('เครื่องนี้มีเอกสารที่กำลังทำงานอยู่แล้ว กรุณากดหยุดก่อน');

    let spec = {};
    try {
      const product = await dbWc.getProduct(productCode);
      if (product) spec = product;
    } catch (err) {
      logger.warn(`ดึง spec จาก DB(WC) ไม่ได้ (จะเริ่มเอกสารต่อโดยไม่มี spec snapshot): ${err.message}`);
    }

    const now = new Date();
    const { shift: sh, reportDate } = shift.classify(now);

    const sessionId = await db.createSession({
      scaleId,
      groupCode,
      productCode,
      spec,
      startTime: now,
      shift: sh,
      reportDate: shift.toIsoDate(reportDate),
      inspectorName,
      remark,
    });

    reader.attachSession(sessionId, groupCode, productCode, now);
    return db.getSession(sessionId);
  }

  /** กด "หยุด" — ปิดเอกสาร คำนวณสรุปผล */
  async stopSession(scaleId) {
    const reader = this.get(scaleId);
    if (!reader) throw new Error('ไม่พบเครื่องชั่งนี้');
    if (!reader.activeSessionId) throw new Error('เครื่องนี้ไม่มีเอกสารที่กำลังทำงานอยู่');

    const sessionId = reader.activeSessionId;
    reader.detachSession();
    return db.closeSession(sessionId, new Date());
  }
}

module.exports = new ScaleManager();
