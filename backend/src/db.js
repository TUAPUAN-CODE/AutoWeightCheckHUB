'use strict';

const sql = require('mssql');
const config = require('./config');
const logger = require('./logger');

const TABLE = config.db.table;

// รายชื่อตารางที่อนุญาตให้ query/insert ได้ — ป้องกัน SQL Injection
// เพราะชื่อตาราง bind เป็น parameter ตรงๆ ไม่ได้ใน mssql ต้องเช็ค whitelist
// ก่อนนำไป interpolate เข้า query string ทุกครั้ง
const ALLOWED_TABLES = new Set([
  TABLE, // ตารางเดิม (เผื่อยังมีจุดอื่นเรียกแบบไม่ระบุตาราง)
  '[dbo].[Spout 1]',
  '[dbo].[Spout 2]',
  '[dbo].[Spout 3]',
]);

/** เช็คชื่อตารางกับ whitelist ก่อนนำไปใช้ใน query — ถ้าไม่ผ่านจะ throw ทันที */
function resolveTable(tableName) {
  const t = tableName || TABLE;
  if (!ALLOWED_TABLES.has(t)) {
    throw new Error(`Table name "${t}" ไม่อยู่ใน whitelist — ปฏิเสธ query เพื่อความปลอดภัย`);
  }
  return t;
}

let poolPromise = null;
let lastError = null;
let connectedAt = null;

function poolConfig() {
  return {
    server: config.db.server,
    port: config.db.port,
    database: config.db.database,
    user: config.db.user,
    password: config.db.password,
    connectionTimeout: 10000,
    requestTimeout: 15000,
    pool: { max: 10, min: 0, idleTimeoutMillis: 30000 },
    options: {
      encrypt: config.db.encrypt,
      trustServerCertificate: config.db.trustServerCertificate,
      enableArithAbort: true,
      // useUTC:false => datetime ถูกอ่าน/เขียนด้วยเวลาท้องถิ่น ตรงกับที่ main.py เดิมเขียนไว้
      useUTC: config.db.useUtc,
    },
  };
}

/** เปิด connection pool (ครั้งเดียว) — ถ้าพังจะเคลียร์ทิ้งเพื่อให้ครั้งถัดไปลองต่อใหม่ */
async function getPool() {
  if (!config.dbEnabled) throw new Error('DB disabled (DB_ENABLED=false)');
  if (poolPromise) return poolPromise;

  const pool = new mssqlPool();
  poolPromise = pool
    .connect()
    .then((p) => {
      lastError = null;
      connectedAt = new Date();
      logger.info(`DB connected: ${config.db.server}:${config.db.port}/${config.db.database}`);
      return p;
    })
    .catch((err) => {
      poolPromise = null;
      connectedAt = null;
      lastError = err.message;
      throw err;
    });

  return poolPromise;
}

function mssqlPool() {
  const pool = new sql.ConnectionPool(poolConfig());
  pool.on('error', (err) => {
    lastError = err.message;
    logger.error(`DB pool error: ${err.message}`);
    poolPromise = null;
    connectedAt = null;
  });
  return pool;
}

/**
 * Insert 1 แถวลงตาราง Spout ที่ระบุ (Spout 1 / Spout 2 / Spout 3 / ตารางเดิม)
 * id เป็น identity ปล่อยให้ SQL Server สร้างเอง — ไม่แตะโครงสร้างตารางเดิม
 * scale_id/session_id เป็น nullable (ข้อมูลเก่าก่อน migrate ไม่มีค่านี้)
 * @param {number} weight
 * @param {Date} timestamp
 * @param {number|null} scaleId
 * @param {number|null} sessionId
 * @param {string|null} tableName - เช่น '[Spout 1]' ถ้าไม่ระบุจะ fallback ไปตารางเดิม (TABLE)
 * @returns {Promise<number|null>} id ที่เพิ่งถูกสร้าง
 */
