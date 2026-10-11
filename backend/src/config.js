'use strict';

const path = require('path');

// โหลด .env จาก root ของโปรเจกต์ก่อน แล้วค่อยทับด้วย backend/.env ถ้ามี
require('dotenv').config({ path: path.join(__dirname, '..', '..', '.env') });
require('dotenv').config({ path: path.join(__dirname, '..', '.env'), override: true });

function num(name, fallback) {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;
  const v = Number(raw);
  return Number.isFinite(v) ? v : fallback;
}

function bool(name, fallback) {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;
  return ['1', 'true', 'yes', 'on'].includes(raw.trim().toLowerCase());
}

module.exports = {
  port: num('PORT', 8000),

  device: {
    ip: process.env.DEVICE_IP || '192.168.1.111',
    port: num('DEVICE_PORT', 1052),
    // ถ้าไม่มีข้อมูลเข้ามาเกินนี้ (ms) ถือว่า connection ตาย แล้วต่อใหม่
    socketTimeoutMs: num('SOCKET_TIMEOUT_SEC', 30) * 1000,
    reconnectDelayMs: num('RECONNECT_DELAY_SEC', 5) * 1000,
    // กันไม่ให้ insert ถี่เกินไป (วินาที) — 0 = เก็บทุกค่าที่อ่านได้
    minInsertIntervalMs: num('MIN_INSERT_INTERVAL_SEC', 0) * 1000,
    // รูปแบบข้อความจากเครื่องชั่ง เช่น "GW+ 0052.5 g,cx11," หรือ "07GW+ 0045.5 g,cx11,"
    weightPattern: process.env.WEIGHT_REGEX || 'GW\\+\\s*(-?\\d+(?:\\.\\d+)?)\\s*g',
  },

  db: {
    server: process.env.DB_SERVER || 'localhost',
    port: num('DB_PORT', 1433),
    database: process.env.DB_NAME || 'AUTO_WEIGHT',
    user: process.env.DB_USER || 'PFCMv2',
    password: process.env.DB_PASSWORD || '',
    table: process.env.DB_TABLE || '[dbo].[Auto]',
    encrypt: bool('DB_ENCRYPT', false),
    trustServerCertificate: bool('DB_TRUST_CERT', true),
    // คอลัมน์ time_stamp เดิมเก็บเป็น "เวลาหน้าปัด" ท้องถิ่นแบบไม่มี timezone
    // (ของเดิมฝั่ง Python ใช้ datetime.now()) — false = อ่าน/เขียนเป็นเวลาท้องถิ่นให้ตรงกับของเดิม
    // ตั้ง DB_USE_UTC=true เฉพาะกรณีที่ระบบคุณตกลงกันว่าเก็บเป็น UTC จริง ๆ
    useUtc: bool('DB_USE_UTC', false),
  },

  // ---------- SQL Server ตัวที่สอง (Weight Checker / TunaCodes) ----------
  // ใช้แค่ "อ่าน" GroupCode/ProductCode + spec FW/NW สำหรับหน้า Monitor — ไม่เขียนอะไรกลับไปที่ DB นี้
  dbWc: {
    server: process.env.DB_SERVER_WC || '',
    port: num('PORT_WC', 1433),
    database: process.env.DB_DATABASE_WC || '',
    user: process.env.DB_USER_WC || '',
    password: process.env.DB_PASSWORD_WC || '',
    encrypt: bool('DB_ENCRYPT_WC', false),
    trustServerCertificate: bool('DB_TRUST_CERT_WC', true),
    enabled: Boolean(process.env.DB_SERVER_WC && process.env.DB_DATABASE_WC),
  },

  // จำนวนแถวที่เก็บไว้ใน memory (ใช้เป็น fallback ตอน DB ล่ม)
  memoryBufferSize: num('MEMORY_BUFFER_SIZE', 5000),

  // SIM_MODE=1 => สร้างค่าน้ำหนักจำลองแทนการต่อเครื่องชั่งจริง (ไว้เทสต์ frontend)
  simMode: bool('SIM_MODE', false),
  simIntervalMs: num('SIM_INTERVAL_MS', 900),

  // ปิดการ insert ลง DB (ใช้ตอนยังต่อ SQL Server ไม่ได้ แต่อยากดู dashboard)
  dbEnabled: bool('DB_ENABLED', true),
};
