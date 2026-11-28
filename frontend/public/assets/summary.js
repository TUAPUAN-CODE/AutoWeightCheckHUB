/**
 * summary.js — หน้า "สรุปผลรายไลน์" (summary.html)
 *
 *  - ด้านบน: สรุปของวันที่เลือก (ทุกไลน์รวมกัน + การ์ดรายไลน์)
 *  - ด้านล่าง: แนวโน้มรายวัน / สัปดาห์ / เดือน / ปี ย้อนหลัง N ช่วง (ผู้ใช้ตั้งเอง) สิ้นสุดที่วันที่เลือก
 *  ข้อมูลจาก GET /api/summary/lines — ผ่าน/ไม่ผ่าน และ Cp/Cpk คิดตามสเปกของเอกสารแต่ละใบ
 */
(function () {
  const $ = (id) => document.getElementById(id);
  const ic = (n, c) => (window.icon ? window.icon(n, c) : '');
  const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const p2 = (n) => String(n).padStart(2, '0');
  const dayKey = (d) => `${d.getFullYear()}-${p2(d.getMonth() + 1)}-${p2(d.getDate())}`;
  const parseDay = (s) => { const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s || ''); return m ? new Date(+m[1], +m[2] - 1, +m[3]) : null; };
  const fint = (v) => (v == null ? '-' : Number(v).toLocaleString('en-US'));
  const f2 = (v) => (v == null || !Number.isFinite(v) ? '-' : v.toFixed(2));
  const fpct = (v) => (v == null || !Number.isFinite(v) ? '-' : `${v >= 99.95 && v < 100 ? v.toFixed(2) : v.toFixed(1)}%`);
  const LOCALE = { th: 'th-TH', en: 'en-GB', my: 'my-MM', km: 'km-KH' }[window.AW_LANG || 'th'] || 'th-TH';
  const fmtDate = (d, o) => { try { return d.toLocaleDateString(LOCALE, o); } catch (e) { return d.toLocaleDateString('th-TH', o); } };

  const PERIODS = {
    day: { unit: 'วัน', max: 400, def: 30 },
    week: { unit: 'สัปดาห์', max: 156, def: 8 },
    month: { unit: 'เดือน', max: 36, def: 12 },
    year: { unit: 'ปี', max: 3, def: 3 },
  };
  const METRICS = {
    cpk: { label: 'Cpk', fmt: f2 },
    cp: { label: 'Cp', fmt: f2 },
    pass_pct: { label: '% ผ่าน', fmt: fpct },
    n: { label: 'จำนวนชิ้น', fmt: fint },
  };

  const Q = new URLSearchParams(location.search);
  const store = {
    get(k) { try { return localStorage.getItem(k); } catch (e) { return null; } },
    set(k, v) { try { localStorage.setItem(k, v); } catch (e) { /* จำไม่ได้ก็ใช้ได้รอบนี้ */ } },
  };
  const st = {
    day: parseDay(Q.get('date')) || startOfDay(new Date()),
    period: PERIODS[Q.get('period')] ? Q.get('period') : (PERIODS[store.get('sum-period')] ? store.get('sum-period') : 'week'),
    nBack: null,
    metric: METRICS[Q.get('metric')] ? Q.get('metric') : 'cpk',
    focus: Number.parseInt(Q.get('focus') || store.get('sum-focus') || '', 10) || null,
    show: store.get('sum-show') === 'all' ? 'all' : 'active',
    sort: store.get('sum-sort') === 'worst' ? 'worst' : 'name',
    dayData: null,
    trendData: null,
    status: null,
    th: { cpkGood: 1.33, cpkMin: 1.0, cpMin: 1.0 },
  };
  {
    const n = Number.parseInt(Q.get('n') || store.get(`sum-n-${st.period}`) || '', 10);
    st.nBack = clampN(Number.isFinite(n) ? n : PERIODS[st.period].def, st.period);
  }

  function startOfDay(d) { const x = new Date(d); x.setHours(0, 0, 0, 0); return x; }
  function clampN(n, period) { return Math.max(1, Math.min(PERIODS[period].max, Math.round(n) || 1)); }
  function periodStart(d, period) {
    const x = startOfDay(d);
    if (period === 'week') x.setDate(x.getDate() - ((x.getDay() + 6) % 7));
    else if (period === 'month') x.setDate(1);
    else if (period === 'year') x.setMonth(0, 1);
    return x;
  }
  function shiftPeriod(d, period, k) {
    const x = new Date(d);
    if (period === 'week') x.setDate(x.getDate() + 7 * k);
    else if (period === 'month') x.setMonth(x.getMonth() + k);
    else if (period === 'year') x.setFullYear(x.getFullYear() + k);
    else x.setDate(x.getDate() + k);
    return x;
  }
  function periodLabel(t, period, long) {
    if (period === 'year') return fmtDate(t, { year: 'numeric' });
    if (period === 'month') return fmtDate(t, { month: 'short', year: long ? 'numeric' : '2-digit' });
    if (period === 'week') {
      const e = shiftPeriod(t, 'day', 6);
      return long ? `${fmtDate(t, { day: 'numeric', month: 'short' })} – ${fmtDate(e, { day: 'numeric', month: 'short', year: 'numeric' })}` : fmtDate(t, { day: 'numeric', month: 'short' });
    }
    return long ? fmtDate(t, { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric' }) : fmtDate(t, { day: 'numeric', month: 'short' });
  }

  /** ผลตาม Cpk: ดี / พอใช้ / ต้องปรับปรุง / ไม่มีสเปก / ไม่ได้ผลิต */
  function verdict(s, key) {
    if (!s || !s.n) return { cls: 'none', label: 'ไม่ได้ผลิต', icon: 'clock' };
    const v = key === 'cp' ? s.cp : s.cpk;
    if (v == null) return { cls: 'none', label: s.with_spec ? 'ข้อมูลไม่พอ' : 'ไม่มีสเปก', icon: 'info' };
    const min = key === 'cp' ? st.th.cpMin : st.th.cpkMin;
    if (v >= st.th.cpkGood) return { cls: 'good', label: 'ดี', icon: 'ok' };
    if (v >= min) return { cls: 'warn', label: 'พอใช้', icon: 'alert' };
    return { cls: 'bad', label: 'ต้องปรับปรุง', icon: 'alert' };
  }

  async function api(path) {
    const res = await fetch(path, { cache: 'no-store', headers: { accept: 'application/json' } });
    let body = null;
    try { body = await res.json(); } catch (e) { /* ไม่ใช่ JSON */ }
    if (!res.ok) throw new Error((body && body.error) || `HTTP ${res.status}`);
    return body || {};
  }

  function syncUrl() {
    const q = new URLSearchParams();
    const today = startOfDay(new Date());
    if (st.day.getTime() !== today.getTime()) q.set('date', dayKey(st.day));
    q.set('period', st.period); q.set('n', st.nBack); q.set('metric', st.metric);
    if (st.focus) q.set('focus', st.focus);
    history.replaceState(null, '', `?${q.toString()}`);
  }

  // ------------------------------------------------------------------ โหลดข้อมูล
  let seq = 0;
  async function loadAll(opts) {
    const my = ++seq;
    const quiet = opts && opts.quiet;
    syncUrl();
    renderControls();
    if (!quiet) document.querySelector('.page').classList.add('loading-veil');
    const d = dayKey(st.day);
    const tFrom = shiftPeriod(periodStart(st.day, st.period), st.period, -(st.nBack - 1));
    try {
      const [dayData, trendData, status] = await Promise.all([
        api(`/api/summary/lines?from=${d}&to=${d}&period=day`),
        api(`/api/summary/lines?from=${dayKey(tFrom)}&to=${d}&period=${st.period}`),
        api('/api/status').catch(() => null),
      ]);
      if (my !== seq) return;
      st.dayData = dayData; st.trendData = trendData; st.status = status;
      st.th = Object.assign(st.th, trendData.thresholds || {});
      const errs = [...(dayData.errors || []), ...(trendData.errors || [])];
      $('errBox').style.display = errs.length ? 'block' : 'none';
      $('errBox').textContent = errs.length ? `อ่านฐานข้อมูลบางไลน์ไม่ได้ (ใช้ข้อมูลในหน่วยความจำแทน): ${[...new Set(errs)].join(' · ')}` : '';
    } catch (err) {
      console.error('summary load:', err);
      if (my !== seq) return;
      $('errBox').style.display = 'block';
      $('errBox').textContent = `โหลดข้อมูลไม่สำเร็จ: ${err.message}`;
    } finally {
      if (my === seq) document.querySelector('.page').classList.remove('loading-veil');
    }
    render();
  }

  function liveOf(id) {
    const sc = st.status && (st.status.scales || []).find((x) => x.scale_id === id);
    if (!sc) return null;
    if (sc.enabled === false) return { cls: 'idle', text: 'ปิดใช้งาน' };
    const cs = sc.connection_status;
    if (sc.device_type === 'opcua') {
      if (cs !== 'connected') return { cls: cs === 'error' || cs === 'stopped' ? 'down' : 'warn', text: cs === 'stopped' ? 'หยุดอยู่' : cs === 'error' ? 'เชื่อมต่อไม่ได้' : 'กำลังเชื่อมต่อ' };
      return sc.cw && sc.cw.run_state === 'running' ? { cls: 'ok live', text: 'กำลังผลิต' } : { cls: 'idle', text: 'ว่าง / หยุดเดิน' };
    }
    return cs === 'connected' || cs === 'simulating' ? { cls: 'ok live', text: 'รับค่าอยู่' } : { cls: 'down', text: 'ไม่เชื่อมต่อ' };
  }

  // ------------------------------------------------------------------ render
  function render() {
    renderOverview();
    renderLines();
    renderFocusSelect();
    renderTrend();
    renderHeatmap();
    renderGuide();
  }

  function renderControls() {
    $('dayInput').value = dayKey(st.day);
    const today = startOfDay(new Date());
    const isToday = st.day.getTime() === today.getTime();
    $('dayTitle').textContent = isToday ? 'วันนี้' : fmtDate(st.day, { day: 'numeric', month: 'short', year: 'numeric' });
    $('btnNext').disabled = st.day >= today;
    $('linesDay').textContent = `· ${fmtDate(st.day, { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' })}`;
    for (const b of $('periodSeg').querySelectorAll('button')) b.classList.toggle('active', b.dataset.v === st.period);
    for (const b of $('metricSeg').querySelectorAll('button')) b.classList.toggle('active', b.dataset.v === st.metric);
    for (const b of $('showSeg').querySelectorAll('button')) b.classList.toggle('active', b.dataset.v === st.show);
    for (const b of $('sortSeg').querySelectorAll('button')) b.classList.toggle('active', b.dataset.v === st.sort);
    $('nBack').value = st.nBack; $('nBack').max = PERIODS[st.period].max;
    $('nUnit').textContent = PERIODS[st.period].unit;
    const tFrom = shiftPeriod(periodStart(st.day, st.period), st.period, -(st.nBack - 1));
    $('trendRange').textContent = `· ${st.nBack} ${PERIODS[st.period].unit} (${fmtDate(tFrom, { day: 'numeric', month: 'short', year: 'numeric' })} – ${fmtDate(st.day, { day: 'numeric', month: 'short', year: 'numeric' })})`;
  }

  function dayLines() { return (st.dayData && st.dayData.lines) || []; }
  function trendLines() { return (st.trendData && st.trendData.lines) || []; }

  function renderOverview() {
    const L = dayLines();
    const tot = { n: 0, pass: 0, fail: 0, with_spec: 0, no_spec: 0 };
    const counts = { good: 0, warn: 0, bad: 0, none: 0 };
    let active = 0;
    for (const l of L) {
      const t = l.total; tot.n += t.n; tot.pass += t.pass; tot.fail += t.fail; tot.with_spec += t.with_spec; tot.no_spec += t.no_spec;
      if (t.n) { active += 1; counts[verdict(t).cls] += 1; }
    }
    const pp = tot.with_spec ? (tot.pass / tot.with_spec) * 100 : null;
    const chip = (cls, n, label) => (n ? `<span class="verdict ${cls}">${ic(cls === 'good' ? 'ok' : cls === 'none' ? 'info' : 'alert')}${label} ${n}</span>` : '');
    $('overview').innerHTML = `
      <div class="kpi"><small>ผลิตทั้งหมด</small><b>${fint(tot.n)}</b><em>ชิ้น${tot.no_spec ? ` · ไม่มีเอกสาร ${fint(tot.no_spec)}` : ''}</em></div>
      <div class="kpi good"><small>ผ่าน</small><b>${fint(tot.pass)}</b><em>ชิ้น</em></div>
      <div class="kpi bad"><small>ไม่ผ่าน (นอก LSL–USL)</small><b>${fint(tot.fail)}</b><em>ชิ้น</em></div>
      <div class="kpi"><small>% ผ่าน</small><b>${fpct(pp)}</b><em>จากชิ้นที่มีสเปก ${fint(tot.with_spec)}</em></div>
      <div class="kpi"><small>ไลน์ที่ผลิตวันนี้</small><b>${active}<span class="muted" style="font-size:16px; font-weight:500;"> / ${L.length}</span></b><em>ไลน์</em></div>
      <div class="kpi"><small>ผลตาม Cpk</small><div class="verdicts">${chip('good', counts.good, 'ดี')}${chip('warn', counts.warn, 'พอใช้')}${chip('bad', counts.bad, 'ต้องปรับปรุง')}${chip('none', counts.none, 'ไม่มีสเปก')}${active ? '' : '<span class="muted">ยังไม่มีการผลิต</span>'}</div></div>`;
  }

  function trendOf(id) { return trendLines().find((l) => l.scale_id === id); }

  /** แนวโน้ม Cpk: ช่วงล่าสุดเทียบค่าเฉลี่ยช่วงก่อนหน้า */
  function direction(series) {
    const v = series.map((s) => s.cpk).filter((x) => x != null);
    if (v.length < 3) return { cls: 'flat', text: 'ข้อมูลยังน้อย' };
    const last = v[v.length - 1];
    const prev = v.slice(0, -1).reduce((a, b) => a + b, 0) / (v.length - 1);
    const d = last - prev;
    if (d >= 0.1) return { cls: 'up', text: `↑ ดีขึ้น +${d.toFixed(2)}` };
    if (d <= -0.1) return { cls: 'down', text: `↓ แย่ลง ${d.toFixed(2)}` };
    return { cls: 'flat', text: '→ คงที่' };
  }

  function sparkSvg(series) {
    const W = 220; const H = 44; const pad = 4;
    const vals = series.map((s) => (s.cpk == null ? null : Math.max(-0.5, Math.min(3, s.cpk))));
    const good = vals.filter((v) => v != null);
    if (!good.length) return `<svg viewBox="0 0 ${W} ${H}" preserveAspectRatio="none"><text x="${W / 2}" y="${H / 2 + 4}" font-size="11" fill="var(--ink-3)" text-anchor="middle">ไม่มีข้อมูล Cpk</text></svg>`;
    const lo = Math.min(0.5, ...good) - 0.1; const hi = Math.max(1.8, ...good) + 0.1;
    const X = (i) => pad + (series.length < 2 ? (W - 2 * pad) / 2 : (i / (series.length - 1)) * (W - 2 * pad));
    const Y = (v) => pad + (1 - (v - lo) / (hi - lo)) * (H - 2 * pad);
    let s = `<rect x="0" y="0" width="${W}" height="${Y(st.th.cpkGood)}" fill="var(--good-bg)" opacity=".6"/>`;
    s += `<rect x="0" y="${Y(st.th.cpkMin)}" width="${W}" height="${H - Y(st.th.cpkMin)}" fill="var(--bad-bg)" opacity=".6"/>`;
    let d = ''; let pen = false;
    vals.forEach((v, i) => { if (v == null) { pen = false; return; } d += `${pen ? 'L' : 'M'}${X(i).toFixed(1)} ${Y(v).toFixed(1)} `; pen = true; });
    s += `<path d="${d}" fill="none" stroke="var(--blue-600)" stroke-width="2" stroke-linejoin="round" stroke-linecap="round" vector-effect="non-scaling-stroke"/>`;
    const li = vals.map((v, i) => (v == null ? -1 : i)).filter((i) => i >= 0).pop();
    if (li != null && li >= 0) {
      const vd = verdict({ n: 1, cpk: series[li].cpk, with_spec: 1 });
      s += `<circle cx="${X(li)}" cy="${Y(vals[li])}" r="4" fill="var(--${vd.cls === 'good' ? 'good' : vd.cls === 'warn' ? 'caution' : 'bad'})" stroke="var(--surface)" stroke-width="2"/>`;
    }
    return `<svg viewBox="0 0 ${W} ${H}" preserveAspectRatio="none" aria-hidden="true">${s}</svg>`;
  }

  function renderLines() {
    let L = dayLines().slice();
    if (st.show === 'active') L = L.filter((l) => l.total.n > 0 || (trendOf(l.scale_id) && trendOf(l.scale_id).total.n > 0 && l.enabled !== false));
    const rank = (l) => (l.total.cpk == null ? (l.total.n ? 50 : 99) : l.total.cpk);
    L.sort(st.sort === 'worst' ? (a, b) => rank(a) - rank(b) : (a, b) => String(a.name).localeCompare(String(b.name), 'th', { numeric: true }));
    if (!L.length) {
      $('lines').innerHTML = `<div class="card empty" style="grid-column:1/-1;">${ic('factory')}ยังไม่มีไลน์ที่ผลิตในวันนี้${st.show === 'active' ? ' — กด "ทุกไลน์" เพื่อดูทั้งหมด' : ''}</div>`;
      return;
    }
    $('lines').innerHTML = L.map((l) => {
      const t = l.total; const v = verdict(t);
      const live = liveOf(l.scale_id);
      const tr = trendOf(l.scale_id);
      const dir = tr ? direction(tr.series) : { cls: 'flat', text: '' };
      const passPct = t.with_spec ? (t.pass / t.with_spec) * 100 : null;
      const failW = t.with_spec ? Math.max(t.fail ? 0.8 : 0, (t.fail / t.with_spec) * 100) : 0;
      const bar = t.with_spec
        ? `<div class="passbar" title="ผ่าน ${fpct(passPct)} · ไม่ผ่าน ${fpct(100 - passPct)}"><i class="p" style="width:${100 - failW}%"></i>${t.fail ? `<i class="f" style="width:${failW}%"></i>` : ''}</div>`
        : `<div class="passbar"><i class="u" style="width:100%"></i></div>`;
      const meta = [];
      if (t.products && t.products.length) meta.push(`Product: <b>${esc(t.products.slice(0, 4).join(', '))}${t.products.length > 4 ? ` +${t.products.length - 4}` : ''}</b>`);
      if (t.products && t.products.length === 1 && t.mean != null) meta.push(`เฉลี่ย ${t.mean.toFixed(2)} g · SD ${t.sd == null ? '-' : t.sd.toFixed(3)}`);
      if (t.cpk_min != null && t.docs > 1 && t.cpk_min < st.th.cpkMin) meta.push(`<span class="warnline">เอกสารที่แย่สุด Cpk ${t.cpk_min.toFixed(2)}</span>`);
      if (t.no_spec) meta.push(`<span class="warnline">ไม่มีเอกสาร ${fint(t.no_spec)} ชิ้น (ไม่รู้สเปก ไม่นับผ่าน/ไม่ผ่าน)</span>`);
      if (t.low_n) meta.push('<span class="warnline">Cpk จากเอกสารที่มีน้อยกว่า 30 ชิ้น — ยังเชื่อถือได้น้อย</span>');
      return `
      <article class="lc v-${v.cls}${t.n ? '' : ' empty-line'}${st.focus === l.scale_id ? ' focus' : ''}" data-id="${l.scale_id}" tabindex="0" aria-label="${esc(l.name)}">
        <div class="lc-head">
          <div class="lc-name"><b>${esc(l.name)}</b><small>${esc(l.line || '')}${l.program ? ` · ${esc(l.program)}` : ''}</small></div>
          ${live ? `<span class="pill ${live.cls}"><span class="dot"></span>${live.text}</span>` : ''}
        </div>
        <div class="lc-main">
          <div class="lc-cpk"><small>Cpk</small><b>${f2(t.cpk)}</b></div>
          <div class="lc-cp">Cp <b>${f2(t.cp)}</b></div>
          <span class="verdict ${v.cls}">${ic(v.icon)}${v.label}</span>
        </div>
        ${bar}
        <div class="lc-counts">
          <div><small>ทั้งหมด</small><b>${fint(t.n)}</b></div>
          <div><small>ผ่าน</small><b>${fint(t.pass)}</b><em>${fpct(passPct)}</em></div>
          <div class="fail"><small>ไม่ผ่าน${t.fail ? ` (เกิน ${fint(t.over)} · ขาด ${fint(t.under)})` : ''}</small><b>${fint(t.fail)}</b></div>
        </div>
        <div class="lc-meta">${meta.join(' · ') || '&nbsp;'}</div>
        <div class="lc-trend">
          ${tr ? sparkSvg(tr.series) : ''}
          <div class="tdir ${dir.cls}">${dir.text}<small>Cpk ${st.nBack} ${PERIODS[st.period].unit}</small></div>
        </div>
        <div class="lc-links">
          <a class="btn small" href="dashboard.html?scale=${l.scale_id}">${ic('dashboard')}Dashboard</a>
          <a class="btn small" href="analysis.html?scale=${l.scale_id}&view=cap&range=${st.period === 'day' ? '30d' : st.period === 'week' ? '30d' : '1y'}">${ic('activity')}วิเคราะห์</a>
          <a class="btn small ghost" href="history.html?scaleId=${l.scale_id}">${ic('history')}เอกสาร</a>
        </div>
      </article>`;
    }).join('');
  }

  function renderFocusSelect() {
    const L = trendLines().filter((l) => l.total.n > 0);
    if (!st.focus || !L.some((l) => l.scale_id === st.focus)) {
      const worst = L.slice().sort((a, b) => (a.total.cpk ?? 99) - (b.total.cpk ?? 99))[0];
      st.focus = worst ? worst.scale_id : null;
    }
    $('focusSel').innerHTML = L.length
      ? L.map((l) => `<option value="${l.scale_id}"${l.scale_id === st.focus ? ' selected' : ''}>เน้น: ${esc(l.name)}</option>`).join('')
      : '<option value="">ไม่มีข้อมูล</option>';
    document.querySelectorAll('.lc').forEach((c) => c.classList.toggle('focus', Number(c.dataset.id) === st.focus));
  }

  // ------------------------------------------------------------------ กราฟแนวโน้ม
  let geom = null;
  function metricVal(s, key) {
    if (!s || !s.n) return null;
    if (key === 'n') return s.n;
    return s[key] == null ? null : s[key];
  }
  function niceStep(span, target) {
    const raw = span / Math.max(1, target); const mag = 10 ** Math.floor(Math.log10(raw || 1));
    return [1, 2, 2.5, 5, 10].map((m) => m * mag).find((x) => x >= raw) || raw;
  }

  function renderTrend() {
    const svg = $('trendSvg'); const wrap = $('trendWrap');
    const W = Math.max(320, wrap.clientWidth); const H = wrap.clientHeight || 360;
    svg.setAttribute('viewBox', `0 0 ${W} ${H}`);
    const L = trendLines().filter((l) => l.total.n > 0);
    const focus = L.find((l) => l.scale_id === st.focus) || L[0];
    const key = st.metric;
    if (!L.length || !focus) {
      svg.innerHTML = `<text x="${W / 2}" y="${H / 2}" text-anchor="middle" font-size="14" fill="var(--ink-3)">ยังไม่มีข้อมูลในช่วงนี้</text>`;
      $('trendLegend').innerHTML = ''; geom = null; return;
    }
    const periods = focus.series.map((s) => s.t);
    const nP = periods.length;
    const padL = 52; const padR = 56; const padT = 18; const padB = 34;
    const pw = W - padL - padR; const ph = H - padT - padB;
    const slot = pw / nP;
    const X = (i) => padL + (i + 0.5) * slot;
    let lo; let hi;
    if (key === 'cpk' || key === 'cp') {
      const all = L.flatMap((l) => l.series.map((s) => metricVal(s, key))).filter((v) => v != null);
      lo = Math.min(0, ...all); hi = Math.max(2, ...all.map((v) => Math.min(v, 4))) * 1.06; lo = Math.max(lo, -1);
    } else if (key === 'pass_pct') {
      const all = L.flatMap((l) => l.series.map((s) => metricVal(s, key))).filter((v) => v != null);
      lo = Math.max(0, Math.floor((Math.min(...all, 99) - 0.5) / 0.5) * 0.5); hi = 100.2;
    } else {
      lo = 0; hi = Math.max(1, ...focus.series.map((s) => s.n)) * 1.1;
    }
    const Y = (v) => padT + (1 - (Math.max(lo, Math.min(hi, v)) - lo) / (hi - lo)) * ph;
    let s = '';
    // แถบเกณฑ์ (Cp/Cpk)
    if (key === 'cpk' || key === 'cp') {
      const gMin = key === 'cp' ? st.th.cpMin : st.th.cpkMin;
      const band = (a, b, fill) => { const ya = Y(Math.min(hi, b)); const yb = Y(Math.max(lo, a)); if (yb > ya) s += `<rect x="${padL}" y="${ya}" width="${pw}" height="${yb - ya}" fill="${fill}"/>`; };
      band(st.th.cpkGood, hi, 'var(--good-bg)'); band(gMin, st.th.cpkGood, 'var(--caution-bg)'); band(lo, gMin, 'var(--bad-bg)');
      for (const [v, lbl, col] of [[st.th.cpkGood, `${st.th.cpkGood.toFixed(2)} ดี`, 'var(--good)'], [gMin, `${gMin.toFixed(2)} ขั้นต่ำ`, 'var(--bad)']]) {
        if (v < lo || v > hi) continue;
        s += `<line x1="${padL}" x2="${padL + pw}" y1="${Y(v)}" y2="${Y(v)}" stroke="${col}" stroke-width="1" opacity=".7"/>`;
        s += `<text x="${padL + pw + 6}" y="${Y(v) + 4}" font-size="11.5" font-weight="600" fill="${col}">${lbl}</text>`;
      }
    }
    // เส้นตาราง + แกน Y
    const step = key === 'pass_pct' ? niceStep(hi - lo, 5) : niceStep(hi - lo, 5);
    for (let v = Math.ceil(lo / step) * step; v <= hi + 1e-9; v += step) {
      const y = Y(v);
      if (!(key === 'cpk' || key === 'cp')) s += `<line x1="${padL}" x2="${padL + pw}" y1="${y}" y2="${y}" stroke="var(--hairline-2)" stroke-width="1"/>`;
      const t = key === 'n' ? (v >= 1000 ? `${+(v / 1000).toFixed(1)}k` : v.toFixed(0)) : key === 'pass_pct' ? `${+v.toFixed(1)}%` : v.toFixed(step < 0.5 ? 2 : 1);
      s += `<text x="${padL - 8}" y="${y + 4}" font-size="11.5" fill="var(--ink-3)" text-anchor="end">${t}</text>`;
    }
    s += `<line x1="${padL}" x2="${padL + pw}" y1="${padT + ph}" y2="${padT + ph}" stroke="var(--hairline)" stroke-width="1"/>`;
    // แกน X
    const every = Math.max(1, Math.ceil(74 / slot));
    periods.forEach((p, i) => {
      if ((nP - 1 - i) % every) return; // ให้ช่วงล่าสุดมีป้ายเสมอ
      s += `<text x="${X(i)}" y="${H - 10}" font-size="11.5" fill="var(--ink-3)" text-anchor="middle">${esc(periodLabel(parseDay(p), st.period, false))}</text>`;
    });
    if (key === 'n') {
      // จำนวนชิ้นของไลน์ที่เน้น: แท่งผ่าน (เขียว) + ไม่ผ่าน (แดง) + ไม่มีสเปก (เทา) ซ้อนกัน
      const bw = Math.max(3, Math.min(34, slot * 0.6));
      focus.series.forEach((sr, i) => {
        if (!sr.n) return;
        const x = X(i) - bw / 2; let base = padT + ph;
        const seg = (v, fill) => { if (!v) return; const h = (v / (hi - lo)) * ph; s += `<rect x="${x}" y="${base - h}" width="${bw}" height="${Math.max(1, h - (base === padT + ph ? 0 : 2))}" fill="${fill}" rx="${base === padT + ph ? 0 : 3}"/>`; base -= h; };
        seg(sr.pass, 'var(--good)'); seg(sr.fail, 'var(--bad)'); seg(sr.no_spec, 'var(--ink-3)');
      });
      const last = focus.series.map((x, i) => [x, i]).filter(([x]) => x.n).pop();
      if (last) s += `<text x="${X(last[1])}" y="${Y(last[0].n) - 6}" font-size="12" font-weight="700" fill="var(--ink)" text-anchor="middle">${fint(last[0].n)}</text>`;
    } else {
      // ไลน์อื่น = เส้นเทาบาง (บริบท), ไลน์ที่เน้น = เส้นน้ำเงิน + จุดสีตามผล
      const path = (series) => { let d = ''; let pen = false; series.forEach((sr, i) => { const v = metricVal(sr, key); if (v == null) { pen = false; return; } d += `${pen ? 'L' : 'M'}${X(i).toFixed(1)} ${Y(v).toFixed(1)} `; pen = true; }); return d; };
      for (const l of L) {
        if (l === focus) continue;
        s += `<path d="${path(l.series)}" fill="none" stroke="var(--ink-3)" stroke-width="1.25" opacity=".45" stroke-linejoin="round"/>`;
      }
      s += `<path d="${path(focus.series)}" fill="none" stroke="var(--blue-600)" stroke-width="2.25" stroke-linejoin="round" stroke-linecap="round"/>`;
      const pts = focus.series.map((sr, i) => [metricVal(sr, key), i, sr]).filter(([v]) => v != null);
      for (const [v, i, sr] of pts) {
        const vd = key === 'pass_pct' ? null : verdict(sr, key);
        const fill = vd ? `var(--${vd.cls === 'good' ? 'good' : vd.cls === 'warn' ? 'caution' : vd.cls === 'bad' ? 'bad' : 'ink-3'})` : 'var(--blue-600)';
        s += `<circle cx="${X(i)}" cy="${Y(v)}" r="${slot >= 14 ? 4.5 : 3}" fill="${fill}" stroke="var(--surface)" stroke-width="2"/>`;
      }
      // ป้ายค่าแบบเลือก: ล่าสุด + ต่ำสุด
      if (pts.length) {
        const lastP = pts[pts.length - 1];
        const minP = pts.reduce((a, b) => (b[0] < a[0] ? b : a));
        const lbl = ([v, i], strong) => { s += `<text x="${X(i)}" y="${Y(v) - 10}" font-size="${strong ? 12.5 : 11.5}" font-weight="700" fill="var(--ink)" text-anchor="${i > nP - 2 ? 'end' : 'middle'}">${METRICS[key].fmt(v)}</text>`; };
        lbl(lastP, true);
        if (minP !== lastP && pts.length > 2) lbl(minP, false);
      }
    }
    s += `<line id="tCross" x1="0" x2="0" y1="${padT}" y2="${padT + ph}" stroke="var(--ink-2)" stroke-width="1" opacity="0"/>`;
    s += `<rect id="tHit" x="${padL}" y="${padT}" width="${pw}" height="${ph}" fill="transparent"/>`;
    svg.innerHTML = s;
    geom = { padL, padT, pw, ph, slot, nP, X, L, focus, periods, key };
    // legend
    const lg = [];
    lg.push(`<span><i class="sw" style="background:var(--blue-600)"></i>${esc(focus.name)} (ไลน์ที่เน้น)</span>`);
    if (key !== 'n' && L.length > 1) lg.push(`<span><i class="sw" style="background:var(--ink-3); opacity:.6"></i>ไลน์อื่น ${L.length - 1} ไลน์</span>`);
    if (key === 'n') {
      lg.push('<span><i class="bx" style="background:var(--good)"></i>ผ่าน</span><span><i class="bx" style="background:var(--bad)"></i>ไม่ผ่าน</span><span><i class="bx" style="background:var(--ink-3)"></i>ไม่มีเอกสาร/สเปก</span>');
    } else if (key !== 'pass_pct') {
      lg.push(`<span><i class="bx" style="background:var(--good-bg); border:1px solid var(--good)"></i>ดี ≥ ${st.th.cpkGood}</span><span><i class="bx" style="background:var(--caution-bg); border:1px solid var(--caution)"></i>พอใช้</span><span><i class="bx" style="background:var(--bad-bg); border:1px solid var(--bad)"></i>ต้องปรับปรุง &lt; ${(key === 'cp' ? st.th.cpMin : st.th.cpkMin).toFixed(2)}</span>`);
    }
    lg.push('<span class="muted">ชี้ที่กราฟเพื่อดูค่าทุกไลน์ · กดการ์ดด้านบนเพื่อเปลี่ยนไลน์ที่เน้น</span>');
    $('trendLegend').innerHTML = lg.join('');
  }

  function hoverAt(clientX) {
    const tip = $('ttip');
    if (!geom) { tip.style.display = 'none'; return; }
    const svg = $('trendSvg'); const r = svg.getBoundingClientRect();
    const vb = svg.viewBox.baseVal; const sx = vb.width / r.width;
    const x = (clientX - r.left) * sx;
    const i = Math.floor((x - geom.padL) / geom.slot);
    const cross = svg.querySelector('#tCross');
    if (i < 0 || i >= geom.nP) { tip.style.display = 'none'; if (cross) cross.setAttribute('opacity', '0'); return; }
    const cx = geom.X(i);
    cross.setAttribute('x1', cx); cross.setAttribute('x2', cx); cross.setAttribute('opacity', '.5');
    const key = geom.key;
    const rows = geom.L.map((l) => ({ l, s: l.series[i], v: metricVal(l.series[i], key) }))
      .sort((a, b) => (a.l === geom.focus ? -1 : b.l === geom.focus ? 1 : (a.v ?? -1e9) < (b.v ?? -1e9) ? -1 : 1));
    const f = rows[0].s;
    const extra = f && f.n ? `<div class="muted" style="margin:2px 0 6px;">${esc(geom.focus.name)}: ${fint(f.n)} ชิ้น · ผ่าน ${fint(f.pass)} · ไม่ผ่าน ${fint(f.fail)}${f.no_spec ? ` · ไม่มีสเปก ${fint(f.no_spec)}` : ''}</div>` : '';
    tip.innerHTML = `<div class="th">${esc(periodLabel(parseDay(geom.periods[i]), st.period, true))}</div>${extra}` +
      rows.map(({ l, s: sr, v }) => {
        const vd = verdict(sr, key === 'cp' ? 'cp' : 'cpk');
        return `<div class="row${l === geom.focus ? ' me' : ''}"><i class="dot ${vd.cls}"></i><span>${esc(l.name)}</span><b>${v == null ? '-' : METRICS[key].fmt(v)}</b></div>`;
      }).join('');
    tip.style.display = 'block';
    const wrap = $('trendWrap'); const tw = tip.offsetWidth; const th = tip.offsetHeight;
    const px = cx / sx;
    let left = px + 14; if (left + tw > wrap.clientWidth - 4) left = px - tw - 14;
    tip.style.left = `${Math.max(4, left)}px`;
    tip.style.top = `${Math.max(4, Math.min(wrap.clientHeight - th - 4, 12))}px`;
  }

  // ------------------------------------------------------------------ ตารางสี
  function cellClass(v, key, sr) {
    if (v == null) return 'na';
    if (key === 'cpk' || key === 'cp') return verdict(sr, key).cls;
    return '';
  }
  function renderHeatmap() {
    const L = trendLines().filter((l) => st.show === 'all' || l.total.n > 0);
    const key = st.metric;
    if (!L.length) { $('hmTable').innerHTML = ''; return; }
    const periods = L[0].series.map((s) => s.t);
    const head = `<thead><tr><th class="ln">ไลน์ · ${esc(METRICS[key].label)}</th>${periods.map((p) => `<th>${esc(periodLabel(parseDay(p), st.period, false))}</th>`).join('')}<th class="tot">รวมทั้งช่วง</th></tr></thead>`;
    const body = L.map((l) => {
      const cells = l.series.map((sr) => {
        const v = metricVal(sr, key);
        const tip = sr.n ? `${l.name} · ${periodLabel(parseDay(sr.t), st.period, true)}\n${fint(sr.n)} ชิ้น · ผ่าน ${fint(sr.pass)} · ไม่ผ่าน ${fint(sr.fail)}\nCp ${f2(sr.cp)} · Cpk ${f2(sr.cpk)}${sr.products && sr.products.length ? `\nProduct: ${sr.products.join(', ')}` : ''}` : 'ไม่ได้ผลิต';
        return `<td class="cell ${cellClass(v, key, sr)}" title="${esc(tip)}">${v == null ? '–' : METRICS[key].fmt(v)}</td>`;
      }).join('');
      const tv = metricVal(l.total, key);
      return `<tr class="${l.scale_id === st.focus ? 'focus' : ''}" data-id="${l.scale_id}"><td class="ln">${esc(l.name)}</td>${cells}<td class="cell tot ${cellClass(tv, key, l.total)}">${tv == null ? '–' : METRICS[key].fmt(tv)}</td></tr>`;
    }).join('');
    $('hmTable').innerHTML = head + `<tbody>${body}</tbody>`;
    const wrap = $('hmTable').parentElement; wrap.scrollLeft = wrap.scrollWidth; // ช่วงล่าสุดอยู่ขวา
  }

  function renderGuide() {
    $('guide').innerHTML = `
      <div class="crit"><b>เกณฑ์ Cpk</b>
        <span class="verdict good">${ic('ok')}ดี — Cpk ≥ ${st.th.cpkGood}</span>
        <span class="verdict warn">${ic('alert')}พอใช้ — ${st.th.cpkMin.toFixed(2)} ถึง ${st.th.cpkGood}</span>
        <span class="verdict bad">${ic('alert')}ต้องปรับปรุง — Cpk &lt; ${st.th.cpkMin.toFixed(2)}</span>
        <span class="muted" style="font-size:12px;">ค่าขั้นต่ำมาจากหน้า "ตั้งค่า" (Cpk ต่ำสุด)</span></div>
      <div><b>Cp กับ Cpk ต่างกันอย่างไร</b><br>Cp = ช่วงสเปกกว้างกว่าการกระจายของน้ำหนักกี่เท่า (ดูแค่ความนิ่ง) · Cpk = เหมือน Cp แต่หักเรื่องค่าเฉลี่ยเยื้องจาก Target ด้วย — ถ้า Cp ดีแต่ Cpk ต่ำ แปลว่าเครื่องนิ่งแต่ตั้งน้ำหนักเยื้อง ให้ปรับ Target ของเครื่อง</div>
      <div><b>นับผ่าน / ไม่ผ่านอย่างไร</b><br>ผ่าน = อยู่ในช่วง LSL–USL ของเอกสารที่เปิดตอนชั่งชิ้นนั้น · ชิ้นที่ชั่งตอนไม่มีเอกสาร ไม่รู้สเปก จึงแยกเป็น "ไม่มีเอกสาร" (ไม่นับเป็นผ่านหรือไม่ผ่าน)</div>
      <div><b>Cpk ของไลน์ทั้งวัน / ทั้งสัปดาห์</b><br>คิด Cpk ของแต่ละเอกสารก่อน แล้วเฉลี่ยถ่วงตามจำนวนชิ้น (ไลน์เดียวอาจผลิตหลาย Product ที่สเปกต่างกัน) · เอกสารที่มีน้อยกว่า ${(st.trendData && st.trendData.min_n_for_cpk) || 30} ชิ้นไม่นำมาคิด</div>`;
  }

  // ------------------------------------------------------------------ CSV
  function exportCsv() {
    const L = trendLines();
    const rows = [['line', 'period_start', 'pieces', 'pass', 'fail', 'over_usl', 'under_lsl', 'no_spec', 'pass_pct', 'cp', 'cpk', 'cpk_min_doc', 'products']];
    for (const l of L) for (const s of l.series) rows.push([l.name, s.t, s.n, s.pass, s.fail, s.over, s.under, s.no_spec, s.pass_pct ?? '', s.cp ?? '', s.cpk ?? '', s.cpk_min ?? '', (s.products || []).join(' ')]);
    const csv = rows.map((r) => r.map((c) => { const t = String(c ?? ''); return /[",\n]/.test(t) ? `"${t.replace(/"/g, '""')}"` : t; }).join(',')).join('\r\n');
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob(['﻿' + csv], { type: 'text/csv;charset=utf-8' }));
    a.download = `line-summary_${st.period}_${dayKey(st.day)}.csv`;
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 2000);
  }

  // ------------------------------------------------------------------ events
  function setDay(d) {
    const today = startOfDay(new Date());
    st.day = d > today ? today : startOfDay(d);
    loadAll();
  }
  $('dayInput').addEventListener('change', () => { const d = parseDay($('dayInput').value); if (d) setDay(d); });
  $('btnPrev').addEventListener('click', () => setDay(shiftPeriod(st.day, 'day', -1)));
  $('btnNext').addEventListener('click', () => setDay(shiftPeriod(st.day, 'day', 1)));
  $('btnToday').addEventListener('click', () => setDay(new Date()));
  $('btnRefresh').addEventListener('click', () => loadAll());
  $('btnCsv').addEventListener('click', exportCsv);
  $('btnPrint').addEventListener('click', () => window.print());
  $('periodSeg').addEventListener('click', (e) => {
    const b = e.target.closest('button'); if (!b || b.dataset.v === st.period) return;
    st.period = b.dataset.v; store.set('sum-period', st.period);
    const n = Number.parseInt(store.get(`sum-n-${st.period}`) || '', 10);
    st.nBack = clampN(Number.isFinite(n) ? n : PERIODS[st.period].def, st.period);
    loadAll();
  });
  let nTimer = null;
  $('nBack').addEventListener('input', () => {
    clearTimeout(nTimer);
    nTimer = setTimeout(() => {
      const n = clampN(Number($('nBack').value), st.period);
      if (n === st.nBack) return;
      st.nBack = n; store.set(`sum-n-${st.period}`, n); loadAll();
    }, 600);
  });
  $('metricSeg').addEventListener('click', (e) => {
    const b = e.target.closest('button'); if (!b) return;
    st.metric = b.dataset.v; syncUrl(); renderControls(); renderTrend(); renderHeatmap();
  });
  $('showSeg').addEventListener('click', (e) => {
    const b = e.target.closest('button'); if (!b) return;
    st.show = b.dataset.v; store.set('sum-show', st.show); renderControls(); renderLines(); renderFocusSelect(); renderHeatmap();
  });
  $('sortSeg').addEventListener('click', (e) => {
    const b = e.target.closest('button'); if (!b) return;
    st.sort = b.dataset.v; store.set('sum-sort', st.sort); renderControls(); renderLines(); renderFocusSelect();
  });
  function setFocus(id) {
    st.focus = id; store.set('sum-focus', id); syncUrl();
    renderFocusSelect(); renderTrend(); renderHeatmap();
  }
  $('focusSel').addEventListener('change', () => setFocus(Number($('focusSel').value) || null));
  $('lines').addEventListener('click', (e) => {
    if (e.target.closest('a')) return;
    const c = e.target.closest('.lc'); if (!c) return;
    setFocus(Number(c.dataset.id));
    document.querySelector('.trend-card').scrollIntoView({ behavior: 'smooth', block: 'start' });
  });
  $('lines').addEventListener('keydown', (e) => {
    if (e.key !== 'Enter' && e.key !== ' ') return;
    const c = e.target.closest('.lc'); if (!c) return;
    e.preventDefault(); setFocus(Number(c.dataset.id));
  });
  $('hmTable').addEventListener('click', (e) => { const tr = e.target.closest('tr[data-id]'); if (tr) setFocus(Number(tr.dataset.id)); });
  $('trendWrap').addEventListener('mousemove', (e) => hoverAt(e.clientX));
  $('trendWrap').addEventListener('mouseleave', () => { $('ttip').style.display = 'none'; const c = document.getElementById('tCross'); if (c) c.setAttribute('opacity', '0'); });
  $('trendWrap').addEventListener('touchstart', (e) => { if (e.touches[0]) hoverAt(e.touches[0].clientX); }, { passive: true });
  if (window.ResizeObserver) new ResizeObserver(() => renderTrend()).observe($('trendWrap'));
  window.addEventListener('themechange', () => renderTrend());

  loadAll();
  // วันนี้: อัปเดตเองทุก 60 วินาที (ไม่กระพริบ)
  setInterval(() => {
    if (document.hidden) return;
    if (st.day.getTime() === startOfDay(new Date()).getTime()) loadAll({ quiet: true });
  }, 60000);
})();
