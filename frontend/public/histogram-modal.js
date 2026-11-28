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
      position:fixed; inset:0; background:var(--bg, #F6F8FB); z-index:5000;
      display:none; flex-direction:column;
      font-family:'IBM Plex Sans Thai','Leelawadee UI',Tahoma,sans-serif; color:var(--text, #0E1A2E);
    `;
    el.innerHTML = `
      <div style="display:flex; align-items:center; justify-content:space-between;
                  padding:14px 24px; background:var(--panel, #fff); border-bottom:1px solid var(--line, #E4E9F1); flex:none;">
        <div id="hmTitle" style="font-size:18px; font-weight:700; letter-spacing:-0.01em;">Histogram</div>
        <button id="hmCloseBtn" class="btn" type="button"><svg class="i"><use href="assets/icons.svg#x"></use></svg>ปิด</button>
      </div>
      <div style="flex:1; overflow:auto; padding:24px 30px;"><div style="background:var(--panel, #fff); border:1px solid var(--line, #E4E9F1); border-radius:16px; padding:22px 24px; box-shadow:0 1px 2px rgba(14,26,46,.04),0 2px 8px -2px rgba(14,26,46,.06);">
        <div id="hmSubtitle" style="font-size:12.5px; color:var(--text-dim, #4A5870); margin-bottom:16px;"></div>
        <div id="hmChartWrap" style="width:100%;"></div>
        <div id="hmMsg" style="display:none; text-align:center; color:var(--text-faint, #8190A6); padding:60px;"></div>
      </div></div>
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

  // ช่อง Histogram + การวาด ใช้ตัวเดียวกับ Dashboard (assets/hist-bins.js) — โหลดเองถ้าหน้านั้นยังไม่ได้ใส่ไว้
  function ensureBins() {
    if (window.computeHistogram && window.histogramSvg) return Promise.resolve();
    return new Promise((resolve, reject) => {
      const sc = document.createElement('script');
      sc.src = 'assets/hist-bins.js';
      sc.onload = () => resolve();
      sc.onerror = () => reject(new Error('โหลด hist-bins.js ไม่ได้'));
      document.head.appendChild(sc);
    });
  }

  let zoneCache = null;
  async function loadZone() {
    if (zoneCache) return zoneCache;
    zoneCache = { yellowPct: 60, redPct: 85 };
    try {
      const st = await apiGet('/api/settings');
      const v = (st && (st.settings || st)) || {};
      const y = Number(v['zone.yellowPct']); const r = Number(v['zone.redPct']);
      if (Number.isFinite(y) && y > 0) zoneCache.yellowPct = y;
      if (Number.isFinite(r) && r > 0) zoneCache.redPct = r;
    } catch (e) { console.error('histogram-modal settings:', e); }
    return zoneCache;
  }

  function renderChart(container, h, opts) {
    const W = Math.max(container.clientWidth || 900, 640);
    const H = 440;
    const inner = window.histogramSvg(h, Object.assign({ W, H, fontSize: 13 }, opts));
    container.innerHTML = `<svg viewBox="0 0 ${W} ${H}" width="100%" style="display:block; font-family:inherit;">${inner}</svg>`;
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
      '<div style="padding:60px; text-align:center; color:var(--text-faint, #8190A6);">กำลังโหลดข้อมูล...</div>';

    try {
      const sessionRes = await apiGet(`/api/sessions/${docId}`);
      const s = sessionRes.session;

      if (!s || !s.end_time) {
        showMessage(modal, 'เอกสารนี้ยังไม่ได้ "หยุด" — ยังไม่มีข้อมูลครบสำหรับสร้าง Histogram');
        return;
      }

      // อ่านตามเลขเอกสาร (session_id) — รวมข้อมูลเก่าที่อยู่ใน dbo.Auto ก่อนแยกตาราง Spout
      const weightsRes = await apiGet(`/api/sessions/${docId}/weights?limit=200000`);
      const values = (weightsRes.rows || []).map((r) => r.weight).filter((v) => Number.isFinite(v));

      if (!values.length) {
        modal.querySelector('#hmSubtitle').textContent =
          `${s.product_code || ''}  ${s.group_code || ''}  ·  ${s.line || s.scale_name || '-'}  ·  จำนวนค่า 0`;
        showMessage(modal, 'ไม่มีข้อมูลน้ำหนักในช่วงเวลานี้');
        return;
      }

      await ensureBins();
      const num = (v) => (v == null || v === '' || !Number.isFinite(Number(v)) ? undefined : Number(v));
      const opts = { lsl: num(s.nw_lcl), usl: num(s.nw_ucl), target: num(s.nw_target), zone: await loadZone() };
      const hist = window.computeHistogram(values, opts);
      const outside = hist.below.count + hist.above.count;
      const w = hist.width >= 1 ? hist.width.toFixed(0) : hist.width >= 0.1 ? hist.width.toFixed(1) : hist.width.toFixed(2);
      modal.querySelector('#hmSubtitle').textContent =
        `${s.product_code || ''}  ${s.group_code || ''}  ·  ${s.line || s.scale_name || '-'}  ·  จำนวนค่า ${values.length.toLocaleString('en-US')}` +
        `  ·  ช่องละ ${w} g` +
        (outside ? `  ·  ${outside.toLocaleString('en-US')} ค่าอยู่ไกลจากกลุ่มหลัก (แท่งขอบ)` : '') +
        (opts.lsl != null && !hist.specInRange ? '  ·  ⚠ สเปกในเอกสารไม่ตรงกับน้ำหนักที่ผลิตจริง' : '');
      renderChart(modal.querySelector('#hmChartWrap'), hist, opts);
    } catch (err) {
      showMessage(modal, 'โหลดข้อมูลไม่สำเร็จ: ' + err.message);
    }
  }

  window.openHistogramModal = openHistogramModal;
})();