async function insertWeight(weight, timestamp, scaleId = null, sessionId = null, tableName = null) {
  const table = resolveTable(tableName);
  const pool = await getPool();
  const result = await pool
    .request()
    .input('weight', sql.Float, weight)
    .input('ts', sql.DateTime, timestamp)
    .input('scaleId', sql.Int, scaleId)
    .input('sessionId', sql.BigInt, sessionId)
    .query(
      `INSERT INTO ${table} ([weight], [time_stamp], [scale_id], [session_id])
       VALUES (@weight, @ts, @scaleId, @sessionId);
       SELECT CAST(SCOPE_IDENTITY() AS BIGINT) AS id;`
    );

  const row = result.recordset && result.recordset[0];
  return row && row.id != null ? Number(row.id) : null;
}

/** แถวล่าสุด n แถว เรียงจากใหม่ไปเก่า (เทียบเท่า /recent เดิมของฝั่ง Python) — scaleId ไม่ใส่ = ทุกเครื่อง */
async function fetchRecent(limit, scaleId = null, tableName = null) {
  const table = resolveTable(tableName);
  const pool = await getPool();
  const req = pool.request().input('limit', sql.Int, limit);
  const where = [];
  if (scaleId != null) { req.input('scaleId', sql.Int, scaleId); where.push('[scale_id] = @scaleId'); }
  const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';
  const result = await req.query(
    `SELECT TOP (@limit) [id], [weight], [time_stamp], [scale_id], [session_id]
     FROM ${table} ${whereSql} ORDER BY [id] DESC`
  );
  return result.recordset;
}

/** แถวล่าสุด n แถว แต่เรียงจากเก่าไปใหม่ — ใช้ตอน frontend โหลดข้อมูลย้อนหลังครั้งแรก */
async function fetchHistory(limit, scaleId = null, tableName = null) {
  const table = resolveTable(tableName);
  const pool = await getPool();
  const req = pool.request().input('limit', sql.Int, limit);
  const where = [];
  if (scaleId != null) { req.input('scaleId', sql.Int, scaleId); where.push('[scale_id] = @scaleId'); }
  const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';
  const result = await req.query(
    `SELECT [id], [weight], [time_stamp], [scale_id], [session_id] FROM (
       SELECT TOP (@limit) [id], [weight], [time_stamp], [scale_id], [session_id]
       FROM ${table} ${whereSql} ORDER BY [id] DESC
     ) AS t ORDER BY [id] ASC`
  );
  return result.recordset;
}

/** แถวที่ id > sinceId — ใช้ตอน frontend poll ข้อมูลใหม่ */
async function fetchSince(sinceId, limit, scaleId = null, tableName = null) {
  const table = resolveTable(tableName);
  const pool = await getPool();
  const req = pool.request().input('sinceId', sql.BigInt, sinceId).input('limit', sql.Int, limit);
  const where = ['[id] > @sinceId'];
  if (scaleId != null) { req.input('scaleId', sql.Int, scaleId); where.push('[scale_id] = @scaleId'); }
  const result = await req.query(
    `SELECT TOP (@limit) [id], [weight], [time_stamp], [scale_id], [session_id]
     FROM ${table} WHERE ${where.join(' AND ')} ORDER BY [id] ASC`
  );
  return result.recordset;
}

/** แถวในช่วงเวลา (ใช้กับ custom range ของ dashboard) */
async function fetchRange(from, to, limit, scaleId = null, tableName = null) {
  const table = resolveTable(tableName);
  const pool = await getPool();
  const req = pool.request().input('from', sql.DateTime, from).input('to', sql.DateTime, to).input('limit', sql.Int, limit);
  const where = ['[time_stamp] BETWEEN @from AND @to'];
  if (scaleId != null) { req.input('scaleId', sql.Int, scaleId); where.push('[scale_id] = @scaleId'); }
  const result = await req.query(
    `SELECT [id], [weight], [time_stamp], [scale_id], [session_id] FROM (
       SELECT TOP (@limit) [id], [weight], [time_stamp], [scale_id], [session_id]
       FROM ${table} WHERE ${where.join(' AND ')}
       ORDER BY [id] DESC
     ) AS t ORDER BY [id] ASC`
  );
  return result.recordset;
}

