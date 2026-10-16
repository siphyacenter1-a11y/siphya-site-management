const express = require('express');
const router = express.Router();
const ExcelJS = require('exceljs');
const PDFDocument = require('pdfkit');
const path = require('path');
const fs = require('fs');
const jwt = require('jsonwebtoken');
const { querySite } = require('../db');
const { JWT_SECRET } = require('../middleware/auth');

// ทุกลิงก์ Export ต้อง login เป็น admin (ลิงก์เปิดจากเบราว์เซอร์ตรงๆ จึงตอบเป็นหน้าเว็บ ไม่ใช่ JSON)
router.use((req, res, next) => {
  const auth = req.headers['authorization'];
  const token = (auth && auth.split(' ')[1]) || (req.cookies && req.cookies.token);
  const page = (msg) => res.status(403).type('html').send(
    `<!doctype html><meta charset="utf-8"><body style="font-family:Tahoma,sans-serif;padding:40px;text-align:center">` +
    `<h3>${msg}</h3><p><a href="/admin">กลับหน้าผู้ดูแลระบบ</a></p></body>`);
  if (!token) return res.redirect('/login?next=' + encodeURIComponent(req.originalUrl));
  jwt.verify(token, JWT_SECRET, (err, user) => {
    if (err) return res.redirect('/login?next=' + encodeURIComponent(req.originalUrl));
    if (!user || user.role !== 'admin') return page('ต้องใช้บัญชีผู้ดูแลระบบ (admin) จึงจะ Export รายงานได้');
    req.user = user;
    next();
  });
});

// Font paths for Thai support
const fontRegularPath = path.join(__dirname, '..', 'fonts', 'tahoma.ttf');
const fontBoldPath = path.join(__dirname, '..', 'fonts', 'tahomabd.ttf');

// Fast Image Buffer Fetcher with cache
const imageCache = new Map();
async function getImageBuffer(url) {
  if (!url) return null;
  if (imageCache.has(url)) return imageCache.get(url);

  try {
    if (url.startsWith('/uploads/')) {
      const localPath = path.join(__dirname, '..', 'public', url);
      if (fs.existsSync(localPath)) {
        const buf = fs.readFileSync(localPath);
        imageCache.set(url, buf);
        return buf;
      }
      return null;
    }
    if (url.startsWith('http')) {
      const res = await fetch(url, { signal: AbortSignal.timeout(1500) });
      if (res.ok) {
        const arrayBuf = await res.arrayBuffer();
        const buf = Buffer.from(arrayBuf);
        imageCache.set(url, buf);
        return buf;
      }
    }
  } catch (err) {}
  return null;
}

