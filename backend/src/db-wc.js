'use strict';

/**
 * db-wc.js — เชื่อมต่อ SQL Server ตัวที่สอง (ITC.SCC.IVDB.WGTCHR) แบบอ่านอย่างเดียว
 * ใช้สำหรับดึง GroupCode -> ProductCode และ spec FW/NW มาให้หน้า Monitor เลือกตอนกด "เริ่ม"
 * ไม่มีการ insert/update/delete ใด ๆ กับ DB นี้
 */

const sql = require('mssql');
const config = require('./config');
const logger = require('./logger');

let poolPromise = null;

const BASE_QUERY = `
  SELECT
      c.ProductCode
    , c.GroupCode
    , c.LabelInk
    , p.Package      AS PackageSize
    , p.PackageName
    , cu.Customer
    , cu.Destination
    , c.TargetFW AS fwTarget
    , c.uclFW    AS fwUCL
    , c.uwlFW    AS fwUWL
    , c.lwlFW    AS fwLWL
    , c.lclFW    AS fwLCL
    , c.TargetNW AS nwTarget
    , c.uclNW    AS nwUCL
    , c.uwlNW    AS nwUWL
    , c.lwlNW    AS nwLWL
    , c.lclNW    AS nwLCL
  FROM dbo.TunaCodes c
  LEFT OUTER JOIN dbo.TunaCustomers cu ON c.CustomerId = cu.Id
  LEFT OUTER JOIN dbo.TunaPackages  p  ON c.PackageId  = p.Id
`;

function assertEnabled() {
  if (!config.dbWc.enabled) {
    throw new Error('DB_SERVER_WC/DB_DATABASE_WC ยังไม่ได้ตั้งค่า — ปิดการใช้งาน DB ตัวที่สองอยู่');
  }
}

async function getPool() {
  assertEnabled();
  if (poolPromise) return poolPromise;

  const pool = new sql.ConnectionPool({
    server: config.dbWc.server,
    port: config.dbWc.port,
    database: config.dbWc.database,
    user: config.dbWc.user,
    password: config.dbWc.password,
    connectionTimeout: 10000,
    requestTimeout: 15000,
    pool: { max: 5, min: 0, idleTimeoutMillis: 30000 },
    options: {
      encrypt: config.dbWc.encrypt,
      trustServerCertificate: config.dbWc.trustServerCertificate,
      enableArithAbort: true,
    },
  });

  pool.on('error', (err) => {
    logger.error(`DB(WC) pool error: ${err.message}`);
    poolPromise = null;
  });

  poolPromise = pool
    .connect()
    .then((p) => {
      logger.info(`DB(WC) connected: ${config.dbWc.server}:${config.dbWc.port}/${config.dbWc.database}`);
      return p;
    })
    .catch((err) => {
      poolPromise = null;
      throw err;
    });

  return poolPromise;
}

/** รายชื่อ GroupCode ทั้งหมด (distinct) เรียงตามตัวอักษร */
async function getGroups() {
  const pool = await getPool();
  const result = await pool.request().query(`
    SELECT DISTINCT c.GroupCode
    FROM dbo.TunaCodes c
    WHERE c.GroupCode IS NOT NULL AND c.GroupCode <> ''
    ORDER BY c.GroupCode
  `);
  return result.recordset.map((r) => r.GroupCode);
}

/** ProductCode ทั้งหมด (+spec) ภายใต้ GroupCode ที่ระบุ */
async function getProductsByGroup(groupCode) {
  const pool = await getPool();
  const result = await pool
    .request()
    .input('group', sql.NVarChar(100), groupCode)
    .query(`${BASE_QUERY} WHERE c.GroupCode = @group ORDER BY c.ProductCode`);
  return result.recordset;
}

/** spec ของ ProductCode เดี่ยว ๆ — ใช้ตอนกด "เริ่ม" เพื่อ snapshot ค่า spec ลง session */
async function getProduct(productCode) {
  const pool = await getPool();
  const result = await pool
    .request()
    .input('code', sql.NVarChar(100), productCode)
    .query(`${BASE_QUERY} WHERE c.ProductCode = @code`);
  return result.recordset[0] || null;
}

async function ping() {
  const pool = await getPool();
  await pool.request().query('SELECT 1 AS ok');
  return true;
}

module.exports = { getGroups, getProductsByGroup, getProduct, ping };
