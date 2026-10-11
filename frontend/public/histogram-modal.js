/* histogram-modal.js
 * Popup แบบเต็มจอสำหรับแสดง Histogram ของค่าน้ำหนักในเอกสารหนึ่ง ๆ
 * เรียกใช้งานด้วย: window.openHistogramModal(docId)
 *
 * ไฟล์นี้เป็นอิสระจาก history.html — ไม่พึ่งพาตัวแปรหรือฟังก์ชันภายในไฟล์นั้น
 * ใช้ endpoint เดิมที่มีอยู่แล้ว: /api/sessions/:id และ /api/weights/range
 */
(function () {
  const MODAL_ID = 'histogramModal';

  function ensureModal() {
    let el = document.getElementById(MODAL_ID);
    if (el) return el;

    el = document.createElement('div');
    el.id = MODAL_ID;
    el.style.cssText = `
      position:fixed; inset:0; background:#ffffff; z-index:5000;
      display:none; flex-direction:column;
      font-family:Tahoma,Geneva,Verdana,sans-serif; color:#131a2b;
    `;
    el.innerHTML = `
      <div style="display:flex; align-items:center; justify-content:space-between;
                  padding:14px 22px; border-bottom:1px solid #e5e9f0; flex:none;">
        <div id="hmTitle" style="font-size:16px; font-weight:700;">Histogram</div>
        <button id="hmCloseBtn" style="border:1px solid #dbe4f0; background:#f4f6fb;
                border-radius:6px; padding:8px 16px; font-size:13px; font-weight:700;
                cursor:pointer; color:#131a2b;">✕ CLOSE</button>
      </div>
      <div style="flex:1; overflow:auto; padding:26px 30px;">
        <div id="hmSubtitle" style="font-size:12.5px; color:rgba(19,26,43,0.6); margin-bottom:16px;"></div>
        <div id="hmChartWrap" style="width:100%;"></div>
        <div id="hmMsg" style="display:none; text-align:center; color:rgba(19,26,43,0.45); padding:60px;"></div>
      </div>
    `;
    document.body.appendChild(el);

    el.querySelector('#hmCloseBtn').addEventListener('click', closeHistogramModal);
    // ปิดด้วย Esc
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && el.style.display === 'flex') closeHistogramModal();
    });
    return el;
  }

  function closeHistogramModal() {
    const el = document.getElementById(MODAL_ID);
    if (el) el.style.display = 'none';
    document.body.style.overflow = '';
  }
  window.closeHistogramModal = closeHistogramModal;

  async function apiGet(path) {
    const res = await fetch(path, { cache: 'no-store', headers: { accept: 'application/json' } });
    let payload = null;
    try { payload = await res.json(); } catch (e) { /* ignore */ }
    if (!res.ok) throw new Error((payload && payload.error) || `HTTP ${res.status}`);
    return payload || {};
  }

  function buildHistogram(values, opts) {
    opts = opts || {};
    let min = Math.min(...values);
    let max = Math.max(...values);
    if (opts.lsl != null) min = Math.min(min, opts.lsl);
    if (opts.usl != null) max = Math.max(max, opts.usl);
    min = Math.floor(min);
    max = Math.ceil(max);
    if (min === max) { min -= 1; max += 1; }

    // ถ้าช่วงข้อมูลกว้างมาก ให้รวมเป็นช่วง ๆ (bin) แทนการนับทีละหน่วย
    const binWidth = (max - min) > 30 ? Math.ceil((max - min) / 20) : 1;
    const binCount = Math.ceil((max - min) / binWidth);
    const bins = new Array(binCount).fill(0);

    values.forEach((v) => {
      let idx = Math.floor((v - min) / binWidth);
      if (idx < 0) idx = 0;
      if (idx >= binCount) idx = binCount - 1;
      bins[idx]++;
    });

    return { min, max, binWidth, binCount, bins };
  }

  function renderChart(container, hist, opts) {
    opts = opts || {};
    const width = Math.max(container.clientWidth || 900, 640);
    const height = 540;
    const padL = 40, padR = 30, padT = 70, padB = 50;
    const plotW = width - padL - padR;
    const plotH = height - padT - padB;
    const maxCount = Math.max(...hist.bins, 1);
    const barW = plotW / hist.binCount;

    const xOf = (val) => padL + ((val - hist.min) / (hist.max - hist.min)) * plotW;
    const yOf = (count) => padT + plotH - (count / maxCount) * plotH;

    let svg = `<svg viewBox="0 0 ${width} ${height}" width="100%" height="${height}"
                 xmlns="http://www.w3.org/2000/svg"
                 style="font-family:Tahoma,Geneva,Verdana,sans-serif;">`;

    // เส้นฐาน
    svg += `<line x1="${padL}" y1="${padT + plotH}" x2="${padL + plotW}" y2="${padT + plotH}"
              stroke="#c9d3e0" stroke-width="1"/>`;

    // แท่งกราฟ
    hist.bins.forEach((count, i) => {
      const x0 = hist.min + i * hist.binWidth;
      const xPix = xOf(x0);
      const yPix = yOf(count);
      const h = (padT + plotH) - yPix;
      svg += `<rect x="${xPix + 1}" y="${yPix}" width="${Math.max(barW - 2, 1)}"
                height="${Math.max(h, 0)}" fill="#3576d8"></rect>`;
      if (count > 0) {
        svg += `<text x="${xPix + barW / 2}" y="${yPix - 8}" font-size="14" font-weight="700"
                  fill="#131a2b" text-anchor="middle">${count}</text>`;
      }
    });

    // เลขกำกับแกน X
    const labelStep = hist.binCount > 16 ? 2 : 1;
    for (let i = 0; i <= hist.binCount; i += labelStep) {
      const val = hist.min + i * hist.binWidth;
      const xPix = xOf(val);
      svg += `<text x="${xPix}" y="${padT + plotH + 22}" font-size="13"
                fill="rgba(19,26,43,0.55)" text-anchor="middle">${val}</text>`;
    }

    // เส้น LSL / USL / Target
    function specLine(val, color, label, dashed) {
      if (val == null || isNaN(val)) return '';
      const xPix = xOf(val);
      let s = `<line x1="${xPix}" y1="${padT - 10}" x2="${xPix}" y2="${padT + plotH}"
                 stroke="${color}" stroke-width="2" ${dashed ? 'stroke-dasharray="6,5"' : ''}/>`;
      s += `<text x="${xPix}" y="${padT - 16}" font-size="13" font-weight="700"
              fill="${color}" text-anchor="middle">${label}</text>`;
      return s;
    }
    svg += specLine(opts.lsl, '#d1453d', 'LSL ' + opts.lsl, false);
    svg += specLine(opts.usl, '#d1453d', 'USL ' + opts.usl, false);
    svg += specLine(opts.target, '#e8720c', 'Target ' + opts.target, true);

    svg += `</svg>`;
    container.innerHTML = svg;
  }

  function showMessage(modal, text) {
    modal.querySelector('#hmChartWrap').innerHTML = '';
    const msg = modal.querySelector('#hmMsg');
    msg.style.display = 'block';
    msg.textContent = text;
  }

  async function openHistogramModal(docId) {
    const modal = ensureModal();
    modal.style.display = 'flex';
    document.body.style.overflow = 'hidden';
    modal.querySelector('#hmMsg').style.display = 'none';
    modal.querySelector('#hmSubtitle').textContent = '';
    modal.querySelector('#hmTitle').textContent = `Histogram — เอกสาร #${docId}`;
    modal.querySelector('#hmChartWrap').innerHTML =
      '<div style="padding:60px; text-align:center; color:rgba(19,26,43,0.45);">กำลังโหลดข้อมูล...</div>';

    try {
      const sessionRes = await apiGet(`/api/sessions/${docId}`);
      const s = sessionRes.session;

      if (!s || !s.end_time) {
        showMessage(modal, 'เอกสารนี้ยังไม่ได้ "หยุด" — ยังไม่มีข้อมูลครบสำหรับสร้าง Histogram');
        return;
      }

      const weightsRes = await apiGet(
        `/api/weights/range?scaleId=${s.scale_id}&from=${encodeURIComponent(s.start_time)}&to=${encodeURIComponent(s.end_time)}&limit=20000`
      );
      const values = (weightsRes.rows || []).map((r) => r.weight).filter((v) => Number.isFinite(v));

      modal.querySelector('#hmSubtitle').textContent =
        `${s.product_code || ''}  ${s.group_code || ''}  ·  ${s.line || s.scale_name || '-'}  ·  จำนวนค่า ${values.length}`;

      if (!values.length) {
        showMessage(modal, 'ไม่มีข้อมูลน้ำหนักในช่วงเวลานี้');
        return;
      }

      const opts = { lsl: s.nw_lcl, usl: s.nw_ucl, target: s.nw_target };
      const hist = buildHistogram(values, opts);
      renderChart(modal.querySelector('#hmChartWrap'), hist, opts);
    } catch (err) {
      showMessage(modal, 'โหลดข้อมูลไม่สำเร็จ: ' + err.message);
    }
  }

  window.openHistogramModal = openHistogramModal;
})();