'use strict';

/**
 * summary.js — สรุปผลรายไลน์ (หน้า summary.html)
 *
 * ข้อมูลตั้งต้นคือ "ชิ้นส่วนรายวัน" ต่อเครื่อง: (เอกสาร, วัน) → n, mean, sd, min, max, over, under พร้อมสเปกของเอกสารนั้น
 * แล้วรวมเป็นรายสัปดาห์ / เดือน / ปีที่นี่ (รวม mean/SD แบบแม่นยำ ไม่ใช่เฉลี่ยของค่าเฉลี่ย)
 *
 * Cp / Cpk ของไลน์ในช่วงหนึ่ง = ค่าเฉลี่ยถ่วงน้ำหนักด้วยจำนวนชิ้นของ Cp/Cpk แต่ละเอกสาร
 * (ไลน์เดียวกันอาจผลิตหลาย Product ที่สเปกต่างกันในวันเดียว — เอาน้ำหนักทุก Product มารวมคำนวณ Cpk เดียวไม่ได้)
 * เอกสารที่มีน้อยกว่า 30 ชิ้นไม่นำมาคิด Cpk (ค่าไม่นิ่ง) ยกเว้นทั้งช่วงไม่มีเอกสารไหนถึง 30 ชิ้น
 *
 * วันที่ปิดแล้ว (ก่อนวันนี้) เก็บ cache ในหน่วยความจำ — ขอซ้ำ/ขอช่วงยาวครั้งถัดไปไม่ต้องอ่านฐานข้อมูลใหม่
 */

const DAY_MS = 86400000;
const MIN_N_FOR_CPK = 30;
const CACHE_MAX_DAYS = 200000; // (เครื่อง × วัน) — กันหน่วยความจำโตไม่จำกัด

const pad = (n) => String(n).padStart(2, '0');
const dayKey = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;

function parseDay(s) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(s || ''));
  if (!m) return null;
  const d = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  return Number.isNaN(d.getTime()) ? null : d;
}
function addDays(d, n) { const x = new Date(d); x.setDate(x.getDate() + n); return x; }
function startOfDay(d) { const x = new Date(d); x.setHours(0, 0, 0, 0); return x; }

/** จุดเริ่มของช่วง (วัน / สัปดาห์เริ่มวันจันทร์ / เดือน / ปี) */
function periodStart(d, period) {
  const x = startOfDay(d);
  if (period === 'week') { const wd = (x.getDay() + 6) % 7; x.setDate(x.getDate() - wd); }
  else if (period === 'month') x.setDate(1);
  else if (period === 'year') { x.setMonth(0, 1); }
  return x;
}
function nextPeriod(d, period) {
  const x = new Date(d);
  if (period === 'week') x.setDate(x.getDate() + 7);
  else if (period === 'month') x.setMonth(x.getMonth() + 1);
  else if (period === 'year') x.setFullYear(x.getFullYear() + 1);
  else x.setDate(x.getDate() + 1);
  return x;
}

// ------------------------------------------------------------------ รวมสถิติ
function emptyAcc() { return { n: 0, mean: 0, m2: 0, min: Infinity, max: -Infinity, over: 0, under: 0 }; }
/** รวมกลุ่ม b เข้า a (สูตร parallel variance ของ Chan) */
function merge(a, b) {
  if (!b.n) return a;
  if (!a.n) { Object.assign(a, b); return a; }
  const n = a.n + b.n;
  const delta = b.mean - a.mean;
  a.m2 = a.m2 + b.m2 + (delta * delta * a.n * b.n) / n;
  a.mean += (delta * b.n) / n;
  a.n = n;
  a.min = Math.min(a.min, b.min); a.max = Math.max(a.max, b.max);
  a.over += b.over; a.under += b.under;
  return a;
}
function fromRow(r) {
  const n = Number(r.n) || 0;
  const sd = r.sd == null ? 0 : Number(r.sd);
  return {
    n, mean: Number(r.mean) || 0, m2: n > 1 ? sd * sd * (n - 1) : 0,
    min: r.min_w == null ? Infinity : Number(r.min_w), max: r.max_w == null ? -Infinity : Number(r.max_w),
    over: Number(r.over_n) || 0, under: Number(r.under_n) || 0,
  };
}
const sdOf = (acc) => (acc.n > 1 ? Math.sqrt(Math.max(0, acc.m2 / (acc.n - 1))) : 0);

