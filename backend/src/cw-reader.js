'use strict';

/**
 * cw-reader.js — อ่านข้อมูลจาก Checkweigher (Yamato CE3000 / I-series) ผ่าน OPC UA "1 เครื่อง"
 *
 * - อ่านอย่างเดียว ไม่เขียนค่าใด ๆ กลับไปที่เครื่อง (Security None + Anonymous)
 * - subscribe ค่าสด (น้ำหนัก/ผลตัดสิน/ตัวนับ/สถานะ) แล้วบันทึกเป็น "รายชิ้น" ลง dbo.CwPieces
 * - อ่านชื่อโปรแกรม/limit/สถิติเป็นรอบ แล้วบันทึก snapshot ลง dbo.CwSnapshots ทุก 1 นาที
 * - บันทึกเหตุการณ์ (เชื่อมต่อ/หลุด, สถานะ, เปลี่ยนโปรแกรม, error, ชิ้นหลุด) ลง dbo.CwEvents
 * - มี interface เดียวกับ ScaleReader (start/stop/attachSession/snapshot/memory*) เพื่อให้ scale-manager
 *   และหน้า Monitor/Dashboard/ประวัติเดิมใช้งานได้ทันที
 *
 * library node-opcua-client ถูก require ตอนเริ่มเชื่อมต่อเท่านั้น — ถ้ายังไม่ได้ติดตั้ง
 * เครื่องชั่ง TCP เดิมยังทำงานปกติ เครื่องนี้จะขึ้นสถานะ error พร้อมบอกวิธีแก้
 */

const config = require('./config');
const db = require('./db');
const logger = require('./logger');
const TAGS = require('./cw-tags');

const BAND = { ACCEPT: 0, OVER: 1, UNDER: 2, HIHI: 3, LOLO: 4 };
const BAND_LABEL = ['Accept', 'Over', 'Under', 'HiHi', 'LoLo'];
const CW_TABLE = '[dbo].[CwPieces]';

let opcua = null;
function loadOpcua() {
  if (opcua) return opcua;
  opcua = require('node-opcua-client'); // eslint-disable-line global-require
  return opcua;
}

function num(v) {
  if (v === null || v === undefined) return null;
  const n = typeof v === 'bigint' ? Number(v) : Number(v);
  return Number.isFinite(n) ? n : null;
}

class CheckweigherReader {
  constructor(scaleRow) {
    this.deviceType = 'opcua';
    this.scaleId = scaleRow.id;
    this.name = scaleRow.name;
    this.ip = scaleRow.ip;
    this.port = scaleRow.port;
    this.line = scaleRow.line;
    this.serialNo = scaleRow.serial_no;
    this.tableName = CW_TABLE;
    this.endpoint = `opc.tcp://${this.ip}:${this.port}`;

    this.status = 'stopped'; // stopped | connecting | connected | reconnecting | error
    this.lastError = null;
    this.connectedAt = null;

    // ค่าสดล่าสุดจาก subscription (ค่าดิบ)
    this.cur = {};
    // ข้อมูลที่อ่านเป็นรอบ (แปลงหน่วยแล้ว)
    this.info = {};
    this.infoAt = null;

    this.lastWeight = null;
    this.lastReceivedAt = null; // เวลาชิ้นล่าสุด
    this.lastPiece = null;
    this.totalReceived = 0; // จำนวนชิ้นที่ระบบรับได้ตั้งแต่เปิด backend
    this.totalInserted = 0;
    this.totalInsertFailed = 0;
    this.totalGaps = 0;

    this.activeSessionId = null;
    this.activeGroupCode = null;
    this.activeProductCode = null;
    this.activeSessionStart = null;

    this._stopped = true;
    this._client = null;
    this._session = null;
    this._subscription = null;
    this._pollTimer = null;
    this._snapTimer = null;
    this._pendingPiece = null; // { timer, delta }
    this._lastCount = null;
    this._countAtLoss = null; // ตัวนับตอนการเชื่อมต่อหลุด — ใช้คำนวณจำนวนชิ้นที่พลาดระหว่างหลุด
    this._periodPieces = 0;
    this._periodGaps = 0;

    this._ring = [];
    this._events = [];
    this._maxSeenId = 0;
    this._queue = Promise.resolve();
  }

