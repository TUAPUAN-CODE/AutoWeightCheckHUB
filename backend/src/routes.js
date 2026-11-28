'use strict';

const express = require('express');
const config = require('./config');
const db = require('./db');
const dbWc = require('./db-wc');
const manager = require('./scale-manager');
const shift = require('./shift');
const logger = require('./logger');
const summary = require('./summary');

const router = express.Router();

const MAX_LIMIT = 50000; // ปรับตามค่าที่ใช้งานจริงบน server (เดิม 10000)
const SESSION_MAX_LIMIT = 200000; // ค่าน้ำหนักของเอกสาร 1 ใบ
const MAX_BUCKETS = 6000; // จำนวนแท่งสูงสุดต่อการขอกราฟแบบรายช่วงเวลา

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
  const { name, ip, port, line, serialNo, note, deviceType, enabled } = req.body || {};
  if (!ip || !port) return res.status(400).json({ error: 'ต้องมี ip, port' });
  try {
    const scale = await manager.addScale({ name, ip, port: Number(port), line, serialNo, note, deviceType, enabled: enabled !== false });
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
    const current = await db.getSession(req.params.id);
    if (!current) return res.status(404).json({ error: 'ไม่พบเอกสารนี้' });
    const session = await db.updateSessionTimes(req.params.id, {
      startTime: startTime ? new Date(startTime) : undefined,
      endTime: endTime === null ? null : endTime ? new Date(endTime) : undefined,
      inspectorName,
      remark,
    }, manager.tableFor(current.scale_id));
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
  // เอกสารเดียวมีได้หลายหมื่นค่า (เช่น 58,886 ค่าในกะเดียว) — อนุญาตสูงกว่า MAX_LIMIT ทั่วไป เพื่อให้ PDF/กราฟครบ
  const n = Number.parseInt(req.query.limit, 10);
  const limit = Number.isFinite(n) && n > 0 ? Math.min(n, SESSION_MAX_LIMIT) : 20000;
  try {
    const session = await db.getSession(req.params.id);
    if (!session) return res.status(404).json({ error: 'ไม่พบเอกสารนี้' });
    const rows = await db.fetchWeightsBySession(req.params.id, limit, manager.tableFor(session.scale_id));
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
    () => db.fetchHistory(limit, scaleId, manager.tableFor(scaleId)),
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
    () => db.fetchRange(from, to, limit, scaleId, manager.tableFor(scaleId)),
    () => memoryForScale(scaleId, (r) => r.memoryHistory(config.memoryBufferSize))
      .filter((r) => r.time_stamp >= from && r.time_stamp <= to)
      .slice(-limit)
  );
});

// ===================================================================== analytics (กราฟแบบรายช่วงเวลา)
const UNIT_MS = { minute: 60e3, hour: 3600e3, day: 86400e3, month: 30 * 86400e3, year: 365 * 86400e3 };

function bucketStart(d, unit, step) {
  const t = new Date(d);
  if (unit === 'year') return new Date(Math.floor(t.getFullYear() / step) * step, 0, 1);
  if (unit === 'month') {
    const m = t.getFullYear() * 12 + t.getMonth();
    const b = Math.floor(m / step) * step;
    return new Date(Math.floor(b / 12), b % 12, 1);
  }
  const base = new Date(1900, 0, 1).getTime(); // เทียบกับ SQL DATEADD(unit, ..., 0) = 1900-01-01
  const size = UNIT_MS[unit] * step;
  return new Date(base + Math.floor((t.getTime() - base) / size) * size);
}

/** สรุปจาก memory ring (ตอน DB ใช้ไม่ได้) — รูปแบบเดียวกับ db.fetchBuckets */
function bucketsFromRows(rows, unit, step, lsl, usl) {
  const map = new Map();
  for (const r of rows) {
    const k = bucketStart(r.time_stamp, unit, step).getTime();
    let b = map.get(k);
    if (!b) { b = { bucket: new Date(k), n: 0, sum: 0, sq: 0, min_w: Infinity, max_w: -Infinity, over_n: 0, under_n: 0 }; map.set(k, b); }
    const w = Number(r.weight);
    b.n += 1; b.sum += w; b.sq += w * w;
    b.min_w = Math.min(b.min_w, w); b.max_w = Math.max(b.max_w, w);
    if (usl != null && w > usl) b.over_n += 1;
    if (lsl != null && w < lsl) b.under_n += 1;
  }
  return Array.from(map.values()).sort((a, b) => a.bucket - b.bucket).map((b) => ({
    bucket: b.bucket, n: b.n, mean: b.sum / b.n,
    sd: b.n > 1 ? Math.sqrt(Math.max(0, (b.sq - (b.sum * b.sum) / b.n) / (b.n - 1))) : null,
    min_w: b.min_w, max_w: b.max_w, over_n: b.over_n, under_n: b.under_n,
  }));
}