/** ค่าน้ำหนักทั้งหมดของ 1 เอกสาร (session) เรียงเก่า->ใหม่ — ใช้วาดกราฟย้อนหลังของเอกสารนั้น */
async function fetchWeightsBySession(sessionId, limit = 20000, tableName = null) {
  const table = resolveTable(tableName);
  const pool = await getPool();
  const result = await pool
    .request()
    .input('sessionId', sql.BigInt, sessionId)
    .input('limit', sql.Int, limit)
    .query(
      `SELECT TOP (@limit) [id], [weight], [time_stamp]
       FROM ${table} WHERE [session_id] = @sessionId ORDER BY [id] ASC`
    );
  return result.recordset;
}

// ============================================================== Scales (ทะเบียนเครื่องชั่ง)
async function listScales() {
  const pool = await getPool();
  const result = await pool.request().query(
    `SELECT [id], [name], [ip], [port], [line], [serial_no], [enabled], [note], [created_at], [updated_at]
     FROM [dbo].[Scales] ORDER BY [id] ASC`
  );
  return result.recordset;
}

async function createScale({ name, ip, port, line, serialNo, note }) {
  const pool = await getPool();
  const finalName = name || line || ip; // ไม่เก็บ "ชื่อเครื่องชั่ง" แยกอีกต่อไป — ใช้ Line (หรือ ip ถ้าไม่มี Line) แทน
  const result = await pool
    .request()
    .input('name', sql.NVarChar(100), finalName)
    .input('ip', sql.VarChar(45), ip)
    .input('port', sql.Int, port)
    .input('line', sql.NVarChar(50), line || null)
    .input('serialNo', sql.NVarChar(100), serialNo || null)
    .input('note', sql.NVarChar(255), note || null)
    .query(
      `INSERT INTO [dbo].[Scales] ([name], [ip], [port], [line], [serial_no], [note])
       VALUES (@name, @ip, @port, @line, @serialNo, @note);
       SELECT CAST(SCOPE_IDENTITY() AS INT) AS id;`
    );
  return result.recordset[0].id;
}

async function updateScale(id, { name, ip, port, line, serialNo, note, enabled }) {
  const pool = await getPool();
  const finalName = name || line || ip;
  await pool
    .request()
    .input('id', sql.Int, id)
    .input('name', sql.NVarChar(100), finalName)
    .input('ip', sql.VarChar(45), ip)
    .input('port', sql.Int, port)
    .input('line', sql.NVarChar(50), line || null)
    .input('serialNo', sql.NVarChar(100), serialNo || null)
    .input('note', sql.NVarChar(255), note || null)
    .input('enabled', sql.Bit, enabled ? 1 : 0)
    .query(
      `UPDATE [dbo].[Scales] SET
         [name] = @name, [ip] = @ip, [port] = @port, [line] = @line,
         [serial_no] = @serialNo, [note] = @note, [enabled] = @enabled, [updated_at] = GETDATE()
       WHERE [id] = @id`
    );
}

async function deleteScale(id) {
  const pool = await getPool();
  await pool.request().input('id', sql.Int, id).query('DELETE FROM [dbo].[Scales] WHERE [id] = @id');
}

// ============================================================== Sessions (เอกสาร เริ่ม/หยุด)
async function findRunningSessionByScale(scaleId) {
  const pool = await getPool();
  const result = await pool
    .request()
    .input('scaleId', sql.Int, scaleId)
    .query(`SELECT TOP 1 * FROM [dbo].[Sessions] WHERE [scale_id] = @scaleId AND [status] = 'running' ORDER BY [id] DESC`);
  return result.recordset[0] || null;
}

