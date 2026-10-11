'use strict';

/**
 * Auto Weight Backend (Node.js)
 * =============================
 * พอร์ตมาจาก main.py (FastAPI) — พฤติกรรมเหมือนเดิมทุกอย่าง:
 * อ่านน้ำหนักจากเครื่องชั่งผ่าน TCP แล้ว insert ลงตาราง Auto(id, weight, time_stamp)
 * ที่มีอยู่แล้วใน SQL Server โดยไม่แก้โครงสร้างตารางเดิม
 *
 * ของใหม่: เปิด REST API ให้ frontend (SPC dashboard) ดึงข้อมูลจริงไปแสดงได้
 *
 * รันด้วย:  npm start   หรือ   pm2 start ecosystem.config.js
 */

const express = require('express');
const cors = require('cors');

const config = require('./src/config');
const logger = require('./src/logger');
const routes = require('./src/routes');
const manager = require('./src/scale-manager');
const db = require('./src/db');

const app = express();

app.use(cors());
app.use(express.json());

app.use('/api', routes);
// alias ให้เข้ากันได้กับ endpoint เดิมของฝั่ง Python (/status, /recent, /start, /stop)
app.use('/', routes);

app.get('/', (_req, res) => {
  res.json({
    message: 'Auto Weight Backend (Node.js) is running',
    endpoints: [
      'GET    /api/status',
      'GET    /api/scales',
      'POST   /api/scales',
      'PUT    /api/scales/:id',
      'DELETE /api/scales/:id',
      'GET    /api/codes/groups',
      'GET    /api/codes/products?group=XXX',
      'POST   /api/sessions/start   { scaleId, groupCode, productCode }',
      'POST   /api/sessions/stop    { scaleId }',
      'GET    /api/sessions?sortBy=&sortDir=&page=&pageSize=&scaleId=&line=&serialNo=&groupCode=&productCode=&shift=&status=&from=&to=',
      'GET    /api/sessions/:id',
      'GET    /api/sessions/:id/weights',
      'GET    /api/weights/history?limit=4000&scaleId=1',
      'GET    /api/weights?sinceId=123&limit=500&scaleId=1',
      'GET    /api/weights/range?from=ISO&to=ISO&scaleId=1',
      'GET    /api/recent?limit=20&scaleId=1',
      'POST   /api/start { scaleId }',
      'POST   /api/stop  { scaleId }',
    ],
  });
});

app.use((req, res) => res.status(404).json({ error: `ไม่พบ endpoint ${req.method} ${req.path}` }));

// eslint-disable-next-line no-unused-vars
app.use((err, _req, res, _next) => {
  logger.error(`Unhandled: ${err.stack || err.message}`);
  res.status(500).json({ error: err.message });
});

const server = app.listen(config.port, '0.0.0.0', async () => {
  logger.info(`HTTP listening on http://0.0.0.0:${config.port}`);
  logger.info(`DB      ${config.db.server}:${config.db.port}/${config.db.database} (enabled=${config.dbEnabled})`);
  logger.info(`DB(WC)  ${config.dbWc.enabled ? `${config.dbWc.server}:${config.dbWc.port}/${config.dbWc.database}` : 'disabled'}`);
  await manager.init(); // โหลดเครื่องชั่งทั้งหมดจาก dbo.Scales แล้วเปิดการเชื่อมต่อ
});

let shuttingDown = false;
async function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  logger.info(`${signal} received, shutting down...`);

  manager.stopAll();
  server.close();
  await db.close();

  // เผื่อมี handle ค้าง ไม่ให้ pm2 ต้องรอจน timeout
  setTimeout(() => process.exit(0), 1500).unref();
}

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('message', (msg) => {
  if (msg === 'shutdown') shutdown('pm2 shutdown'); // pm2 บน Windows ส่ง message นี้แทน signal
});
process.on('unhandledRejection', (err) => {
  logger.error(`Unhandled rejection: ${err && err.stack ? err.stack : err}`);
});
