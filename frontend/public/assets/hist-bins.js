/**
 * hist-bins.js — คำนวณช่องของ Histogram ให้ถูกต้องทุกหน้า (Dashboard / วิเคราะห์ / popup ในหน้าประวัติ)
 *
 *   const h = window.computeHistogram(values, { lsl, usl, target });
 *
 * ปัญหาเดิมที่แก้:
 *  - ตัดข้อมูลทิ้งตามช่วงสเปก → ถ้าสเปกไม่ตรงกับของที่ผลิตจริง (เช่นเอกสาร Target 103 g แต่เครื่องเดิน 73 g)
 *    ข้อมูลเกือบทั้งหมดถูกซ่อน เหลือ n=2
 *  - ความกว้างช่องตายตัว (1 g / 0.5 g) → ข้อมูลกระจายแคบเห็นแค่ 1–2 แท่ง, กระจายกว้างแท่งเยอะเกิน
 *  - ช่องกว้างไม่ลงตัวกับความละเอียดเครื่องชั่ง (0.1 g) → แท่งสูง-ต่ำสลับกันเป็นฟันปลา
 *  - ค่าผิดปกติตัวเดียว (เช่น 158.6 g ในงาน 73 g) ดึงแกนจนแท่งปกติแคบติดกัน
 *  - Math.min(...values) กับข้อมูลหลายหมื่นค่า ทำให้หน้าเว็บค้าง (stack overflow)
 *
 * วิธีใหม่:
 *  - ช่วงแกน = ช่วงที่ข้อมูลส่วนใหญ่อยู่ (Q1 − 4·IQR ถึง Q3 + 4·IQR) รวมช่วงสเปกถ้าสเปกอยู่ใกล้ข้อมูล
 *  - ค่าที่อยู่นอกแกนไม่ซ่อน — นับรวมเป็นแท่ง "ต่ำกว่า…" / "สูงกว่า…" ที่ขอบ
 *  - ความกว้างช่อง = ตามกฎ Freedman–Diaconis แล้วปัดเป็นจำนวนเท่าของความละเอียดเครื่องชั่ง (0.1, 0.2, 0.5, 1 …)
 *  - ขอบช่องอยู่กึ่งกลางระหว่างค่าที่เครื่องอ่านได้ (เช่น 72.95–73.05) ค่าไม่ตกบนขอบพอดี
 */
