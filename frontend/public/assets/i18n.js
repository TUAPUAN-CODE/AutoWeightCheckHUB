/**
 * i18n.js — แปลหน้าเว็บเป็น English / မြန်မာ / ខ្មែរ (โหลดโดย app-header.js เฉพาะเมื่อไม่ใช่ภาษาไทย)
 *
 * โค้ดของทุกหน้ายังเขียนข้อความเป็นภาษาไทยตามเดิม — ไฟล์นี้คอยแปลข้อความที่ขึ้นบนจอ (รวมที่เปลี่ยนแบบ real-time)
 * พจนานุกรมอยู่ใน assets/i18n-dict.js : [ไทย, English, မြန်မာ, ខ្មែរ]
 *   {n} = ตัวเลข (เช่น "ผ่าน {n} ชิ้น"), {x} = ข้อความอะไรก็ได้ (ชื่อเครื่อง, Product …) — ใส่ในคำแปลตามลำดับเดิม
 *   แถวที่ช่องพม่า/เขมรว่าง จะใช้คำแปลอังกฤษแทน
 * ลำดับการแปล: ตรงทั้งประโยค → แทนตัวเลขด้วย {n} → รูปแบบที่มี {x} → แยกตาม " · " / " — " → แปลเป็นคำ ๆ (AW_I18N_PHRASES)
 * ใช้ในโค้ดที่วาดลง canvas: window.t('ข้อความ')
 * ส่วนที่ไม่ต้องการให้แปล: ใส่ attribute data-no-i18n
 */
