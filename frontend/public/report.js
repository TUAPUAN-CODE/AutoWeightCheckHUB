/**
 * report.js — สร้าง HTML ของใบ "WEIGHT CHECK RECORD" (พิมพ์ / Export PDF ผ่าน window.print())
 * ใช้ร่วมกันระหว่างหน้า Dashboard (ข้อมูลสด) และหน้าประวัติ (ข้อมูลย้อนหลังของ 1 เอกสาร)
 *
 * เรียกใช้: window.buildWeightCheckReportHtml(opts) -> คืน HTML string เต็มหน้า พร้อม window.open + document.write เอง
 */
(function () {
  function fmtNum(v, digits) {
    if (v == null || Number.isNaN(v)) return '-';
    return Number(v).toFixed(digits ?? 1);
  }

  /**
   * opts:
   *   productCode, groupCode, packageSize, packageName, customerLabel, lineLabel, inspectorName,
   *   nwTarget, nwUcl, nwUwl, nwLwl, nwLcl,
   *   values: number[]  (ค่าน้ำหนักดิบทั้งหมดในช่วงเวลาที่เลือก/ของเอกสาร)
   *   dateStr, timeStr, rangeLabel, docLabel (เลขที่เอกสารในระบบ ถ้ามี), remark (หมายเหตุที่กรอกตอนเริ่มเอกสาร),
   *   formCode (รหัสฟอร์ม/document control number — ค่าคงที่จากหน้าตั้งค่า)
   */
  function buildWeightCheckReportHtml(opts) {
    const {
      productCode = '-', groupCode = '-', packageSize = '', packageName = '', customerLabel = '-',
      lineLabel = '-', inspectorName = '-',
      nwTarget, nwUcl, nwUwl, nwLwl, nwLcl,
      values = [], dateStr = '-', timeStr = '-', rangeLabel = '-', docLabel = '',
      remark = '', formCode = '',
    } = opts;

    const sizeLabel = [packageSize, packageName].filter(Boolean).join(' — ') || '-';
    const remarkText = remark && remark.trim()
      ? remark.trim()
      : `Auto-generated from SPC Panel · Range: ${rangeLabel}`;

    const n = values.length;
    const avg = n ? values.reduce((a, x) => a + x, 0) / n : null;
    const minV = n ? Math.min(...values) : null;
    const maxV = n ? Math.max(...values) : null;

    const EMPTY_STAT = '<td class="cell stat"></td>';
    function firstTripleCells(a, b, c) {
      return `<td class="cell stat statval">${a}</td><td class="cell stat statval">${b}</td><td class="cell stat statval">${c}</td>` + EMPTY_STAT.repeat(21);
    }
    const BLANK_24 = EMPTY_STAT.repeat(24);

    const html = `<!doctype html><html lang="th"><head><meta charset="utf-8">
<title>WEIGHT CHECK RECORD - i-Tail Corporation ${formCode || ''}</title>
<style>
  :root{ --navy:#191970; --shade:#F0F8FF; --red:#e8747c; --page-bg:#e9ebf2; }
  *{box-sizing:border-box;}
  body{ margin:0; padding:24px; background:var(--page-bg); font-family:"Courier New","Consolas",ui-monospace,monospace; color:var(--navy); }
  .toolbar{ max-width:1900px; margin:0 auto 14px auto; display:flex; justify-content:flex-end; gap:10px; }
  .toolbar button{ font-family:inherit; font-size:13px; padding:8px 16px; border:1.5px solid var(--navy); background:#fff; color:var(--navy); border-radius:4px; cursor:pointer; font-weight:bold; }
  .toolbar button:hover{ background:var(--navy); color:#fff; }
  .sheet-wrap{ max-width:1900px; margin:0 auto; overflow-x:auto; background:#fff; box-shadow:0 2px 14px rgba(25,25,112,0.18); padding:14px; }
  table.form{ border-collapse:collapse; width:100%; min-width:1720px; table-layout:fixed; }
  table.form col.c-major{ width:150px; } table.form col.c-box{ width:96px; } table.form col.c-scale{ width:48px; } table.form col.c-stat{ width:66px; }
  td.cell{ border:1px solid var(--navy); padding:3px 6px; font-size:12.5px; line-height:1.25; vertical-align:middle; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
  .bold{ font-weight:700; } .shaded{ background:var(--shade); } .vcenter{ text-align:center; vertical-align:middle; }
  tr.titlebar td.titlecell{ border:2px solid var(--navy); font-size:21px; font-weight:700; letter-spacing:0.5px; padding:10px 14px; white-space:normal; }
  tr.titlebar td.titlecenter{ text-align:center; }
  tr.addrrow td.addrcell{ border:1px solid var(--navy); border-top:none; font-size:13px; font-weight:700; padding:5px 10px; white-space:normal; }
  .chkbox{ display:inline-block; width:15px; height:15px; border:2px solid var(--navy); text-align:center; line-height:13px; font-size:12px; margin-right:4px; color:var(--navy); font-weight:900; }
  tr.dprow td.dpcell{ border:1px solid var(--navy); padding:6px 10px; font-size:13px; white-space:normal; }
  .fieldlabel{ font-weight:400; }
  .typed{ font-family:"Trebuchet MS","Segoe UI",sans-serif; font-weight:600; font-size:15px; border-bottom:1.5px solid var(--navy); padding:0 4px 1px 4px; }
  .qcinspector{ text-align:right; }
  .signature{ font-family:"Segoe Script","Brush Script MT",cursive; font-size:20px; font-weight:700; border-bottom:1.5px solid var(--navy); padding:0 10px 0 6px; color:var(--navy); display:inline-block; min-width:120px; }
  td.labelmajor{ font-size:12.5px; white-space:normal; font-weight:400; }
  td.box{ text-align:center; font-size:12px; } td.scale{ text-align:right; font-weight:700; padding-right:8px; }
  td.prodval{ text-align:center; font-size:14px; white-space:normal; }
  td.stathead{ text-align:center; font-weight:700; background:#fff; font-size:12px; }
  td.stat{ text-align:center; } td.statval{ font-weight:700; }

  td.thaicell{ font-family:"Noto Sans Thai","Tahoma","Leelawadee UI",sans-serif; font-size:13px; white-space:normal; }
  @media print{ body{ background:#fff; padding:0; } .toolbar{ display:none; } .sheet-wrap{ box-shadow:none; padding:0; } }
</style>
</head>
<body>
  <div class="toolbar"><button onclick="window.print()">🖨️ Print / Export PDF</button></div>
  <div class="sheet-wrap">
    <table class="form">
      <colgroup>
        <col class="c-major"><col class="c-box"><col class="c-scale">
        ${'<col class="c-stat">'.repeat(24)}
      </colgroup>
      <tbody>
<tr class="titlebar"><td class="cell titlecell" colspan="10">i-Tail Corporation Public Company Limited</td><td class="cell titlecell titlecenter" colspan="10">WEIGHT CHECK RECORD</td><td class="cell titlecell" colspan="7" style="font-size:12px; text-align:center;">${formCode || ''}</td></tr>
<tr class="addrrow"><td class="cell addrcell" colspan="27"><span class="chkbox">&#10003;</span> ITC: 333 Moo 2, Karnjanavanich Road,&nbsp;&nbsp;Pavong Sub-district, Mueang Songkhla District, Songkhla 90100, Thailand</td></tr>
<tr class="dprow"><td class="cell dpcell" colspan="8"><span class="fieldlabel">DATE CHECK :</span> <span class="typed">${dateStr}</span></td><td class="cell dpcell" colspan="7"><span class="fieldlabel">PACKING LINE :</span> <span class="typed">${lineLabel}</span></td><td class="cell dpcell" colspan="8"></td><td class="cell dpcell qcinspector" colspan="4"><span class="fieldlabel">QC INSPECTOR :</span> <span class="signature">${inspectorName || '-'}</span></td></tr>
<tr><td class="cell labelmajor bold shaded">GENERAL INFO.</td><td class="cell box bold shaded" rowspan="3">PRODUCT<br>CODE</td><td class="cell prodval bold" colspan="25" rowspan="3">${productCode}</td></tr>
<tr class="sizerow"><td class="cell labelmajor">SIZE: ${sizeLabel}</td></tr>
<tr class="custrow"><td class="cell labelmajor">CUSTOMER: ${customerLabel}</td></tr>
<tr><td class="cell labelmajor">CODE: ${groupCode}</td><td class="cell box bold">TIME CHECK</td><td class="cell scale"></td><td class="cell prodval" colspan="3">${timeStr}</td><td class="cell prodval" colspan="3">&nbsp;</td><td class="cell prodval" colspan="3">&nbsp;</td><td class="cell prodval" colspan="3">&nbsp;</td><td class="cell prodval" colspan="3">&nbsp;</td><td class="cell prodval" colspan="3">&nbsp;</td><td class="cell prodval" colspan="3">&nbsp;</td><td class="cell prodval" colspan="3">&nbsp;</td></tr>
<tr><td class="cell labelmajor bold shaded" rowspan="2">DIGITAL BALANCE<br>EQ. NO.</td><td class="cell box shaded" rowspan="2"></td><td class="cell scale shaded" rowspan="2"></td><td class="cell stathead">N</td><td class="cell stathead">AVG.</td><td class="cell stathead">R</td><td class="cell stathead">N</td><td class="cell stathead">AVG.</td><td class="cell stathead">R</td><td class="cell stathead">N</td><td class="cell stathead">AVG.</td><td class="cell stathead">R</td><td class="cell stathead">N</td><td class="cell stathead">AVG.</td><td class="cell stathead">R</td><td class="cell stathead">N</td><td class="cell stathead">AVG.</td><td class="cell stathead">R</td><td class="cell stathead">N</td><td class="cell stathead">AVG.</td><td class="cell stathead">R</td><td class="cell stathead">N</td><td class="cell stathead">AVG.</td><td class="cell stathead">R</td><td class="cell stathead">N</td><td class="cell stathead">AVG.</td><td class="cell stathead">R</td></tr>
<tr>${firstTripleCells(n, fmtNum(avg,1), `${fmtNum(minV,0)}-${fmtNum(maxV,0)}`)}</tr>
<tr class="ttrow"><td class="cell labelmajor tlcurow"><div class="tlcu"><span>TARGET</span><span>LCL</span><span>UCL</span></div></td><td class="cell box bold">TOPPING</td><td class="cell scale"></td>${BLANK_24}</tr>
<tr class="ttrow"><td class="cell labelmajor tlcurow"><div class="tlcu"><span>TARGET</span><span>LCL</span><span>UCL</span></div></td><td class="cell box bold">SOLUTION</td><td class="cell scale"></td>${BLANK_24}</tr>
<tr><td class="cell labelmajor bold" colspan="3">CALCULATE MAX F/W:</td>${BLANK_24}</tr>
<tr><td class="cell labelmajor bold shaded">NET WEIGHT (g)</td><td class="cell box"></td><td class="cell scale"></td>${BLANK_24}</tr>
<tr><td class="cell labelmajor">TARGET: ${fmtNum(nwTarget,1)}</td><td class="cell box"></td><td class="cell scale"></td>${firstTripleCells(n, fmtNum(avg,1), `${fmtNum(minV,0)}-${fmtNum(maxV,0)}`)}</tr>
<tr class="netrow"><td class="cell labelmajor">UCL: ${fmtNum(nwUcl,1)}</td><td class="cell box"></td><td class="cell scale">&gt;10</td>${BLANK_24}</tr>
<tr class="netrow"><td class="cell labelmajor">UWL: ${nwUwl != null ? fmtNum(nwUwl,1) : '-'}</td><td class="cell box"></td><td class="cell scale">10</td>${BLANK_24}</tr>
<tr class="netrow"><td class="cell labelmajor">LWL: ${nwLwl != null ? fmtNum(nwLwl,1) : '-'}</td><td class="cell box"></td><td class="cell scale">9</td>${BLANK_24}</tr>
<tr class="netrow"><td class="cell labelmajor">LCL: ${fmtNum(nwLcl,1)}</td><td class="cell box"></td><td class="cell scale">8</td>${BLANK_24}</tr>
<tr class="checkrow lastcheck"><td class="cell labelmajor bold" colspan="3">REMARK:</td><td class="cell labelmajor thaicell" colspan="24">${remarkText}</td></tr>
      </tbody>
    </table>
  </div>
</body></html>`;

    return html;
  }

  function openWeightCheckReport(opts) {
    const html = buildWeightCheckReportHtml(opts);
    const w = window.open('', '_blank');
    if (!w) { alert('เบราว์เซอร์บล็อกป๊อปอัป — กรุณาอนุญาตป๊อปอัปสำหรับหน้านี้แล้วลองใหม่'); return; }
    w.document.write(html);
    w.document.close();
  }

  window.buildWeightCheckReportHtml = buildWeightCheckReportHtml;
  window.openWeightCheckReport = openWeightCheckReport;
})();