(function () {
  function quantile(sorted, q) {
    const i = (sorted.length - 1) * q;
    const lo = Math.floor(i); const hi = Math.ceil(i);
    return sorted[lo] + (sorted[hi] - sorted[lo]) * (i - lo);
  }

  /** ความละเอียดของเครื่องชั่ง (ระยะห่างที่เล็กที่สุดระหว่างค่าที่ต่างกัน) ปัดเป็น 0.01 / 0.02 / 0.05 / 0.1 / 0.2 / 0.5 / 1 … */
  function detectResolution(sorted) {
    let best = Infinity;
    const step = Math.max(1, Math.floor(sorted.length / 4000)); // ไม่ต้องดูทุกค่าถ้าข้อมูลเยอะมาก
    for (let i = step; i < sorted.length; i += step) {
      const d = Math.round((sorted[i] - sorted[i - step]) * 1000) / 1000;
      if (d > 0 && d < best) best = d;
    }
    if (!Number.isFinite(best)) best = 0.1;
    const nice = [0.001, 0.002, 0.005, 0.01, 0.02, 0.05, 0.1, 0.2, 0.5, 1, 2, 5, 10];
    return nice.find((x) => x >= best * 0.999) || 10;
  }

  function computeHistogram(values, opts) {
    opts = opts || {};
    const vals = [];
    for (const v of values) { const x = Number(v); if (Number.isFinite(x)) vals.push(x); }
    const n = vals.length;
    const sorted = Float64Array.from(vals).sort();
    const empty = { n, bins: [], edges: [], width: 0, lo: 0, hi: 0, below: { count: 0 }, above: { count: 0 }, specInRange: false };
    if (!n) return empty;
    const min = sorted[0]; const max = sorted[n - 1];
    const res = detectResolution(sorted);
    const q1 = quantile(sorted, 0.25); const q3 = quantile(sorted, 0.75);
    const iqr = q3 - q1;

    // ช่วงหลักของข้อมูล (ไม่ให้ค่าผิดปกติไม่กี่ค่าดึงแกน)
    let coreLo = min; let coreHi = max;
    if (iqr > 0) { coreLo = Math.max(min, q1 - 4 * iqr); coreHi = Math.min(max, q3 + 4 * iqr); }
    if (coreHi - coreLo < res) { coreLo -= res * 2; coreHi += res * 2; }

    // รวมช่วงสเปกเฉพาะเมื่ออยู่ใกล้ข้อมูล — สเปกที่ห่างมาก (เลือก Product ผิด) จะไม่บีบข้อมูลจนมองไม่เห็น
    const { lsl, usl } = opts;
    let lo = coreLo; let hi = coreHi; let specInRange = false;
    if (Number.isFinite(lsl) && Number.isFinite(usl) && usl > lsl) {
      const span = Math.max(coreHi - coreLo, usl - lsl);
      const near = usl >= coreLo - span && lsl <= coreHi + span;
      if (near) { lo = Math.min(lo, lsl); hi = Math.max(hi, usl); specInRange = true; }
    }

    // ความกว้างช่อง: Freedman–Diaconis แล้วบังคับ 8–45 ช่อง และเป็นจำนวนเท่าของความละเอียด
    const range = Math.max(hi - lo, res);
    let h = iqr > 0 ? (2 * iqr) / Math.cbrt(n) : range / 10;
    h = Math.min(Math.max(h, range / 45), range / 8);
    const cands = [];
    for (const m of [1, 2, 5, 10, 20, 50, 100, 200, 500, 1000]) cands.push(res * m);
    let w = cands[0];
    for (const c of cands) if (Math.abs(Math.log(c / h)) < Math.abs(Math.log(w / h))) w = c;
    while (range / w > 60) w = cands[cands.indexOf(w) + 1] || w * 2;
    w = +w.toFixed(6);

    // ขอบช่องอยู่ระหว่างค่าที่เครื่องอ่านได้ (ครึ่งหนึ่งของความละเอียด)
    const half = res / 2;
    const edge0 = +(Math.floor((lo + half) / w) * w - half).toFixed(6);
    let count = Math.max(1, Math.ceil((hi + half - edge0) / w - 1e-9));
    if (count < 5) count = 5;
    const edges = [];
    for (let i = 0; i <= count; i += 1) edges.push(+(edge0 + i * w).toFixed(6));
    const top = edges[count];

    const bins = new Array(count).fill(0);
    const below = { count: 0, min: Infinity, max: -Infinity };
    const above = { count: 0, min: Infinity, max: -Infinity };
    for (const v of vals) {
      if (v < edge0) { below.count += 1; below.min = Math.min(below.min, v); below.max = Math.max(below.max, v); continue; }
      if (v >= top) { above.count += 1; above.min = Math.min(above.min, v); above.max = Math.max(above.max, v); continue; }
      bins[Math.min(count - 1, Math.floor((v - edge0) / w + 1e-9))] += 1;
    }
    let sum = 0; for (const v of vals) sum += v;
    const mean = sum / n;
    let ss = 0; for (const v of vals) ss += (v - mean) ** 2;
    return {
      n, bins, edges, width: w, res, lo: edge0, hi: top, below, above, specInRange,
      min, max, mean, sd: n > 1 ? Math.sqrt(ss / (n - 1)) : 0,
      maxCount: Math.max(...bins, below.count, above.count, 1),
    };
  }

  window.computeHistogram = computeHistogram;

  /** โซนของค่าน้ำหนัก (ตามหน้า "ตั้งค่า"): GREEN | YELLOW | RED | OUT */
  function zoneOf(v, o) {
    const { lsl, usl, target } = o;
    if (!Number.isFinite(lsl) || !Number.isFinite(usl)) return 'GREEN';
    if (v < lsl || v > usl) return 'OUT';
    if (!Number.isFinite(target)) return 'GREEN';
    const d = v - target; const lim = d >= 0 ? usl - target : target - lsl;
    if (!(lim > 0)) return 'GREEN';
    const r = (Math.abs(d) / lim) * 100;
    const z = o.zone || { yellowPct: 60, redPct: 85 };
    return r >= z.redPct ? 'RED' : r >= z.yellowPct ? 'YELLOW' : 'GREEN';
  }

  function niceTicks(lo, hi, count) {
    const raw = (hi - lo) / Math.max(1, count);
    const mag = 10 ** Math.floor(Math.log10(raw || 1));
    const step = [1, 2, 2.5, 5, 10].map((m) => m * mag).find((x) => x >= raw) || raw;
    const out = [];
    for (let v = Math.ceil(lo / step) * step; v <= hi + 1e-9; v += step) out.push(+v.toFixed(6));
    return { ticks: out, step };
  }

  /**
   * วาด Histogram เป็น SVG (ใช้ร่วมกันหน้า Dashboard และ popup ในหน้าประวัติ)
   * คืนค่า markup ภายใน <svg> — ผู้เรียกตั้ง viewBox = `0 0 ${W} ${H}` เอง
   */
  function histogramSvg(h, o) {
    const W = o.W || 1400; const H = o.H || 420;
    const fs = o.fontSize || 14;
    const padL = 56; const padR = 28; const padT = 50; const padB = 46;
    const plotW = W - padL - padR; const plotH = H - padT - padB;
    if (!h || h.n < 1 || !h.bins.length) return '';
    const leftU = h.below.count ? 1.6 : 0; const rightU = h.above.count ? 1.6 : 0;
    const units = h.bins.length + leftU + rightU;
    const u = plotW / units;
    const X = (v) => padL + leftU * u + ((v - h.lo) / h.width) * u;
    const Y = (c) => padT + plotH - (c / (h.maxCount * 1.08)) * plotH;
    const col = { GREEN: 'var(--ok, #1D4ED8)', YELLOW: '#E3A008', RED: '#F0602B', OUT: 'var(--limit, #D23A31)' };
    let s = '';
    // แถบโซน
    const { lsl, usl, target } = o;
    const z = o.zone || { yellowPct: 60, redPct: 85 };
    if (h.specInRange && Number.isFinite(target)) {
      const up = usl - target; const dn = target - lsl;
      const band = (a, b, fill) => {
        const xa = Math.max(X(h.lo), X(Math.min(a, b))); const xb = Math.min(X(h.hi), X(Math.max(a, b)));
        if (xb > xa) s += `<rect x="${xa}" y="${padT}" width="${xb - xa}" height="${plotH}" fill="${fill}"/>`;
      };
      band(target - (dn * z.yellowPct) / 100, target + (up * z.yellowPct) / 100, 'rgba(14,148,102,0.08)');
      band(target + (up * z.yellowPct) / 100, target + (up * z.redPct) / 100, 'rgba(227,160,8,0.11)');
      band(target - (dn * z.redPct) / 100, target - (dn * z.yellowPct) / 100, 'rgba(227,160,8,0.11)');
      band(target + (up * z.redPct) / 100, usl, 'rgba(240,96,43,0.11)');
      band(lsl, target - (dn * z.redPct) / 100, 'rgba(240,96,43,0.11)');
    }
    // แกน Y จาง ๆ
    const yt = niceTicks(0, h.maxCount * 1.08, 4);
    for (const t of yt.ticks) {
      const y = Y(t);
      s += `<line x1="${padL}" x2="${W - padR}" y1="${y}" y2="${y}" stroke="var(--line, #E4E9F1)" stroke-width="1" opacity="0.7"/>`;
      s += `<text x="${padL - 8}" y="${y + fs * 0.35}" font-size="${fs - 2}" fill="var(--text-faint, #8190A6)" text-anchor="end">${t.toLocaleString('en-US')}</text>`;
    }
    const showLabels = u >= fs * 1.6;
    const label = (x, y, c) => { if (showLabels && c) s += `<text x="${x}" y="${y - 6}" font-size="${fs}" font-weight="600" fill="var(--text-dim, #4A5870)" text-anchor="middle">${c.toLocaleString('en-US')}</text>`; };
    // แท่งปกติ
    h.bins.forEach((c, i) => {
      if (!c) return;
      const a = h.edges[i]; const x = X(a); const y = Y(c);
      const zc = Number.isFinite(lsl) ? zoneOf((a + h.edges[i + 1]) / 2, o) : 'GREEN';
      s += `<rect x="${x + 1}" y="${y}" width="${Math.max(1, u - 2)}" height="${padT + plotH - y}" rx="2" fill="${col[zc]}" opacity="0.88"><title>${a.toFixed(2)}–${h.edges[i + 1].toFixed(2)} g: ${c} ชิ้น</title></rect>`;
      label(x + u / 2, y, c);
    });
    // แท่งค่าที่อยู่นอกแกน (ไม่ซ่อน)
    const ov = (x0, c, txt, tip) => {
      const y = Y(c);
      s += `<rect x="${x0 + 1}" y="${y}" width="${Math.max(1, u - 2)}" height="${padT + plotH - y}" rx="2" fill="#8B2A24" opacity="0.9"><title>${tip}</title></rect>`;
      s += `<text x="${x0 + u / 2}" y="${y - 6}" font-size="${fs}" font-weight="700" fill="#8B2A24" text-anchor="middle">${c.toLocaleString('en-US')}</text>`;
      s += `<text x="${x0 + u / 2}" y="${H - 8}" font-size="${fs - 2}" fill="#8B2A24" text-anchor="middle">${txt}</text>`;
    };
    if (h.below.count) ov(padL, h.below.count, `< ${+h.lo.toFixed(2)}`, `ต่ำกว่า ${h.lo.toFixed(2)} g (${h.below.min.toFixed(1)}–${h.below.max.toFixed(1)} g)`);
    if (h.above.count) ov(W - padR - u, h.above.count, `> ${+h.hi.toFixed(2)}`, `สูงกว่า ${h.hi.toFixed(2)} g (${h.above.min.toFixed(1)}–${h.above.max.toFixed(1)} g)`);
    // เส้นสเปก
    const vline = (v, c, l, dash) => {
      if (!Number.isFinite(v) || v < h.lo || v > h.hi) return;
      const x = X(v);
      s += `<line x1="${x}" x2="${x}" y1="${padT - 6}" y2="${padT + plotH}" stroke="${c}" stroke-width="2.2" ${dash ? 'stroke-dasharray="6 4"' : ''}/>`;
      s += `<text x="${x}" y="${padT - 12}" font-size="${fs}" font-weight="700" fill="${c}" text-anchor="middle">${l} ${v}</text>`;
    };
    vline(lsl, 'var(--limit, #D23A31)', 'LSL'); vline(usl, 'var(--limit, #D23A31)', 'USL'); vline(target, 'var(--target, #F57C1F)', 'Target', true);
    if (Number.isFinite(lsl) && !h.specInRange) {
      s += `<text x="${W - padR}" y="${padT - 12}" font-size="${fs}" font-weight="700" fill="var(--limit, #D23A31)" text-anchor="end">สเปก LSL ${lsl} – USL ${usl} g อยู่ห่างจากข้อมูล →</text>`;
    }
    // แกน X
    s += `<line x1="${padL}" x2="${W - padR}" y1="${padT + plotH}" y2="${padT + plotH}" stroke="var(--line, #E4E9F1)" stroke-width="1.5"/>`;
    const xt = niceTicks(h.lo, h.hi, Math.max(4, Math.floor(plotW / 110)));
    const dec = xt.step >= 1 ? 0 : xt.step >= 0.1 ? 1 : 2;
    for (const t of xt.ticks) s += `<text x="${X(t)}" y="${H - 8}" font-size="${fs - 1}" fill="var(--text-faint, #8190A6)" text-anchor="middle">${t.toFixed(dec)}</text>`;
    return s;
  }

  window.histZoneOf = zoneOf;
  window.histogramSvg = histogramSvg;
})();
