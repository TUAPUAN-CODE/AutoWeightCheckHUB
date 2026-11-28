/**
 * analysis.js — หน้าวิเคราะห์กราฟแบบเต็มจอ (analysis.html)
 *
 *   analysis.html?scale=3&view=trend&range=1h          เครื่อง 3, ย้อนหลัง 1 ชม.
 *   analysis.html?scale=3&range=7d&tf=1h               7 วัน แท่งละ 1 ชม. (แบบกราฟหุ้น)
 *   analysis.html?session=45                           ทั้งเอกสาร #45
 *   analysis.html?scale=3&from=2026-11-28T06:00&to=2026-11-28T17:30
 *
 * view: trend | hist | xbar | r | s | cap
 * tf (แท่งละ): raw | 1m | 5m | 15m | 1h | 1d | 1M | 1y   (ไม่ระบุ = เลือกให้อัตโนมัติตามช่วงเวลา)
 */
(function () {
  'use strict';

  const $ = (id) => document.getElementById(id);
  const Q = new URLSearchParams(location.search);
  const RAW_LIMIT = 50000;
  const SESSION_LIMIT = 200000;
  const ic = (n, c) => (window.icon ? window.icon(n, c) : '');

  // ------------------------------------------------------------------ helpers
  async function api(path) {
    const res = await fetch(path, { cache: 'no-store', headers: { accept: 'application/json' } });
    let body = null;
    try { body = await res.json(); } catch (e) { /* ไม่ใช่ JSON */ }
    if (!res.ok) throw new Error((body && body.error) || `HTTP ${res.status}`);
    return body || {};
  }
  const p2 = (n) => String(n).padStart(2, '0');
  const fmt = (v, d = 1) => (v == null || !Number.isFinite(v) ? '-' : Number(v).toFixed(d));
  const fint = (v) => (v == null || !Number.isFinite(v) ? '-' : Math.round(v).toLocaleString('en-US'));
  const pct = (v, d = 1) => (v == null || !Number.isFinite(v) ? '-' : `${(v * 100).toFixed(d)}%`);
  const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const localIso = (d) => `${d.getFullYear()}-${p2(d.getMonth() + 1)}-${p2(d.getDate())}T${p2(d.getHours())}:${p2(d.getMinutes())}:${p2(d.getSeconds())}`;
  const dts = (d) => `${p2(d.getDate())}/${p2(d.getMonth() + 1)} ${p2(d.getHours())}:${p2(d.getMinutes())}:${p2(d.getSeconds())}`;
  const dtm = (d) => `${p2(d.getDate())}/${p2(d.getMonth() + 1)}/${d.getFullYear() + 543} ${p2(d.getHours())}:${p2(d.getMinutes())}`;
  const signed = (v, d = 2) => (v == null || !Number.isFinite(v) ? '-' : `${v >= 0 ? '+' : ''}${v.toFixed(d)}`);

  function shiftStart(now) {
    const d = new Date(now);
    const m = d.getHours() * 60 + d.getMinutes();
    if (m >= 360 && m < 1050) { d.setHours(6, 0, 0, 0); return d; }
    if (m >= 1050) { d.setHours(17, 30, 0, 0); return d; }
    d.setDate(d.getDate() - 1); d.setHours(17, 30, 0, 0); return d;
  }

  // ------------------------------------------------------------------ options
  const VIEWS = [
    { key: 'trend', label: 'แนวโน้มน้ำหนัก' },
    { key: 'hist', label: 'Histogram' },
    { key: 'xbar', label: 'X̄ Chart' },
    { key: 'r', label: 'R Chart' },
    { key: 's', label: 'S Chart' },
    { key: 'cap', label: 'Cp / Cpk' },
  ];
  const PERIODS = [
    { key: '30m', label: '30 นาที', ms: 30 * 60e3 },
    { key: '1h', label: '1 ชม.', ms: 3600e3 },
    { key: 'shift', label: 'กะนี้' },
    { key: '24h', label: '24 ชม.', ms: 86400e3 },
    { key: '7d', label: '7 วัน', ms: 7 * 86400e3 },
    { key: '30d', label: '30 วัน', ms: 30 * 86400e3 },
    { key: '1y', label: '1 ปี', ms: 365 * 86400e3 },
    { key: 'custom', label: 'กำหนดเอง' },
  ];
  const TFS = [
    { key: 'raw', label: 'รายชิ้น' },
    { key: '1m', label: '1 นาที', unit: 'minute', step: 1, ms: 60e3 },
    { key: '5m', label: '5 นาที', unit: 'minute', step: 5, ms: 5 * 60e3 },
    { key: '15m', label: '15 นาที', unit: 'minute', step: 15, ms: 15 * 60e3 },
    { key: '30m', label: '30 นาที', unit: 'minute', step: 30, ms: 30 * 60e3 },
    { key: '1h', label: '1 ชม.', unit: 'hour', step: 1, ms: 3600e3 },
    { key: '1d', label: '1 วัน', unit: 'day', step: 1, ms: 86400e3 },
    { key: '1M', label: '1 เดือน', unit: 'month', step: 1, ms: 30 * 86400e3 },
    { key: '1y', label: '1 ปี', unit: 'year', step: 1, ms: 365 * 86400e3 },
  ];
  const MAX_BUCKETS = 6000;
  // ช่วงเวลาจากหน้า Dashboard (5m, 10m, All) แปลงให้ใกล้เคียง
  const PERIOD_ALIAS = { '5m': '30m', '10m': '30m', all: '1h', All: '1h' };

  const st = {
    scaleId: Number.parseInt(Q.get('scale'), 10) || null,
    sessionId: Number.parseInt(Q.get('session'), 10) || null,
    session: null,
    view: VIEWS.some((v) => v.key === Q.get('view')) ? Q.get('view') : 'trend',
    period: PERIOD_ALIAS[Q.get('range')] || (PERIODS.some((p) => p.key === Q.get('range')) ? Q.get('range') : '1h'),
    tf: TFS.some((t) => t.key === Q.get('tf')) ? Q.get('tf') : 'auto',
    from: null,
    to: null,
    spec: { lsl: null, target: null, usl: null, source: '' },
    scales: [],
    raw: [], // {id, w, t}
    rawTruncated: false,
    buckets: [], // {t, n, mean, sd, min, max, over, under}
    bucketTf: null,
    zoom: { i0: 0, i1: 0 },
    model: null,
    picked: null,
    error: null,
    zone: { yellowPct: 60, redPct: 85 },
  };
  if (Q.get('from') && Q.get('to')) {
    const f = new Date(Q.get('from')); const t = new Date(Q.get('to'));
    if (!Number.isNaN(f.getTime()) && !Number.isNaN(t.getTime()) && t > f) { st.period = 'custom'; st.from = f; st.to = t; }
  }

  // ------------------------------------------------------------------ statistics
  function stats(vals) {
    const n = vals.length;
    if (!n) return { n: 0, mean: null, sd: null, min: null, max: null };
    let sum = 0; let min = Infinity; let max = -Infinity;
    for (const v of vals) { sum += v; if (v < min) min = v; if (v > max) max = v; }
    const mean = sum / n;
    let ss = 0;
    for (const v of vals) ss += (v - mean) ** 2;
    return { n, mean, sd: n > 1 ? Math.sqrt(ss / (n - 1)) : null, min, max };
  }
  function capability(s, spec) {
    if (!s || !s.sd || spec.lsl == null || spec.usl == null) return { cp: null, cpk: null, cpu: null, cpl: null };
    const cp = (spec.usl - spec.lsl) / (6 * s.sd);
    const cpu = (spec.usl - s.mean) / (3 * s.sd);
    const cpl = (s.mean - spec.lsl) / (3 * s.sd);
    return { cp, cpk: Math.min(cpu, cpl), cpu, cpl };
  }
  /** โซนตามหน้า "ตั้งค่า": green / yellow / red (ยังผ่าน) และ over / under (หลุดสเปก = reject) */
  function classOf(v, spec) {
    if (spec.lsl == null || spec.usl == null) return 'green';
    if (v > spec.usl) return 'over';
    if (v < spec.lsl) return 'under';
    if (spec.target == null) return 'green';
    const d = v - spec.target;
    const lim = d >= 0 ? spec.usl - spec.target : spec.target - spec.lsl;
    if (!(lim > 0)) return 'green';
    const r = (Math.abs(d) / lim) * 100;
    return r >= st.zone.redPct ? 'red' : r >= st.zone.yellowPct ? 'yellow' : 'green';
  }
  function zoneEdges(spec) {
    if (spec.lsl == null || spec.usl == null || spec.target == null) return null;
    const up = spec.usl - spec.target; const dn = spec.target - spec.lsl;
    return {
      yHi: spec.target + (up * st.zone.yellowPct) / 100, rHi: spec.target + (up * st.zone.redPct) / 100,
      yLo: spec.target - (dn * st.zone.yellowPct) / 100, rLo: spec.target - (dn * st.zone.redPct) / 100,
    };
  }
  const capLevel = (v) => (v == null ? '' : v >= 1.33 ? 'good' : v >= 1 ? 'warn' : 'bad');
  const capText = (v) => (v == null ? '-' : v >= 1.33 ? 'ดี' : v >= 1 ? 'พอใช้' : 'ไม่ดี');

  /** รวมสถิติจากแท่ง (ใช้ตอนไม่มีข้อมูลรายชิ้นทั้งหมด) */
  function statsFromBuckets(bs) {
    let N = 0; let sum = 0; let min = Infinity; let max = -Infinity; let over = 0; let under = 0;
    for (const b of bs) { N += b.n; sum += b.n * b.mean; min = Math.min(min, b.min); max = Math.max(max, b.max); over += b.over; under += b.under; }
    if (!N) return { s: stats([]), over: 0, under: 0 };
    const M = sum / N;
    let ss = 0;
    for (const b of bs) ss += (b.n - 1) * (b.sd || 0) ** 2 + b.n * (b.mean - M) ** 2;
    return { s: { n: N, mean: M, sd: N > 1 ? Math.sqrt(ss / (N - 1)) : null, min, max }, over, under };
  }

  // ------------------------------------------------------------------ colors (อ่านจากธีม รองรับโหมดมืด)
  function hexA(hex, a) {
    const h = String(hex).trim().replace('#', '');
    if (h.length !== 6) return hex;
    return `rgba(${parseInt(h.slice(0, 2), 16)},${parseInt(h.slice(2, 4), 16)},${parseInt(h.slice(4, 6), 16)},${a})`;
  }
  function colors() {
    const cs = getComputedStyle(document.documentElement);
    const v = (n, d) => cs.getPropertyValue(n).trim() || d;
    return {
      ink: v('--ink', '#0E1A2E'), ink2: v('--ink-2', '#4A5870'), ink3: v('--ink-3', '#8190A6'),
      grid: v('--hairline-2', '#EEF2F7'), line: v('--hairline', '#E4E9F1'), surface: v('--surface', '#fff'),
      blue: v('--blue-600', '#1D4ED8'), blueL: v('--blue-500', '#2563EB'), orange: v('--orange-500', '#F57C1F'),
      bad: v('--bad', '#D23A31'), good: v('--good', '#0E9466'), caution: '#E3A008', red: '#F0602B', ctrl: '#6C84B8',
      font: v('--font', 'sans-serif'),
    };
  }

  // ------------------------------------------------------------------ canvas
  const wrap = $('wrap');
  const cvBase = $('cvBase');
  const cvOver = $('cvOver');
  const tip = $('tip');
  let W = 0; let H = 0; let DPR = 1;

  function sizeCanvas() {
    const r = wrap.getBoundingClientRect();
    DPR = window.devicePixelRatio || 1;
    W = Math.max(200, Math.floor(r.width)); H = Math.max(200, Math.floor(r.height));
    for (const c of [cvBase, cvOver]) { c.width = Math.round(W * DPR); c.height = Math.round(H * DPR); }
  }
  function ctxOf(c) { const x = c.getContext('2d'); x.setTransform(DPR, 0, 0, DPR, 0, 0); return x; }

  function niceTicks(lo, hi, count) {
    const span = hi - lo || 1;
    const raw = span / count;
    const mag = 10 ** Math.floor(Math.log10(raw));
    const step = [1, 2, 2.5, 5, 10].map((m) => m * mag).find((s) => s >= raw) || raw;
    const out = [];
    for (let v = Math.ceil(lo / step) * step; v <= hi + step * 1e-6; v += step) out.push(+v.toFixed(10));
    return { ticks: out, step };
  }
  function decimalsFor(step) { return step >= 1 ? 0 : step >= 0.1 ? 1 : 2; }

  // ------------------------------------------------------------------ models (สิ่งที่จะวาด)
  /** แปลงข้อมูลเป็น "ซีรีส์" ตามมุมมองที่เลือก */
  function buildModel() {
    const spec = st.spec;
    const vals = st.raw.map((r) => r.w);
    if (st.view === 'trend' && st.bucketTf) {
      return {
        kind: 'candles',
        title: `แนวโน้มน้ำหนัก แท่งละ ${st.bucketTf.label}`,
        items: st.buckets,
        refs: specRefs(spec),
      };
    }
    if (st.view === 'trend') {
      const s = stats(vals);
      const mr = [];
      for (let i = 1; i < vals.length; i += 1) mr.push(Math.abs(vals[i] - vals[i - 1]));
      const mrBar = mr.length ? mr.reduce((a, b) => a + b, 0) / mr.length : 0;
      const refs = specRefs(spec);
      if (s.n > 1) {
        refs.push({ v: s.mean, color: 'ctrl', dash: [2, 3], label: 'x̄' });
        refs.push({ v: s.mean + 2.66 * mrBar, color: 'ctrl', dash: [6, 4], label: 'UCL' });
        refs.push({ v: s.mean - 2.66 * mrBar, color: 'ctrl', dash: [6, 4], label: 'LCL' });
      }
      return {
        kind: 'points', title: 'น้ำหนักรายชิ้น (Individuals)', unit: 'g', decimals: 1,
        items: st.raw.map((r, i) => ({ v: r.w, t: r.t, id: r.id, seq: i + 1, cls: classOf(r.w, spec) })),
        refs, ucl: s.mean + 2.66 * mrBar, lcl: s.mean - 2.66 * mrBar, centre: s.mean,
      };
    }
    if (st.view === 'hist') return { kind: 'hist', title: 'Histogram การกระจายน้ำหนัก', vals };
    if (st.view === 'xbar' || st.view === 'r') {
      const n = 5;
      const groups = [];
      for (let i = 0; i + n <= st.raw.length; i += n) {
        const g = st.raw.slice(i, i + n);
        const gv = g.map((r) => r.w);
        groups.push({ mean: gv.reduce((a, b) => a + b, 0) / n, range: Math.max(...gv) - Math.min(...gv), t: g[n - 1].t, seq: groups.length + 1, from: i + 1 });
      }
      const xbb = groups.length ? groups.reduce((a, g) => a + g.mean, 0) / groups.length : null;
      const rBar = groups.length ? groups.reduce((a, g) => a + g.range, 0) / groups.length : null;
      if (st.view === 'xbar') {
        const ucl = xbb + 0.577 * rBar; const lcl = xbb - 0.577 * rBar;
        return {
          kind: 'points', title: 'X̄ Chart (ค่าเฉลี่ยกลุ่มละ 5 ชิ้น)', unit: 'g', decimals: 2, sub: true,
          items: groups.map((g) => ({ v: g.mean, t: g.t, seq: g.seq, from: g.from, cls: g.mean > ucl || g.mean < lcl ? 'over' : 'ok' })),
          refs: [{ v: ucl, color: 'bad', dash: [6, 4], label: 'UCL' }, { v: xbb, color: 'ctrl', dash: [2, 3], label: 'X̄̄' }, { v: lcl, color: 'bad', dash: [6, 4], label: 'LCL' }],
          ucl, lcl, centre: xbb,
        };
      }
      const ucl = 2.114 * rBar;
      return {
        kind: 'points', title: 'R Chart (ช่วงกว้างของกลุ่มละ 5 ชิ้น)', unit: 'g', decimals: 2, sub: true,
        items: groups.map((g) => ({ v: g.range, t: g.t, seq: g.seq, from: g.from, cls: g.range > ucl ? 'over' : 'ok' })),
        refs: [{ v: ucl, color: 'bad', dash: [6, 4], label: 'UCL' }, { v: rBar, color: 'ctrl', dash: [2, 3], label: 'R̄' }, { v: 0, color: 'ctrl', dash: [6, 4], label: 'LCL' }],
        ucl, lcl: 0, centre: rBar,
      };
    }
    if (st.view === 's') {
      const n = 30;
      const groups = [];
      for (let i = 0; i + n <= st.raw.length; i += n) {
        const g = st.raw.slice(i, i + n);
        groups.push({ s: stats(g.map((r) => r.w)).sd, t: g[n - 1].t, seq: groups.length + 1, from: i + 1 });
      }
      const sBar = groups.length ? groups.reduce((a, g) => a + g.s, 0) / groups.length : null;
      const c4 = (4 * (n - 1)) / (4 * n - 3);
      const term = (3 * Math.sqrt(Math.max(0, 1 - c4 * c4))) / c4;
      const ucl = (1 + term) * sBar; const lcl = Math.max(0, 1 - term) * sBar;
      return {
        kind: 'points', title: 'S Chart (SD ของกลุ่มละ 30 ชิ้น)', unit: 'g', decimals: 3, sub: true,
        items: groups.map((g) => ({ v: g.s, t: g.t, seq: g.seq, from: g.from, cls: g.s > ucl || g.s < lcl ? 'over' : 'ok' })),
        refs: [{ v: ucl, color: 'bad', dash: [6, 4], label: 'UCL' }, { v: sBar, color: 'ctrl', dash: [2, 3], label: 'S̄' }, { v: lcl, color: 'bad', dash: [6, 4], label: 'LCL' }],
        ucl, lcl, centre: sBar,
      };
    }
    // cap: Cp/Cpk ต่อกลุ่ม 20 ชิ้น
    const n = 20;
    const items = [];
    for (let i = 0; i + n <= st.raw.length; i += n) {
      const g = st.raw.slice(i, i + n);
      const c = capability(stats(g.map((r) => r.w)), spec);
      if (c.cpk != null) items.push({ v: c.cpk, v2: c.cp, t: g[n - 1].t, seq: items.length + 1, from: i + 1, cls: c.cpk < 1 ? 'over' : c.cpk < 1.33 ? 'warn' : 'ok' });
    }
    return {
      kind: 'points', title: 'Cp / Cpk ต่อกลุ่ม 20 ชิ้น', unit: '', decimals: 2, sub: true, dual: true,
      items,
      refs: [{ v: 1.33, color: 'orange', dash: [6, 4], label: '1.33' }, { v: 1, color: 'bad', dash: [6, 4], label: '1.00' }],
    };
  }

  function specRefs(spec) {
    const r = [];
    if (spec.usl != null) r.push({ v: spec.usl, color: 'bad', dash: [], label: 'USL' });
    if (spec.target != null) r.push({ v: spec.target, color: 'orange', dash: [5, 4], label: 'Target' });
    if (spec.lsl != null) r.push({ v: spec.lsl, color: 'bad', dash: [], label: 'LSL' });
    return r;
  }

  // ------------------------------------------------------------------ layout ที่ใช้ร่วม
  function plotRect(m) {
    const pad = { l: 58, r: 80, t: 22, b: 36 };
    const r = { x: pad.l, y: pad.t, w: W - pad.l - pad.r, h: H - pad.t - pad.b };
    if (m.kind === 'candles') {
      const volH = Math.round(r.h * 0.2);
      return { main: { x: r.x, y: r.y, w: r.w, h: r.h - volH - 14 }, vol: { x: r.x, y: r.y + r.h - volH, w: r.w, h: volH } };
    }
    return { main: r };
  }
  function visibleRange(m) {
    const n = m.items ? m.items.length : 0;
    let { i0, i1 } = st.zoom;
    if (!(i1 > i0) || i1 > n) { i0 = 0; i1 = n; }
    return { i0: Math.max(0, i0), i1: Math.min(n, i1), n };
  }
  function xOf(rect, i, i0, i1) {
    const cnt = Math.max(1, i1 - i0);
    return rect.x + ((i - i0 + 0.5) / cnt) * rect.w;
  }

  function yRangeFor(m, i0, i1) {
    let lo = Infinity; let hi = -Infinity;
    for (let i = i0; i < i1; i += 1) {
      const it = m.items[i];
      if (m.kind === 'candles') { lo = Math.min(lo, it.min); hi = Math.max(hi, it.max); } else {
        lo = Math.min(lo, it.v); hi = Math.max(hi, it.v);
        if (it.v2 != null) { lo = Math.min(lo, it.v2); hi = Math.max(hi, it.v2); }
      }
    }
    for (const r of m.refs || []) if (Number.isFinite(r.v)) { lo = Math.min(lo, r.v); hi = Math.max(hi, r.v); }
    if (!Number.isFinite(lo)) { lo = 0; hi = 1; }
    // ไม่ให้ค่าที่หลุดไกลมากตัวเดียวดึงแกนจนกราฟแบน: จำกัดที่ ±3 เท่าของช่วงสเปก
    if (m.kind !== 'candles' && st.spec.lsl != null && st.spec.usl != null && st.view === 'trend') {
      const span = st.spec.usl - st.spec.lsl;
      lo = Math.max(lo, st.spec.lsl - span * 3); hi = Math.min(hi, st.spec.usl + span * 3);
    }
    const span = hi - lo || Math.abs(hi) * 0.1 || 1;
    return { lo: lo - span * 0.08, hi: hi + span * 0.1 };
  }

  function timeLabel(d, unit) {
    if (!d) return '';
    if (unit === 'year') return String(d.getFullYear() + 543);
    if (unit === 'month') return `${p2(d.getMonth() + 1)}/${d.getFullYear() + 543}`;
    if (unit === 'day') return `${p2(d.getDate())}/${p2(d.getMonth() + 1)}`;
    if (unit === 'hour' || unit === 'minute') {
      const span = st.to - st.from;
      return span > 86400e3 ? `${p2(d.getDate())}/${p2(d.getMonth() + 1)} ${p2(d.getHours())}:${p2(d.getMinutes())}` : `${p2(d.getHours())}:${p2(d.getMinutes())}`;
    }
    return `${p2(d.getHours())}:${p2(d.getMinutes())}:${p2(d.getSeconds())}`;
  }

  // ------------------------------------------------------------------ วาด
  function draw() {
    sizeCanvas();
    const ctx = ctxOf(cvBase);
    ctx.clearRect(0, 0, W, H);
    ctxOf(cvOver).clearRect(0, 0, W, H);
    const m = st.model;
    if (!m) return;
    const c = colors();
    ctx.font = `12px ${c.font}`;
    if (m.kind === 'hist') { drawHist(ctx, m, c); updateZoomLabel(); return; }
    if (!m.items.length) { showMsg(st.raw.length || st.buckets.length ? 'ข้อมูลไม่พอสำหรับกราฟนี้ — เลือกช่วงเวลาที่ยาวขึ้น' : 'ไม่มีข้อมูลในช่วงเวลานี้'); return; }
    hideMsg();
    const { i0, i1 } = visibleRange(m);
    const L = plotRect(m);
    const R = L.main;
    const yr = yRangeFor(m, i0, i1);
    const Y = (v) => R.y + (1 - (v - yr.lo) / (yr.hi - yr.lo)) * R.h;
    m._geom = { L, i0, i1, yr, Y };

    // แถบโซน เขียว / เหลือง / แดง ระหว่าง LSL–USL
    const ze = st.view === 'trend' ? zoneEdges(st.spec) : null;
    if (ze) {
      const band = (a, b, col, al) => {
        const yA = Math.max(R.y, Y(Math.max(a, b))); const yB = Math.min(R.y + R.h, Y(Math.min(a, b)));
        if (yB > yA) { ctx.fillStyle = hexA(col, al); ctx.fillRect(R.x, yA, R.w, yB - yA); }
      };
      band(ze.yLo, ze.yHi, c.good, 0.08);
      band(ze.yHi, ze.rHi, c.caution, 0.12); band(ze.rLo, ze.yLo, c.caution, 0.12);
      band(ze.rHi, st.spec.usl, c.red, 0.12); band(st.spec.lsl, ze.rLo, c.red, 0.12);
    }
    // grid + y axis
    const { ticks, step } = niceTicks(yr.lo, yr.hi, Math.max(3, Math.floor(R.h / 55)));
    const dec = Math.max(decimalsFor(step), m.kind === 'candles' ? 1 : 0);
    ctx.strokeStyle = c.grid; ctx.lineWidth = 1; ctx.fillStyle = c.ink3; ctx.textAlign = 'right'; ctx.textBaseline = 'middle';
    for (const t of ticks) {
      const y = Math.round(Y(t)) + 0.5;
      if (y < R.y - 1 || y > R.y + R.h + 1) continue;
      ctx.beginPath(); ctx.moveTo(R.x, y); ctx.lineTo(R.x + R.w, y); ctx.stroke();
      ctx.fillText(t.toFixed(dec), R.x - 8, y);
    }
    // reference lines
    for (const r of m.refs || []) {
      if (!Number.isFinite(r.v)) continue;
      const y = Y(r.v);
      if (y < R.y - 2 || y > R.y + R.h + 2) continue;
      ctx.save();
      ctx.strokeStyle = c[r.color] || r.color; ctx.lineWidth = r.dash.length ? 1.4 : 1.6; ctx.setLineDash(r.dash);
      ctx.beginPath(); ctx.moveTo(R.x, y); ctx.lineTo(R.x + R.w, y); ctx.stroke(); ctx.restore();
      ctx.fillStyle = c[r.color] || r.color; ctx.textAlign = 'left'; ctx.font = `600 11.5px ${c.font}`;
      ctx.fillText(`${r.label} ${fmt(r.v, r.v >= 10 ? 1 : 2)}`, R.x + R.w + 6, y);
      ctx.font = `12px ${c.font}`;
    }
    if (m.kind === 'candles') drawCandles(ctx, m, c, L, i0, i1, Y);
    else drawPoints(ctx, m, c, R, i0, i1, Y);
    drawXAxis(ctx, m, c, L, i0, i1);
    updateZoomLabel();
  }

  function drawPoints(ctx, m, c, R, i0, i1, Y) {
    const cnt = i1 - i0;
    const slot = R.w / Math.max(1, cnt);
    const colorOf = (cls) => ({ over: c.bad, under: c.bad, red: c.red, yellow: c.caution, green: c.good, warn: c.orange }[cls] || c.blue);
    ctx.save();
    ctx.beginPath(); ctx.rect(R.x, R.y - 6, R.w, R.h + 12); ctx.clip();
    // เส้น
    const series = m.dual ? ['v2', 'v'] : ['v'];
    for (const key of series) {
      ctx.strokeStyle = key === 'v2' ? hexA(c.ctrl, 0.8) : hexA(c.blueL, cnt > 1500 ? 0.75 : 0.55);
      ctx.lineWidth = cnt > 3000 ? 1 : 1.4;
      ctx.setLineDash(key === 'v2' ? [4, 3] : []);
      ctx.beginPath();
      // ข้อมูลเยอะมาก: วาดทุกพิกเซลเป็นเส้น min/max ของช่องนั้น (ไม่หายจุดที่หลุด)
      if (cnt > R.w * 2 && key === 'v') {
        const px = Math.ceil(R.w);
        for (let p = 0; p < px; p += 1) {
          const a = i0 + Math.floor((p / px) * cnt); const b = Math.max(a + 1, i0 + Math.floor(((p + 1) / px) * cnt));
          let lo = Infinity; let hi = -Infinity;
          for (let i = a; i < b && i < i1; i += 1) { const v = m.items[i].v; if (v < lo) lo = v; if (v > hi) hi = v; }
          if (!Number.isFinite(lo)) continue;
          ctx.moveTo(R.x + p + 0.5, Y(hi)); ctx.lineTo(R.x + p + 0.5, Y(lo) + 0.5);
        }
      } else {
        for (let i = i0; i < i1; i += 1) { const it = m.items[i]; const val = it[key]; if (val == null) continue; const x = xOf(R, i, i0, i1); const y = Y(val); if (i === i0) ctx.moveTo(x, y); else ctx.lineTo(x, y); }
      }
      ctx.stroke();
    }
    ctx.setLineDash([]);
    // จุด
    const showAll = cnt <= 1500;
    for (let i = i0; i < i1; i += 1) {
      const it = m.items[i];
      const bad = it.cls === 'over' || it.cls === 'under';
      if (!showAll && !bad && it.cls !== 'red') continue;
      const x = xOf(R, i, i0, i1); const y = Y(it.v);
      ctx.fillStyle = colorOf(it.cls);
      ctx.beginPath(); ctx.arc(x, y, bad ? Math.min(4.5, 2 + slot / 6) : Math.min(3.6, 1.4 + slot / 8), 0, Math.PI * 2); ctx.fill();
    }
    // ตัวเลขบนจุด (เมื่อซูมจนมีที่พอ)
    if (slot >= 30) {
      ctx.font = `600 11px ${c.font}`; ctx.textAlign = 'center'; ctx.textBaseline = 'bottom';
      for (let i = i0; i < i1; i += 1) {
        const it = m.items[i];
        const x = xOf(R, i, i0, i1); const y = Y(it.v);
        ctx.fillStyle = colorOf(it.cls);
        ctx.fillText(fmt(it.v, m.decimals), x, y - 7);
      }
    }
    ctx.restore();
  }

  function drawCandles(ctx, m, c, L, i0, i1, Y) {
    const R = L.main; const V = L.vol;
    const cnt = i1 - i0; const slot = R.w / Math.max(1, cnt);
    const bw = Math.max(1, Math.min(26, slot * 0.62));
    ctx.save();
    ctx.beginPath(); ctx.rect(R.x, R.y - 4, R.w, V.y + V.h - R.y + 4); ctx.clip();
    let maxN = 1;
    for (let i = i0; i < i1; i += 1) maxN = Math.max(maxN, m.items[i].n);
    // เส้นค่าเฉลี่ย
    ctx.strokeStyle = hexA(c.blueL, 0.5); ctx.lineWidth = 1.2; ctx.beginPath();
    for (let i = i0; i < i1; i += 1) { const x = xOf(R, i, i0, i1); const y = Y(m.items[i].mean); if (i === i0) ctx.moveTo(x, y); else ctx.lineTo(x, y); }
    ctx.stroke();
    for (let i = i0; i < i1; i += 1) {
      const b = m.items[i];
      const x = xOf(R, i, i0, i1);
      const failRate = b.n ? (b.over + b.under) / b.n : 0;
      const col = failRate > 0.02 ? c.bad : failRate > 0 ? c.orange : c.good;
      // ไส้ = ต่ำสุด..สูงสุด
      ctx.strokeStyle = col; ctx.lineWidth = 1.2;
      ctx.beginPath(); ctx.moveTo(Math.round(x) + 0.5, Y(b.max)); ctx.lineTo(Math.round(x) + 0.5, Y(b.min)); ctx.stroke();
      // ตัวแท่ง = ค่าเฉลี่ย ± 1 SD
      const sd = b.sd || 0;
      const top = Y(Math.min(b.max, b.mean + sd)); const bot = Y(Math.max(b.min, b.mean - sd));
      ctx.fillStyle = hexA(col, 0.85);
      ctx.fillRect(x - bw / 2, top, bw, Math.max(2, bot - top));
      // จุดค่าเฉลี่ย
      ctx.fillStyle = c.surface; ctx.fillRect(x - bw / 2, Y(b.mean) - 1, bw, 2);
      // ปริมาณการผลิต (ผ่าน / ไม่ผ่าน)
      const total = (b.n / maxN) * V.h; const failH = ((b.over + b.under) / maxN) * V.h;
      ctx.fillStyle = hexA(c.blueL, 0.35); ctx.fillRect(x - bw / 2, V.y + V.h - total, bw, total - failH);
      ctx.fillStyle = hexA(c.bad, 0.8); ctx.fillRect(x - bw / 2, V.y + V.h - failH, bw, failH);
    }
    // ป้ายตัวเลข
    if (slot >= 40) {
      ctx.textAlign = 'center';
      for (let i = i0; i < i1; i += 1) {
        const b = m.items[i]; const x = xOf(R, i, i0, i1);
        ctx.font = `600 11px ${c.font}`; ctx.fillStyle = c.ink; ctx.textBaseline = 'bottom';
        ctx.fillText(fmt(b.mean, 1), x, Y(b.max) - 4);
        ctx.font = `10.5px ${c.font}`; ctx.fillStyle = c.ink3; ctx.textBaseline = 'bottom';
        ctx.fillText(fint(b.n), x, V.y + V.h - (b.n / maxN) * V.h - 2);
      }
    }
    ctx.restore();
    ctx.fillStyle = c.ink3; ctx.font = `11px ${c.font}`; ctx.textAlign = 'right'; ctx.textBaseline = 'top';
    ctx.fillText('ชิ้น', V.x - 8, V.y);
    ctx.strokeStyle = c.line; ctx.beginPath(); ctx.moveTo(V.x, V.y + V.h + 0.5); ctx.lineTo(V.x + V.w, V.y + V.h + 0.5); ctx.stroke();
  }

  function drawXAxis(ctx, m, c, L, i0, i1) {
    const R = L.main; const base = L.vol ? L.vol.y + L.vol.h : R.y + R.h;
    ctx.strokeStyle = c.line; ctx.beginPath(); ctx.moveTo(R.x, base + 0.5); ctx.lineTo(R.x + R.w, base + 0.5); ctx.stroke();
    const cnt = i1 - i0; const slot = R.w / Math.max(1, cnt);
    ctx.fillStyle = c.ink3; ctx.font = `11.5px ${c.font}`; ctx.textAlign = 'center'; ctx.textBaseline = 'top';
    const every = Math.max(1, Math.ceil(110 / slot));
    const unit = m.kind === 'candles' && st.bucketTf ? st.bucketTf.unit : null;
    let lastX = -Infinity;
    for (let i = i0; i < i1; i += every) {
      const it = m.items[i]; const x = xOf(R, i, i0, i1);
      if (x - lastX < 90) continue;
      lastX = x;
      const label = it.t ? timeLabel(it.t, unit) : String(i + 1);
      ctx.fillText(label, x, base + 6);
      if (slot >= 46 && m.kind === 'points') {
        ctx.fillStyle = c.ink3; ctx.font = `10.5px ${c.font}`;
        ctx.fillText(m.sub ? `กลุ่ม ${it.seq}` : `ชิ้นที่ ${it.seq}`, x, base + 20);
        ctx.font = `11.5px ${c.font}`;
      }
    }
  }

  function drawHist(ctx, m, c) {
    const vals = m.vals;
    if (vals.length < 2) { showMsg('ข้อมูลไม่พอสำหรับ Histogram'); return; }
    hideMsg();
    const s = stats(vals);
    const spec = st.spec;
    // ช่องคำนวณด้วยตัวเดียวกับ Dashboard (assets/hist-bins.js): ปัดตามความละเอียดเครื่องชั่ง, ไม่ซ่อนค่า —
    // ค่าที่อยู่ไกลจากกลุ่มหลักรวมเป็นแท่ง "ต่ำกว่า / สูงกว่า" ที่ขอบ, สเปกที่ห่างจากข้อมูลมากไม่บีบกราฟ
    const h = window.computeHistogram(vals, { lsl: spec.lsl, usl: spec.usl, target: spec.target });
    const pad = { l: 58, r: 30, t: 34, b: 40 };
    const R = { x: pad.l, y: pad.t, w: W - pad.l - pad.r, h: H - pad.t - pad.b };
    const leftU = h.below.count ? 1.6 : 0; const rightU = h.above.count ? 1.6 : 0;
    const sw = R.w / (h.bins.length + leftU + rightU);
    const X = (v) => R.x + leftU * sw + ((v - h.lo) / h.width) * sw;
    const maxC = Math.max(h.maxCount, h.below.count, h.above.count, 1);
    const Y = (n) => R.y + R.h - (n / (maxC * 1.12)) * R.h;
    const slots = [];
    if (h.below.count) slots.push({ kind: 'below', a: h.below.min, b: h.lo, n: h.below.count, x0: R.x, x1: R.x + sw });
    h.bins.forEach((n, i) => slots.push({ kind: 'bin', a: h.edges[i], b: h.edges[i + 1], n, x0: X(h.edges[i]), x1: X(h.edges[i + 1]) }));
    if (h.above.count) slots.push({ kind: 'above', a: h.hi, b: h.above.max, n: h.above.count, x0: R.x + R.w - sw, x1: R.x + R.w });
    m._hist = { slots, R, h };
    // grid
    const yt = niceTicks(0, maxC * 1.12, 5);
    ctx.strokeStyle = c.grid; ctx.fillStyle = c.ink3; ctx.textAlign = 'right'; ctx.textBaseline = 'middle';
    ctx.font = `11.5px ${c.font}`;
    for (const t of yt.ticks) { const y = Math.round(Y(t)) + 0.5; ctx.beginPath(); ctx.moveTo(R.x, y); ctx.lineTo(R.x + R.w, y); ctx.stroke(); ctx.fillText(fint(t), R.x - 8, y); }
    // แถบโซน (เฉพาะช่วงที่อยู่บนแกน)
    const ze = h.specInRange ? zoneEdges(spec) : null;
    if (ze) {
      const xMin = X(h.lo); const xMax = X(h.hi);
      const vb = (a, b, col, al) => {
        const xa = Math.max(xMin, X(Math.min(a, b))); const xb = Math.min(xMax, X(Math.max(a, b)));
        if (xb > xa) { ctx.fillStyle = hexA(col, al); ctx.fillRect(xa, R.y, xb - xa, R.h); }
      };
      vb(ze.yLo, ze.yHi, c.good, 0.07); vb(ze.yHi, ze.rHi, c.caution, 0.1); vb(ze.rLo, ze.yLo, c.caution, 0.1);
      vb(ze.rHi, spec.usl, c.red, 0.1); vb(spec.lsl, ze.rLo, c.red, 0.1);
    }
    // bars
    for (const sl of slots) {
      if (!sl.n) continue;
      const y = Y(sl.n); const bw = sl.x1 - sl.x0;
      if (sl.kind === 'bin') {
        const z = classOf((sl.a + sl.b) / 2, spec);
        ctx.fillStyle = z === 'green' ? hexA(c.blueL, 0.85) : z === 'yellow' ? hexA(c.caution, 0.9) : z === 'red' ? hexA(c.red, 0.9) : hexA(c.bad, 0.85);
      } else {
        ctx.fillStyle = hexA(c.bad, 0.95);
      }
      ctx.fillRect(sl.x0 + 1, y, Math.max(1, bw - 2), R.y + R.h - y);
      if (bw >= 22 || sl.kind !== 'bin') {
        ctx.fillStyle = sl.kind === 'bin' ? c.ink2 : c.bad; ctx.font = `600 10.5px ${c.font}`; ctx.textAlign = 'center'; ctx.textBaseline = 'bottom';
        ctx.fillText(fint(sl.n), (sl.x0 + sl.x1) / 2, y - 2);
      }
    }
    // normal curve (เฉพาะช่วงแกนหลัก)
    if (s.sd) {
      ctx.strokeStyle = c.ink2; ctx.lineWidth = 1.6; ctx.beginPath();
      for (let p = 0; p <= 200; p += 1) {
        const v = h.lo + ((h.hi - h.lo) * p) / 200;
        const dens = (vals.length * h.width) * Math.exp(-0.5 * ((v - s.mean) / s.sd) ** 2) / (s.sd * Math.sqrt(2 * Math.PI));
        const x = X(v); const y = Math.max(R.y, Y(dens));
        if (p === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
      }
      ctx.stroke();
    }
    // spec lines
    const vline = (v, color, label, dash) => {
      if (v == null || v < h.lo || v > h.hi) return;
      const x = Math.round(X(v)) + 0.5;
      ctx.save(); ctx.strokeStyle = color; ctx.lineWidth = 1.6; ctx.setLineDash(dash); ctx.beginPath(); ctx.moveTo(x, R.y - 6); ctx.lineTo(x, R.y + R.h); ctx.stroke(); ctx.restore();
      ctx.fillStyle = color; ctx.font = `600 11.5px ${c.font}`; ctx.textAlign = 'center'; ctx.textBaseline = 'bottom'; ctx.fillText(`${label} ${fmt(v)}`, x, R.y - 8);
    };
    vline(spec.lsl, c.bad, 'LSL', []); vline(spec.usl, c.bad, 'USL', []); vline(spec.target, c.orange, 'Target', [5, 4]);
    vline(s.mean, c.ctrl, 'x̄', [2, 3]);
    if (spec.lsl != null && !h.specInRange) {
      ctx.fillStyle = c.bad; ctx.font = `600 11.5px ${c.font}`; ctx.textAlign = 'right'; ctx.textBaseline = 'bottom';
      ctx.fillText(window.t(`สเปก ${fmt(spec.lsl)} – ${fmt(spec.usl)} g อยู่ห่างจากน้ำหนักที่ผลิตจริง`), R.x + R.w, R.y - 8);
    }
    // x axis
    const xt = niceTicks(h.lo, h.hi, Math.max(4, Math.floor((X(h.hi) - X(h.lo)) / 90)));
    ctx.fillStyle = c.ink3; ctx.font = `11.5px ${c.font}`; ctx.textAlign = 'center'; ctx.textBaseline = 'top';
    ctx.strokeStyle = c.line; ctx.beginPath(); ctx.moveTo(R.x, R.y + R.h + 0.5); ctx.lineTo(R.x + R.w, R.y + R.h + 0.5); ctx.stroke();
    for (const t of xt.ticks) ctx.fillText(t.toFixed(decimalsFor(xt.step)), X(t), R.y + R.h + 8);
    ctx.fillStyle = c.bad;
    if (h.below.count) ctx.fillText(`< ${fmt(h.lo, 2)}`, R.x + sw / 2, R.y + R.h + 8);
    if (h.above.count) ctx.fillText(`> ${fmt(h.hi, 2)}`, R.x + R.w - sw / 2, R.y + R.h + 8);
    ctx.fillStyle = c.ink3;
    ctx.fillText(window.t('น้ำหนัก (g)'), R.x + R.w / 2, R.y + R.h + 24);
  }

  // ------------------------------------------------------------------ hover / pick
  function hitIndex(ev) {
    const m = st.model; if (!m) return null;
    const r = cvOver.getBoundingClientRect();
    const x = ev.clientX - r.left; const y = ev.clientY - r.top;
    if (m.kind === 'hist') {
      const h = m._hist; if (!h) return null;
      const i = h.slots.findIndex((sl) => x >= sl.x0 && x < sl.x1);
      return i < 0 ? null : { i, x, y };
    }
    const g = m._geom; if (!g) return null;
    const R = g.L.main;
    if (x < R.x || x > R.x + R.w) return null;
    const i = g.i0 + Math.floor(((x - R.x) / R.w) * (g.i1 - g.i0));
    return { i: Math.max(g.i0, Math.min(g.i1 - 1, i)), x, y };
  }

  function describe(i) {
    const m = st.model; const spec = st.spec;
    if (m.kind === 'hist') {
      const sl = m._hist.slots[i];
      const head = sl.kind === 'below' ? `ต่ำกว่า ${fmt(sl.b, 2)} g` : sl.kind === 'above' ? `สูงกว่า ${fmt(sl.a, 2)} g` : `ช่วง ${fmt(sl.a, 2)} – ${fmt(sl.b, 2)} g`;
      const rows = [['จำนวน', `${fint(sl.n)} ชิ้น`], ['สัดส่วน', pct(sl.n / m.vals.length)]];
      if (sl.kind !== 'bin') {
        const g = sl.kind === 'below' ? m._hist.h.below : m._hist.h.above;
        rows.push(['ค่าในกลุ่มนี้', `${fmt(g.min, 2)} – ${fmt(g.max, 2)} g`]);
      }
      return { head, rows };
    }
    const it = m.items[i];
    if (m.kind === 'candles') {
      const end = nextBucket(it.t);
      const fail = it.over + it.under;
      const cap = capability({ mean: it.mean, sd: it.sd }, spec);
      return {
        head: `${dtm(it.t)} – ${dtm(end)}`,
        rows: [
          ['จำนวนชิ้น', fint(it.n)], ['ผ่าน', `${fint(it.n - fail)} (${pct((it.n - fail) / it.n)})`],
          ['เกิน USL', `${fint(it.over)} (${pct(it.over / it.n)})`], ['ต่ำกว่า LSL', `${fint(it.under)} (${pct(it.under / it.n)})`],
          ['ค่าเฉลี่ย', `${fmt(it.mean, 2)} g`], ['SD', `${fmt(it.sd, 3)} g`], ['ต่ำสุด / สูงสุด', `${fmt(it.min)} / ${fmt(it.max)} g`],
          ['Cpk ช่วงนี้', cap.cpk == null ? '-' : `${fmt(cap.cpk, 2)} (${capText(cap.cpk)})`],
        ],
      };
    }
    if (m.sub) {
      return {
        head: `กลุ่มที่ ${it.seq} (ชิ้นที่ ${fint(it.from)}–${fint(it.from + (st.view === 's' ? 29 : st.view === 'cap' ? 19 : 4))})`,
        rows: [
          [st.view === 'cap' ? 'Cpk' : st.view === 'xbar' ? 'ค่าเฉลี่ยกลุ่ม' : st.view === 'r' ? 'ช่วงกว้าง (R)' : 'SD กลุ่ม', `${fmt(it.v, m.decimals)}${m.unit ? ' ' + m.unit : ''}`],
          ...(st.view === 'cap' ? [['Cp', fmt(it.v2, 2)]] : []),
          ['เวลา', it.t ? dts(it.t) : '-'],
          ['สถานะ', it.cls === 'over' ? 'นอกเกณฑ์' : it.cls === 'warn' ? 'ต้องระวัง' : 'ปกติ'],
        ],
      };
    }
    const label = { green: 'ผ่าน · โซนเขียว', yellow: 'ผ่าน · โซนเหลือง', red: 'ผ่าน · โซนแดง (ใกล้ขอบสเปก)', over: 'เกิน USL (reject)', under: 'ต่ำกว่า LSL (reject)' }[it.cls];
    return {
      head: `ชิ้นที่ ${fint(it.seq)} ในช่วงนี้ · S-${String(it.id).padStart(4, '0')}`,
      rows: [
        ['น้ำหนัก', `${fmt(it.v, 1)} g`], ['เวลา', dts(it.t)],
        ['ห่างจาก Target', spec.target == null ? '-' : `${signed(it.v - spec.target)} g`],
        ['ผล', label],
      ],
      cls: it.cls,
    };
  }

  function nextBucket(t) {
    const tf = st.bucketTf; const d = new Date(t);
    if (!tf) return d;
    if (tf.unit === 'year') d.setFullYear(d.getFullYear() + tf.step);
    else if (tf.unit === 'month') d.setMonth(d.getMonth() + tf.step);
    else d.setTime(d.getTime() + tf.ms);
    return d;
  }

  function drawOverlay(hit) {
    const ctx = ctxOf(cvOver); ctx.clearRect(0, 0, W, H);
    const m = st.model;
    if (!hit || !m) { tip.style.display = 'none'; return; }
    const c = colors();
    ctx.strokeStyle = hexA(c.ink2, 0.45); ctx.setLineDash([3, 3]); ctx.lineWidth = 1;
    let cx = hit.x;
    if (m.kind !== 'hist' && m._geom) {
      const g = m._geom; const R = g.L.main;
      cx = xOf(R, hit.i, g.i0, g.i1);
      const bottom = g.L.vol ? g.L.vol.y + g.L.vol.h : R.y + R.h;
      ctx.beginPath(); ctx.moveTo(Math.round(cx) + 0.5, R.y); ctx.lineTo(Math.round(cx) + 0.5, bottom); ctx.stroke();
      const it = m.items[hit.i]; const v = m.kind === 'candles' ? it.mean : it.v;
      const y = g.Y(v);
      ctx.beginPath(); ctx.moveTo(R.x, Math.round(y) + 0.5); ctx.lineTo(R.x + R.w, Math.round(y) + 0.5); ctx.stroke();
      ctx.setLineDash([]); ctx.fillStyle = c.surface; ctx.strokeStyle = c.blue; ctx.lineWidth = 2;
      ctx.beginPath(); ctx.arc(cx, y, 5, 0, Math.PI * 2); ctx.fill(); ctx.stroke();
      // ป้ายค่าบนแกน Y
      ctx.fillStyle = c.blue; const txt = fmt(v, m.decimals || 2);
      ctx.font = `600 11px ${c.font}`; const tw = ctx.measureText(txt).width + 10;
      ctx.fillRect(R.x - tw - 2, y - 9, tw, 18); ctx.fillStyle = '#fff'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle'; ctx.fillText(txt, R.x - tw / 2 - 2, y);
    } else if (m._hist) {
      const h = m._hist; const sl = h.slots[hit.i];
      ctx.setLineDash([]); ctx.fillStyle = hexA(c.ink2, 0.12);
      ctx.fillRect(sl.x0, h.R.y, sl.x1 - sl.x0, h.R.h);
      cx = (sl.x0 + sl.x1) / 2;
    }
    const d = describe(hit.i);
    tip.innerHTML = `<div class="t-head">${esc(d.head)}</div>${d.rows.map((r) => `<div class="row"><span>${esc(r[0])}</span><b>${esc(r[1])}</b></div>`).join('')}`;
    tip.style.display = 'block';
    const tw = tip.offsetWidth; const th = tip.offsetHeight;
    let left = cx + 16; if (left + tw > W - 8) left = cx - tw - 16;
    let top = hit.y - th / 2; top = Math.max(8, Math.min(H - th - 8, top));
    tip.style.left = `${Math.max(8, left)}px`; tip.style.top = `${top}px`;
  }

  function renderPicked() {
    const el = $('picked');
    if (st.picked == null || !st.model || (st.model.items && !st.model.items[st.picked] && st.model.kind !== 'hist')) {
      el.innerHTML = '<span class="muted">คลิกจุดหรือแท่งบนกราฟเพื่อดูรายละเอียด</span>';
      return;
    }
    const d = describe(st.picked);
    el.innerHTML = `<div class="row"><b style="text-align:left">${esc(d.head)}</b></div>${d.rows.map((r) => `<div class="row"><span>${esc(r[0])}</span><b>${esc(r[1])}</b></div>`).join('')}`;
  }

  // ------------------------------------------------------------------ zoom / pan
  function setZoom(i0, i1) {
    const m = st.model; if (!m || !m.items) return;
    const n = m.items.length;
    const minWin = Math.min(n, 8);
    let a = Math.round(i0); let b = Math.round(i1);
    if (b - a < minWin) { const mid = (a + b) / 2; a = Math.round(mid - minWin / 2); b = a + minWin; }
    if (a < 0) { b -= a; a = 0; }
    if (b > n) { a -= b - n; b = n; }
    st.zoom = { i0: Math.max(0, a), i1: Math.min(n, b) };
    draw();
  }
  function zoomBy(f, pivotFrac) {
    const m = st.model; if (!m || !m.items) return;
    const { i0, i1 } = visibleRange(m);
    const span = i1 - i0; const ns = span / f;
    const p = i0 + span * (pivotFrac ?? 0.5);
    setZoom(p - ns * (pivotFrac ?? 0.5), p + ns * (1 - (pivotFrac ?? 0.5)));
  }
  function updateZoomLabel() {
    const m = st.model;
    if (!m || !m.items || !m.items.length) { $('zLvl').textContent = '100%'; return; }
    const { i0, i1, n } = visibleRange(m);
    $('zLvl').textContent = `${Math.round((n / Math.max(1, i1 - i0)) * 100)}%`;
  }

  let drag = null;
  cvOver.addEventListener('wheel', (e) => {
    const m = st.model; if (!m || m.kind === 'hist') return;
    e.preventDefault();
    const g = m._geom; if (!g) return;
    const r = cvOver.getBoundingClientRect(); const R = g.L.main;
    const frac = Math.max(0, Math.min(1, (e.clientX - r.left - R.x) / R.w));
    zoomBy(e.deltaY < 0 ? 1.3 : 1 / 1.3, frac);
  }, { passive: false });
  cvOver.addEventListener('pointerdown', (e) => {
    const m = st.model; if (!m || m.kind === 'hist' || !m._geom) return;
    drag = { x: e.clientX, i0: m._geom.i0, i1: m._geom.i1, moved: false };
    cvOver.setPointerCapture(e.pointerId);
  });
  cvOver.addEventListener('pointermove', (e) => {
    const m = st.model;
    if (drag && m && m._geom) {
      const dx = e.clientX - drag.x;
      if (Math.abs(dx) > 3) { drag.moved = true; cvOver.classList.add('panning'); }
      if (drag.moved) {
        const per = (drag.i1 - drag.i0) / m._geom.L.main.w;
        setZoom(drag.i0 - dx * per, drag.i1 - dx * per);
        drawOverlay(null);
        return;
      }
    }
    drawOverlay(hitIndex(e));
  });
  cvOver.addEventListener('pointerup', (e) => {
    const wasDrag = drag && drag.moved;
    drag = null; cvOver.classList.remove('panning');
    if (!wasDrag) { const h = hitIndex(e); if (h) { st.picked = h.i; renderPicked(); } }
  });
  cvOver.addEventListener('pointerleave', () => { if (!drag) drawOverlay(null); });
  cvOver.addEventListener('dblclick', () => { st.zoom = { i0: 0, i1: 0 }; draw(); });
  $('zIn').addEventListener('click', () => zoomBy(1.6));
  $('zOut').addEventListener('click', () => zoomBy(1 / 1.6));
  $('zReset').addEventListener('click', () => { st.zoom = { i0: 0, i1: 0 }; draw(); });
  document.addEventListener('keydown', (e) => {
    if (e.target.closest('input, select, textarea')) return;
    const m = st.model; if (!m || !m.items || st.picked == null) return;
    if (e.key === 'ArrowRight' && st.picked < m.items.length - 1) { st.picked += 1; renderPicked(); }
    if (e.key === 'ArrowLeft' && st.picked > 0) { st.picked -= 1; renderPicked(); }
  });

  function showMsg(t) { $('chartMsg').textContent = t; $('chartMsg').classList.add('show'); }
  function hideMsg() { $('chartMsg').classList.remove('show'); }

  // ------------------------------------------------------------------ side panel
  function summary() {
    const spec = st.spec;
    let s; let over = 0; let under = 0; let note = '';
    if (st.raw.length && (st.view !== 'trend' || !st.bucketTf)) {
      const vals = st.raw.map((r) => r.w);
      s = stats(vals);
      if (spec.usl != null) over = vals.filter((v) => v > spec.usl).length;
      if (spec.lsl != null) under = vals.filter((v) => v < spec.lsl).length;
      if (st.rawTruncated) note = `ช่วงนี้มีข้อมูลมากกว่าที่ดึงได้ — แสดง ${fint(st.raw.length)} ชิ้นล่าสุด (เลือก "แท่งละ" 1 นาทีขึ้นไปเพื่อดูครบทั้งช่วง)`;
    } else {
      const r = statsFromBuckets(st.buckets); s = r.s; over = r.over; under = r.under;
      note = 'คำนวณจากข้อมูลรายแท่งของทุกชิ้นในช่วงนี้';
    }
    const cap = capability(s, spec);
    return { s, cap, over, under, pass: s.n - over - under, note };
  }

  function renderSide() {
    const { s, cap, over, under, pass, note } = summary();
    const n = s.n || 0;
    $('sumGrid').innerHTML = [
      ['จำนวนชิ้น', fint(n), ''], ['ค่าเฉลี่ย', s.mean == null ? '-' : `${fmt(s.mean, 2)} g`, ''],
      ['SD', s.sd == null ? '-' : `${fmt(s.sd, 3)} g`, ''], ['ต่ำสุด / สูงสุด', s.min == null ? '-' : `${fmt(s.min)} / ${fmt(s.max)}`, ''],
      ['Cp', fmt(cap.cp, 2), capLevel(cap.cp)], ['Cpk', fmt(cap.cpk, 2), capLevel(cap.cpk)],
    ].map(([a, b, c]) => `<div class="${c}"><span>${a}</span><b>${b}</b></div>`).join('');
    const c = colors();
    const seg = (v, col) => (n && v ? `<div style="width:${(v / n) * 100}%; background:${col}"></div>` : '');
    $('yieldBar').innerHTML = seg(pass, c.good) + seg(over, c.bad) + seg(under, c.orange);
    $('yieldLegend').innerHTML = `
      <span><i style="background:${c.good}"></i>ผ่าน ${fint(pass)} (${pct(n ? pass / n : null)})</span>
      <span><i style="background:${c.bad}"></i>เกิน USL ${fint(over)} (${pct(n ? over / n : null)})</span>
      <span><i style="background:${c.orange}"></i>ต่ำกว่า LSL ${fint(under)} (${pct(n ? under / n : null)})</span>`;
    $('srcNote').textContent = [periodText(), note].filter(Boolean).join(' · ');
    renderInsights(s, cap, over, under);
    renderGuide();
    renderPicked();
  }

  function periodText() {
    if (!st.from || !st.to) return '';
    return `${dtm(st.from)} – ${dtm(st.to)}`;
  }

  function renderInsights(s, cap, over, under) {
    const spec = st.spec; const out = [];
    const add = (level, text) => out.push({ level, text });
    if (!s.n) { add('info', 'ไม่มีข้อมูลในช่วงเวลานี้ — ลองเลือกช่วงเวลาอื่น หรือดูว่าเครื่องเชื่อมต่ออยู่หรือไม่'); return paint(); }
    if (spec.lsl == null || spec.usl == null) add('info', 'ยังไม่มีสเปก (LSL / USL) — ใส่ค่าในกล่อง "สเปกที่ใช้คำนวณ" เพื่อดู Cp / Cpk และผ่าน / ไม่ผ่าน');
    else {
      const n = s.n;
      if (cap.cpk != null) {
        if (cap.cpk >= 1.33) add('good', `Cpk ${fmt(cap.cpk, 2)} อยู่ในเกณฑ์ดี (≥ 1.33) — กระบวนการควบคุมน้ำหนักได้มั่นคง มีระยะเผื่อจากขอบสเปกเพียงพอ`);
        else if (cap.cpk >= 1) add('warn', `Cpk ${fmt(cap.cpk, 2)} อยู่ในเกณฑ์พอใช้ (1.00–1.33) — ยังอยู่ในสเปกแต่ระยะเผื่อน้อย ควรเฝ้าระวัง`);
        else add('bad', `Cpk ${fmt(cap.cpk, 2)} ต่ำกว่า 1.00 — กระบวนการไม่สามารถผลิตให้อยู่ในสเปกได้สม่ำเสมอ มีโอกาสหลุดสเปกสูง`);
      }
      if (spec.target != null && s.sd) {
        const off = s.mean - spec.target; const tol = (spec.usl - spec.lsl) / 2;
        if (Math.abs(off) >= tol * 0.15) {
          add(Math.abs(off) >= tol * 0.4 ? 'bad' : 'warn',
            `ค่าเฉลี่ย${off > 0 ? 'สูง' : 'ต่ำ'}กว่า Target ${fmt(Math.abs(off), 2)} g — ถ้าปรับน้ำหนักเติม${off > 0 ? 'ลง' : 'ขึ้น'} ประมาณ ${fmt(Math.abs(off), 1)} g ให้ตรง Target, Cpk จะขึ้นไปใกล้ ${fmt(cap.cp, 2)}`);
        } else add('good', `ค่าเฉลี่ยใกล้ Target (ห่าง ${signed(off)} g) — การตั้งน้ำหนักเติมอยู่กึ่งกลางสเปกแล้ว`);
      }
      if (cap.cp != null && cap.cp < 1) add('bad', `Cp ${fmt(cap.cp, 2)} < 1.00 — การกระจายของน้ำหนักกว้างกว่าช่วงสเปก แม้ปรับค่าเฉลี่ยให้ตรงกลางแล้วก็ยังหลุด ต้องลดความแปรปรวน (ตรวจเครื่องเติม, หัวฉีด, วัตถุดิบ, ความเร็วไลน์)`);
      const fail = over + under;
      if (fail === 0) add('good', `ทุกชิ้นอยู่ในสเปก (${fint(n)} ชิ้น)`);
      else {
        add(fail / n > 0.02 ? 'bad' : 'warn', `ไม่ผ่าน ${fint(fail)} ชิ้น (${pct(fail / n, 2)}) — เกิน USL ${fint(over)} · ต่ำกว่า LSL ${fint(under)}`);
        if (under > 0) add('bad', `มีชิ้นน้ำหนักขาด ${fint(under)} ชิ้น — เสี่ยงต่อการร้องเรียนจากลูกค้าและกฎหมายฉลาก ควรคัดออกและหาสาเหตุ`);
        if (over > under * 3 && over > 0) add('warn', `ส่วนใหญ่ที่ไม่ผ่านเป็นน้ำหนักเกิน — เป็นต้นทุนวัตถุดิบที่เสียไป ลองลดน้ำหนักเติมลงเล็กน้อย`);
      }
      if (spec.target != null && s.mean > spec.target) {
        const give = (s.mean - spec.target) * n;
        add('info', `ให้น้ำหนักเกิน Target เฉลี่ย ${fmt(s.mean - spec.target, 2)} g/ชิ้น รวมประมาณ ${fmt(give / 1000, 2)} kg ในช่วงนี้ (Giveaway)`);
      }
    }
    // ความเสถียร (เฉพาะข้อมูลรายชิ้น)
    const m = st.model;
    if (m && m.kind === 'points' && m.items.length >= 9 && m.centre != null) {
      let beyond = 0; let run = 0; let maxRun = 0; let side = 0; let trendRun = 1; let maxTrend = 1; let dir = 0;
      m.items.forEach((it, i) => {
        if (m.ucl != null && (it.v > m.ucl || it.v < m.lcl)) beyond += 1;
        const sd = it.v > m.centre ? 1 : it.v < m.centre ? -1 : 0;
        run = sd !== 0 && sd === side ? run + 1 : sd !== 0 ? 1 : 0; side = sd; maxRun = Math.max(maxRun, run);
        if (i > 0) {
          const d = Math.sign(it.v - m.items[i - 1].v);
          trendRun = d !== 0 && d === dir ? trendRun + 1 : 2; dir = d; maxTrend = Math.max(maxTrend, trendRun);
        }
      });
      if (beyond) add(beyond / m.items.length > 0.01 ? 'warn' : 'info', `มี ${fint(beyond)} ${m.sub ? 'กลุ่ม' : 'จุด'}อยู่นอกเส้นควบคุม (UCL/LCL) — เป็นสัญญาณว่ามีสาเหตุพิเศษ ควรดูช่วงเวลาที่เกิด`);
      if (maxRun >= 9) add('warn', `มีจุดอยู่ฝั่งเดียวกันของเส้นกลางติดกัน ${maxRun} จุด — ค่าเฉลี่ยน่าจะเลื่อน (เช่นเปลี่ยนล็อตวัตถุดิบ / ปรับเครื่อง)`);
      if (maxTrend >= 7) add('warn', `มีจุดเพิ่มขึ้นหรือลดลงต่อเนื่อง ${maxTrend} จุด — มีแนวโน้มค่อย ๆ เปลี่ยน (เช่นเครื่องร้อนขึ้น / วัตถุดิบเปลี่ยน)`);
      if (!beyond && maxRun < 9 && maxTrend < 7) add('good', 'ไม่พบสัญญาณผิดปกติตามกฎ SPC (นอกเส้นควบคุม / เลื่อน / แนวโน้ม)');
    }
    if (m && m.kind === 'candles' && m.items.length > 1) {
      const worst = m.items.reduce((a, b) => ((b.over + b.under) / b.n > (a.over + a.under) / a.n ? b : a));
      const wr = (worst.over + worst.under) / worst.n;
      if (wr > 0) add('warn', `ช่วงที่หลุดสเปกมากที่สุด: ${dtm(worst.t)} (${pct(wr)} จาก ${fint(worst.n)} ชิ้น) — คลิกแท่งนั้นเพื่อดูรายละเอียด`);
      if (st.bucketTf && st.bucketTf.unit === 'hour' && m.items.length >= 24) {
        const byHour = new Map();
        for (const b of m.items) { const h = b.t.getHours(); const o = byHour.get(h) || { n: 0, f: 0 }; o.n += b.n; o.f += b.over + b.under; byHour.set(h, o); }
        const arr = Array.from(byHour, ([h, o]) => ({ h, r: o.f / o.n })).sort((a, b) => b.r - a.r);
        if (arr[0] && arr[0].r > 0) add('info', `ช่วงเวลาของวันที่หลุดสเปกบ่อยสุด: ${p2(arr[0].h)}:00–${p2((arr[0].h + 1) % 24)}:00 (${pct(arr[0].r)}) — อาจเกี่ยวกับการเปลี่ยนกะ / พักเบรก / เปลี่ยนล็อต`);
      }
      const first = m.items[0].mean; const last = m.items[m.items.length - 1].mean;
      if (Math.abs(last - first) > (s.sd || 0) * 0.5) add('info', `ค่าเฉลี่ย${last > first ? 'เพิ่มขึ้น' : 'ลดลง'}จาก ${fmt(first, 2)} เป็น ${fmt(last, 2)} g ตลอดช่วงที่เลือก`);
    }
    paint();
    function paint() {
      const iconFor = { good: 'ok', warn: 'alert', bad: 'alert', info: 'info' };
      $('insights').innerHTML = out.map((o) => `<li class="${o.level}">${ic(iconFor[o.level])}<span>${esc(o.text)}</span></li>`).join('');
    }
  }

  const GUIDES = {
    trend: () => (st.bucketTf
      ? `<p>แต่ละแท่ง = น้ำหนักของทุกชิ้นใน ${esc(st.bucketTf.label)} (คล้ายกราฟหุ้น)</p><ul>
          <li><b>เส้นตั้ง (ไส้)</b> = น้ำหนักต่ำสุด–สูงสุดในช่วงนั้น</li>
          <li><b>ตัวแท่ง</b> = ค่าเฉลี่ย ± 1 SD (ขีดขาวกลางแท่ง = ค่าเฉลี่ย)</li>
          <li><b>สีแท่ง</b>: เขียว = ไม่มีชิ้นหลุดสเปก · ส้ม = หลุดไม่เกิน 2% · แดง = หลุดเกิน 2%</li>
          <li><b>แท่งด้านล่าง</b> = จำนวนชิ้นที่ผลิต (ส่วนสีแดง = ไม่ผ่าน)</li>
          <li>เลื่อนเมาส์เพื่อดูตัวเลข · หมุนล้อเมาส์เพื่อซูม · ลากเพื่อเลื่อน · ดับเบิลคลิกเพื่อดูทั้งช่วง</li></ul>`
      : `<p>แต่ละจุด = น้ำหนักของ 1 ชิ้น เรียงตามเวลา</p><ul>
          <li><b>เส้นแดง</b> = LSL / USL (ช่วงที่ผ่าน) · <b>เส้นส้ม</b> = Target</li>
          <li><b>เส้นประน้ำเงินเทา</b> = ค่าเฉลี่ย (x̄) และเส้นควบคุม UCL / LCL (x̄ ± 2.66 × MR̄)</li>
          <li>แถบสีและสีจุด = โซน <b>เขียว</b> (ใกล้ Target) · <b>เหลือง</b> (เริ่มห่าง) · <b>แดง</b> (ใกล้ขอบสเปก) · จุดแดงเข้มนอกเส้น LSL/USL = <b>หลุดสเปก (reject)</b> — ขนาดโซนตั้งที่หน้า "ตั้งค่า"</li>
          <li>ซูมเข้าจนจุดห่างกันพอ จะเห็นน้ำหนักของแต่ละชิ้นและเลขลำดับชิ้นบนกราฟ</li>
          <li>กฎ SPC ที่ระบบตรวจ: จุดนอกเส้นควบคุม, จุดฝั่งเดียวกันติดกัน ≥ 9 จุด, ขึ้น/ลงต่อเนื่อง ≥ 7 จุด</li></ul>`),
    hist: () => `<p>แท่ง = จำนวนชิ้นในแต่ละช่วงน้ำหนัก (ตัวเลขบนแท่ง = จำนวนชิ้น)</p><ul>
          <li>รูปร่างที่ดี: ระฆังคว่ำ อยู่กลางระหว่าง LSL–USL และยอดอยู่ใกล้ Target</li>
          <li>เส้นโค้ง = การแจกแจงปกติจากค่าเฉลี่ยและ SD จริง ถ้าแท่งไม่เข้ากับเส้น อาจมีหลายล็อต/หลายหัวเติมปนกัน</li>
          <li>สีแท่ง = โซนเขียว / เหลือง / แดง และสีแดงเข้ม = หลุดสเปก (reject) · เส้นประ x̄ = ค่าเฉลี่ยจริง เทียบกับ Target</li>
          <li>เบ้ไปทางซ้าย = มีชิ้นขาดน้ำหนัก, เบ้ไปทางขวา = ให้ของเกิน</li></ul>`,
    xbar: () => `<p>แต่ละจุด = ค่าเฉลี่ยของ 5 ชิ้นติดกัน ใช้ดูว่า "ค่ากลาง" ของกระบวนการเลื่อนหรือไม่</p><ul>
          <li>เส้นกลาง X̄̄ = ค่าเฉลี่ยรวม · UCL / LCL = X̄̄ ± 0.577 × R̄</li>
          <li>จุดหลุดเส้นควบคุม = มีสาเหตุพิเศษ (ปรับเครื่อง, เปลี่ยนวัตถุดิบ ฯลฯ)</li>
          <li>ดูคู่กับ R Chart เสมอ — ถ้า R Chart ผิดปกติ เส้นควบคุมของ X̄ จะเชื่อถือไม่ได้</li></ul>`,
    r: () => `<p>แต่ละจุด = ช่วงกว้าง (สูงสุด − ต่ำสุด) ของ 5 ชิ้นติดกัน ใช้ดูความสม่ำเสมอระยะสั้น</p><ul>
          <li>เส้นกลาง R̄ = ช่วงกว้างเฉลี่ย · UCL = 2.114 × R̄</li>
          <li>จุดสูงเกิน UCL = มีบางชิ้นต่างจากชิ้นข้างเคียงมาก (เช่นหัวเติมบางหัวมีปัญหา)</li></ul>`,
    s: () => `<p>แต่ละจุด = SD ของ 30 ชิ้นติดกัน ใช้ดูความแปรปรวนเมื่อกลุ่มใหญ่</p><ul>
          <li>ค่ายิ่งต่ำยิ่งดี (น้ำหนักสม่ำเสมอ) · เส้นควบคุมคำนวณจาก S̄ และค่าคงที่ B3 / B4</li>
          <li>SD สูงขึ้นเป็นช่วง ๆ = เครื่องเริ่มไม่นิ่ง ควรตรวจสอบ</li></ul>`,
    cap: () => `<p>แต่ละจุด = Cpk (เส้นทึบ) และ Cp (เส้นประ) ของกลุ่มละ 20 ชิ้น</p><ul>
          <li><b>≥ 1.33</b> ดี · <b>1.00–1.33</b> พอใช้ · <b>&lt; 1.00</b> ไม่ดี</li>
          <li>Cp = ความสามารถถ้าค่าเฉลี่ยอยู่กลางสเปกพอดี · Cpk = ความสามารถจริง (นับการเยื้องของค่าเฉลี่ย)</li>
          <li>Cp สูงแต่ Cpk ต่ำ = ค่าเฉลี่ยเยื้อง ปรับน้ำหนักเติมให้ตรง Target ได้</li></ul>`,
  };
  function renderGuide() { $('guide').innerHTML = GUIDES[st.view](); }

  function renderFoot() {
    const c = colors(); const m = st.model;
    const parts = [];
    if (m && m.kind === 'hist') {
      parts.push(`<span><i style="background:${c.blueL}"></i>โซนเขียว</span>`, `<span><i style="background:${c.caution}"></i>โซนเหลือง</span>`, `<span><i style="background:${c.red}"></i>โซนแดง</span>`, `<span><i style="background:${c.bad}"></i>หลุดสเปก (reject)</span>`, `<span><i style="background:${c.ink2}"></i>เส้นการแจกแจงปกติ</span>`);
    } else if (m && m.kind === 'candles') {
      parts.push(`<span><i style="background:${c.good}"></i>ไม่หลุดสเปก</span>`, `<span><i style="background:${c.orange}"></i>หลุด ≤ 2%</span>`, `<span><i style="background:${c.bad}"></i>หลุด &gt; 2%</span>`, `<span><i style="background:${c.blueL}"></i>ค่าเฉลี่ย</span>`);
    } else {
      if (st.view === 'trend') parts.push(`<span><i style="background:${c.good}"></i>โซนเขียว</span>`, `<span><i style="background:${c.caution}"></i>โซนเหลือง</span>`, `<span><i style="background:${c.red}"></i>โซนแดง</span>`, `<span><i style="background:${c.bad}"></i>หลุดสเปก (reject)</span>`);
      else parts.push(`<span><i style="background:${c.blue}"></i>ค่าจริง</span>`, `<span><i style="background:${c.bad}"></i>นอกเส้นควบคุม</span>`);
      parts.push(`<span><i class="dash" style="border-color:${c.orange}"></i>Target / 1.33</span>`, `<span><i class="dash" style="border-color:${c.ctrl}"></i>เส้นกลาง / เส้นควบคุม</span>`);
    }
    parts.push('<span class="hint">ล้อเมาส์ = ซูม · ลาก = เลื่อน · คลิก = เลือกจุด · ดับเบิลคลิก = ทั้งช่วง</span>');
    $('chartFoot').innerHTML = parts.join('');
  }

  // ------------------------------------------------------------------ controls
  function segHtml(list, active, disabled) {
    return list.map((o) => `<button type="button" data-k="${o.key}" class="${o.key === active ? 'active' : ''}" ${disabled && disabled(o) ? 'disabled' : ''}>${esc(o.label)}</button>`).join('');
  }
  function periodMs() {
    if (st.from && st.to) return st.to - st.from;
    const p = PERIODS.find((x) => x.key === st.period);
    return p && p.ms ? p.ms : 12 * 3600e3;
  }
  function autoTf() {
    if (st.sessionId) return 'raw';
    const ms = periodMs();
    if (ms <= 3600e3 * 1.01) return 'raw';
    if (ms <= 13 * 3600e3) return '5m';
    if (ms <= 2 * 86400e3) return '15m';
    if (ms <= 8 * 86400e3) return '1h';
    if (ms <= 32 * 86400e3) return '1d';
    return '1M';
  }
  function effectiveTf() { return st.tf === 'auto' ? autoTf() : st.tf; }
  function renderControls() {
    $('viewSeg').innerHTML = segHtml(VIEWS, st.view);
    $('periodSeg').innerHTML = segHtml(PERIODS, st.period);
    $('periodGroup').style.display = st.sessionId ? 'none' : '';
    $('customBox').classList.toggle('open', st.period === 'custom' && !st.sessionId);
    const ms = periodMs(); const tf = effectiveTf();
    $('tfSeg').innerHTML = segHtml(TFS, tf, (o) => o.ms && ms / o.ms > MAX_BUCKETS);
    $('tfGroup').style.display = st.view === 'trend' ? '' : 'none';
  }

  function computeWindow() {
    if (st.sessionId && st.session) {
      st.from = new Date(st.session.start_time);
      st.to = st.session.end_time ? new Date(st.session.end_time) : new Date();
      return;
    }
    if (st.period === 'custom') {
      const f = new Date($('fromInp').value); const t = new Date($('toInp').value);
      if (!Number.isNaN(f.getTime()) && !Number.isNaN(t.getTime()) && t > f) { st.from = f; st.to = t; }
      if (!st.from || !st.to) { st.to = new Date(); st.from = new Date(st.to - 3600e3); }
      return;
    }
    const now = new Date();
    if (st.period === 'shift') { st.from = shiftStart(now); st.to = now; return; }
    const p = PERIODS.find((x) => x.key === st.period) || PERIODS[1];
    st.from = new Date(now - p.ms); st.to = now;
  }

  function syncUrl() {
    const q = new URLSearchParams();
    if (st.sessionId) q.set('session', st.sessionId); else q.set('scale', st.scaleId);
    q.set('view', st.view);
    if (!st.sessionId) {
      q.set('range', st.period);
      if (st.period === 'custom' && st.from && st.to) { q.set('from', localIso(st.from).slice(0, 16)); q.set('to', localIso(st.to).slice(0, 16)); }
    }
    if (st.tf !== 'auto') q.set('tf', st.tf);
    history.replaceState(null, '', `?${q.toString()}`);
  }

  // ------------------------------------------------------------------ data
  // สเปกเอกสารกับโปรแกรมบนเครื่องไม่ตรงกัน (เช่น เอกสาร Target 103 g แต่เครื่องเดิน 73 g) → ให้เลือกได้ จำร่วมกับหน้า Dashboard
  const specPrefKey = () => `spec_src_${st.scaleId}`;
  function specPref() { try { return localStorage.getItem(specPrefKey()) === 'machine' ? 'machine' : 'doc'; } catch (e) { return 'doc'; } }
  function specMismatch(d, m) {
    if (!d || !m || d.target == null || m.target == null) return false;
    const half = Math.max(0.5, (m.usl - m.lsl) / 2);
    return Math.abs(d.target - m.target) > half || d.usl < m.lsl || d.lsl > m.usl;
  }
  async function resolveSpec() {
    const sc = st.scales.find((s) => s.scale_id === st.scaleId);
    let doc = null; let docSrc = '';
    if (st.session && st.session.nw_target != null) {
      doc = { lsl: st.session.nw_lcl, target: st.session.nw_target, usl: st.session.nw_ucl };
      docSrc = `จากเอกสาร #${st.session.id} (${st.session.product_code || ''})`;
    } else {
      try {
        const run = await api(`/api/sessions?scaleId=${st.scaleId}&status=running&pageSize=1`);
        const s = run.rows && run.rows[0];
        if (s && s.nw_target != null) { doc = { lsl: s.nw_lcl, target: s.nw_target, usl: s.nw_ucl }; docSrc = `จากเอกสารที่กำลังทำ #${s.id} (${s.product_code})`; }
      } catch (e) { console.error('resolveSpec running session:', e); }
    }
    const L = sc && sc.cw && sc.cw.limits;
    // ดูเอกสารย้อนหลัง: โปรแกรมบนเครื่องตอนนี้อาจไม่ใช่ของงานนั้น จึงไม่เทียบ
    const mach = !st.sessionId && L && L.target != null ? { lsl: L.lo, target: L.target, usl: L.hi } : null;
    const machSrc = `จากโปรแกรมบนเครื่อง${sc && sc.cw && sc.cw.program_name ? ` (No.${sc.cw.program_no ?? '-'} ${sc.cw.program_name})` : ''}`;
    st.specChoice = specMismatch(doc, mach) ? { doc, mach } : null;
    let spec = null; let source = '';
    if (doc && !(st.specChoice && specPref() === 'machine')) { spec = doc; source = docSrc; }
    else if (mach) { spec = mach; source = machSrc; }
    st.spec = Object.assign({ lsl: null, target: null, usl: null }, spec || {}, { source: source || 'ยังไม่มีสเปก — ใส่เองได้' });
    $('specL').value = st.spec.lsl ?? ''; $('specT').value = st.spec.target ?? ''; $('specU').value = st.spec.usl ?? '';
    $('specNote').textContent = `${st.spec.source} · แก้ตัวเลขเพื่อทดลองดูผลได้ (ไม่บันทึกลงระบบ)`;
    const box = $('specChoice');
    if (box) {
      if (st.specChoice) {
        const f = (x) => `Target ${fmt(x.target)} (${fmt(x.lsl)}–${fmt(x.usl)})`;
        const useM = spec === mach;
        box.innerHTML = `<div class="sc-warn">${ic('alert', 'sm')}สเปกเอกสาร ${esc(f(doc))} ไม่ตรงกับเครื่อง ${esc(f(mach))}</div>
          <div class="seg sc-seg"><button type="button" data-spec="doc" class="${useM ? '' : 'active'}">สเปกเอกสาร</button><button type="button" data-spec="machine" class="${useM ? 'active' : ''}">สเปกเครื่อง</button></div>`;
        box.querySelectorAll('[data-spec]').forEach((b) => b.addEventListener('click', async () => {
          try { localStorage.setItem(specPrefKey(), b.dataset.spec); } catch (e) { /* จำไม่ได้ก็ใช้ได้รอบนี้ */ }
          await resolveSpec(); load({ quiet: true });
        }));
        box.hidden = false;
      } else { box.hidden = true; box.innerHTML = ''; }
    }
  }

  let reqSeq = 0;
  async function load(opts) {
    const quiet = !!(opts && opts.quiet);
    const my = ++reqSeq;
    computeWindow();
    renderControls();
    syncUrl();
    if (!quiet) showMsg('กำลังโหลดข้อมูล…');
    st.error = null;
    const tfKey = effectiveTf();
    const tf = TFS.find((t) => t.key === tfKey);
    const useBuckets = st.view === 'trend' && tf && tf.unit;
    try {
      if (useBuckets) {
        const q = new URLSearchParams({ scaleId: st.scaleId, from: localIso(st.from), to: localIso(st.to), unit: tf.unit, step: tf.step });
        if (st.spec.lsl != null) q.set('lsl', st.spec.lsl);
        if (st.spec.usl != null) q.set('usl', st.spec.usl);
        const data = await api(`/api/analytics/buckets?${q.toString()}`);
        if (my !== reqSeq) return;
        st.buckets = (data.rows || []).map((r) => ({ t: new Date(r.bucket), n: r.n, mean: r.mean, sd: r.sd, min: r.min, max: r.max, over: r.over, under: r.under }));
        st.bucketTf = tf;
      } else {
        st.bucketTf = null;
        let rows;
        if (st.sessionId) {
          const data = await api(`/api/sessions/${st.sessionId}/weights?limit=${SESSION_LIMIT}`);
          rows = data.rows || []; st.rawTruncated = rows.length >= SESSION_LIMIT;
        } else {
          const data = await api(`/api/weights/range?scaleId=${st.scaleId}&from=${encodeURIComponent(localIso(st.from))}&to=${encodeURIComponent(localIso(st.to))}&limit=${RAW_LIMIT}`);
          rows = data.rows || []; st.rawTruncated = rows.length >= RAW_LIMIT;
        }
        if (my !== reqSeq) return;
        st.raw = rows.map((r) => ({ id: r.id, w: Number(r.weight), t: new Date(r.time_stamp) })).filter((r) => Number.isFinite(r.w));
      }
    } catch (err) {
      if (my !== reqSeq) return;
      st.error = err.message;
    }
    rebuild(!quiet);
  }

  function rebuild(resetZoom) {
    if (resetZoom) { st.zoom = { i0: 0, i1: 0 }; st.picked = null; }
    st.model = st.error ? null : buildModel();
    $('chartTitle').textContent = st.model ? st.model.title : 'โหลดข้อมูลไม่สำเร็จ';
    const count = st.model && st.model.kind === 'candles' ? `${fint(st.buckets.length)} แท่ง` : `${fint(st.raw.length)} ชิ้น`;
    $('chartMeta').textContent = st.model ? `${count} · ${periodText()}` : '';
    renderFoot();
    document.querySelector('.chart-head .tools').style.visibility = st.model && st.model.kind === 'hist' ? 'hidden' : '';
    if (st.error) { showMsg(`โหลดข้อมูลไม่สำเร็จ: ${st.error}`); renderSide(); return; }
    draw();
    renderSide();
  }

  // ------------------------------------------------------------------ events
  $('viewSeg').addEventListener('click', (e) => {
    const b = e.target.closest('button[data-k]'); if (!b) return;
    const prevNeedsRaw = st.view !== 'trend' || !st.bucketTf;
    st.view = b.dataset.k;
    const needsRaw = st.view !== 'trend' || effectiveTf() === 'raw';
    if (prevNeedsRaw && needsRaw && st.raw.length) { renderControls(); syncUrl(); rebuild(true); } else load();
  });
  $('periodSeg').addEventListener('click', (e) => {
    const b = e.target.closest('button[data-k]'); if (!b) return;
    st.period = b.dataset.k; st.tf = 'auto';
    if (st.period === 'custom') {
      const now = new Date();
      if (!$('fromInp').value) $('fromInp').value = localIso(shiftStart(now)).slice(0, 16);
      if (!$('toInp').value) $('toInp').value = localIso(now).slice(0, 16);
      renderControls();
      return;
    }
    load();
  });
  $('btnApply').addEventListener('click', () => { st.from = null; st.to = null; load(); });
  $('tfSeg').addEventListener('click', (e) => {
    const b = e.target.closest('button[data-k]'); if (!b || b.disabled) return;
    st.tf = b.dataset.k; load();
  });
  $('selScale').addEventListener('change', () => {
    st.scaleId = Number($('selScale').value); st.sessionId = null; st.session = null;
    $('docBadge').classList.remove('show');
    resolveSpec().then(load);
    updateTitle();
  });
  for (const id of ['specL', 'specT', 'specU']) {
    $(id).addEventListener('change', () => {
      const v = (x) => (x.value === '' ? null : Number(x.value));
      st.spec.lsl = v($('specL')); st.spec.target = v($('specT')); st.spec.usl = v($('specU'));
      if (st.view === 'trend' && st.bucketTf) load(); else rebuild(false);
    });
  }
  $('btnFull').addEventListener('click', () => {
    if (document.fullscreenElement) document.exitFullscreen();
    else if (document.documentElement.requestFullscreen) document.documentElement.requestFullscreen();
  });
  document.addEventListener('fullscreenchange', () => requestAnimationFrame(draw));
  $('btnCsv').addEventListener('click', () => {
    let lines;
    if (st.model && st.model.kind === 'candles') {
      lines = ['time,pieces,mean_g,sd_g,min_g,max_g,over_usl,under_lsl', ...st.buckets.map((b) => [localIso(b.t), b.n, fmt(b.mean, 3), fmt(b.sd, 4), b.min, b.max, b.over, b.under].join(','))];
    } else {
      lines = ['seq,id,time,weight_g,result', ...st.raw.map((r, i) => [i + 1, r.id, localIso(r.t), r.w, classOf(r.w, st.spec)].join(','))];
    }
    const blob = new Blob(['﻿' + lines.join('\n')], { type: 'text/csv;charset=utf-8' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    const sc = st.scales.find((s) => s.scale_id === st.scaleId);
    a.download = `weights_${(sc && (sc.line || sc.ip)) || st.scaleId}_${localIso(st.from).slice(0, 16).replace(/[:T]/g, '')}.csv`.replace(/\s+/g, '_');
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 2000);
  });
  window.addEventListener('themechange', () => { draw(); renderSide(); renderFoot(); });
  new ResizeObserver(() => draw()).observe(wrap);

  function updateTitle() {
    const sc = st.scales.find((s) => s.scale_id === st.scaleId);
    $('anScale').textContent = sc ? (sc.line || sc.ip) : '';
    $('btnBack').href = st.sessionId ? `session.html?id=${st.sessionId}` : `dashboard.html?scale=${st.scaleId}`;
    document.title = `วิเคราะห์ ${sc ? sc.line || sc.ip : ''} — Auto Weight`;
  }

  // อัปเดตเองเมื่อดูช่วงเวลาล่าสุด
  setInterval(() => {
    if (st.sessionId || st.period === 'custom' || document.hidden) return;
    const ms = effectiveTf() === 'raw' && st.view === 'trend' ? 10e3 : 30e3;
    if (!st._lastAuto || Date.now() - st._lastAuto >= ms) {
      st._lastAuto = Date.now();
      load({ quiet: true });
    }
  }, 5000);

  // ------------------------------------------------------------------ boot
  (async () => {
    try {
      const data = await api('/api/scales');
      st.scales = data.scales || [];
      try {
        const cfg = (await api('/api/settings')).settings || {};
        const y = Number(cfg['zone.yellowPct']); const r = Number(cfg['zone.redPct']);
        if (Number.isFinite(y) && y > 0) st.zone.yellowPct = y;
        if (Number.isFinite(r) && r > st.zone.yellowPct) st.zone.redPct = r;
      } catch (e) { /* ใช้ค่าเริ่มต้น 60 / 85 */ }
      if (st.sessionId) {
        const s = await api(`/api/sessions/${st.sessionId}`);
        st.session = s.session;
        st.scaleId = st.session.scale_id;
        $('docBadge').innerHTML = `${ic('file', 'sm')}เอกสาร #${st.session.id} · ${esc(st.session.product_code || '')}`;
        $('docBadge').classList.add('show');
      }
      if (!st.scaleId || !st.scales.some((s) => s.scale_id === st.scaleId)) {
        const first = st.scales.find((s) => s.enabled !== false) || st.scales[0];
        st.scaleId = first ? first.scale_id : null;
      }
      $('selScale').innerHTML = st.scales
        .filter((s) => s.enabled !== false || s.scale_id === st.scaleId)
        .map((s) => `<option value="${s.scale_id}" ${s.scale_id === st.scaleId ? 'selected' : ''}>${esc(s.line || s.ip)}${s.device_type === 'opcua' ? ' (CW)' : ''}</option>`).join('');
      if (!st.scaleId) { showMsg('ยังไม่มีเครื่องในระบบ'); return; }
      if (st.period === 'custom' && st.from && st.to) { $('fromInp').value = localIso(st.from).slice(0, 16); $('toInp').value = localIso(st.to).slice(0, 16); }
      updateTitle();
      await resolveSpec();
      st._lastAuto = Date.now();
      await load();
    } catch (err) {
      showMsg(`โหลดข้อมูลไม่สำเร็จ: ${err.message}`);
    }
  })();
})();
