'use strict';

/**
 * Frontend server — เสิร์ฟ SPC dashboard (static) + proxy /api ไปที่ backend
 *
 * proxy ทำให้ browser คุยกับ origin เดียว (พอร์ต frontend) ไม่ต้องยุ่งกับ CORS
 * และเวลาย้ายเครื่อง/เปลี่ยนพอร์ต backend ก็แก้แค่ตัวแปร BACKEND_URL
 */

const path = require('path');
const express = require('express');

require('dotenv').config({ path: path.join(__dirname, '..', '.env') });
require('dotenv').config({ path: path.join(__dirname, '.env'), override: true });

const PORT = Number(process.env.FRONTEND_PORT || 3000);
const BACKEND_URL = (process.env.BACKEND_URL || `http://127.0.0.1:${process.env.PORT || 8000}`).replace(/\/$/, '');
const PROXY_TIMEOUT_MS = Number(process.env.PROXY_TIMEOUT_MS || 15000);

const app = express();

const stamp = () => new Date().toISOString().replace('T', ' ').slice(0, 19);
const log = (msg) => process.stdout.write(`${stamp()} [INFO] ${msg}\n`);
const logErr = (msg) => process.stderr.write(`${stamp()} [ERROR] ${msg}\n`);

app.use('/api', express.raw({ type: '*/*', limit: '1mb' }), async (req, res) => {
  const target = `${BACKEND_URL}/api${req.url}`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), PROXY_TIMEOUT_MS);

  try {
    const init = { method: req.method, headers: {}, signal: controller.signal };
    if (req.headers['content-type']) init.headers['content-type'] = req.headers['content-type'];
    if (!['GET', 'HEAD'].includes(req.method) && Buffer.isBuffer(req.body) && req.body.length) {
      init.body = req.body;
    }

    const upstream = await fetch(target, init);
    const body = Buffer.from(await upstream.arrayBuffer());

    res.status(upstream.status);
    const ct = upstream.headers.get('content-type');
    if (ct) res.set('content-type', ct);
    res.set('cache-control', 'no-store');
    res.send(body);
  } catch (err) {
    const reason = err.name === 'AbortError' ? 'backend timeout' : err.message;
    logErr(`proxy ${req.method} ${target} -> ${reason}`);
    res.status(502).json({ error: `ต่อ backend ไม่ได้ (${BACKEND_URL}): ${reason}` });
  } finally {
    clearTimeout(timer);
  }
});

app.use(
  express.static(path.join(__dirname, 'public'), {
    extensions: ['html'],
    setHeaders: (res, filePath) => {
      if (filePath.endsWith('.html')) res.set('cache-control', 'no-store');
    },
  })
);

app.get('/healthz', (_req, res) => res.json({ ok: true, backend: BACKEND_URL }));

app.use((_req, res) => res.status(404).send('Not found'));

const server = app.listen(PORT, '0.0.0.0', () => {
  log(`Frontend on http://0.0.0.0:${PORT}  ->  proxying /api to ${BACKEND_URL}`);
});

let shuttingDown = false;
function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  log(`${signal} received, shutting down...`);
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 1500).unref();
}

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('message', (msg) => {
  if (msg === 'shutdown') shutdown('pm2 shutdown');
});
