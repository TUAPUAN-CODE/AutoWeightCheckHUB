#!/usr/bin/env node
'use strict';

/**
 * ลงทะเบียน checkweigher Yamato (OPC UA) ตามตารางสำรวจเครื่อง พ.ย. 2026 ผ่าน API ของ backend ที่รันอยู่
 *
 *   node backend/scripts/register-checkweighers.js            # ดูแผนอย่างเดียว ยังไม่แก้อะไร
 *   node backend/scripts/register-checkweighers.js --apply    # ลงทะเบียนจริง
 *   node backend/scripts/register-checkweighers.js --apply --api http://127.0.0.1:8000
 *
 * - เครื่องที่พร้อม (ตั้ง OPC แล้ว + ping ผ่าน + ETHERNET ON) จะ "เปิดใช้งาน" และเริ่มดึงข้อมูลทันที
 * - เครื่องที่ยังไม่พร้อมจะถูกเพิ่มแบบ "ปิดใช้งาน" พร้อมหมายเหตุ — เปิดเองในหน้า Monitor เมื่อเครื่องพร้อม
 * - IP ที่มีในระบบอยู่แล้ว: ถ้าเป็น checkweigher เดิม อัปเดตแค่ Line / S/N / หมายเหตุ (สถานะเปิด/ปิดคงเดิม)
 *   ถ้าเป็นเครื่องชนิดอื่น (เช่น TCP แบบเดิม) จะข้าม ไม่แตะ
 * - ไม่ต้อง restart backend
 */

const MACHINES = [
  // line, serialNo, ip, ready, note
  { line: 'Pouch Auto B', serialNo: 'TA220475', ip: '10.246.145.187', ready: true, note: null },
  { line: 'Pouch Auto C', serialNo: 'TA220219', ip: '10.246.145.188', ready: true, note: null },
  { line: 'Pouch Auto D', serialNo: 'TA220364', ip: '10.246.145.189', ready: true, note: null },
  { line: 'Pouch Auto A', serialNo: 'TA160501', ip: '10.246.145.192', ready: false,
    note: 'ยังไม่พร้อม: ping ไม่ผ่าน · option ETHERNET ยังไม่ ON' },
  { line: 'Pouch Auto E', serialNo: 'TA220332', ip: '10.246.145.193', ready: false,
    note: 'ยังไม่พร้อม: ไม่มีรหัส OPC UA (ซื้อ option หรือใช้ CE500-2 port 1052 แบบเดิม) · ping ไม่ผ่าน · ETHERNET ยังไม่ ON' },
  { line: 'Pouch Auto F', serialNo: 'TA220911', ip: '10.246.145.194', ready: false,
    note: 'ยังไม่พร้อม: ping ไม่ผ่าน · option ETHERNET ยังไม่ ON' },
  { line: 'Cup 1.1', serialNo: 'TA220045', ip: '10.246.145.190', ready: false,
    note: 'ยังไม่พร้อม: ยังไม่ได้อัปเดต driver · ping ไม่ผ่าน · ETHERNET ยังไม่ ON' },
  { line: 'Cup 1.2', serialNo: 'TA220044', ip: '10.246.145.191', ready: false,
    note: 'ยังไม่พร้อม: ยังไม่ได้อัปเดต driver · ping ไม่ผ่าน · ETHERNET ยังไม่ ON' },
  { line: 'Spout 1', serialNo: 'TA220976', ip: '10.246.145.195', ready: false,
    note: 'ยังไม่พร้อม: ไม่มีรหัส OPC UA (ซื้อ option หรือใช้ CE500-2 port 1052 แบบเดิม)' },
  { line: 'Spout 2', serialNo: 'TA220889', ip: '10.246.145.196', ready: true,
    note: 'driver ยังไม่อัปเดต (OPC UA ใช้งานได้)' },
  { line: 'Pouch Dollop', serialNo: 'TA220346', ip: '10.246.145.197', ready: false,
    note: 'ยังไม่พร้อม: ยังไม่ติดตั้งสายแลน' },
  // Spout 3: ยังไม่มี S/N / IP ในตารางสำรวจ — เพิ่มเองในหน้า Monitor เมื่อมีข้อมูล
];