router.get('/analytics/buckets', async (req, res) => {
  const scaleId = parseScaleId(req.query.scaleId);
  const unit = String(req.query.unit || 'hour');
  const step = Math.max(1, Number.parseInt(req.query.step, 10) || 1);
  const from = new Date(req.query.from);
  const to = new Date(req.query.to);
  const num = (v) => (v === undefined || v === '' || v === null || !Number.isFinite(Number(v)) ? null : Number(v));
  const lsl = num(req.query.lsl);
  const usl = num(req.query.usl);
  if (scaleId == null) return res.status(400).json({ error: 'ต้องระบุ scaleId' });
  if (!UNIT_MS[unit]) return res.status(400).json({ error: 'unit ต้องเป็น minute, hour, day, month หรือ year' });
  if (Number.isNaN(from.getTime()) || Number.isNaN(to.getTime()) || to <= from) {
    return res.status(400).json({ error: 'from/to ต้องเป็นวันเวลาที่ถูกต้อง' });
  }
  const expected = (to - from) / (UNIT_MS[unit] * step);
  if (expected > MAX_BUCKETS) {
    return res.status(400).json({ error: `ช่วงเวลานี้มี ${Math.ceil(expected).toLocaleString('en-US')} แท่ง มากเกินไป — เลือกแท่งที่ใหญ่ขึ้น หรือช่วงเวลาที่สั้นลง` });
  }
  const out = (rows, source) => res.json({
    source, unit, step,
    rows: rows.map((r) => ({
      bucket: naive(r.bucket instanceof Date ? r.bucket : new Date(r.bucket), source === 'db' ? config.db.useUtc : false),
      n: Number(r.n), mean: r.mean == null ? null : Number(r.mean), sd: r.sd == null ? null : Number(r.sd),
      min: r.min_w == null ? null : Number(r.min_w), max: r.max_w == null ? null : Number(r.max_w),
      over: Number(r.over_n || 0), under: Number(r.under_n || 0),
    })),
  });
  const memory = () => {
    const reader = manager.get(scaleId);
    const rows = reader ? reader.memoryHistory(config.memoryBufferSize).filter((r) => r.time_stamp >= from && r.time_stamp <= to) : [];
    return bucketsFromRows(rows, unit, step, lsl, usl);
  };
  if (config.dbEnabled) {
    try {
      const rows = await db.fetchBuckets(scaleId, from, to, unit, step, lsl, usl, manager.tableFor(scaleId));
      return out(rows, 'db');
    } catch (err) {
      logger.error(`analytics buckets DB failed, fallback memory: ${err.message}`);
    }
  }
  return out(memory(), 'memory');
});