function capability(acc, spec) {
  const sd = sdOf(acc);
  if (!spec || !(sd > 0) || spec.lsl == null || spec.usl == null) return { cp: null, cpk: null };
  const cp = (spec.usl - spec.lsl) / (6 * sd);
  const cpk = Math.min(spec.usl - acc.mean, acc.mean - spec.lsl) / (3 * sd);
  return { cp, cpk };
}

/**
 * segments: [{ day: Date, session_id, product_code, spec|null, acc }]
 * คืนสรุปของกลุ่มนั้น: จำนวน/ผ่าน/ไม่ผ่าน/Cp/Cpk/ค่าเฉลี่ย ฯลฯ
 */
function summarize(segments) {
  const bySession = new Map();
  const all = emptyAcc();
  let noSpec = 0;
  for (const sg of segments) {
    merge(all, { ...sg.acc });
    if (!sg.spec) { noSpec += sg.acc.n; continue; }
    const k = String(sg.session_id);
    let e = bySession.get(k);
    if (!e) { e = { session_id: sg.session_id, product_code: sg.product_code, spec: sg.spec, acc: emptyAcc() }; bySession.set(k, e); }
    merge(e.acc, { ...sg.acc });
  }
  const docs = [...bySession.values()].map((e) => ({ ...e, ...capability(e.acc, e.spec) }));
  const eligible = docs.filter((d) => d.cpk != null && d.acc.n >= MIN_N_FOR_CPK);
  const pool = eligible.length ? eligible : docs.filter((d) => d.cpk != null);
  let cp = null; let cpk = null; let cpkMin = null; let cpkPrelim = null;
  if (pool.length) {
    const w = pool.reduce((a, d) => a + d.acc.n, 0);
    cp = pool.reduce((a, d) => a + d.cp * d.acc.n, 0) / w;
    cpk = pool.reduce((a, d) => a + d.cpk * d.acc.n, 0) / w;
    cpkMin = Math.min(...pool.map((d) => d.cpk));
  }
  // ทุกเอกสารมีไม่ถึง 30 ชิ้น (เช่น เพิ่งเริ่มกะ) → ยังไม่ตัดสิน ให้ค่าเบื้องต้นไว้ดูเฉย ๆ
  if (pool.length && !eligible.length) { cpkPrelim = cpk; cp = null; cpk = null; cpkMin = null; }
  const withSpec = all.n - noSpec;
  const fail = all.over + all.under;
  const products = [...new Set(docs.map((d) => d.product_code).filter(Boolean))];
  const round = (v, k = 3) => (v == null || !Number.isFinite(v) ? null : Number(v.toFixed(k)));
  return {
    n: all.n, with_spec: withSpec, no_spec: noSpec,
    pass: withSpec - fail, fail, over: all.over, under: all.under,
    pass_pct: withSpec ? round(((withSpec - fail) / withSpec) * 100, 2) : null,
    mean: all.n ? round(all.mean, 3) : null, sd: all.n > 1 ? round(sdOf(all), 4) : null,
    min: Number.isFinite(all.min) ? all.min : null, max: Number.isFinite(all.max) ? all.max : null,
    cp: round(cp), cpk: round(cpk), cpk_min: round(cpkMin), cpk_prelim: round(cpkPrelim),
    docs: docs.length, products,
    low_n: pool.length > 0 && !eligible.length, // มีแต่เอกสารที่น้อยกว่า 30 ชิ้น — ยังไม่คิด Cp/Cpk
  };
}

// ------------------------------------------------------------------ cache + อ่านฐานข้อมูล
const cache = new Map(); // `${scaleId}|${YYYY-MM-DD}` → rows ของวันนั้น (เฉพาะวันที่ปิดแล้ว)

function rowsToSegments(rows) {
  return rows.map((r) => {
    const lsl = r.nw_lcl == null ? null : Number(r.nw_lcl);
    const usl = r.nw_ucl == null ? null : Number(r.nw_ucl);
    const target = r.nw_target == null ? null : Number(r.nw_target);
    return {
      day: startOfDay(r.day instanceof Date ? r.day : new Date(r.day)),
      session_id: r.session_id == null ? null : Number(r.session_id),
      product_code: r.product_code || null,
      spec: r.session_id != null && lsl != null && usl != null ? { lsl, usl, target } : null,
      acc: fromRow(r),
    };
  });
}

