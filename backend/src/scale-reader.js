'use strict';

const net = require('net');
const config = require('./config');
const db = require('./db');
const logger = require('./logger');

// mapping IP ของเครื่องชั่ง -> ชื่อตารางปลายทางใน SQL Server
// เพิ่ม/แก้ IP หรือชื่อตารางตรงนี้จุดเดียว ถ้ามีเครื่องชั่งเพิ่มในอนาคต
const SPOUT_TABLE_BY_IP = {
  '10.246.145.184': '[dbo].[Spout 1]',
  '10.246.145.185': '[dbo].[Spout 2]',
  '10.246.145.186': '[dbo].[Spout 3]',
};

/**
 * ScaleReader — อ่านข้อมูลน้ำหนักจากเครื่องชั่ง "1 เครื่อง" ผ่าน TCP
 * แล้ว insert ลงตาราง Spout ที่ตรงกับ IP ของเครื่องนั้น พร้อม scale_id (และ session_id ถ้ามีเอกสารที่กำลังรันอยู่)
 * เก็บสำเนาไว้ใน memory ring buffer ของตัวเอง เพื่อให้หน้า dashboard ยังมีข้อมูลแม้ SQL Server ล่มชั่วคราว
 *
 * เดิมเป็น singleton (เครื่องเดียว) — ตอนนี้ทำเป็น class เพื่อให้ scale-manager.js
 * สร้างได้หลาย instance พร้อมกัน (1 instance ต่อเครื่องชั่ง 1 เครื่อง)
 */
class ScaleReader {
  constructor(scaleRow) {
    this.scaleId = scaleRow.id;
    this.name = scaleRow.name;
    this.ip = scaleRow.ip;
    this.port = scaleRow.port;
    this.line = scaleRow.line;
    this.serialNo = scaleRow.serial_no;

    // หาชื่อตารางปลายทางจาก IP ของเครื่องชั่งนี้ — ถ้าไม่เจอใน mapping จะ fallback ไปตารางเดิม (Auto)
    this.tableName = SPOUT_TABLE_BY_IP[this.ip] || null;
    if (!this.tableName) {
      logger.warn(`[${this.name}] ไม่พบ mapping ตารางสำหรับ IP ${this.ip} — จะ insert ลงตารางเดิม (Auto) แทน`);
    } else {
      logger.info(`[${this.name}] IP ${this.ip} -> insert ลงตาราง ${this.tableName}`);
    }

    this.status = 'stopped'; // stopped | connecting | connected | reconnecting | error | simulating
    this.lastWeight = null;
    this.lastReceivedAt = null;
    this.totalReceived = 0;
    this.totalInserted = 0;
    this.totalInsertFailed = 0;
    this.lastError = null;

    // เอกสาร (session) ที่กำลังรันอยู่บนเครื่องนี้ ณ ตอนนี้ (null = ไม่มี, แค่ monitor เฉย ๆ)
    this.activeSessionId = null;
    this.activeGroupCode = null;
    this.activeProductCode = null;

    this._socket = null;
    this._reconnectTimer = null;
    this._simTimer = null;
    this._stopped = true;
    this._rawBuffer = '';
    this._lastInsertAt = 0;

    this._ring = [];
    this._maxSeenId = 0;

    this._queue = Promise.resolve();
    this._patternSource = config.device.weightPattern;
    this._sim = { mean: 40, sigma: 2.0 };
  }

  // ---------------------------------------------------------------- lifecycle
  start() {
    if (!this._stopped) return;
    this._stopped = false;

    if (config.simMode) {
      this.status = 'simulating';
      logger.warn(`[${this.name}] SIM_MODE เปิดอยู่ — สร้างค่าน้ำหนักจำลอง ไม่ได้ต่อเครื่องชั่งจริง`);
      this._simTimer = setInterval(() => this._emitSimValue(), config.simIntervalMs);
      return;
    }
    this._connect();
  }

  stop() {
    this._stopped = true;
    this.status = 'stopped';

    if (this._reconnectTimer) { clearTimeout(this._reconnectTimer); this._reconnectTimer = null; }
    if (this._simTimer) { clearInterval(this._simTimer); this._simTimer = null; }
    if (this._socket) {
      this._socket.removeAllListeners();
      this._socket.destroy();
      this._socket = null;
    }
  }

  /** เริ่มเอกสารใหม่บนเครื่องนี้ — ค่าน้ำหนักที่อ่านได้หลังจากนี้จะถูก tag ด้วย session_id */
  attachSession(sessionId, groupCode, productCode, startTime) {
    this.activeSessionId = sessionId;
    this.activeGroupCode = groupCode;
    this.activeProductCode = productCode;
    this.activeSessionStart = startTime || new Date();
  }

  /** ปิดเอกสาร — เลิก tag session_id ให้ค่าน้ำหนักถัดไป */
  detachSession() {
    this.activeSessionId = null;
    this.activeGroupCode = null;
    this.activeProductCode = null;
    this.activeSessionStart = null;
  }

