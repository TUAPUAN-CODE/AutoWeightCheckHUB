'use strict';

function stamp() {
  // เวลาท้องถิ่นของเครื่อง เพื่อให้เทียบกับ time_stamp ในตาราง Auto ได้ตรง ๆ
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

function write(stream, level, msg) {
  stream.write(`${stamp()} [${level}] ${msg}\n`);
}

module.exports = {
  info: (msg) => write(process.stdout, 'INFO', msg),
  warn: (msg) => write(process.stdout, 'WARN', msg),
  error: (msg) => write(process.stderr, 'ERROR', msg),
};