  // ---------------------------------------------------------------- lifecycle
  start() {
    if (!this._stopped) return;
    this._stopped = false;
    this._connect();
  }

  stop() {
    this._stopped = true;
    this.status = 'stopped';
    this._clearTimers();
    this._teardown().catch(() => {});
  }

  attachSession(sessionId, groupCode, productCode, startTime) {
    this.activeSessionId = sessionId;
    this.activeGroupCode = groupCode;
    this.activeProductCode = productCode;
    this.activeSessionStart = startTime || new Date();
  }

  detachSession() {
    this.activeSessionId = null;
    this.activeGroupCode = null;
    this.activeProductCode = null;
    this.activeSessionStart = null;
  }

  _clearTimers() {
    if (this._pollTimer) { clearInterval(this._pollTimer); this._pollTimer = null; }
    if (this._snapTimer) { clearInterval(this._snapTimer); this._snapTimer = null; }
    if (this._pendingPiece) { clearTimeout(this._pendingPiece.timer); this._pendingPiece = null; }
  }

  async _teardown() {
    const client = this._client;
    const session = this._session;
    const subscription = this._subscription;
    this._client = null;
    this._session = null;
    this._subscription = null;
    try { if (subscription) await subscription.terminate(); } catch { /* ignore */ }
    try { if (session) await session.close(); } catch { /* ignore */ }
    try { if (client) await client.disconnect(); } catch { /* ignore */ }
  }

  async _connect() {
    if (this._stopped) return;
    let lib;
    try {
      lib = loadOpcua();
    } catch (err) {
      this.status = 'error';
      this.lastError = 'ยังไม่ได้ติดตั้ง node-opcua-client — รัน "cd backend && npm install" แล้ว restart backend';
      logger.error(`[${this.name}] ${this.lastError} (${err.message})`);
      return;
    }

    const { OPCUAClient, MessageSecurityMode, SecurityPolicy } = lib;
    this.status = 'connecting';
    logger.info(`[${this.name}] OPC UA connecting to ${this.endpoint} ...`);

    const client = OPCUAClient.create({
      applicationName: 'AutoWeightCheckHUB',
      securityMode: MessageSecurityMode.None,
      securityPolicy: SecurityPolicy.None,
      endpointMustExist: false,
      keepSessionAlive: true,
      requestedSessionTimeout: 600000,
      // retry ไม่สิ้นสุด (ห่างสุด 30 วินาที) ทั้งตอนเชื่อมต่อครั้งแรกและตอนสายหลุด
      connectionStrategy: { maxRetry: -1, initialDelay: 2000, maxDelay: 30000 },
    });
    this._client = client;

    client.on('backoff', (retry, delay) => {
      this.status = 'connecting';
      this.lastError = `เชื่อมต่อไม่ได้ ลองใหม่ครั้งที่ ${retry + 1} (อีก ${Math.round(delay / 1000)} วินาที)`;
      if (retry % 10 === 0) logger.warn(`[${this.name}] OPC UA ${this.endpoint} ${this.lastError}`);
    });
    client.on('connection_lost', () => {
      if (this._stopped) return;
      this.status = 'reconnecting';
      this.lastError = 'การเชื่อมต่อหลุด กำลังเชื่อมต่อใหม่';
      logger.warn(`[${this.name}] OPC UA connection lost`);
      this._event('disconnected', 'alarm', 'การเชื่อมต่อกับเครื่องหลุด');
      if (this._lastCount != null) this._countAtLoss = this._lastCount;
    });
    client.on('connection_reestablished', () => {
      if (this._stopped) return;
      this.status = 'connected';
      this.lastError = null;
      logger.info(`[${this.name}] OPC UA connection re-established`);
      this._event('connected', 'info', 'เชื่อมต่อกลับมาแล้ว');
      // ตัวนับเดินต่อระหว่างหลุด — ค่าแรกหลังเชื่อมต่อใหม่เป็น baseline และนับส่วนต่างเป็นชิ้นที่พลาด
      this._lastCount = null;
    });

    try {
      await client.connect(this.endpoint);
      if (this._stopped) { await this._teardown(); return; }
      const session = await client.createSession();
      this._session = session;
      await this._subscribe(lib, session);
      this.status = 'connected';
      this.lastError = null;
      this.connectedAt = new Date();
      logger.info(`[${this.name}] OPC UA connected ${this.endpoint}`);
      this._event('connected', 'info', `เชื่อมต่อ ${this.endpoint}`);

      await this._poll();
      this._pollTimer = setInterval(() => this._poll(), config.cw.pollIntervalMs);
      this._snapTimer = setInterval(() => this._snapshotToDb(), config.cw.snapshotIntervalMs);
    } catch (err) {
      if (this._stopped) return;
      this.status = 'error';
      this.lastError = err.message;
      logger.error(`[${this.name}] OPC UA error: ${err.message}`);
      this._clearTimers();
      await this._teardown();
      setTimeout(() => this._connect(), 10000).unref();
    }
  }

