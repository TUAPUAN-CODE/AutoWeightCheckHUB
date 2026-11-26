'use strict';

/**
 * cw-routes.js — REST API ของ checkweigher (OPC UA) — mount ที่ /api/cw
 *
 *   GET /api/cw/:id/live                 สถานะสด + ชิ้นล่าสุด (memory) + เหตุการณ์ล่าสุด
 *   GET /api/cw/:id/pieces?sinceId=&limit= ชิ้นใหม่หลัง id ที่มีอยู่ (memory — ใช้ poll หน้า live)
 *   GET /api/cw/:id/range?from=&to=&limit= ชิ้นงานในช่วงเวลา (DB, fallback memory)
 *   GET /api/cw/:id/summary?from=&to=     สรุปผลช่วงเวลา: จำนวน/เฉลี่ย/SD/Cp/Cpk/reject/giveaway/availability
 *   GET /api/cw/:id/events?from=&to=&limit= เหตุการณ์ (DB, fallback memory)
 *   GET /api/cw/:id/snapshots?from=&to=   สถิติของเครื่องรายนาที (DB)
 *
 * อ่านอย่างเดียว ไม่มี endpoint ใดเขียนค่ากลับไปที่เครื่อง
 */

const express = require('express');
const config = require('./config');
const db = require('./db');
const manager = require('./scale-manager');
const logger = require('./logger');
const CheckweigherReader = require('./cw-reader');

const router = express.Router();
const pad = (n, w = 2) => String(n).padStart(w, '0');

function naive(d) {
  const x = d instanceof Date ? d : new Date(d);
  if (Number.isNaN(x.getTime())) return null;
  return `${x.getFullYear()}-${pad(x.getMonth() + 1)}-${pad(x.getDate())}T${pad(x.getHours())}:${pad(x.getMinutes())}:${pad(x.getSeconds())}.${pad(x.getMilliseconds(), 3)}`;
}

function clampLimit(raw, fallback, max = 20000) {
  const n = Number.parseInt(raw, 10);
  if (!Number.isFinite(n) || n <= 0) return fallback;
  return Math.min(n, max);
}

function parseDate(raw) {
  if (!raw) return null;
  const d = new Date(raw);
  return Number.isNaN(d.getTime()) ? null : d;
}

function pieceOut(p) {
  return {
    id: Number(p.id),
    weight: p.weight == null ? null : Number(p.weight),
    time_stamp: naive(p.time_stamp),
    session_id: p.session_id == null ? null : Number(p.session_id),
    raw_weight: p.raw_weight ?? null,
    rank_code: p.rank_code ?? null,
    sub_rank_code: p.sub_rank_code ?? null,
    pass_flag: p.pass_flag ?? null,
    band: p.band ?? null,
    target_weight: p.target_weight ?? null,
    program_no: p.program_no ?? null,
    total_count: p.total_count ?? null,
    gap: p.gap || 0,
  };
}

function eventOut(e) {
  return {
    id: e.id != null ? Number(e.id) : null,
    time_stamp: naive(e.time_stamp),
    event_type: e.event_type,
    severity: e.severity,
    detail: e.detail,
  };
}

/** middleware: ต้องเป็น id ตัวเลข และเป็นเครื่องชนิด opcua */
function requireCw(req, res, next) {
  if (!/^\d+$/.test(req.params.id)) return res.status(400).json({ error: 'id ต้องเป็นตัวเลข' });
  const reader = manager.get(Number(req.params.id));
  if (!reader) return res.status(404).json({ error: 'ไม่พบเครื่องนี้' });
  if (reader.deviceType !== 'opcua') return res.status(400).json({ error: 'เครื่องนี้ไม่ใช่ checkweigher (OPC UA)' });
  req.cw = reader;
  return next();
}