async function createSession({ scaleId, groupCode, productCode, spec, startTime, shift, reportDate, inspectorName, remark }) {
  const pool = await getPool();
  const s = spec || {};
  const result = await pool
    .request()
    .input('scaleId', sql.Int, scaleId)
    .input('groupCode', sql.NVarChar(50), groupCode)
    .input('productCode', sql.NVarChar(50), productCode)
    .input('fwTarget', sql.Float, s.fwTarget ?? null).input('fwUCL', sql.Float, s.fwUCL ?? null)
    .input('fwUWL', sql.Float, s.fwUWL ?? null).input('fwLWL', sql.Float, s.fwLWL ?? null).input('fwLCL', sql.Float, s.fwLCL ?? null)
    .input('nwTarget', sql.Float, s.nwTarget ?? null).input('nwUCL', sql.Float, s.nwUCL ?? null)
    .input('nwUWL', sql.Float, s.nwUWL ?? null).input('nwLWL', sql.Float, s.nwLWL ?? null).input('nwLCL', sql.Float, s.nwLCL ?? null)
    .input('package', sql.NVarChar(100), s.PackageSize ?? null)
    .input('packageName', sql.NVarChar(200), s.PackageName ?? null)
    .input('customer', sql.NVarChar(200), s.Customer ?? null)
    .input('destination', sql.NVarChar(200), s.Destination ?? null)
    .input('labelInk', sql.NVarChar(50), s.LabelInk ?? null)
    .input('inspectorName', sql.NVarChar(100), inspectorName ?? null)
    .input('remark', sql.NVarChar(500), remark ?? null)
    .input('startTime', sql.DateTime, startTime)
    .input('shift', sql.VarChar(2), shift)
    .input('reportDate', sql.Date, reportDate)
    .query(
      `INSERT INTO [dbo].[Sessions]
         ([scale_id], [group_code], [product_code],
          [fw_target],[fw_ucl],[fw_uwl],[fw_lwl],[fw_lcl],
          [nw_target],[nw_ucl],[nw_uwl],[nw_lwl],[nw_lcl],
          [package],[package_name],[customer],[destination],[label_ink],
          [inspector_name],[remark],
          [start_time], [status], [shift], [report_date])
       VALUES
         (@scaleId, @groupCode, @productCode,
          @fwTarget,@fwUCL,@fwUWL,@fwLWL,@fwLCL,
          @nwTarget,@nwUCL,@nwUWL,@nwLWL,@nwLCL,
          @package,@packageName,@customer,@destination,@labelInk,
          @inspectorName,@remark,
          @startTime, 'running', @shift, @reportDate);
       SELECT CAST(SCOPE_IDENTITY() AS BIGINT) AS id;`
    );
  return result.recordset[0].id;
}

/**
 * แก้ไข start_time/end_time/inspector_name ของเอกสาร (ใช้ในหน้า Monitor/Dashboard/ประวัติ)
 * คำนวณสรุปผลใหม่จาก "ช่วงเวลา" (ไม่ใช่ session_id) เพื่อให้ตรงกับเวลาที่แก้ล่าสุดเสมอ
 *
 * หมายเหตุ: ฟังก์ชันนี้ยัง aggregate จากตารางเดียว (TABLE) — ถ้าเอกสารนี้ผูกกับเครื่องชั่ง
 * ที่ข้อมูลน้ำหนักถูกแยกไปอยู่ตาราง Spout 1/2/3 แล้ว ต้อง map scale_id -> ชื่อตาราง
 * แล้วส่งเป็น tableName เข้ามาด้วย ไม่งั้นค่าสรุปผล (avg/min/max) จะคำนวณผิด/ว่างเปล่า
 */