  async _subscribe(lib, session) {
    const { ClientSubscription, ClientMonitoredItemGroup, AttributeIds, TimestampsToReturn } = lib;
    const subscription = ClientSubscription.create(session, {
      requestedPublishingInterval: config.cw.publishingIntervalMs,
      requestedLifetimeCount: 6000,
      requestedMaxKeepAliveCount: 20,
      maxNotificationsPerPublish: 1000,
      publishingEnabled: true,
      priority: 10,
    });
    this._subscription = subscription;

    const keys = Object.keys(TAGS.live);
    const items = keys.map((k) => ({ nodeId: TAGS.live[k], attributeId: AttributeIds.Value }));
    const group = ClientMonitoredItemGroup.create(
      subscription,
      items,
      // queueSize > 1 = ถ้าค่าเปลี่ยนหลายครั้งใน 1 รอบ publish จะได้ครบทุกค่า ไม่ตกหล่น
      { samplingInterval: config.cw.samplingIntervalMs, discardOldest: false, queueSize: 20 },
      TimestampsToReturn.Both
    );
    group.on('initialized', () => {
      // server อาจปรับรอบการอ่านให้ช้ากว่าที่ขอ — ถ้าช้ากว่าระยะห่างระหว่างชิ้น จะเกิด "ชิ้นหลุด" (gap)
      const revised = group.monitoredItems
        .map((m, i) => `${keys[i]}=${m.result && m.result.revisedSamplingInterval}`)
        .filter((x) => /^(weight|totalCount|rankCode)=/.test(x));
      logger.info(`[${this.name}] OPC UA revised sampling interval (ms): ${revised.join(', ')}`);
    });
    group.on('changed', (monitoredItem, dataValue, index) => {
      try {
        this._onChange(keys[index], dataValue);
      } catch (err) {
        logger.error(`[${this.name}] handle change ${keys[index]}: ${err.message}`);
      }
    });
  }

  // ----------------------------------------------------------------- live data
  _onChange(key, dataValue) {
    if (!dataValue || !dataValue.statusCode || !dataValue.statusCode.isGood()) return;
    const value = dataValue.value ? dataValue.value.value : null;
    const prev = this.cur[key];
    this.cur[key] = value;

    switch (key) {
      case 'totalCount': this._onCount(num(value)); break;
      case 'weight':
        if (config.cw.pieceTrigger === 'weight' && prev !== undefined && value !== prev) this._schedulePiece(1);
        break;
      case 'operationStatus':
        if (prev !== undefined && value !== prev) this._event('status', 'info', `สถานะเครื่อง ${prev} → ${value}`);
        break;
      case 'programNo':
        if (prev !== undefined && value !== prev) {
          this._event('program', 'warn', `เปลี่ยนโปรแกรมสินค้า No.${prev} → No.${value}`);
          this._poll();
        }
        break;
      case 'error1': case 'error2': case 'error9': case 'error10':
        if (num(value) && value !== prev) this._event('error', 'alarm', `เครื่องแจ้ง ${key} = ${value}`);
        break;
      default:
        break;
    }
  }

