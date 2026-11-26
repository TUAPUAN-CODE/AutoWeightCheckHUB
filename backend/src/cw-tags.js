'use strict';

/**
 * cw-tags.js — NodeId ของ OPC UA server ในเครื่อง Yamato CE3000 (I-series Checkweigher)
 * ได้จากการ browse เครื่องจริง (Objects/CW) — namespace 2, numeric id
 *
 * live  = subscribe (เครื่องแจ้งทันทีที่ค่าเปลี่ยน) — ใช้จับน้ำหนักรายชิ้น/สถานะ
 * poll  = อ่านเป็นรอบ (config.cw.pollIntervalMs) — ชื่อโปรแกรม, limit, สถิติสะสม
 *
 * ค่าน้ำหนักทุกตัวเป็นจำนวนเต็มไม่มีจุดทศนิยม (เช่น 880 = 88.0 g) — แปลงใน cw-reader.js
 */
module.exports = {
  live: {
    operationStatus: 'ns=2;i=649', // OperationInfo/Common/OperationStatus
    programNo: 'ns=2;i=651', // OperationInfo/Common/CurrentProgramNo.
    weight: 'ns=2;i=652', // OperationInfo/Weighing/Weight
    passFlag: 'ns=2;i=653', // OperationInfo/Weighing/PassFlag
    rankCode: 'ns=2;i=654', // OperationInfo/Weighing/ResultRankCode
    subRankCode: 'ns=2;i=655', // OperationInfo/Weighing/SubResultRankCode
    currentTarget: 'ns=2;i=657', // OperationInfo/Weighing/CurrentTargetWeight
    totalCount: 'ns=2;i=122', // Statistics/Total/TotalCount
    error1: 'ns=2;i=660', // OperationInfo/Status/MachineStatusError1
    error2: 'ns=2;i=661',
    error9: 'ns=2;i=662',
    error10: 'ns=2;i=663',
  },
  poll: {
    programName: 'ns=2;i=0', // Program/Common/ProgramName
    speedSetting: 'ns=2;i=1', // Program/Common/Speed (ชิ้น/นาที)
    rankTarget: 'ns=2;i=12', // Program/Rank/TargetWeight
    hiHiLimit: 'ns=2;i=13',
    hiLimit: 'ns=2;i=14',
    loLimit: 'ns=2;i=15',
    loLoLimit: 'ns=2;i=16',
    hiHiCount: 'ns=2;i=114', // Statistics/Total/*
    overCount: 'ns=2;i=115',
    acceptCount: 'ns=2;i=116',
    underCount: 'ns=2;i=117',
    loLoCount: 'ns=2;i=118',
    metalCount: 'ns=2;i=119',
    errorCount: 'ns=2;i=120',
    totalCountPoll: 'ns=2;i=122',
    averageTotal: 'ns=2;i=127',
    productSd: 'ns=2;i=128',
    machineCp: 'ns=2;i=146',
    machineCpk: 'ns=2;i=147',
    infeedSpeed: 'ns=2;i=271', // Statistics/Others/InfeedSpeed
    passSpeed: 'ns=2;i=272', // Statistics/Others/PassSpeed
  },
};
