'use strict';

/**
 * PM2 config — รันทั้ง backend และ frontend พร้อมกัน
 *
 *   pm2 start ecosystem.config.js     # เริ่มทั้งคู่
 *   pm2 status                        # ดูสถานะ
 *   pm2 logs auto-weight-backend      # ดู log เฉพาะ backend
 *   pm2 restart ecosystem.config.js   # รีสตาร์ททั้งคู่
 *   pm2 stop all / pm2 delete all     # หยุด / เอาออกจาก pm2
 *   pm2 save                          # จำ process list ไว้ให้ start เองตอนเปิดเครื่อง
 */

const path = require('path');

const ROOT = __dirname;
const LOGS = path.join(ROOT, 'logs');

module.exports = {
  apps: [
    {
      name: 'auto-weight-backend',
      cwd: path.join(ROOT, 'backend'),
      script: 'server.js',
      instances: 1,
      exec_mode: 'fork', // fork เท่านั้น — TCP ไปหาเครื่องชั่งต้องมี connection เดียว ห้าม cluster
      autorestart: true,
      watch: false,
      max_memory_restart: '400M',
      kill_timeout: 5000,
      exp_backoff_restart_delay: 200,
      env: {
        NODE_ENV: 'production',
        PORT: 8000,
      },
      out_file: path.join(LOGS, 'backend-out.log'),
      error_file: path.join(LOGS, 'backend-error.log'),
      merge_logs: true,
    },
    {
      name: 'auto-weight-frontend',
      cwd: path.join(ROOT, 'frontend'),
      script: 'server.js',
      instances: 1,
      exec_mode: 'fork',
      autorestart: true,
      watch: false,
      max_memory_restart: '250M',
      kill_timeout: 5000,
      exp_backoff_restart_delay: 200,
      env: {
        NODE_ENV: 'production',
        FRONTEND_PORT: 3000,
        BACKEND_URL: 'http://127.0.0.1:8000',
      },
      out_file: path.join(LOGS, 'frontend-out.log'),
      error_file: path.join(LOGS, 'frontend-error.log'),
      merge_logs: true,
    },
  ],
};