(function () {
  const LANG = window.AW_LANG;
  const IDX = { en: 1, my: 2, km: 3 }[LANG];
  if (!IDX) return;
  const LOCALE = { en: 'en-GB', my: 'my-MM', km: 'km-KH' }[LANG];

  const TH = /[฀-๿]/;
  const NUM = /(?<![\w\u0E00-\u0E7F.])[-+−]?\d[\d,]*(?:\.\d+)?%?/g; // ไม่นับเลขที่ติดตัวอักษร เช่น P103, S-43511 ยังเป็นเลขได้
  const pick = (row) => row[IDX] || row[1] || null;
  const escRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

  const exact = new Map();
  const tmpl = new Map();
  const pats = [];
  for (const row of window.AW_I18N_DICT || []) {
    const th = norm(row[0]); const tr = pick(row);
    if (!th || !tr) continue;
    if (th.includes('{x}')) {
      const src = escRe(th).replace(/\\\{x\\\}/g, '(.+?)').replace(/\\\{n\\\}/g, '([-+−]?\\d[\\d,]*(?:\\.\\d+)?%?)');
      const kinds = (th.match(/\{[nx]\}/g) || []).map((k) => k[1]);
      pats.push({ re: new RegExp(`^${src}$`), kinds, tr, len: th.length });
    } else if (th.includes('{n}')) {
      tmpl.set(th, tr);
    } else {
      exact.set(th, tr);
    }
  }
  pats.sort((a, b) => b.len - a.len);

  // คำ/วลีสั้น ๆ สำหรับข้อความที่ไม่มีในพจนานุกรมทั้งประโยค (ยาวก่อนสั้น)
  const phrases = (window.AW_I18N_PHRASES || []).map((r) => [r[0], pick(r)]).filter((r) => r[0] && r[1]).sort((a, b) => b[0].length - a[0].length);
  const phraseMap = new Map(phrases);
  const phraseRe = phrases.length ? new RegExp(phrases.map((p) => escRe(p[0])).join('|'), 'g') : null;

  function norm(s) { return String(s || '').replace(/\s+/g, ' ').trim(); }

  // {n}/{x} เติมตามลำดับ · ถ้าคำแปลต้องสลับลำดับ ใช้ {1} {2} … (ลำดับของค่าในประโยคไทย)
  function fill(tr, vals) {
    if (/\{\d\}/.test(tr)) return tr.replace(/\{(\d)\}/g, (_, k) => vals[Number(k) - 1] ?? '');
    let i = 0;
    return tr.replace(/\{[nx]\}/g, () => (i < vals.length ? vals[i++] : ''));
  }

  function tidy(s) {
    return s.replace(/\s{2,}/g, ' ').replace(/\s+([,.)\]:;%!?])/g, '$1').replace(/([([])\s+/g, '$1').trim();
  }

  function byPhrases(s) {
    if (!phraseRe) return s;
    const out = s.replace(phraseRe, (m) => ` ${phraseMap.get(m)} `);
    return tidy(out);
  }

  const thaiCount = (x) => (x.match(/[\u0E00-\u0E7F]/g) || []).length;
  const cache = new Map();
  // allowPhrase=false สำหรับค่าที่แทน {x} (ชื่อคน / Product ฯลฯ) — ไม่แปลทีละคำ กันชื่อเพี้ยน
  function tr1(core, depth, allowPhrase = true) {
    const phr = (x) => (allowPhrase ? byPhrases(x) : x);
    if (!TH.test(core)) return core;
    let r = exact.get(core);
    if (r != null) return r;
    const nums = [];
    const key = core.replace(NUM, (m) => { nums.push(m); return '{n}'; });
    r = tmpl.get(key);
    if (r != null) return fill(r, nums);
    r = exact.get(key); // ข้อความที่มีตัวเลขเป็นส่วนหนึ่งของชื่อ
    if (r != null) return r;
    if (depth >= 4) return phr(core);
    // ตัวคั่นหน้า/หลัง เช่น "ดี ·" หรือ "· เอกสาร"
    const edge = /^([·—–|]\s+)?(.*?)(\s+[·—–|])?$/.exec(core);
    if (edge && (edge[1] || edge[3]) && edge[2]) return (edge[1] || '') + tr1(edge[2], depth + 1, allowPhrase) + (edge[3] || '');
    // ลองหลายวิธีแบบไม่แปลทีละคำ แล้วเลือกผลที่เหลือภาษาไทยน้อยที่สุด (เสมอกัน = เลือกแบบรูปแบบ {x} เพราะกันชื่อเพี้ยน)
    let best = null;
    const consider = (out, kind, extra) => {
      const sc = thaiCount(out);
      if (!best || sc < best.sc || (sc === best.sc && kind === 'pat' && best.kind !== 'pat')) best = { out, sc, kind, extra };
      return sc === 0;
    };
    for (const sep of [' · ', ' — ', ' – ', ' | ', ': ']) {
      if (!core.includes(sep)) continue;
      const parts = core.split(sep);
      if (consider(parts.map((x) => tr1(norm(x), depth + 1, false)).join(sep), 'split', { parts, sep })) return best.out;
    }
    for (const p of pats) {
      const m = p.re.exec(core);
      if (!m) continue;
      const vals = m.slice(1).map((v, i) => (p.kinds[i] === 'x' ? tr1(norm(v), depth + 1, false) : v));
      if (consider(fill(p.tr, vals), 'pat')) return best.out;
    }
    if (!best || best.sc >= thaiCount(core)) return phr(core);
    // ผลจากรูปแบบ {x} ที่เหลือไทยนิดเดียว = ชื่อคน/Product → คงไว้ · เหลือยาว = ประโยคที่ไม่รู้จัก → แปลทีละคำ
    if (!allowPhrase || (best.kind === 'pat' && best.sc <= 20)) return best.out;
    if (best.kind === 'pat') return byPhrases(best.out);
    // แยกตามตัวคั่นได้บางส่วน — ส่วนที่ยังไม่รู้จักค่อยแปลทีละคำ
    return best.extra.parts.map((x) => tr1(norm(x), depth + 1, true)).join(best.extra.sep);
  }

  /** แปลข้อความ (คงช่องว่างหน้า/หลังไว้) */
  function translate(s) {
    if (s == null) return s;
    const str = String(s);
    if (!TH.test(str)) return str;
    const hit = cache.get(str);
    if (hit !== undefined) return hit;
    const lead = str.match(/^\s*/)[0]; const trail = str.match(/\s*$/)[0];
    let out = lead + tr1(norm(str), 0) + trail;
    // tooltip หลายบรรทัด: ถ้าแปลทั้งก้อนแล้วยังเหลือไทย ลองแปลทีละบรรทัด (ข้อความใน HTML ที่ขึ้นบรรทัดใหม่เฉย ๆ จะแปลทั้งก้อนได้อยู่แล้ว)
    if (str.includes('\n') && TH.test(out)) {
      const alt = str.split('\n').map(translate).join('\n');
      if (thaiCount(alt) < thaiCount(out)) out = alt;
    }
    if (cache.size > 20000) cache.clear();
    cache.set(str, out);
    cache.set(out, out);
    return out;
  }
  window.t = translate;
  window.AW_TRANSLATE = translate;

  // ---- วันที่: โค้ดเดิมใช้ 'th-TH' → ใช้ภาษาที่เลือกแทน
  const fixLoc = (loc) => (loc === undefined || loc === 'th-TH' || loc === 'th' ? LOCALE : loc);
  for (const fn of ['toLocaleDateString', 'toLocaleTimeString', 'toLocaleString']) {
    const orig = Date.prototype[fn];
    Date.prototype[fn] = function (loc, opts) {
      try { return orig.call(this, fixLoc(loc), opts); } catch (e) { return orig.call(this, 'en-GB', opts); }
    };
  }

  // ---- กล่องข้อความของเบราว์เซอร์
  const oAlert = window.alert.bind(window); const oConfirm = window.confirm.bind(window); const oPrompt = window.prompt.bind(window);
  window.alert = (m) => oAlert(translate(String(m ?? '')));
  window.confirm = (m) => oConfirm(translate(String(m ?? '')));
  window.prompt = (m, d) => oPrompt(translate(String(m ?? '')), d);

  // ---- DOM
  const ATTRS = ['placeholder', 'title', 'aria-label', 'alt', 'label', 'data-title'];
  const SKIP_TAGS = new Set(['SCRIPT', 'STYLE', 'TEXTAREA', 'NOSCRIPT']);
  function skipEl(el) {
    if (!el) return true;
    if (SKIP_TAGS.has(el.tagName)) return true;
    return !!(el.closest && el.closest('[data-no-i18n],[contenteditable="true"]'));
  }
  function doText(node) {
    const v = node.nodeValue;
    if (!v || !TH.test(v) || skipEl(node.parentElement)) return;
    const nv = translate(v);
    if (nv !== v) node.nodeValue = nv;
  }
  function doAttrs(el) {
    if (el.nodeType !== 1 || skipEl(el)) return;
    for (const a of ATTRS) {
      const v = el.getAttribute(a);
      if (v && TH.test(v)) { const nv = translate(v); if (nv !== v) el.setAttribute(a, nv); }
    }
    if (el.tagName === 'INPUT' && (el.type === 'button' || el.type === 'submit') && TH.test(el.value)) el.value = translate(el.value);
  }
  function walk(root) {
    if (!root) return;
    if (root.nodeType === 3) { doText(root); return; }
    if (root.nodeType !== 1 && root.nodeType !== 9 && root.nodeType !== 11) return;
    if (root.nodeType === 1) { if (skipEl(root)) return; doAttrs(root); }
    const w = document.createTreeWalker(root, NodeFilter.SHOW_ELEMENT | NodeFilter.SHOW_TEXT);
    let n;
    while ((n = w.nextNode())) { if (n.nodeType === 3) doText(n); else doAttrs(n); }
  }
  function doTitle() { // ตั้งเฉพาะเมื่อแปลแล้วต่างจากเดิม — ไม่งั้น observer ของ <title> วนไม่รู้จบ (ชื่อที่ยังไม่มีคำแปล)
    if (!TH.test(document.title)) return;
    const nv = translate(document.title);
    if (nv !== document.title) document.title = nv;
  }

  function start() {
    document.documentElement.lang = LANG;
    walk(document.body); doTitle();
    const mo = new MutationObserver((list) => {
      for (const m of list) {
        if (m.type === 'characterData') doText(m.target);
        else if (m.type === 'attributes') doAttrs(m.target);
        else for (const n of m.addedNodes) walk(n);
      }
      doTitle();
    });
    mo.observe(document.body, { subtree: true, childList: true, characterData: true, attributes: true, attributeFilter: ATTRS });
    const tEl = document.querySelector('title');
    if (tEl) new MutationObserver(doTitle).observe(tEl, { childList: true, characterData: true, subtree: true });
  }
  if (document.body) start(); else document.addEventListener('DOMContentLoaded', start);
})();