/**
 * ชิ้นส่วนรายวันของเครื่อง scaleId ช่วง [from, toExcl) — วันที่ปิดแล้วใช้ cache, วันนี้อ่านใหม่ทุกครั้ง
 * fetch(from, toExcl) ต้องคืนแถวจาก db.fetchDaySegments
 */
async function daySegments(scaleId, from, toExcl, fetch, useUtc) {
  const today = startOfDay(new Date());
  const out = [];
  // หาวันที่ปิดแล้วที่ยังไม่มีใน cache → อ่านเป็นก้อนเดียว (ตั้งแต่วันแรกที่ขาดถึงวันสุดท้ายที่ขาด)
  let missFrom = null; let missTo = null;
  for (let d = new Date(from); d < toExcl && d < today; d = addDays(d, 1)) {
    if (!cache.has(`${scaleId}|${dayKey(d)}`)) { if (!missFrom) missFrom = new Date(d); missTo = addDays(d, 1); }
  }
  if (missFrom) {
    const rows = await fetch(missFrom, missTo);
    const byDay = new Map();
    for (const r of rows) {
      const d = normalizeDay(r.day, useUtc);
      const k = dayKey(d);
      if (!byDay.has(k)) byDay.set(k, []);
      byDay.get(k).push({ ...r, day: d });
    }
    if (cache.size > CACHE_MAX_DAYS) cache.clear();
    for (let d = new Date(missFrom); d < missTo; d = addDays(d, 1)) cache.set(`${scaleId}|${dayKey(d)}`, byDay.get(dayKey(d)) || []);
  }
  for (let d = new Date(from); d < toExcl && d < today; d = addDays(d, 1)) {
    out.push(...rowsToSegments(cache.get(`${scaleId}|${dayKey(d)}`) || []));
  }
  if (toExcl > today) {
    const rows = await fetch(today > from ? today : from, toExcl);
    out.push(...rowsToSegments(rows.map((r) => ({ ...r, day: normalizeDay(r.day, useUtc) }))));
  }
  return out;
}

/** mssql คืน DATETIME เป็น Date ที่ตีความเป็น UTC (ถ้า useUTC) — แปลงกลับเป็นวันตามเวลาเครื่อง */
function normalizeDay(v, useUtc) {
  const d = v instanceof Date ? v : new Date(v);
  if (useUtc) return new Date(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
  return startOfDay(d);
}

/** รวมชิ้นส่วนรายวันเป็นสรุปต่อช่วง + สรุปทั้งช่วง */
function buildLine(segments, from, toExcl, period) {
  const buckets = [];
  for (let t = periodStart(from, period); t < toExcl; t = nextPeriod(t, period)) buckets.push(t);
  const groups = new Map(buckets.map((t) => [dayKey(t), []]));
  for (const sg of segments) {
    const k = dayKey(periodStart(sg.day, period));
    if (groups.has(k)) groups.get(k).push(sg);
  }
  return {
    total: summarize(segments),
    series: buckets.map((t) => ({ t: dayKey(t), ...summarize(groups.get(dayKey(t))) })),
  };
}

/** สรุปจากแถวรายชิ้นในหน่วยความจำ (ตอนไม่มีฐานข้อมูล) — ไม่มีสเปกเอกสาร จึงมีแค่จำนวน/ค่าเฉลี่ย */
function rowsFromMemory(rows) {
  const map = new Map();
  for (const r of rows) {
    const d = startOfDay(r.time_stamp);
    const k = `${dayKey(d)}|${r.session_id ?? ''}`;
    let a = map.get(k);
    if (!a) { a = { day: d, session_id: r.session_id ?? null, list: [] }; map.set(k, a); }
    a.list.push(Number(r.weight));
  }
  return [...map.values()].map((a) => {
    const n = a.list.length; const mean = a.list.reduce((x, y) => x + y, 0) / n;
    const sd = n > 1 ? Math.sqrt(a.list.reduce((x, y) => x + (y - mean) ** 2, 0) / (n - 1)) : 0;
    let min = Infinity; let max = -Infinity;
    for (const v of a.list) { if (v < min) min = v; if (v > max) max = v; }
    return { day: a.day, session_id: null, n, mean, sd, min_w: min, max_w: max, over_n: 0, under_n: 0 };
  });
}

module.exports = { parseDay, addDays, startOfDay, periodStart, nextPeriod, dayKey, daySegments, buildLine, rowsFromMemory, summarize, rowsToSegments, MIN_N_FOR_CPK };