// 1. GET /api/export/waste/excel - ส่งออก Excel บันทึกขยะพร้อมรูปรวดเร็ว
router.get('/waste/excel', async (req, res) => {
  try {
    const { project_id } = req.query;
    let sql = `
      SELECT 
        w.id,
        TO_CHAR(w.record_date, 'YYYY-MM-DD') AS record_date,
        p.name AS project_name,
        w.floor_zone,
        w.bill_no,
        w.plate_no,
        w.truck_type,
        w.trips,
        w.volume_m3,
        w.cost,
        w.waste_construction,
        w.waste_packing,
        w.waste_system,
        w.waste_concrete,
        w.photo_front_url,
        w.photo_waste_url,
        w.photo_canvas_url,
        w.recorder,
        w.note
      FROM waste_records w
      LEFT JOIN projects p ON w.project_id = p.id
      WHERE 1=1
    `;
    const params = [];
    if (project_id) {
      params.push(project_id);
      sql += ` AND w.project_id = $${params.length}`;
    }
    sql += ' ORDER BY w.record_date DESC, w.id DESC LIMIT 200';

    const dbRes = await querySite(sql, params);
    const rows = dbRes.rows;

    const workbook = new ExcelJS.Workbook();
    workbook.creator = 'Siphya Site Management Hub';

    const sheet = workbook.addWorksheet('รายงานขยะไซต์งาน', {
      views: [{ showGridLines: true }]
    });

    // Title Row
    sheet.mergeCells('A1:L1');
    const titleCell = sheet.getCell('A1');
    titleCell.value = 'SIPHYA CONSTRUCTION - รายงานการขนย้ายและจัดการขยะในไซต์งาน';
    titleCell.font = { name: 'Tahoma', size: 14, bold: true, color: { argb: 'FFFFFFFF' } };
    titleCell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF0B1F4B' } };
    titleCell.alignment = { vertical: 'middle', horizontal: 'center' };
    sheet.getRow(1).height = 36;

    // Subtitle Row
    sheet.mergeCells('A2:L2');
    const subCell = sheet.getCell('A2');
    subCell.value = `อัปเดตข้อมูลล่าสุด: ${new Date().toLocaleString('th-TH')} | จำนวนทั้งหมด: ${rows.length} รายการ`;
    subCell.font = { name: 'Tahoma', size: 10, italic: true, color: { argb: 'FF5A6478' } };
    subCell.alignment = { vertical: 'middle', horizontal: 'center' };
    sheet.getRow(2).height = 20;

    // Headers
    const headers = [
      'วันที่', 'โครงการ', 'เลขที่บิล', 'ทะเบียนรถ', 'ประเภทรถ', 
      'เที่ยว', 'ปริมาตร (m³)', 'ค่าใช้จ่าย (บาท)', 
      'รูปหน้ารถ', 'รูปกองขยะ', 'รูปผ้าใบคลุม', 'ผู้บันทึก'
    ];
    sheet.getRow(3).values = headers;
    sheet.getRow(3).font = { name: 'Tahoma', size: 11, bold: true, color: { argb: 'FFFFFFFF' } };
    sheet.getRow(3).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF1C4D44' } };
    sheet.getRow(3).alignment = { vertical: 'middle', horizontal: 'center' };
    sheet.getRow(3).height = 26;

    // Column widths
    sheet.columns = [
      { width: 14 }, { width: 30 }, { width: 16 }, { width: 16 }, { width: 12 },
      { width: 10 }, { width: 14 }, { width: 16 }, { width: 16 }, { width: 16 },
      { width: 16 }, { width: 18 }
    ];

    rows.forEach((r, idx) => {
      const rowIdx = idx + 4;
      const row = sheet.getRow(rowIdx);
      row.values = [
        r.record_date,
        r.project_name || '-',
        r.bill_no,
        r.plate_no,
        r.truck_type,
        parseInt(r.trips) || 1,
        parseFloat(r.volume_m3) || 0,
        parseFloat(r.cost) || 0,
        r.photo_front_url ? { text: '📷 ดูรูปหน้ารถ', hyperlink: r.photo_front_url } : '-',
        r.photo_waste_url ? { text: '📷 ดูรูปกองขยะ', hyperlink: r.photo_waste_url } : '-',
        r.photo_canvas_url ? { text: '📷 ดูรูปผ้าใบ', hyperlink: r.photo_canvas_url } : '-',
        r.recorder || '-'
      ];

      row.height = 28;
      row.alignment = { vertical: 'middle' };
      row.getCell(6).alignment = { vertical: 'middle', horizontal: 'center' };
      row.getCell(7).numFmt = '#,##0.0';
      row.getCell(8).numFmt = '#,##0.00';

      // Style Links
      [9, 10, 11].forEach(col => {
        const c = row.getCell(col);
        if (typeof c.value === 'object' && c.value && c.value.hyperlink) {
          c.font = { name: 'Tahoma', color: { argb: 'FF2F5D9E' }, underline: true, bold: true };
        }
      });
    });

    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', `attachment; filename=Siphya_Waste_Report_${Date.now()}.xlsx`);

    await workbook.xlsx.write(res);
    res.end();
  } catch (err) {
    console.error('Export Excel error:', err);
    res.status(500).json({ ok: false, error: err.message });
  }
});

