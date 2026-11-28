/**
 * app-header.js — เมนูด้านบน (แทน sidebar เดิม) ใช้ร่วมกันทุกหน้า
 *
 *   <body data-page="monitor">
 *   <script src="assets/app-header.js"></script>   ← วางเป็นบรรทัดแรกใน <body>
 *
 * data-page: monitor | dashboard | checkweigher | history | config
 * มี helper window.icon('scale', 'sm') คืน <svg> จาก assets/icons.svg ไว้ใช้ใน template ของแต่ละหน้า
 */
(function () {
  const SPRITE = 'assets/icons.svg';
  const NAV_ITEMS = [
    { key: 'monitor', href: 'monitor.html', label: 'Monitor', icon: 'monitor', desc: 'สถานะเครื่องทั้งหมด' },
    { key: 'dashboard', href: 'dashboard.html', label: 'Dashboard', icon: 'dashboard', desc: 'กราฟ SPC แบบเรียลไทม์' },
    { key: 'checkweigher', href: 'checkweigher.html', label: 'Checkweigher', icon: 'scale', desc: 'น้ำหนักรายชิ้น / ผลตัดสิน' },
    { key: 'history', href: 'history.html', label: 'ประวัติ', icon: 'history', desc: 'เอกสารย้อนหลัง / ค้นหา' },
    { key: 'config', href: 'config.html', label: 'ตั้งค่า', icon: 'settings', desc: 'เกณฑ์แจ้งเตือน Cp / Cpk / Ppk' },
  ];

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
        <button class="btn icon-only ab-menu-btn" type="button" aria-label="เปิดเมนู" aria-expanded="false">${icon('menu')}</button>
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

  const tEl = bar.querySelector('#abTime');
  const dEl = bar.querySelector('#abDate');
  const pad = (n) => String(n).padStart(2, '0');
  function tick() {
    const d = new Date();
    tEl.textContent = `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
    dEl.textContent = d.toLocaleDateString('th-TH', { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric' });
  }
  tick();
  setInterval(tick, 1000);
})();