  // ------------------------------------------------------------------- socket
  _connect() {
    if (this._stopped) return;

    const { socketTimeoutMs } = config.device;
    this.status = 'connecting';
    logger.info(`[${this.name}] Connecting to ${this.ip}:${this.port} ...`);

    const socket = new net.Socket();
    this._socket = socket;
    this._rawBuffer = '';

    socket.setTimeout(socketTimeoutMs);

    socket.on('connect', () => {
      this.status = 'connected';
      this.lastError = null;
      logger.info(`[${this.name}] Connected to ${this.ip}:${this.port}`);
    });

    socket.on('data', (chunk) => this._onData(chunk));

    socket.on('timeout', () => {
      logger.warn(`[${this.name}] Socket read timeout, reconnecting...`);
      socket.destroy();
    });

    socket.on('error', (err) => {
      this.status = 'error';
      this.lastError = err.message;
      logger.error(`[${this.name}] Connection error: ${err.message}`);
    });

    socket.on('close', () => {
      if (this._socket === socket) this._socket = null;
      socket.removeAllListeners();
      this._scheduleReconnect();
    });

    socket.connect(this.port, this.ip);
  }

  _scheduleReconnect() {
    if (this._stopped || this._reconnectTimer) return;
    this.status = 'reconnecting';
    this._reconnectTimer = setTimeout(() => {
      this._reconnectTimer = null;
      this._connect();
    }, config.device.reconnectDelayMs);
  }

  // --------------------------------------------------------------- data parse
  _onData(chunk) {
    this._rawBuffer += chunk.toString('latin1');

    const re = new RegExp(this._patternSource, 'g');
    let match;
    let lastEnd = -1;

    while ((match = re.exec(this._rawBuffer)) !== null) {
      const weight = Number.parseFloat(match[1]);
      lastEnd = re.lastIndex;
      if (Number.isFinite(weight)) this._accept(weight);
      if (match.index === re.lastIndex) re.lastIndex++;
    }

    if (lastEnd >= 0) this._rawBuffer = this._rawBuffer.slice(lastEnd);
    if (this._rawBuffer.length > 8192) this._rawBuffer = this._rawBuffer.slice(-2048);
  }

  _accept(weight) {
    const now = Date.now();
    const { minInsertIntervalMs } = config.device;
    if (minInsertIntervalMs > 0 && now - this._lastInsertAt < minInsertIntervalMs) return;
    this._lastInsertAt = now;

    const ts = new Date(now);
    this.lastWeight = weight;
    this.lastReceivedAt = ts;
    this.totalReceived += 1;

    this._enqueueInsert(weight, ts);
  }

  _enqueueInsert(weight, ts) {
    const sessionId = this.activeSessionId;
    this._queue = this._queue.then(async () => {
      let id = null;
      let persisted = false;

      if (config.dbEnabled) {
        try {
          // ส่ง this.tableName เข้าไปด้วย เพื่อ insert ลงตาราง Spout ที่ตรงกับ IP ของเครื่องนี้
          id = await db.insertWeight(weight, ts, this.scaleId, sessionId, this.tableName);
          persisted = true;
          this.totalInserted += 1;
        } catch (err) {
          this.totalInsertFailed += 1;
          this.lastError = `DB insert failed: ${err.message}`;
          logger.error(`[${this.name}] DB insert failed for weight=${weight}: ${err.message}`);
        }
      }

      if (id == null) id = this._maxSeenId + 1;
      this._pushRing({ id, weight, time_stamp: ts, persisted, session_id: sessionId });
    });
    return this._queue;
  }

  _pushRing(record) {
    if (record.id > this._maxSeenId) this._maxSeenId = record.id;
    this._ring.push(record);
    const overflow = this._ring.length - config.memoryBufferSize;
    if (overflow > 0) this._ring.splice(0, overflow);
  }

  // ----------------------------------------------------------------- sim mode
  _emitSimValue() {
    const randNormal = () => {
      let u = 0;
      let v = 0;
      while (u === 0) u = Math.random();
      while (v === 0) v = Math.random();
      return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
    };

    this._sim.mean = Math.max(37, Math.min(43, this._sim.mean + (Math.random() - 0.5) * 0.5));
    this._sim.sigma = Math.max(1.2, Math.min(4.3, this._sim.sigma + (Math.random() - 0.5) * 0.2));

    let v = this._sim.mean + randNormal() * this._sim.sigma;
    if (Math.random() < 0.025) {
      v = Math.random() < 0.5 ? 50 + Math.random() * 2.5 : 30 - Math.random() * 2.5;
    }
    this._accept(Math.round(v * 10) / 10);
  }

  // ------------------------------------------------------------------ readers
  memorySince(sinceId, limit) {
    return this._ring.filter((r) => r.id > sinceId).slice(0, limit);
  }

  memoryHistory(limit) {
    return this._ring.slice(-limit);
  }

  snapshot() {
    return {
      scale_id: this.scaleId,
      name: this.name,
      ip: this.ip,
      port: this.port,
      line: this.line,
      serial_no: this.serialNo,
      table_name: this.tableName,
      device: `${this.ip}:${this.port}`,
      sim_mode: config.simMode,
      connection_status: this.status,
      last_weight: this.lastWeight,
      last_received_at: this.lastReceivedAt ? this.lastReceivedAt.toISOString() : null,
      total_received: this.totalReceived,
      total_inserted: this.totalInserted,
      total_insert_failed: this.totalInsertFailed,
      memory_rows: this._ring.length,
      last_error: this.lastError,
      active_session_id: this.activeSessionId,
      active_group_code: this.activeGroupCode,
      active_product_code: this.activeProductCode,
      active_session_start: this.activeSessionStart ? this.activeSessionStart.toISOString() : null,
    };
  }
}

module.exports = ScaleReader;