const OPCUA_PORT = 4880;

function argValue(name) {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

const APPLY = process.argv.includes('--apply');
const API = (argValue('--api') || process.env.AUTO_WEIGHT_API || `http://127.0.0.1:${process.env.PORT || 8000}`).replace(/\/$/, '');

async function call(method, path, body) {
  const res = await fetch(`${API}/api${path}`, {
    method,
    headers: { 'content-type': 'application/json', accept: 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  });
  let data = null;
  try { data = await res.json(); } catch (_) { /* ไม่ใช่ JSON */ }
  if (!res.ok) throw new Error((data && data.error) || `HTTP ${res.status}`);
  return data || {};
}

function planFor(machine, existing) {
  const sameIp = existing.filter((s) => s.ip === machine.ip);
  if (!sameIp.length) return { action: 'add' };
  const cw = sameIp.find((s) => s.device_type === 'opcua');
  if (!cw) {
    const other = sameIp.map((s) => `${s.device_type || 'tcp'} port ${s.port}`).join(', ');
    return { action: 'skip', reason: `IP นี้มีในระบบแล้วเป็น ${other} — ไม่แตะ` };
  }
  const changed = (cw.line || '') !== machine.line
    || (cw.serial_no || '') !== machine.serialNo
    || (cw.note || null) !== machine.note;
  return changed ? { action: 'update', scale: cw } : { action: 'same', scale: cw };
}

async function main() {
  console.log(`API: ${API}${APPLY ? '' : '   (ดูแผนอย่างเดียว — เพิ่ม --apply เพื่อลงทะเบียนจริง)'}`);
  const { scales = [] } = await call('GET', '/scales');
  console.log(`ในระบบตอนนี้ ${scales.length} เครื่อง\n`);

  let failed = 0;
  for (const m of MACHINES) {
    const plan = planFor(m, scales);
    const label = `${m.line.padEnd(13)} ${m.ip.padEnd(15)} ${m.serialNo}`;
    const state = m.ready ? 'เปิดใช้งาน' : 'ปิดใช้งาน';

    if (plan.action === 'skip') { console.log(`ข้าม      ${label}  ${plan.reason}`); continue; }
    if (plan.action === 'same') { console.log(`มีแล้ว    ${label}  (#${plan.scale.scale_id})`); continue; }

    const verb = plan.action === 'add' ? `เพิ่ม (${state})` : `อัปเดต #${plan.scale.scale_id}`;
    if (!APPLY) { console.log(`${verb.padEnd(9)} ${label}${m.note ? '  — ' + m.note : ''}`); continue; }

    try {
      if (plan.action === 'add') {
        const { scale } = await call('POST', '/scales', {
          ip: m.ip, port: OPCUA_PORT, line: m.line, serialNo: m.serialNo, note: m.note,
          deviceType: 'opcua', enabled: m.ready,
        });
        console.log(`เพิ่มแล้ว  ${label}  #${scale.scale_id} (${state})`);
      } else {
        const s = plan.scale;
        await call('PUT', `/scales/${s.scale_id}`, {
          ip: s.ip, port: s.port, line: m.line, serialNo: m.serialNo, note: m.note,
          deviceType: 'opcua', enabled: s.enabled !== false,
        });
        console.log(`อัปเดตแล้ว ${label}  #${s.scale_id}`);
      }
    } catch (err) {
      failed += 1;
      console.error(`ไม่สำเร็จ  ${label}  ${err.message}`);
    }
  }

  console.log('\nSpout 3: ยังไม่มี S/N และ IP ในตารางสำรวจ — ไม่ได้เพิ่ม');
  if (failed) process.exitCode = 1;
}

main().catch((err) => {
  console.error(`ต่อ backend ไม่ได้ (${API}): ${err.message}`);
  process.exitCode = 1;
});
