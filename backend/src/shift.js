'use strict';

/**
 * shift.js — คำนวณ "กะ" และ "วันที่รายงาน" ตามปฏิทินโรงงาน
 *
 * กติกา (ตามที่แจ้ง):
 *   06:00 - 17:30  = กะ DS ของ "วันนั้น"
 *   17:30 - 06:00  = กะ NS ของ "วันเดียวกับตอนที่กะ NS เริ่ม" (ไม่ใช่วันที่จบ)
 *
 * เช่น 8/16/69 06:00-17:30 = DS ของวันที่ 16
 *      8/16/69 17:30 - 8/17/69 06:00 = NS ของวันที่ 16 (ทั้งที่ข้ามเที่ยงคืนไปวันที่ 17 แล้ว)
 *      8/17/69 06:00-17:30 = DS ของวันที่ 17
 *
 * ดังนั้นถ้าเวลา < 06:00 ให้ถือว่าเป็น NS ของ "เมื่อวาน" (เพราะกะ NS เริ่มเมื่อวาน 17:30)
 */

const DS_START_MIN = 6 * 60; // 06:00
const NS_START_MIN = 17 * 60 + 30; // 17:30

function dateOnly(d) {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate());
}

function addDays(d, n) {
  const r = new Date(d);
  r.setDate(r.getDate() + n);
  return r;
}

/**
 * @param {Date} ts เวลาท้องถิ่น
 * @returns {{ shift: 'DS'|'NS', reportDate: Date }} reportDate เป็นเที่ยงคืนของวันที่รายงาน (เวลาท้องถิ่น)
 */
function classify(ts) {
  const minutes = ts.getHours() * 60 + ts.getMinutes();
  const today = dateOnly(ts);

  if (minutes >= DS_START_MIN && minutes < NS_START_MIN) {
    return { shift: 'DS', reportDate: today };
  }
  if (minutes >= NS_START_MIN) {
    return { shift: 'NS', reportDate: today };
  }
  // minutes < 06:00 -> ยังเป็นกะ NS ที่เริ่มเมื่อวาน
  return { shift: 'NS', reportDate: addDays(today, -1) };
}

/** แปลง Date -> วันที่แบบ พ.ศ. สั้น "M/D/YY" เช่น 8/16/69 (ตามฟอร์แมตที่โรงงานใช้) */
function toBuddhistShort(d) {
  const beYear2 = String((d.getFullYear() + 543) % 100).padStart(2, '0');
  return `${d.getMonth() + 1}/${d.getDate()}/${beYear2}`;
}

/** แปลง Date -> "YYYY-MM-DD" (ค.ศ.) ไว้เก็บ/query ใน DB (คอลัมน์ report_date เป็น DATE) */
function toIsoDate(d) {
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

module.exports = { classify, toBuddhistShort, toIsoDate };
