const express = require('express');
const router = express.Router();
const path = require('path');
const fs = require('fs');
const { querySite } = require('../db');

// Helper to save base64 image to public/uploads
function saveBase64Image(dataUrl, prefix) {
  if (!dataUrl || typeof dataUrl !== 'string' || !dataUrl.startsWith('data:image/')) {
    return null;
  }
  try {
    const matches = dataUrl.match(/^data:image\/([a-zA-Z0-9]+);base64,(.+)$/);
    if (!matches) return null;
    const ext = matches[1] === 'jpeg' ? 'jpg' : matches[1];
    const data = Buffer.from(matches[2], 'base64');
    const filename = `${prefix}_${Date.now()}_${Math.floor(Math.random() * 1000)}.${ext}`;
    const uploadDir = path.join(__dirname, '..', 'public', 'uploads');
    if (!fs.existsSync(uploadDir)) {
      fs.mkdirSync(uploadDir, { recursive: true });
    }
    fs.writeFileSync(path.join(uploadDir, filename), data);
    return `/uploads/${filename}`;
  } catch (err) {
    console.error('Error saving base64 image:', err);
    return null;
  }
}

// 1. GET /api/waste/projects - รายชื่อโครงการทั้งหมด
router.get('/projects', async (req, res) => {
  try {
    const result = await querySite('SELECT id, name FROM projects ORDER BY name ASC');
    res.json({ ok: true, result: result.rows });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// 2. POST /api/waste/projects - เพิ่มโครงการใหม่
router.post('/projects', async (req, res) => {
  try {
    const { name } = req.body;
    if (!name || !name.trim()) {
      return res.status(400).json({ ok: false, error: 'กรุณาระบุชื่อโครงการ' });
    }
    const check = await querySite('SELECT id, name FROM projects WHERE name = $1', [name.trim()]);
    if (check.rows.length > 0) {
      return res.json({ ok: true, result: check.rows[0] });
    }
    const inserted = await querySite('INSERT INTO projects (name) VALUES ($1) RETURNING id, name', [name.trim()]);
    res.json({ ok: true, result: inserted.rows[0] });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// 3. GET /api/waste/meta - สรุปภาพรวม KPI
router.get('/meta', async (req, res) => {
  try {
    const [kpiRes, projectsRes] = await Promise.all([
      querySite(`
        SELECT 
          COUNT(*) as total_records,
          COALESCE(SUM(trips), 0) as total_trips,
          COALESCE(SUM(volume_m3), 0) as total_volume,
          COALESCE(SUM(cost), 0) as total_cost,
          COALESCE(SUM(waste_construction), 0) as sum_construction,
          COALESCE(SUM(waste_packing), 0) as sum_packing,
          COALESCE(SUM(waste_system), 0) as sum_system,
          COALESCE(SUM(waste_concrete), 0) as sum_concrete
        FROM waste_records
      `),
      querySite('SELECT id, name FROM projects ORDER BY name ASC')
    ]);

    res.json({
      ok: true,
      result: {
        companyName: 'SIPHYA CONSTRUCTION',
        subtitle: 'SITE WASTE MANAGEMENT — LIVE (POSTGRESQL)',
        title: 'สรุปการขนย้ายและจัดการขยะในไซต์งาน',
        kpi: kpiRes.rows[0],
        projects: projectsRes.rows
      }
    });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// 4. GET /api/waste/dashboard - ดึงข้อมูลแบบโครงสร้างสำหรับ Dashboard
router.get('/dashboard', async (req, res) => {
  try {
    const { project_id, month } = req.query;
    let sql = `
      SELECT 
        w.id,
        w.project_id,
        p.name AS "โครงการ",
        TO_CHAR(w.record_date, 'YYYY-MM-DD') AS "วันที่",
        w.floor_zone AS "ชั้น / โซน",
        w.time_in AS "เวลาเข้า",
        w.time_out AS "เวลาออก",
        w.bill_no AS "เลขที่บิล",
        w.plate_no AS "ทะเบียนรถ",
        w.truck_type AS "ประเภทรถ",
        w.trips AS "จำนวนเที่ยว",
        w.volume_m3 AS "ปริมาณขยะ (คิว)",
        w.cost AS "ค่าใช้จ่ายรวม (บาท)",
        w.waste_concrete AS "ขยะคอนกรีต",
        w.waste_construction AS "ขยะก่อสร้าง",
        w.waste_packing AS "ขยะPacking",
        w.waste_system AS "ขยะงานระบบ",
        w.photo_front_url AS "รูปหน้ารถ",
        w.photo_waste_url AS "รูปขยะบนรถ",
        w.photo_canvas_url AS "รูปก่อนคลุมผ้า",
        w.recorder AS "ผู้บันทึก",
        w.note AS "หมายเหตุ"
      FROM waste_records w
      LEFT JOIN projects p ON w.project_id = p.id
      WHERE 1=1
    `;
    const params = [];
    if (project_id) {
      params.push(project_id);
      sql += ` AND w.project_id = $${params.length}`;
    }
    sql += ' ORDER BY w.record_date DESC, w.id DESC';

    const result = await querySite(sql, params);
    res.json({
      ok: true,
      rows: result.rows
    });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// 5. GET /api/waste/logs - ตารางรายการขยะ
router.get('/logs', async (req, res) => {
  try {
    const { project_id, search } = req.query;
    let sql = `
      SELECT 
        w.id,
        w.project_id,
        p.name AS project_name,
        TO_CHAR(w.record_date, 'YYYY-MM-DD') AS record_date,
        w.floor_zone,
        w.time_in,
        w.time_out,
        w.bill_no,
        w.plate_no,
        w.recorder,
        w.trips,
        w.truck_type,
        w.waste_construction,
        w.waste_packing,
        w.waste_system,
        w.waste_concrete,
        w.volume_m3,
        w.cost,
        w.photo_front_url,
        w.photo_waste_url,
        w.photo_canvas_url,
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
    if (search) {
      params.push(`%${search}%`);
      sql += ` AND (w.bill_no ILIKE $${params.length} OR w.plate_no ILIKE $${params.length} OR w.recorder ILIKE $${params.length} OR p.name ILIKE $${params.length})`;
    }
    sql += ' ORDER BY w.record_date DESC, w.id DESC';

    const result = await querySite(sql, params);
    res.json({
      ok: true,
      result: {
        rows: result.rows,
        updatedAt: new Date().toISOString()
      }
    });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// 6. POST /api/waste/add - บันทึกข้อมูลขยะ (รองรับทั้งแบบฟอร์มเดิมและ API ใหม่)
router.post('/add', async (req, res) => {
  try {
    const b = req.body;

    // หาหรือสร้าง project_id
    let projectId = b.project_id;
    if (!projectId && b.project) {
      if (/^\d+$/.test(String(b.project).trim())) {
        projectId = parseInt(b.project, 10);
      } else {
        const pFind = await querySite('SELECT id FROM projects WHERE name = $1', [String(b.project).trim()]);
        if (pFind.rows.length > 0) {
          projectId = pFind.rows[0].id;
        } else {
          const pNew = await querySite('INSERT INTO projects (name) VALUES ($1) RETURNING id', [String(b.project).trim()]);
          projectId = pNew.rows[0].id;
        }
      }
    }

    // แปลงวันที่ (ถ้ามาเป็น DD/MM/YYYY ให้แปลงเป็น YYYY-MM-DD)
    let recDate = b.record_date || b.date;
    if (recDate && typeof recDate === 'string' && recDate.includes('/')) {
      const parts = recDate.split('/');
      if (parts.length === 3) {
        recDate = `${parts[2]}-${parts[1]}-${parts[0]}`;
      }
    }
    if (!recDate) recDate = new Date().toISOString().split('T')[0];

    const floorZone = b.floor_zone || b.location || '-';
    const timeIn = b.time_in || b.timeIn || '';
    const timeOut = b.time_out || b.time || '';
    const billNo = b.bill_no || b.billNo || '-';
    const plateNo = b.plate_no || b.plateNo || '-';
    const recorder = b.recorder || '';
    const trips = parseInt(b.trips, 10) || 1;
    const truckType = b.truck_type || b.truck || '6 ล้อเล็ก';

    // คำนวณปริมาตรและราคาถ้าไม่ได้ระบุมาโดยตรง
    let vol = parseFloat(b.volume_m3);
    let cost = parseFloat(b.cost);
    if (isNaN(vol) || isNaN(cost)) {
      if (truckType.includes('10 ล้อ')) {
        vol = 13.5 * trips;
        cost = 2500 * trips;
      } else if (truckType.includes('6 ล้อใหญ่')) {
        vol = 6.0 * trips;
        cost = 1100 * trips;
      } else {
        vol = 3.0 * trips;
        cost = 550 * trips;
      }
    }

    const wasteConcrete = parseFloat(b.waste_concrete ?? b.wasteConcrete) || 0;
    const wasteConstruction = parseFloat(b.waste_construction ?? b.wasteConstruction) || 0;
    const wastePacking = parseFloat(b.waste_packing ?? b.wastePacking) || 0;
    const wasteSystem = parseFloat(b.waste_system ?? b.wasteSystem) || 0;
    const note = b.note || '';

    // จัดการรูปภาพ (base64 หรือ url)
    let photo1Url = b.photo_front_url || (b.photo1 ? saveBase64Image(b.photo1, 'front') : null);
    let photo2Url = b.photo_waste_url || (b.photo2 ? saveBase64Image(b.photo2, 'waste') : null);
    let photo3Url = b.photo_canvas_url || (b.photo3 ? saveBase64Image(b.photo3, 'canvas') : null);

    const sql = `
      INSERT INTO waste_records (
        project_id, record_date, floor_zone, time_in, time_out,
        bill_no, plate_no, recorder, trips, truck_type,
        waste_construction, waste_packing, waste_system, waste_concrete,
        volume_m3, cost, photo_front_url, photo_waste_url, photo_canvas_url, note
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20)
      RETURNING *
    `;

    const result = await querySite(sql, [
      projectId,
      recDate,
      floorZone,
      timeIn,
      timeOut,
      billNo,
      plateNo,
      recorder,
      trips,
      truckType,
      wasteConstruction,
      wastePacking,
      wasteSystem,
      wasteConcrete,
      vol,
      cost,
      photo1Url,
      photo2Url,
      photo3Url,
      note
    ]);

    res.json({ ok: true, success: true, result: result.rows[0] });
  } catch (err) {
    console.error('Error inserting waste record:', err);
    res.status(500).json({ ok: false, success: false, error: err.message, message: err.message });
  }
});

module.exports = router;