async function updateSessionTimes(id, { startTime, endTime, inspectorName, remark }, tableName = null) {
  const table = resolveTable(tableName);
  const pool = await getPool();
  const current = await pool.request().input('id', sql.BigInt, id).query('SELECT * FROM [dbo].[Sessions] WHERE [id] = @id');
  const row = current.recordset[0];
  if (!row) throw new Error('ไม่พบเอกสารนี้');

  const newStart = startTime ?? row.start_time;
  const newEnd = endTime !== undefined ? endTime : row.end_time;
  const newInspector = inspectorName !== undefined ? inspectorName : row.inspector_name;
  const newRemark = remark !== undefined ? remark : row.remark;

  let agg = { cnt: 0, avgW: null, minW: null, maxW: null };
  if (newEnd) {
    const aggRes = await pool
      .request()
      .input('scaleId', sql.Int, row.scale_id)
      .input('from', sql.DateTime, newStart)
      .input('to', sql.DateTime, newEnd)
      .query(`
        SELECT COUNT(*) AS cnt, AVG([weight]) AS avgW, MIN([weight]) AS minW, MAX([weight]) AS maxW
        FROM ${table} WHERE [scale_id] = @scaleId AND [time_stamp] BETWEEN @from AND @to
      `);
    agg = aggRes.recordset[0] || agg;
  }

  let outOfSpec = null;
  if (newEnd && row.nw_lcl != null && row.nw_ucl != null) {
    const oos = await pool
      .request()
      .input('scaleId', sql.Int, row.scale_id)
      .input('from', sql.DateTime, newStart)
      .input('to', sql.DateTime, newEnd)
      .input('lcl', sql.Float, row.nw_lcl)
      .input('ucl', sql.Float, row.nw_ucl)
      .query(`
        SELECT COUNT(*) AS n FROM ${table}
        WHERE [scale_id] = @scaleId AND [time_stamp] BETWEEN @from AND @to AND ([weight] < @lcl OR [weight] > @ucl)
      `);
    outOfSpec = oos.recordset[0].n;
  }

  await pool
    .request()
    .input('id', sql.BigInt, id)
    .input('startTime', sql.DateTime, newStart)
    .input('endTime', sql.DateTime, newEnd)
    .input('inspectorName', sql.NVarChar(100), newInspector)
    .input('remark', sql.NVarChar(500), newRemark)
    .input('cnt', sql.Int, agg.cnt || 0)
    .input('avgW', sql.Float, agg.avgW ?? null)
    .input('minW', sql.Float, agg.minW ?? null)
    .input('maxW', sql.Float, agg.maxW ?? null)
    .input('oos', sql.Int, outOfSpec)
    .query(`
      UPDATE [dbo].[Sessions] SET
        [start_time] = @startTime, [end_time] = @endTime, [inspector_name] = @inspectorName, [remark] = @remark,
        [reading_count] = @cnt, [avg_weight] = @avgW, [min_weight] = @minW, [max_weight] = @maxW,
        [out_of_spec_count] = @oos
      WHERE [id] = @id
    `);

  return getSession(id);
}

/**
 * ปิดเอกสาร — คำนวณสรุปผลจากค่าน้ำหนักทั้งหมดที่ session_id นี้ในคราวเดียว (aggregate ฝั่ง SQL เร็วกว่าดึงมาคำนวณฝั่ง JS)
 *
 * หมายเหตุ: เช่นเดียวกับ updateSessionTimes — ต้องรู้ว่าเอกสารนี้อยู่ตาราง Spout ไหน
 * ก่อนเรียกฟังก์ชันนี้ (map จาก scale_id ของ session แล้วส่งเป็น tableName)
 */