/** ค่าวิเคราะห์ที่คำนวณจากผลรวม (ใช้ได้ทั้งจาก DB และ memory) */
function derive(t, lim, from, to) {
  const n = Number(t.n) || 0;
  const avg = t.avg_w == null ? null : Number(t.avg_w);
  const sd = t.sd_w == null ? null : Number(t.sd_w);
  const usl = lim.hi;
  const lsl = lim.lo;
  let cp = null;
  let cpk = null;
  if (n >= 2 && sd && sd > 0 && usl != null && lsl != null && avg != null) {
    cp = (usl - lsl) / (6 * sd);
    cpk = Math.min(usl - avg, avg - lsl) / (3 * sd);
  }
  const accept = Number(t.band_accept) || 0;
  const rejected = n - accept;
  const giveawayN = Number(t.giveaway_n) || 0;
  const giveawayG = Number(t.giveaway_g) || 0;
  const rangeMin = from && to ? Math.max(1, (to - from) / 60000) : null;
  const runMin = Number(t.run_minutes) || 0;
  return {
    count: n,
    average: avg,
    sd,
    min: t.min_w == null ? null : Number(t.min_w),
    max: t.max_w == null ? null : Number(t.max_w),
    target: t.avg_target == null ? lim.target : Number(t.avg_target),
    usl,
    lsl,
    cp,
    cpk,
    bands: {
      accept,
      over: Number(t.band_over) || 0,
      under: Number(t.band_under) || 0,
      hihi: Number(t.band_hihi) || 0,
      lolo: Number(t.band_lolo) || 0,
    },
    reject_count: rejected,
    reject_percent: n ? (rejected / n) * 100 : null,
    giveaway_per_piece_g: giveawayN ? giveawayG / giveawayN : null,
    giveaway_total_kg: giveawayG / 1000,
    gaps: Number(t.gaps) || 0,
    run_minutes: runMin,
    range_minutes: rangeMin,
    availability_percent: rangeMin ? Math.min(100, (runMin / rangeMin) * 100) : null,
    pieces_per_run_minute: runMin ? n / runMin : null,
    first_ts: t.first_ts ? naive(t.first_ts) : null,
    last_ts: t.last_ts ? naive(t.last_ts) : null,
  };
}

/** สรุปจาก memory (ตอน DB ใช้ไม่ได้) — รูปแบบเดียวกับ db.cwSummary */
function summarizeMemory(rows) {
  const n = rows.length;
  const t = { n, gaps: 0, giveaway_g: 0, giveaway_n: 0, band_accept: 0, band_over: 0, band_under: 0, band_hihi: 0, band_lolo: 0 };
  if (!n) return { totals: t, ranks: [], programs: [] };
  let sum = 0;
  let sumT = 0;
  let nT = 0;
  const minutes = new Set();
  const ranks = new Map();
  const bandKey = ['band_accept', 'band_over', 'band_under', 'band_hihi', 'band_lolo'];
  t.min_w = Infinity;
  t.max_w = -Infinity;
  for (const r of rows) {
    sum += r.weight;
    t.min_w = Math.min(t.min_w, r.weight);
    t.max_w = Math.max(t.max_w, r.weight);
    t.gaps += r.gap || 0;
    if (r.target_weight != null) { sumT += r.target_weight; nT += 1; }
    if (r.band != null) t[bandKey[r.band]] += 1;
    if (r.band === 0 && r.target_weight != null) { t.giveaway_g += r.weight - r.target_weight; t.giveaway_n += 1; }
    minutes.add(Math.floor(new Date(r.time_stamp).getTime() / 60000));
    ranks.set(r.rank_code, (ranks.get(r.rank_code) || 0) + 1);
  }
  t.avg_w = sum / n;
  t.sd_w = n > 1 ? Math.sqrt(rows.reduce((a, r) => a + (r.weight - t.avg_w) ** 2, 0) / (n - 1)) : null;
  t.avg_target = nT ? sumT / nT : null;
  t.run_minutes = minutes.size;
  t.first_ts = rows[0].time_stamp;
  t.last_ts = rows[n - 1].time_stamp;
  return { totals: t, ranks: Array.from(ranks, ([rank_code, cnt]) => ({ rank_code, n: cnt })), programs: [] };
}

function rankLabel(code) {
  if (code == null) return null;
  return config.cw.rankLabels[String(code)] || null;
}

// ------------------------------------------------------------------- routes
router.get('/:id/live', requireCw, (req, res) => {
  const limit = clampLimit(req.query.limit, 300, 5000);
  const r = req.cw;
  res.json({
    scale: r.snapshot(),
    pieces: r.memoryHistory(limit).map(pieceOut),
    events: r.memoryEvents(50).map(eventOut),
    band_labels: CheckweigherReader.BAND_LABEL,
    rank_labels: config.cw.rankLabels,
    server_time: naive(new Date()),
  });
});