// 2. GET /api/export/waste/pdf - ส่งออก PDF บันทึกขยะพร้อมหลักฐานรูปถ่าย (รองรับภาษาไทย 100%)
router.get('/waste/pdf', async (req, res) => {
  try {
    const { project_id } = req.query;
    let sql = `
      SELECT 
        w.id,
        TO_CHAR(w.record_date, 'YYYY-MM-DD') AS record_date,
        p.name AS project_name,
        w.bill_no,
        w.plate_no,
        w.truck_type,
        w.trips,
        w.volume_m3,
        w.cost,
        w.photo_front_url,
        w.photo_waste_url,
        w.photo_canvas_url,
        w.recorder,
        w.note
      FROM waste_records w
      LEFT JOIN projects p ON w.project_id = p.id
      WHERE 1=1
    `;
    const params = [];
    if (project_id) {
      params.push(project_id);
      sql += ` AND w.project_id = $${params.length}`;
    }
    sql += ' ORDER BY w.record_date DESC, w.id DESC LIMIT 30';

    const dbRes = await querySite(sql, params);
    const rows = dbRes.rows;

    const doc = new PDFDocument({ margin: 36, size: 'A4' });

    // Register Thai TrueType Font
    doc.registerFont('ThaiRegular', fontRegularPath);
    doc.registerFont('ThaiBold', fontBoldPath);

    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `inline; filename=Siphya_Waste_Report_${Date.now()}.pdf`);

    doc.pipe(res);

    // Header Banner
    doc.rect(36, 36, 523, 48).fill('#0B1F4B');
    doc.fillColor('#FFFFFF').font('ThaiBold').fontSize(14).text('SIPHYA CONSTRUCTION - SITE WASTE MANIFEST REPORT', 48, 44);
    doc.font('ThaiRegular').fontSize(9.5).fillColor('#A3BBEB').text('รายงานสรุปการขนย้ายขยะและหลักฐานรูปถ่ายหน้างาน (PostgreSQL Live Database)', 48, 64);

    let yPos = 96;
    for (let i = 0; i < rows.length; i++) {
      const r = rows[i];

      if (yPos > 680) {
        doc.addPage();
        yPos = 40;
      }

      // Card Background
      doc.rect(36, yPos, 523, 94).fillAndStroke('#F8FAFD', '#E1E3E9');

      // Info Texts
      doc.fillColor('#0B1F4B').font('ThaiBold').fontSize(11).text(`รายการ #${r.id} | เลขที่บิล: ${r.bill_no} | ทะเบียนรถ: ${r.plate_no}`, 48, yPos + 8);
      doc.fillColor('#4A5462').font('ThaiRegular').fontSize(9).text(`โครงการ: ${r.project_name || '-'} | วันที่: ${r.record_date}`, 48, yPos + 24);
      doc.text(`ประเภทรถ: ${r.truck_type} | ${r.trips} เที่ยว | ปริมาตรรวม: ${parseFloat(r.volume_m3).toFixed(1)} m³ | ค่าใช้จ่าย: ${parseFloat(r.cost).toLocaleString()} บาท`, 48, yPos + 38);
      doc.text(`ผู้บันทึก: ${r.recorder || '-'} | หมายเหตุ: ${r.note || '-'}`, 48, yPos + 52);

      // Photo Links
      let linkX = 48;
      const photos = [
        { label: '[รูปหน้ารถ]', url: r.photo_front_url },
        { label: '[รูปกองขยะ]', url: r.photo_waste_url },
        { label: '[รูปผ้าใบ]', url: r.photo_canvas_url }
      ];

      doc.font('ThaiRegular').fontSize(9).fillColor('#2F5D9E');
      photos.forEach(p => {
        if (p.url) {
          doc.text(p.label, linkX, yPos + 70, { link: p.url, underline: true });
          linkX += 76;
        }
      });

      // Embed photo thumbnail on the right if available
      const firstPhotoUrl = r.photo_front_url || r.photo_waste_url;
      if (firstPhotoUrl) {
        const buf = await getImageBuffer(firstPhotoUrl);
        if (buf) {
          try {
            doc.image(buf, 440, yPos + 8, { width: 95, height: 74, fit: [95, 74] });
            doc.rect(440, yPos + 8, 95, 74).stroke('#CCD3E0');
          } catch (e) {}
        }
      }

      yPos += 104;
    }

    doc.end();
  } catch (err) {
    console.error('Export PDF error:', err);
    res.status(500).json({ ok: false, error: err.message });
  }
});