async function closeSession(id, endTime, tableName = null) {
  const table = resolveTable(tableName);
  const pool = await getPool();

  const agg = await pool
    .request()
    .input('id', sql.BigInt, id)
    .query(`
      SELECT
        COUNT(*) AS cnt,
        AVG([weight]) AS avgW,
        MIN([weight]) AS minW,
        MAX([weight]) AS maxW
      FROM ${table} WHERE [session_id] = @id
    `);
  const a = agg.recordset[0] || {};

  // จำนวนที่หลุด spec (นอกช่วง LCL-UCL ของ NW ถ้ามี ไม่งั้นข้าม)
  const sess = await pool.request().input('id', sql.BigInt, id).query('SELECT * FROM [dbo].[Sessions] WHERE [id] = @id');
  const row = sess.recordset[0];
  let outOfSpec = null;
  if (row && row.nw_lcl != null && row.nw_ucl != null) {
    const oos = await pool
      .request()
      .input('id', sql.BigInt, id)
      .input('lcl', sql.Float, row.nw_lcl)
      .input('ucl', sql.Float, row.nw_ucl)
      .query(`SELECT COUNT(*) AS n FROM ${table} WHERE [session_id] = @id AND ([weight] < @lcl OR [weight] > @ucl)`);
    outOfSpec = oos.recordset[0].n;
  }

  await pool
    .request()
    .input('id', sql.BigInt, id)
    .input('endTime', sql.DateTime, endTime)
    .input('cnt', sql.Int, a.cnt || 0)
    .input('avgW', sql.Float, a.avgW ?? null)
    .input('minW', sql.Float, a.minW ?? null)
    .input('maxW', sql.Float, a.maxW ?? null)
    .input('oos', sql.Int, outOfSpec)
    .query(`
      UPDATE [dbo].[Sessions] SET
        [end_time] = @endTime, [status] = 'completed',
        [reading_count] = @cnt, [avg_weight] = @avgW, [min_weight] = @minW, [max_weight] = @maxW,
        [out_of_spec_count] = @oos
      WHERE [id] = @id
    `);

  const final = await pool.request().input('id', sql.BigInt, id).query('SELECT * FROM [dbo].[Sessions] WHERE [id] = @id');
  return final.recordset[0];
}

const SESSION_SORTABLE = new Set([
  'id', 'scale_id', 'group_code', 'product_code', 'start_time', 'end_time', 'status',
  'shift', 'report_date', 'reading_count', 'avg_weight', 'min_weight', 'max_weight',
  'out_of_spec_count', 'line', 'serial_no', 'scale_name',
]);

/**
 * หน้าประวัติ — list เอกสารทั้งหมด join ชื่อ/ไลน์/S-N ของเครื่องชั่ง, sort/filter/pagination ได้ทุกคอลัมน์
 */
async function listSessions({
  sortBy = 'start_time', sortDir = 'desc', page = 1, pageSize = 50,
  scaleId, line, serialNo, groupCode, productCode, shift, status, from, to,
} = {}) {
  const pool = await getPool();
  const col = SESSION_SORTABLE.has(sortBy) ? sortBy : 'start_time';
  const dir = String(sortDir).toLowerCase() === 'asc' ? 'ASC' : 'DESC';

  const req = pool.request();
  const where = [];
  if (scaleId) { req.input('scaleId', sql.Int, scaleId); where.push('sc.[id] = @scaleId'); }
  if (line) { req.input('line', sql.NVarChar(50), line); where.push('sc.[line] = @line'); }
  if (serialNo) { req.input('serialNo', sql.NVarChar(100), serialNo); where.push('sc.[serial_no] = @serialNo'); }
  if (groupCode) { req.input('groupCode', sql.NVarChar(50), groupCode); where.push('s.[group_code] = @groupCode'); }
  if (productCode) { req.input('productCode', sql.NVarChar(50), productCode); where.push('s.[product_code] = @productCode'); }
  if (shift) { req.input('shift', sql.VarChar(2), shift); where.push('s.[shift] = @shift'); }
  if (status) { req.input('status', sql.VarChar(20), status); where.push('s.[status] = @status'); }
  if (from) { req.input('from', sql.Date, from); where.push('s.[report_date] >= @from'); }
  if (to) { req.input('to', sql.Date, to); where.push('s.[report_date] <= @to'); }
  const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';

  const offset = Math.max(0, (page - 1) * pageSize);
  req.input('offset', sql.Int, offset).input('pageSize', sql.Int, pageSize);

  const orderCol = col === 'line' || col === 'serial_no' || col === 'scale_name'
    ? `sc.[${col === 'scale_name' ? 'name' : col}]`
    : `s.[${col}]`;

  const result = await req.query(`
    SELECT
      s.[id], s.[scale_id], sc.[name] AS scale_name, sc.[line], sc.[serial_no], sc.[ip], sc.[port],
      s.[group_code], s.[product_code],
      s.[fw_target],s.[fw_ucl],s.[fw_uwl],s.[fw_lwl],s.[fw_lcl],
      s.[nw_target],s.[nw_ucl],s.[nw_uwl],s.[nw_lwl],s.[nw_lcl],
      s.[package], s.[package_name], s.[customer], s.[destination], s.[label_ink],
      s.[inspector_name], s.[remark],
      s.[start_time], s.[end_time], s.[status], s.[shift], s.[report_date],
      s.[reading_count], s.[avg_weight], s.[min_weight], s.[max_weight], s.[out_of_spec_count],
      COUNT(*) OVER() AS total_count
    FROM [dbo].[Sessions] s
    JOIN [dbo].[Scales] sc ON sc.[id] = s.[scale_id]
    ${whereSql}
    ORDER BY ${orderCol} ${dir}
    OFFSET @offset ROWS FETCH NEXT @pageSize ROWS ONLY
  `);
  return result.recordset;
}