router.get('/:id/pieces', requireCw, (req, res) => {
  const limit = clampLimit(req.query.limit, 500, 5000);
  const sinceId = Number.parseInt(req.query.sinceId, 10) || 0;
  const rows = sinceId > 0 ? req.cw.memorySince(sinceId, limit) : req.cw.memoryHistory(limit);
  res.json({ source: 'memory', count: rows.length, rows: rows.map(pieceOut), scale: req.cw.snapshot() });
});

router.get('/:id/range', requireCw, async (req, res) => {
  const from = parseDate(req.query.from);
  const to = parseDate(req.query.to);
  if (!from || !to) return res.status(400).json({ error: 'from/to ต้องเป็นวันเวลาที่ถูกต้อง' });
  const limit = clampLimit(req.query.limit, 20000);
  if (config.dbEnabled) {
    try {
      const rows = await db.fetchCwPieces(req.cw.scaleId, { from, to, limit });
      return res.json({ source: 'db', count: rows.length, rows: rows.map(pieceOut) });
    } catch (err) {
      logger.error(`cw range DB failed, fallback memory: ${err.message}`);
    }
  }
  const rows = req.cw.memoryHistory(config.cw.memoryPieces).filter((p) => p.time_stamp >= from && p.time_stamp <= to).slice(-limit);
  return res.json({ source: 'memory', count: rows.length, rows: rows.map(pieceOut) });
});

router.get('/:id/summary', requireCw, async (req, res) => {
  const to = parseDate(req.query.to) || new Date();
  const from = parseDate(req.query.from) || new Date(to.getTime() - 60 * 60 * 1000);
  const lim = req.cw.limits();
  let raw = null;
  let source = 'memory';
  if (config.dbEnabled) {
    try {
      raw = await db.cwSummary(req.cw.scaleId, from, to);
      source = 'db';
    } catch (err) {
      logger.error(`cw summary DB failed, fallback memory: ${err.message}`);
    }
  }
  if (!raw) {
    raw = summarizeMemory(req.cw.memoryHistory(config.cw.memoryPieces).filter((p) => p.time_stamp >= from && p.time_stamp <= to));
  }
  res.json({
    source,
    from: naive(from),
    to: naive(to),
    summary: derive(raw.totals, lim, from, to),
    ranks: raw.ranks.map((r) => ({ rank_code: r.rank_code, label: rankLabel(r.rank_code), count: Number(r.n) })),
    programs: raw.programs.map((p) => ({
      program_no: p.program_no, count: Number(p.n), average: p.avg_w == null ? null : Number(p.avg_w), target: p.target == null ? null : Number(p.target),
    })),
    machine_stats: (req.cw.info && req.cw.info.stats) || null,
  });
});

router.get('/:id/events', requireCw, async (req, res) => {
  const limit = clampLimit(req.query.limit, 200, 2000);
  const from = parseDate(req.query.from);
  const to = parseDate(req.query.to);
  if (config.dbEnabled) {
    try {
      const rows = await db.fetchCwEvents(req.cw.scaleId, { from, to, limit });
      return res.json({ source: 'db', rows: rows.map(eventOut) });
    } catch (err) {
      logger.error(`cw events DB failed, fallback memory: ${err.message}`);
    }
  }
  return res.json({ source: 'memory', rows: req.cw.memoryEvents(limit).map(eventOut) });
});

router.get('/:id/snapshots', requireCw, async (req, res) => {
  const to = parseDate(req.query.to) || new Date();
  const from = parseDate(req.query.from) || new Date(to.getTime() - 8 * 60 * 60 * 1000);
  try {
    const rows = await db.fetchCwSnapshots(req.cw.scaleId, from, to);
    res.json({ rows: rows.map((r) => ({ ...r, id: Number(r.id), time_stamp: naive(r.time_stamp) })) });
  } catch (err) {
    res.status(503).json({ error: `อ่าน snapshot ไม่ได้: ${err.message}`, rows: [] });
  }
});

module.exports = router;