// 3. GET /api/export/waste/print - หน้าพิมพ์รายงานแบบ HTML Print พร้อมรูปเต็มความละเอียด
router.get('/waste/print', async (req, res) => {
  try {
    const { project_id } = req.query;
    let sql = `
      SELECT 
        w.id,
        TO_CHAR(w.record_date, 'YYYY-MM-DD') AS record_date,
        p.name AS project_name,
        w.floor_zone,
        w.bill_no,
        w.plate_no,
        w.truck_type,
        w.trips,
        w.volume_m3,
        w.cost,
        w.photo_front_url,
        w.photo_waste_url,
        w.photo_canvas_url,
        w.recorder,
        w.note
      FROM waste_records w
      LEFT JOIN projects p ON w.project_id = p.id
      WHERE 1=1
    `;
    const params = [];
    if (project_id) {
      params.push(project_id);
      sql += ` AND w.project_id = $${params.length}`;
    }
    sql += ' ORDER BY w.record_date DESC, w.id DESC LIMIT 40';

    const dbRes = await querySite(sql, params);
    const rows = dbRes.rows;

    const html = `
<!DOCTYPE html>
<html lang="th">
<head>
  <meta charset="utf-8">
  <title>รายงานการขนย้ายขยะไซต์งาน - SIPHYA CONSTRUCTION</title>
  <link href="https://fonts.googleapis.com/css2?family=Prompt:wght@300;400;500;600;700&display=swap" rel="stylesheet">
  <style>
    @page { size: A4 portrait; margin: 12mm; }
    body { font-family: 'Prompt', sans-serif; margin: 0; padding: 20px; color: #0B1F4B; font-size: 13px; line-height: 1.4; background: #fff; }
    .print-header { display: flex; justify-content: space-between; align-items: center; border-bottom: 3px solid #F2B705; padding-bottom: 14px; margin-bottom: 20px; }
    .print-header h1 { margin: 0; font-size: 20px; color: #0B1F4B; }
    .print-header p { margin: 4px 0 0; color: #5A6478; font-size: 12px; }
    .print-btn { background: #0B1F4B; color: #fff; border: none; padding: 8px 16px; border-radius: 8px; font-size: 13px; font-weight: 600; cursor: pointer; }
    @media print { .no-print { display: none !important; } body { padding: 0; } }
    .item-card { border: 1px solid #E1E3E9; border-radius: 10px; padding: 14px 16px; margin-bottom: 14px; page-break-inside: avoid; background: #FAFBFD; display: grid; grid-template-columns: 1fr 220px; gap: 16px; align-items: start; }
    .item-title { font-size: 15px; font-weight: 700; color: #0B1F4B; margin-bottom: 6px; }
    .meta-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 4px 12px; font-size: 12px; color: #4A5462; }
    .meta-grid strong { color: #0B1F4B; }
    .photo-grid { display: flex; gap: 8px; justify-content: flex-end; }
    .photo-thumb { width: 68px; height: 56px; border-radius: 6px; object-fit: cover; border: 1px solid #CCD3E0; background: #eee; }
  </style>
</head>
<body>
  <div class="print-header">
    <div>
      <h1>SIPHYA CONSTRUCTION &bull; รายงานการขนย้ายขยะและรูปถ่ายหน้างาน</h1>
      <p>ข้อมูลแบบเรียลไทม์จากฐานข้อมูล PostgreSQL | วันที่พิมพ์: ${new Date().toLocaleString('th-TH')}</p>
    </div>
    <div class="no-print">
      <button class="print-btn" onclick="window.print()">🖨️ สั่งพิมพ์ / บันทึกเป็น PDF (Print to PDF)</button>
    </div>
  </div>

  <div class="items-list">
    ${rows.map(r => `
      <div class="item-card">
        <div>
          <div class="item-title">#${r.id} | บิลเลขที่: ${r.bill_no} (ทะเบียน: ${r.plate_no})</div>
          <div class="meta-grid">
            <div><strong>โครงการ:</strong> ${r.project_name || '-'}</div>
            <div><strong>วันที่:</strong> ${r.record_date}</div>
            <div><strong>ประเภทรถ:</strong> ${r.truck_type}</div>
            <div><strong>จำนวนเที่ยว:</strong> ${r.trips} เที่ยว</div>
            <div><strong>ปริมาตรรวม:</strong> ${parseFloat(r.volume_m3).toFixed(1)} m³</div>
            <div><strong>ค่าใช้จ่าย:</strong> ${parseFloat(r.cost).toLocaleString()} บาท</div>
            <div><strong>ผู้บันทึก:</strong> ${r.recorder || '-'}</div>
            <div><strong>โซน/ชั้น:</strong> ${r.floor_zone || '-'}</div>
          </div>
          ${r.note ? `<div style="font-size:11.5px; color:#5A6478; margin-top:6px;"><strong>หมายเหตุ:</strong> ${r.note}</div>` : ''}
        </div>
        <div class="photo-grid">
          ${r.photo_front_url ? `<img src="${r.photo_front_url}" class="photo-thumb" alt="หน้ารถ" title="หน้ารถ" onerror="this.style.display='none'">` : ''}
          ${r.photo_waste_url ? `<img src="${r.photo_waste_url}" class="photo-thumb" alt="กองขยะ" title="กองขยะ" onerror="this.style.display='none'">` : ''}
          ${r.photo_canvas_url ? `<img src="${r.photo_canvas_url}" class="photo-thumb" alt="ผ้าใบ" title="ผ้าใบ" onerror="this.style.display='none'">` : ''}
        </div>
      </div>
    `).join('')}
  </div>
</body>
</html>
    `;

    res.send(html);
  } catch (err) {
    res.status(500).send('Error generating print report: ' + err.message);
  }
});

