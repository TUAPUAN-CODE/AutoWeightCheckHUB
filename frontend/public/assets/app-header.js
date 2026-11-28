/**
 * app-header.js — เมนูด้านบน (แทน sidebar เดิม) ใช้ร่วมกันทุกหน้า
 *
 *   <body data-page="monitor">
 *   <script src="assets/app-header.js"></script>   ← วางเป็นบรรทัดแรกใน <body>
 *
 * data-page: monitor | dashboard | line3d | summary | history | config
 * มี helper window.icon('scale', 'sm') คืน <svg> จาก assets/icons.svg ไว้ใช้ใน template ของแต่ละหน้า
 * ภาษา (ไทย / English / မြန်မာ / ខ្មែរ) และโหมดมืด จำไว้ใน localStorage ของเครื่องนั้น
 */
(function () {
  const SPRITE = 'assets/icons.svg';
  const NAV_ITEMS = [
    { key: 'monitor', href: 'monitor.html', label: 'Monitor', icon: 'monitor', desc: 'สถานะเครื่องทั้งหมด' },
    { key: 'dashboard', href: 'dashboard.html', label: 'Dashboard', icon: 'dashboard', desc: 'กราฟ SPC แบบเรียลไทม์' },
    { key: 'line3d', href: 'line3d.html', label: 'สายพาน 3D', icon: 'package', desc: 'ภาพ 3D สายพานเครื่องชั่ง — ถุงวิ่งตามข้อมูลจริง' },
    { key: 'summary', href: 'summary.html', label: 'สรุปผล', icon: 'chart-bar', desc: 'สรุปรายวันรายไลน์ · แนวโน้ม Cp / Cpk' },
    { key: 'history', href: 'history.html', label: 'ประวัติ', icon: 'history', desc: 'เอกสารย้อนหลัง / ค้นหา' },
    { key: 'config', href: 'config.html', label: 'ตั้งค่า', icon: 'settings', desc: 'เกณฑ์แจ้งเตือน Cp / Cpk / Ppk' },
  ];
  const LANGS = [
    { key: 'th', label: 'ไทย', locale: 'th-TH' },
    { key: 'en', label: 'English', locale: 'en-GB' },
    { key: 'my', label: 'မြန်မာ', locale: 'my-MM' },
    { key: 'km', label: 'ខ្មែរ', locale: 'km-KH' },
  ];

  const store = {
    get(k) { try { return localStorage.getItem(k); } catch (e) { return null; } },
    set(k, v) { try { localStorage.setItem(k, v); } catch (e) { /* ใช้ได้เฉพาะรอบนี้ */ } },
  };

  // ---- โหมดมืด: ตั้งก่อนวาดหน้า จะได้ไม่กระพริบ ----
  const theme = store.get('aw-theme') === 'dark' ? 'dark' : 'light';
  document.documentElement.setAttribute('data-theme', theme);

  // ---- ภาษา: ไทยไม่ต้องโหลดอะไรเพิ่ม, ภาษาอื่นโหลดพจนานุกรม + ตัวแปลหน้า ----
  const lang = LANGS.some((l) => l.key === store.get('aw-lang')) ? store.get('aw-lang') : 'th';
  window.AW_LANG = lang;
  window.t = window.t || ((s) => s); // ตัวแปลข้อความที่วาดลง canvas — i18n.js แทนที่เมื่อไม่ใช่ภาษาไทย
  if (lang !== 'th') {
    document.documentElement.lang = lang;
    for (const src of ['assets/i18n-dict.js', 'assets/i18n.js']) {
      const sc = document.createElement('script');
      sc.src = src;
      sc.async = false; // โหลดตามลำดับ (พจนานุกรมก่อนตัวแปล)
      document.head.appendChild(sc);
    }
  }

  function icon(name, cls) {
    return `<svg class="i${cls ? ' ' + cls : ''}" aria-hidden="true"><use href="${SPRITE}#${name}"></use></svg>`;
  }
  window.icon = icon;

  const current = document.body.getAttribute('data-page') || '';

  const bar = document.createElement('div');
  bar.id = 'appbar';
  bar.setAttribute('role', 'navigation');
  bar.innerHTML = `
    <div class="ab-inner">
      <a class="ab-brand" href="monitor.html" aria-label="Auto Weight — หน้าแรก">
        <img class="ab-logo" src="assets/logo.svg" alt="">
        <span class="ab-name"><b>Auto<span>Weight</span></b><small>SPC · Checkweigher</small></span>
      </a>
      <nav class="ab-nav">
        ${NAV_ITEMS.map((n) => `
          <a class="ab-link${n.key === current ? ' active' : ''}" href="${n.href}" title="${n.desc}"${n.key === current ? ' aria-current="page"' : ''}>
            <span class="ab-pill"></span>${icon(n.icon)}<span>${n.label}</span>
          </a>`).join('')}
      </nav>
      <div class="ab-right">
        <div class="ab-clock" aria-live="off"><b id="abTime">--:--:--</b><small id="abDate"></small></div>
        <div class="ab-tools">
          <label class="ab-lang-wrap" title="ภาษา">${icon('lang')}
            <select class="ab-lang" id="abLang" aria-label="ภาษา">${LANGS.map((l) => `<option value="${l.key}"${l.key === lang ? ' selected' : ''}>${l.label}</option>`).join('')}</select>
          </label>
          <button class="btn icon-only ab-theme" id="abTheme" type="button" title="สลับโหมดมืด / สว่าง" aria-label="สลับโหมดมืด / สว่าง">${icon(theme === 'dark' ? 'sun' : 'moon')}</button>
          <button class="btn icon-only ab-menu-btn" type="button" aria-label="เปิดเมนู" aria-expanded="false">${icon('menu')}</button>
        </div>
      </div>
    </div>
    <div class="ab-drawer">
      ${NAV_ITEMS.map((n) => `
        <a class="${n.key === current ? 'active' : ''}" href="${n.href}">${icon(n.icon)}<span>${n.label}<small>${n.desc}</small></span></a>`).join('')}
    </div>`;

  const me = document.currentScript;
  if (me && me.parentNode) me.parentNode.insertBefore(bar, me);
  else document.body.prepend(bar);

  const btn = bar.querySelector('.ab-menu-btn');
  btn.addEventListener('click', () => {
    const open = bar.classList.toggle('open');
    btn.setAttribute('aria-expanded', open ? 'true' : 'false');
  });
  document.addEventListener('click', (e) => {
    if (bar.classList.contains('open') && !bar.contains(e.target)) {
      bar.classList.remove('open');
      btn.setAttribute('aria-expanded', 'false');
    }
  });

  bar.querySelector('#abLang').addEventListener('change', (e) => {
    store.set('aw-lang', e.target.value);
    location.reload(); // แปลทั้งหน้าใหม่ตั้งแต่ต้น ง่ายและไม่ตกหล่น
  });
  const themeBtn = bar.querySelector('#abTheme');
  themeBtn.addEventListener('click', () => {
    const next = document.documentElement.getAttribute('data-theme') === 'dark' ? 'light' : 'dark';
    document.documentElement.setAttribute('data-theme', next);
    store.set('aw-theme', next);
    themeBtn.innerHTML = icon(next === 'dark' ? 'sun' : 'moon');
    window.dispatchEvent(new Event('themechange')); // ให้กราฟ canvas วาดใหม่ด้วยสีของธีม
  });

  const tEl = bar.querySelector('#abTime');
  const dEl = bar.querySelector('#abDate');
  const pad = (n) => String(n).padStart(2, '0');
  const locale = (LANGS.find((l) => l.key === lang) || LANGS[0]).locale;
  function tick() {
    const d = new Date();
    tEl.textContent = `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
    try {
      dEl.textContent = d.toLocaleDateString(locale, { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric' });
    } catch (e) {
      dEl.textContent = d.toLocaleDateString('th-TH', { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric' });
    }
  }
  tick();
  setInterval(tick, 1000);
})();