  _onCount(count) {
    if (config.cw.pieceTrigger !== 'count' || count == null) return;
    if (this._lastCount == null) { // ค่าแรกหลังเชื่อมต่อ = baseline
      if (this._countAtLoss != null) {
        const missed = count - this._countAtLoss;
        if (missed > 0) {
          this.totalGaps += missed;
          this._periodGaps += missed;
          this._event('gap', 'warn', `ระหว่างการเชื่อมต่อหลุด มีชิ้นผ่านเครื่อง ${missed} ชิ้นที่ระบบไม่ได้บันทึกรายชิ้น`);
        } else if (missed < 0) {
          this._event('stats_cleared', 'info', `ตัวนับบนเครื่องถูกล้างระหว่างการเชื่อมต่อหลุด (${this._countAtLoss} → ${count})`);
        }
        this._countAtLoss = null;
      }
      this._lastCount = count;
      return;
    }
    if (count < this._lastCount) {
      this._event('stats_cleared', 'info', `ตัวนับบนเครื่องถูกล้าง (${this._lastCount} → ${count})`);
      this._lastCount = count;
      return;
    }
    const delta = count - this._lastCount;
    this._lastCount = count;
    if (delta > 0) this._schedulePiece(delta);
  }

  /** รอค่า Weight/RankCode ของชิ้นเดียวกันตามมาสักครู่ แล้วค่อยบันทึก (กันได้ค่าของชิ้นก่อนหน้า) */
  _schedulePiece(delta) {
    if (this._pendingPiece) {
      this._pendingPiece.delta += delta;
      return;
    }
    const pending = { delta, timer: null };
    pending.timer = setTimeout(() => {
      this._pendingPiece = null;
      this._commitPiece(pending.delta);
    }, config.cw.pieceSettleMs);
    this._pendingPiece = pending;
  }

  _scaleWeight(raw) {
    const n = num(raw);
    return n == null ? null : n / 10 ** config.cw.weightDecimals;
  }

  limits() {
    const i = this.info;
    const target = i.target ?? this._scaleWeight(this.cur.currentTarget);
    return {
      target,
      hi: i.hiLimitAbs ?? null,
      lo: i.loLimitAbs ?? null,
      hihi: i.hiHiLimitAbs ?? null,
      lolo: i.loLoLimitAbs ?? null,
    };
  }

  static band(weight, lim) {
    if (weight == null || lim.hi == null || lim.lo == null) return null;
    if (lim.hihi != null && weight > lim.hihi) return BAND.HIHI;
    if (weight > lim.hi) return BAND.OVER;
    if (lim.lolo != null && weight < lim.lolo) return BAND.LOLO;
    if (weight < lim.lo) return BAND.UNDER;
    return BAND.ACCEPT;
  }

  _commitPiece(delta) {
    const raw = num(this.cur.weight);
    const weight = this._scaleWeight(raw);
    if (weight == null) return;
    const ts = new Date();
    const lim = this.limits();
    const gap = Math.max(0, delta - 1);
    const piece = {
      weight,
      time_stamp: ts,
      raw_weight: raw,
      rank_code: num(this.cur.rankCode),
      sub_rank_code: num(this.cur.subRankCode),
      pass_flag: num(this.cur.passFlag),
      band: CheckweigherReader.band(weight, lim),
      target_weight: lim.target,
      program_no: num(this.cur.programNo),
      total_count: num(this.cur.totalCount),
      gap,
      session_id: this.activeSessionId,
      scale_id: this.scaleId,
    };

    this.lastWeight = weight;
    this.lastReceivedAt = ts;
    this.lastPiece = piece;
    this.totalReceived += 1;
    this._periodPieces += 1;
    if (gap > 0) {
      this.totalGaps += gap;
      this._periodGaps += gap;
      this._event('gap', 'warn', `อ่านไม่ทัน ${gap} ชิ้น (TotalCount เพิ่ม ${delta})`);
    }
    this._enqueueInsert(piece);
  }

  _enqueueInsert(piece) {
    this._queue = this._queue.then(async () => {
      let id = null;
      let persisted = false;
      if (config.dbEnabled) {
        try {
          id = await db.insertCwPiece(piece);
          persisted = true;
          this.totalInserted += 1;
        } catch (err) {
          this.totalInsertFailed += 1;
          this.lastError = `DB insert failed: ${err.message}`;
          logger.error(`[${this.name}] CwPieces insert failed weight=${piece.weight}: ${err.message}`);
        }
      }
      if (id == null) id = this._maxSeenId + 1;
      this._pushRing({ ...piece, id, persisted });
    });
    return this._queue;
  }