// ================================================================ สรุปผลรายไลน์
// GET /api/summary/lines?from=YYYY-MM-DD&to=YYYY-MM-DD&period=day|week|month|year
// ทุกเครื่อง: จำนวน / ผ่าน / ไม่ผ่าน (ตามสเปกของแต่ละเอกสาร) / Cp / Cpk รวมทั้งช่วง + แยกต่อวัน/สัปดาห์/เดือน/ปี
const SUMMARY_PERIODS = ['day', 'week', 'month', 'year'];
const SUMMARY_MAX_DAYS = 3 * 366 + 1;
router.get('/summary/lines', async (req, res) => {
  const period = SUMMARY_PERIODS.includes(req.query.period) ? req.query.period : 'day';
  const from = summary.parseDay(req.query.from);
  const to = summary.parseDay(req.query.to);
  if (!from || !to || to < from) return res.status(400).json({ error: 'from/to ต้องเป็นวันที่ YYYY-MM-DD และ from ≤ to' });
  const toExcl = summary.addDays(to, 1);
  const days = Math.round((toExcl - from) / 86400000);
  if (days > SUMMARY_MAX_DAYS) return res.status(400).json({ error: 'ช่วงวันที่ยาวเกิน 3 ปี — เลือกช่วงที่สั้นลง' });
  if (period === 'day' && days > 400) return res.status(400).json({ error: 'รายวันดูได้ไม่เกิน 400 วัน — เลือกรายสัปดาห์หรือรายเดือน' });
  const scaleFilter = req.query.scaleIds ? new Set(String(req.query.scaleIds).split(',').map(Number)) : null;
  const scales = manager.list().filter((s) => !scaleFilter || scaleFilter.has(s.scale_id));
  let settings = {};
  if (config.dbEnabled) {
    try { settings = await db.getSettings(); } catch (err) { logger.error(`summary settings: ${err.message}`); }
  }
  const numSetting = (k, d) => { const v = Number(settings[k]); return Number.isFinite(v) && v > 0 ? v : d; };
  const t0 = Date.now();
  const errors = [];
  const forScale = async (sc) => {
    const id = sc.scale_id;
    let segments = null; let source = 'db';
    if (config.dbEnabled) {
      try {
        segments = await summary.daySegments(id, from, toExcl,
          (a, b) => db.fetchDaySegments(id, a, b, manager.tableFor(id)), config.db.useUtc);
      } catch (err) {
        logger.error(`summary scale ${id} DB failed, fallback memory: ${err.message}`);
        errors.push(`${sc.name || id}: ${err.message}`);
      }
    }
    if (!segments) {
      source = 'memory';
      const reader = manager.get(id);
      const rows = reader ? reader.memoryHistory(config.memoryBufferSize).filter((r) => r.time_stamp >= from && r.time_stamp < toExcl) : [];
      segments = summary.rowsToSegments(summary.rowsFromMemory(rows));
    }
    const built = summary.buildLine(segments, from, toExcl, period);
    const cw = sc.cw || {};
    return {
      scale_id: id, name: sc.name, line: sc.line, device_type: sc.device_type, enabled: sc.enabled,
      connection_status: sc.connection_status, run_state: cw.run_state || null,
      program: cw.program_name ? `No.${cw.program_no ?? '-'} ${cw.program_name}` : null,
      active_product_code: sc.active_product_code || null,
      last_received_at: sc.last_received_at, source, ...built,
    };
  };
  try {
    // ทีละ 3 เครื่อง — ไม่ให้ช่วงยาวหลายไลน์แย่ง connection pool กับหน้าจออื่น
    const lines = [];
    for (let i = 0; i < scales.length; i += 3) lines.push(...(await Promise.all(scales.slice(i, i + 3).map(forScale))));
    res.json({
      from: summary.dayKey(from), to: summary.dayKey(to), period,
      thresholds: { cpkGood: numSetting('summary.cpkGood', 1.33), cpkMin: numSetting('alert.cpkMin', 1.0), cpMin: numSetting('alert.cpMin', 1.0) },
      min_n_for_cpk: summary.MIN_N_FOR_CPK, took_ms: Date.now() - t0, errors, lines,
    });
  } catch (err) {
    logger.error(`summary/lines failed: ${err.message}`);
    res.status(500).json({ error: err.message });
  }
});

// poll ข้อมูลใหม่หลังจาก id ที่ frontend มีอยู่แล้ว (เรียงเก่า -> ใหม่)
router.get('/weights', (req, res) => {
  const sinceId = Number.parseInt(req.query.sinceId ?? req.query.since_id ?? '0', 10) || 0;
  const limit = clampLimit(req.query.limit, 500);
  const scaleId = parseScaleId(req.query.scaleId);
  if (sinceId <= 0) {
    return withFallback(res, () => db.fetchHistory(limit, scaleId, manager.tableFor(scaleId)), () => memoryForScale(scaleId, (r) => r.memoryHistory(limit)));
  }
  return withFallback(
    res,
    () => db.fetchSince(sinceId, limit, scaleId, manager.tableFor(scaleId)),
    () => memoryForScale(scaleId, (r) => r.memorySince(sinceId, limit))
  );
});

// เทียบเท่า GET /recent เดิมของฝั่ง Python (ใหม่ -> เก่า)
router.get('/recent', (req, res) => {
  const limit = clampLimit(req.query.limit, 20);
  const scaleId = parseScaleId(req.query.scaleId);
  return withFallback(
    res,
    () => db.fetchRecent(limit, scaleId, manager.tableFor(scaleId)),
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

// ---------------------------------------------------------- checkweigher (OPC UA)
router.use('/cw', require('./cw-routes'));

module.exports = router;
