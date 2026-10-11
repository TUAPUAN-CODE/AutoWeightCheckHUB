/**
 * sidebar.js — sidebar (hamburger เปิด/ปิดได้) ใช้ร่วมกันทุกหน้า
 * แต่ละหน้าแค่ใส่ <div id="app-sidebar-root"></div> ที่ต้นๆของ <body> แล้วโหลดสคริปต์นี้
 * ระบุหน้าปัจจุบันด้วย <body data-page="monitor|dashboard|history">
 */
(function () {
  const NAV_ITEMS = [
    { key: 'monitor', href: 'monitor.html', label: 'Monitor', icon: '📡', desc: 'สถานะเครื่องชั่งทั้งหมด' },
    { key: 'dashboard', href: 'dashboard.html', label: 'Dashboard', icon: '📊', desc: 'กราฟ SPC แบบเรียลไทม์' },
    { key: 'history', href: 'history.html', label: 'ประวัติ', icon: '🗂️', desc: 'เอกสารย้อนหลัง / ค้นหา' },
    { key: 'config', href: 'config.html', label: 'ตั้งค่า', icon: '⚙️', desc: 'เกณฑ์แจ้งเตือน Cp/Cpk/Ppk' },
  ];

  const STYLE = `
    :root{ --sb-w: 236px; --sb-w-collapsed: 60px; }
    #app-sidebar{
      position:fixed; top:0; left:0; bottom:0; width:var(--sb-w); z-index:1000;
      background:#12172b; color:#e8ecf7; display:flex; flex-direction:column;
      font-family:Tahoma,Geneva,Verdana,sans-serif; transition:width .18s ease;
      box-shadow:2px 0 10px rgba(0,0,0,0.15); overflow:hidden;
    }
    #app-sidebar.collapsed{ width:var(--sb-w-collapsed); }
    #app-sidebar .sb-head{ display:flex; align-items:center; gap:10px; padding:14px 14px; border-bottom:1px solid rgba(255,255,255,0.08); flex:0 0 auto; }
    #app-sidebar .sb-burger{
      width:34px; height:34px; flex:none; border-radius:8px; border:1px solid rgba(255,255,255,0.15);
      background:rgba(255,255,255,0.05); color:#fff; cursor:pointer; font-size:16px; display:flex; align-items:center; justify-content:center;
    }
    #app-sidebar .sb-burger:hover{ background:rgba(255,255,255,0.12); }
    #app-sidebar .sb-title{ font-weight:700; font-size:14px; white-space:nowrap; overflow:hidden; }
    #app-sidebar .sb-title small{ display:block; font-weight:400; font-size:10px; color:rgba(255,255,255,0.55); letter-spacing:.06em; }
    #app-sidebar.collapsed .sb-title{ display:none; }
    #app-sidebar nav{ flex:1; padding:10px 8px; overflow-y:auto; }
    #app-sidebar a.sb-link{
      display:flex; align-items:center; gap:12px; padding:10px 10px; border-radius:8px; margin-bottom:4px;
      color:#c9cfe6; text-decoration:none; font-size:13px; font-weight:600; white-space:nowrap; overflow:hidden;
    }
    #app-sidebar a.sb-link .sb-icon{ font-size:17px; flex:none; width:20px; text-align:center; }
    #app-sidebar a.sb-link .sb-label small{ display:block; font-weight:400; font-size:10.5px; color:rgba(255,255,255,0.45); }
    #app-sidebar a.sb-link:hover{ background:rgba(255,255,255,0.06); color:#fff; }
    #app-sidebar a.sb-link.active{ background:linear-gradient(135deg,#2f8fef,#7c5cff); color:#fff; }
    #app-sidebar.collapsed a.sb-link .sb-label{ display:none; }
    #app-sidebar .sb-foot{ padding:10px 14px; font-size:10px; color:rgba(255,255,255,0.35); border-top:1px solid rgba(255,255,255,0.08); flex:0 0 auto; }
    #app-sidebar.collapsed .sb-foot{ display:none; }

    body{ padding-left: var(--sb-w) !important; transition: padding-left .18s ease; }
    body.sb-collapsed{ padding-left: var(--sb-w-collapsed) !important; }
    @media (max-width: 860px){
      #app-sidebar{ width:var(--sb-w-collapsed); }
      #app-sidebar.expanded{ width:var(--sb-w); }
      #app-sidebar.expanded .sb-title, #app-sidebar.expanded a.sb-link .sb-label{ display:block; }
      body{ padding-left: var(--sb-w-collapsed) !important; }
    }
  `;

  function injectStyle() {
    const s = document.createElement('style');
    s.textContent = STYLE;
    document.head.appendChild(s);
  }

  function build() {
    const currentPage = document.body.getAttribute('data-page') || '';
    const collapsedSaved = localStorage.getItem('sb-collapsed') === '1';

    const root = document.getElementById('app-sidebar-root') || (() => {
      const d = document.createElement('div');
      document.body.prepend(d);
      return d;
    })();

    const aside = document.createElement('aside');
    aside.id = 'app-sidebar';
    if (collapsedSaved) { aside.classList.add('collapsed'); document.body.classList.add('sb-collapsed'); }

    const links = NAV_ITEMS.map((item) => `
      <a class="sb-link ${item.key === currentPage ? 'active' : ''}" href="${item.href}">
        <span class="sb-icon">${item.icon}</span>
        <span class="sb-label">${item.label}<small>${item.desc}</small></span>
      </a>
    `).join('');

    aside.innerHTML = `
      <div class="sb-head">
        <button class="sb-burger" id="sb-toggle" title="เปิด/ปิดเมนู" aria-label="เปิด/ปิดเมนู">☰</button>
        <div class="sb-title">Auto Weight<small>SPC MONITORING</small></div>
      </div>
      <nav>${links}</nav>
      <div class="sb-foot">Auto Weight System</div>
    `;

    root.replaceWith(aside);

    document.getElementById('sb-toggle').addEventListener('click', () => {
      const collapsed = aside.classList.toggle('collapsed');
      aside.classList.toggle('expanded', !collapsed && window.innerWidth <= 860);
      document.body.classList.toggle('sb-collapsed', collapsed);
      localStorage.setItem('sb-collapsed', collapsed ? '1' : '0');
    });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => { injectStyle(); build(); });
  } else {
    injectStyle();
    build();
  }
})();