  _pushRing(rec) {
    if (rec.id > this._maxSeenId) this._maxSeenId = rec.id;
    this._ring.push(rec);
    const overflow = this._ring.length - config.cw.memoryPieces;
    if (overflow > 0) this._ring.splice(0, overflow);
  }

  _event(type, severity, detail) {
    const ev = { scale_id: this.scaleId, time_stamp: new Date(), event_type: type, severity, detail };
    this._events.push(ev);
    if (this._events.length > 300) this._events.splice(0, this._events.length - 300);
    if (config.dbEnabled) {
      db.insertCwEvent(ev).catch((err) => logger.error(`[${this.name}] CwEvents insert failed: ${err.message}`));
    }
  }

  // ------------------------------------------------------------- poll / snapshot
  async _poll() {
    const session = this._session;
    if (!session || this._stopped) return;
    const lib = loadOpcua();
    const keys = Object.keys(TAGS.poll);
    try {
      const values = await session.read(keys.map((k) => ({ nodeId: TAGS.poll[k], attributeId: lib.AttributeIds.Value })));
      const raw = {};
      keys.forEach((k, i) => {
        const dv = values[i];
        raw[k] = dv && dv.statusCode && dv.statusCode.isGood() && dv.value ? dv.value.value : null;
      });
      const w = (v) => this._scaleWeight(v);
      const sd = (v) => (num(v) == null ? null : num(v) / 10 ** config.cw.sdDecimals);
      const cp = (v) => (num(v) == null ? null : num(v) / 10 ** config.cw.cpDecimals);
      const target = w(raw.rankTarget);
      const rel = config.cw.limitsRelative;
      const abs = (off, sign) => {
        const o = w(off);
        if (o == null || target == null) return null;
        return rel ? Math.round((target + sign * o) * 1000) / 1000 : o;
      };
      this.info = {
        programName: raw.programName != null ? String(raw.programName).trim() : null,
        speedSetting: num(raw.speedSetting),
        target,
        hiLimitAbs: abs(raw.hiLimit, +1),
        loLimitAbs: abs(raw.loLimit, -1),
        hiHiLimitAbs: abs(raw.hiHiLimit, +1),
        loLoLimitAbs: abs(raw.loLoLimit, -1),
        raw: {
          hiLimit: num(raw.hiLimit), loLimit: num(raw.loLimit), hiHiLimit: num(raw.hiHiLimit), loLoLimit: num(raw.loLoLimit),
        },
        stats: {
          total: num(raw.totalCountPoll),
          accept: num(raw.acceptCount),
          over: num(raw.overCount),
          under: num(raw.underCount),
          hihi: num(raw.hiHiCount),
          lolo: num(raw.loLoCount),
          metal: num(raw.metalCount),
          error: num(raw.errorCount),
          average: w(raw.averageTotal),
          sd: sd(raw.productSd),
          cp: cp(raw.machineCp),
          cpk: cp(raw.machineCpk),
        },
        infeedSpeed: num(raw.infeedSpeed),
        passSpeed: num(raw.passSpeed),
      };
      this.infoAt = new Date();
    } catch (err) {
      logger.warn(`[${this.name}] OPC UA poll failed: ${err.message}`);
    }
  }

