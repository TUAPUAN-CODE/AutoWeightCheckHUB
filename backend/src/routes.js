'use strict';

const express = require('express');
const config = require('./config');
const db = require('./db');
const dbWc = require('./db-wc');
const manager = require('./scale-manager');
const shift = require('./shift');
const logger = require('./logger');

const router = express.Router();

const MAX_LIMIT = 10000;

function clampLimit(raw, fallback) {
  const n = Number.parseInt(raw, 10);
  if (!Number.isFinite(n) || n <= 0) return fallback;
  return Math.min(n, MAX_LIMIT);
}

function parseScaleId(raw) {
  if (raw === undefined || raw === null || raw === '') return null;
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) ? n : null;
}

/**
 * Middleware กันพัง: ตรวจว่า req.params[paramName] เป็นจำนวนเต็มบวกจริง ๆ ก่อนส่งต่อไปที่ SQL (sql.Int/sql.BigInt)
 * ป้องกันเคสที่มี request หลุดมาแบบ id="start" (เช่น เบราว์เซอร์ยิง GET ไปที่ /sessions/start ผิด method, tab เก่าค้าง,
 * หรือ health-check) ซึ่งก่อนหน้านี้จะทำให้ mssql โยน RequestError และ log เตือนรัว ๆ
 */
function requireIntParam(paramName) {
  return (req, res, next) => {
    const raw = req.params[paramName];
    if (!/^\d+$/.test(raw)) {
      return res.status(400).json({ error: `พารามิเตอร์ ${paramName} ต้องเป็นตัวเลข (ได้รับ: ${raw})` });
    }
    next();
  };
}

const pad = (n, w = 2) => String(n).padStart(w, '0');

/**
 * ส่ง timestamp กลับเป็นสตริงแบบไม่มี timezone ("2026-08-15T09:15:23.120")
 * เพื่อให้เบราว์เซอร์ตีความเป็นเวลาท้องถิ่นตรงกับที่ backend บันทึกไว้
 */
function naive(d, fromUtcParts) {
  if (!(d instanceof Date) || Number.isNaN(d.getTime())) return null;
  const g = fromUtcParts
    ? [d.getUTCFullYear(), d.getUTCMonth() + 1, d.getUTCDate(), d.getUTCHours(), d.getUTCMinutes(), d.getUTCSeconds(), d.getUTCMilliseconds()]
    : [d.getFullYear(), d.getMonth() + 1, d.getDate(), d.getHours(), d.getMinutes(), d.getSeconds(), d.getMilliseconds()];
  const [Y, M, D, h, m, s, ms] = g;
  return `${Y}-${pad(M)}-${pad(D)}T${pad(h)}:${pad(m)}:${pad(s)}.${pad(ms, 3)}`;
}

/** แถวจาก SQL Server -> รูปแบบที่ frontend ใช้ */
function mapDbRow(row) {
  const ts = row.time_stamp instanceof Date ? row.time_stamp : new Date(row.time_stamp);
  return {
    id: Number(row.id),
    weight: row.weight == null ? null : Number(row.weight),
    time_stamp: naive(ts, config.db.useUtc),
    scale_id: row.scale_id == null ? null : Number(row.scale_id),
    session_id: row.session_id == null ? null : Number(row.session_id),
  };
}

/** แถวจาก memory ring (time_stamp เป็น Date เวลาท้องถิ่นอยู่แล้ว) */
function mapMemRow(row) {
  return {
    id: Number(row.id),
    weight: Number(row.weight),
    time_stamp: naive(row.time_stamp, false),
    persisted: row.persisted,
    session_id: row.session_id == null ? null : Number(row.session_id),
  };
}

/** ลอง DB ก่อน ถ้าไม่ได้ค่อยตกไปใช้ memory ring ของเครื่องนั้น (หรือรวมทุกเครื่องถ้าไม่ระบุ) เพื่อให้ dashboard ไม่ดับตาม DB */
async function withFallback(res, dbFn, memFn) {
  if (config.dbEnabled) {
    try {
      const rows = await dbFn();
      return res.json({ source: 'db', count: rows.length, rows: rows.map(mapDbRow) });
    } catch (err) {
      logger.error(`DB query failed, falling back to memory: ${err.message}`);
      const rows = memFn();
      return res.json({ source: 'memory', count: rows.length, rows: rows.map(mapMemRow), db_error: err.message });
    }
  }
  const rows = memFn();
  return res.json({ source: 'memory', count: rows.length, rows: rows.map(mapMemRow) });
}

function memoryForScale(scaleId, fn) {
  if (scaleId != null) {
    const reader = manager.get(scaleId);
    return reader ? fn(reader) : [];
  }
  // ไม่ระบุเครื่อง -> รวมทุกเครื่อง เรียงตาม id
  const all = Array.from(manager.readers.values()).flatMap((r) => fn(r));
  return all.sort((a, b) => a.id - b.id);
}