async function getSession(id) {
  const pool = await getPool();
  const result = await pool.request().input('id', sql.BigInt, id).query(`
    SELECT s.*, sc.[name] AS scale_name, sc.[line], sc.[serial_no], sc.[ip], sc.[port]
    FROM [dbo].[Sessions] s JOIN [dbo].[Scales] sc ON sc.[id] = s.[scale_id]
    WHERE s.[id] = @id
  `);
  return result.recordset[0] || null;
}

// ============================================================== Settings (key-value config)
async function getSettings() {
  const pool = await getPool();
  const result = await pool.request().query('SELECT [key], [value] FROM [dbo].[Settings]');
  const out = {};
  for (const row of result.recordset) out[row.key] = row.value;
  return out;
}

async function setSettings(map) {
  const pool = await getPool();
  for (const [key, value] of Object.entries(map)) {
    await pool
      .request()
      .input('key', sql.NVarChar(100), key)
      .input('value', sql.NVarChar(sql.MAX), value == null ? null : String(value))
      .query(`
        MERGE [dbo].[Settings] AS target
        USING (SELECT @key AS [key]) AS src ON target.[key] = src.[key]
        WHEN MATCHED THEN UPDATE SET [value] = @value, [updated_at] = GETDATE()
        WHEN NOT MATCHED THEN INSERT ([key], [value]) VALUES (@key, @value);
      `);
  }
  return getSettings();
}

async function ping() {
  const pool = await getPool();
  await pool.request().query('SELECT 1 AS ok');
  return true;
}

function status() {
  return {
    enabled: config.dbEnabled,
    target: `${config.db.server}:${config.db.port}/${config.db.database}`,
    table: TABLE,
    allowed_tables: Array.from(ALLOWED_TABLES),
    connected: Boolean(poolPromise && connectedAt),
    connected_at: connectedAt ? connectedAt.toISOString() : null,
    last_error: lastError,
  };
}

async function close() {
  if (!poolPromise) return;
  try {
    const pool = await poolPromise;
    await pool.close();
  } catch {
    /* ปิดไม่ได้ก็ไม่เป็นไร กำลังจะดับ process อยู่แล้ว */
  }
  poolPromise = null;
  connectedAt = null;
}

module.exports = {
  insertWeight,
  fetchRecent,
  fetchHistory,
  fetchSince,
  fetchRange,
  fetchWeightsBySession,
  listScales,
  createScale,
  updateScale,
  deleteScale,
  findRunningSessionByScale,
  createSession,
  closeSession,
  updateSessionTimes,
  listSessions,
  getSession,
  getSettings,
  setSettings,
  ping,
  status,
  close,
};