// 4. GET /api/export/transport/excel - ส่งออก Excel การเบิก-จ่ายวัสดุ
router.get('/transport/excel', async (req, res) => {
  try {
    const sql = `
      SELECT 
        log_order,
        TO_CHAR(request_date, 'YYYY-MM-DD') AS request_date,
        TO_CHAR(receive_date, 'YYYY-MM-DD') AS receive_date,
        status,
        mat_code,
        mat_type,
        mat_item,
        building,
        floor,
        quantity,
        unit,
        warehouse,
        status2,
        requester_receiver,
        note
      FROM material_transport_logs
      ORDER BY log_order DESC NULLS LAST, id DESC
      LIMIT 1500
    `;
    const dbRes = await querySite(sql);
    const rows = dbRes.rows;

    const workbook = new ExcelJS.Workbook();
    const sheet = workbook.addWorksheet('การเบิกจ่ายวัสดุ');

    sheet.mergeCells('A1:N1');
    const titleCell = sheet.getCell('A1');
    titleCell.value = 'SIPHYA CONSTRUCTION - รายงานการเบิก-จ่ายวัสดุประจำไซต์งาน';
    titleCell.font = { name: 'Tahoma', size: 14, bold: true, color: { argb: 'FFFFFFFF' } };
    titleCell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF0B1F4B' } };
    titleCell.alignment = { vertical: 'middle', horizontal: 'center' };
    sheet.getRow(1).height = 36;

    const headers = [
      'ลำดับ', 'วันที่ขอเบิก', 'วันที่รับของ', 'สถานะ', 'Mat. Code',
      'ประเภทวัสดุ', 'รายการวัสดุ', 'อาคาร', 'ชั้น', 'จำนวนที่เบิก/ย้าย',
      'หน่วย', 'สถานะ2', 'ผู้ขอเบิก/ผู้รับ', 'หมายเหตุ'
    ];
    sheet.getRow(2).values = headers;
    sheet.getRow(2).font = { name: 'Tahoma', size: 11, bold: true, color: { argb: 'FFFFFFFF' } };
    sheet.getRow(2).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFB36B12' } };
    sheet.getRow(2).alignment = { vertical: 'middle', horizontal: 'center' };
    sheet.getRow(2).height = 26;

    sheet.columns = [
      { width: 8 }, { width: 14 }, { width: 14 }, { width: 12 }, { width: 14 },
      { width: 16 }, { width: 28 }, { width: 12 }, { width: 10 }, { width: 16 },
      { width: 10 }, { width: 14 }, { width: 20 }, { width: 20 }
    ];

    rows.forEach((r, idx) => {
      const row = sheet.getRow(idx + 3);
      row.values = [
        r.log_order || (idx + 1),
        r.request_date || '-',
        r.receive_date || '-',
        r.status || '-',
        r.mat_code || '-',
        r.mat_type || '-',
        r.mat_item || '-',
        r.building || '-',
        r.floor || '-',
        parseFloat(r.quantity) || 0,
        r.unit || '-',
        r.status2 || '-',
        r.requester_receiver || '-',
        r.note || '-'
      ];
      row.alignment = { vertical: 'middle' };
      row.getCell(10).numFmt = '#,##0.00';
    });

    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', `attachment; filename=Siphya_Transport_Report_${Date.now()}.xlsx`);

    await workbook.xlsx.write(res);
    res.end();
  } catch (err) {
    console.error('Export Transport error:', err);
    res.status(500).json({ ok: false, error: err.message });
  }
});

module.exports = router;