  async _snapshotToDb() {
    const pieces = this._periodPieces;
    const gaps = this._periodGaps;
    this._periodPieces = 0;
    this._periodGaps = 0;
    if (!config.dbEnabled) return;
    const i = this.info || {};
    const s = i.stats || {};
    try {
      await db.insertCwSnapshot({
        scale_id: this.scaleId,
        time_stamp: new Date(),
        connected: this.status === 'connected',
        operation_status: num(this.cur.operationStatus),
        program_no: num(this.cur.programNo),
        program_name: i.programName || null,
        speed_setting: i.speedSetting ?? null,
        target_weight: i.target ?? null,
        hi_limit: i.hiLimitAbs ?? null,
        lo_limit: i.loLimitAbs ?? null,
        hihi_limit: i.hiHiLimitAbs ?? null,
        lolo_limit: i.loLoLimitAbs ?? null,
        total_count: s.total ?? null,
        accept_count: s.accept ?? null,
        over_count: s.over ?? null,
        under_count: s.under ?? null,
        hihi_count: s.hihi ?? null,
        lolo_count: s.lolo ?? null,
        metal_count: s.metal ?? null,
        error_count: s.error ?? null,
        average_weight: s.average ?? null,
        sd_weight: s.sd ?? null,
        machine_cp: s.cp ?? null,
        machine_cpk: s.cpk ?? null,
        infeed_speed: i.infeedSpeed ?? null,
        pass_speed: i.passSpeed ?? null,
        pieces_in_period: pieces,
        gaps_in_period: gaps,
      });
    } catch (err) {
      logger.error(`[${this.name}] CwSnapshots insert failed: ${err.message}`);
    }
  }

  // ------------------------------------------------------------------ readers
  memorySince(sinceId, limit) {
    return this._ring.filter((r) => r.id > sinceId).slice(0, limit);
  }

  memoryHistory(limit) {
    return this._ring.slice(-limit);
  }

  memoryEvents(limit) {
    return this._events.slice(-limit).reverse();
  }

  runState() {
    if (this.status !== 'connected') return this.status;
    const last = this.lastReceivedAt ? Date.now() - this.lastReceivedAt.getTime() : Infinity;
    return last <= config.cw.idleAfterSec * 1000 ? 'running' : 'idle';
  }

  snapshot() {
    const i = this.info || {};
    const lim = this.limits();
    const rankCode = this.lastPiece ? this.lastPiece.rank_code : null;
    const errors = ['error1', 'error2', 'error9', 'error10']
      .filter((k) => num(this.cur[k]))
      .map((k) => `${k}=${this.cur[k]}`);
    return {
      scale_id: this.scaleId,
      device_type: this.deviceType,
      name: this.name,
      ip: this.ip,
      port: this.port,
      line: this.line,
      serial_no: this.serialNo,
      table_name: this.tableName,
      device: this.endpoint,
      sim_mode: false,
      connection_status: this.status,
      last_weight: this.lastWeight,
      last_received_at: this.lastReceivedAt ? this.lastReceivedAt.toISOString() : null,
      total_received: this.totalReceived,
      total_inserted: this.totalInserted,
      total_insert_failed: this.totalInsertFailed,
      memory_rows: this._ring.length,
      last_error: this.lastError,
      active_session_id: this.activeSessionId,
      active_group_code: this.activeGroupCode,
      active_product_code: this.activeProductCode,
      active_session_start: this.activeSessionStart ? this.activeSessionStart.toISOString() : null,
      cw: {
        run_state: this.runState(),
        operation_status: num(this.cur.operationStatus),
        program_no: num(this.cur.programNo),
        program_name: i.programName || null,
        speed_setting: i.speedSetting ?? null,
        infeed_speed: i.infeedSpeed ?? null,
        pass_speed: i.passSpeed ?? null,
        limits: lim,
        limits_relative: config.cw.limitsRelative,
        limits_raw: i.raw || null,
        last_rank_code: rankCode,
        last_rank_label: rankCode != null ? (config.cw.rankLabels[String(rankCode)] || null) : null,
        last_band: this.lastPiece ? this.lastPiece.band : null,
        last_band_label: this.lastPiece && this.lastPiece.band != null ? BAND_LABEL[this.lastPiece.band] : null,
        last_pass_flag: this.lastPiece ? this.lastPiece.pass_flag : null,
        machine_stats: i.stats || null,
        machine_errors: errors,
        gaps_total: this.totalGaps,
        info_at: this.infoAt ? this.infoAt.toISOString() : null,
        connected_at: this.connectedAt ? this.connectedAt.toISOString() : null,
      },
    };
  }
}

CheckweigherReader.BAND = BAND;
CheckweigherReader.BAND_LABEL = BAND_LABEL;
CheckweigherReader.TABLE = CW_TABLE;

module.exports = CheckweigherReader;