// ===================================================================== status
router.get('/status', async (_req, res) => {
  const dbStatus = db.status();
  if (config.dbEnabled) {
    try {
      await db.ping();
      dbStatus.connected = true;
      dbStatus.last_error = null;
    } catch (err) {
      dbStatus.connected = false;
      dbStatus.last_error = err.message;
    }
  }
  res.json({ scales: manager.list(), db: dbStatus, server_time: naive(new Date(), false) });
});

router.get('/health', (_req, res) => res.json({ ok: true }));

// ===================================================================== scales
router.get('/scales', async (_req, res) => {
  res.json({ scales: manager.list() });
});

router.post('/scales', async (req, res) => {
  const { name, ip, port, line, serialNo, note } = req.body || {};
  if (!ip || !port) return res.status(400).json({ error: 'ต้องมี ip, port' });
  try {
    const scale = await manager.addScale({ name, ip, port: Number(port), line, serialNo, note });
    res.status(201).json({ scale });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.put('/scales/:id', requireIntParam('id'), async (req, res) => {
  try {
    const scale = await manager.editScale(req.params.id, req.body || {});
    res.json({ scale });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

router.delete('/scales/:id', requireIntParam('id'), async (req, res) => {
  try {
    const result = await manager.removeScale(req.params.id);
    res.json({ ok: true, ...result });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// ============================================================ codes (DB ตัวที่ 2)
router.get('/codes/groups', async (_req, res) => {
  try {
    const groups = await dbWc.getGroups();
    res.json({ groups });
  } catch (err) {
    res.status(502).json({ error: `ดึง GroupCode ไม่ได้: ${err.message}` });
  }
});

router.get('/codes/products', async (req, res) => {
  const group = req.query.group;
  if (!group) return res.status(400).json({ error: 'ต้องระบุ ?group=' });
  try {
    const products = await dbWc.getProductsByGroup(group);
    res.json({ products });
  } catch (err) {
    res.status(502).json({ error: `ดึง ProductCode ไม่ได้: ${err.message}` });
  }
});

// ================================================================= sessions
router.post('/sessions/start', async (req, res) => {
  const { scaleId, groupCode, productCode, inspectorName, remark } = req.body || {};
  if (!scaleId || !groupCode || !productCode) {
    return res.status(400).json({ error: 'ต้องมี scaleId, groupCode, productCode' });
  }
  try {
    const session = await manager.startSession(Number(scaleId), groupCode, productCode, inspectorName, remark);
    res.status(201).json({ session });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

router.post('/sessions/stop', async (req, res) => {
  const { scaleId } = req.body || {};
  if (!scaleId) return res.status(400).json({ error: 'ต้องมี scaleId' });
  try {
    const session = await manager.stopSession(Number(scaleId));
    res.json({ session });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// หน้าประวัติ — sort/filter/pagination ได้ทุกคอลัมน์
router.get('/sessions', async (req, res) => {
  const {
    sortBy, sortDir, page, pageSize, scaleId, line, serialNo,
    groupCode, productCode, shift: shiftFilter, status, from, to,
  } = req.query;
  try {
    const rows = await db.listSessions({
      sortBy, sortDir,
      page: page ? Number(page) : 1,
      pageSize: pageSize ? Math.min(Number(pageSize), 1000) : 50,
      scaleId: scaleId ? Number(scaleId) : undefined,
      line, serialNo, groupCode, productCode, shift: shiftFilter, status, from, to,
    });
    const total = rows.length ? rows[0].total_count : 0;
    res.json({
      total,
      rows: rows.map((r) => ({
        ...r,
        id: Number(r.id),
        scale_id: Number(r.scale_id),
        start_time: naive(r.start_time, false),
        end_time: r.end_time ? naive(r.end_time, false) : null,
        report_date_be: r.report_date ? shift.toBuddhistShort(new Date(r.report_date)) : null,
      })),
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.get('/sessions/:id', requireIntParam('id'), async (req, res) => {
  const session = await db.getSession(req.params.id);
  if (!session) return res.status(404).json({ error: 'ไม่พบเอกสารนี้' });
  res.json({
    session: {
      ...session,
      id: Number(session.id),
      scale_id: Number(session.scale_id),
      start_time: naive(session.start_time, false),
      end_time: session.end_time ? naive(session.end_time, false) : null,
      report_date_be: session.report_date ? shift.toBuddhistShort(new Date(session.report_date)) : null,
    },
  });
});

// แก้ไขเวลาเริ่ม/หยุด + ชื่อผู้ตรวจสอบ — คำนวณสรุปผลใหม่จากช่วงเวลาที่แก้ให้อัตโนมัติ
router.put('/sessions/:id', requireIntParam('id'), async (req, res) => {
  const { startTime, endTime, inspectorName, remark } = req.body || {};
  try {
    const session = await db.updateSessionTimes(req.params.id, {
      startTime: startTime ? new Date(startTime) : undefined,
      endTime: endTime === null ? null : endTime ? new Date(endTime) : undefined,
      inspectorName,
      remark,
    });
    res.json({
      session: {
        ...session,
        id: Number(session.id),
        scale_id: Number(session.scale_id),
        start_time: naive(session.start_time, false),
        end_time: session.end_time ? naive(session.end_time, false) : null,
        report_date_be: session.report_date ? shift.toBuddhistShort(new Date(session.report_date)) : null,
      },
    });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// ค่าน้ำหนักทั้งหมดของเอกสารนี้ — ใช้วาดกราฟหน้า detail
router.get('/sessions/:id/weights', requireIntParam('id'), async (req, res) => {
  const limit = clampLimit(req.query.limit, 20000);
  try {
    const rows = await db.fetchWeightsBySession(req.params.id, limit);
    res.json({ count: rows.length, rows: rows.map(mapDbRow) });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ================================================================= settings
router.get('/settings', async (_req, res) => {
  try {
    const settings = await db.getSettings();
    res.json({ settings });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.put('/settings', async (req, res) => {
  const map = req.body || {};
  try {
    const settings = await db.setSettings(map);
    res.json({ settings });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ===================================================================== data
// โหลดข้อมูลย้อนหลังครั้งแรก (เรียงเก่า -> ใหม่) — ?scaleId= เลือกเครื่องเดียว ไม่ใส่ = ทุกเครื่อง
router.get('/weights/history', (req, res) => {
  const limit = clampLimit(req.query.limit, 4000);
  const scaleId = parseScaleId(req.query.scaleId);
  return withFallback(
    res,
    () => db.fetchHistory(limit, scaleId),
    () => memoryForScale(scaleId, (r) => r.memoryHistory(limit))
  );
});

// ช่วงเวลาที่ระบุเอง (custom range ของ dashboard)
router.get('/weights/range', async (req, res) => {
  const limit = clampLimit(req.query.limit, 5000);
  const scaleId = parseScaleId(req.query.scaleId);
  const from = new Date(req.query.from);
  const to = new Date(req.query.to);
  if (Number.isNaN(from.getTime()) || Number.isNaN(to.getTime())) {
    return res.status(400).json({ error: 'from/to ต้องเป็นวันเวลาที่ถูกต้อง' });
  }
  return withFallback(
    res,
    () => db.fetchRange(from, to, limit, scaleId),
    () => memoryForScale(scaleId, (r) => r.memoryHistory(config.memoryBufferSize))
      .filter((r) => r.time_stamp >= from && r.time_stamp <= to)
      .slice(-limit)
  );
});

// poll ข้อมูลใหม่หลังจาก id ที่ frontend มีอยู่แล้ว (เรียงเก่า -> ใหม่)
router.get('/weights', (req, res) => {
  const sinceId = Number.parseInt(req.query.sinceId ?? req.query.since_id ?? '0', 10) || 0;
  const limit = clampLimit(req.query.limit, 500);
  const scaleId = parseScaleId(req.query.scaleId);
  if (sinceId <= 0) {
    return withFallback(res, () => db.fetchHistory(limit, scaleId), () => memoryForScale(scaleId, (r) => r.memoryHistory(limit)));
  }
  return withFallback(
    res,
    () => db.fetchSince(sinceId, limit, scaleId),
    () => memoryForScale(scaleId, (r) => r.memorySince(sinceId, limit))
  );
});

// เทียบเท่า GET /recent เดิมของฝั่ง Python (ใหม่ -> เก่า)
router.get('/recent', (req, res) => {
  const limit = clampLimit(req.query.limit, 20);
  const scaleId = parseScaleId(req.query.scaleId);
  return withFallback(
    res,
    () => db.fetchRecent(limit, scaleId),
    () => memoryForScale(scaleId, (r) => r.memoryHistory(limit)).slice().reverse()
  );
});

// ----------------------------------------------------------------- control
// เปิด/ปิดการอ่านค่าของเครื่อง (ไม่เกี่ยวกับเอกสาร แค่ตัด/ต่อ TCP) — ต้องระบุ scaleId
router.post('/start', (req, res) => {
  const scaleId = parseScaleId(req.body && req.body.scaleId);
  const reader = scaleId != null ? manager.get(scaleId) : null;
  if (!reader) return res.status(400).json({ error: 'ต้องระบุ scaleId ที่ถูกต้อง' });
  reader.start();
  res.json({ message: 'reader started', status: reader.status });
});

router.post('/stop', (req, res) => {
  const scaleId = parseScaleId(req.body && req.body.scaleId);
  const reader = scaleId != null ? manager.get(scaleId) : null;
  if (!reader) return res.status(400).json({ error: 'ต้องระบุ scaleId ที่ถูกต้อง' });
  reader.stop();
  res.json({ message: 'reader stopped', status: reader.status });
});

module.exports = router;
