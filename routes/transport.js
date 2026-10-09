const express = require('express');
const router = express.Router();
const { querySite } = require('../db');

// GET /api/transport/meta
router.get('/meta', async (req, res) => {
  try {
    const meta = {
      companyName: 'SIPHYA CONSTRUCTION',
      subtitle: 'MATERIAL DELIVERY REPORT — LIVE (POSTGRESQL)',
      title: 'สรุปสถานะการเบิก-จ่ายวัสดุ',
      logoText: 'SP'
    };
    res.json({ ok: true, result: meta });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// GET /api/transport/logs (format compatible with dashboard)
router.get('/logs', async (req, res) => {
  try {
    const { mat_type, building, status2, q } = req.query;
    let query = `
      SELECT 
        log_order AS "ลำดับ",
        TO_CHAR(request_date, 'YYYY-MM-DD') AS "วันที่ขอเบิก",
        TO_CHAR(receive_date, 'YYYY-MM-DD') AS "วันที่รับของ",
        status AS "สถานะ",
        mat_code AS "Mat. Code",
        mat_type AS "ประเภทวัสดุ",
        mat_item AS "รายการวัสดุ",
        building AS "อาคาร",
        floor AS "ชั้น",
        quantity AS "จำนวนที่เบิก/ย้าย",
        unit AS "หน่วย",
        warehouse AS "คลังจัดเก็บ",
        status2 AS "สถานะ2",
        requester_receiver AS "ผู้ขอเบิก/ผู้รับ",
        note AS "หมายเหตุ",
        created_at
      FROM material_transport_logs
      WHERE 1=1
    `;
    const params = [];

    if (mat_type) {
      params.push(mat_type);
      query += ` AND mat_type = $${params.length}`;
    }
    if (building) {
      params.push(building);
      query += ` AND building = $${params.length}`;
    }
    if (status2) {
      params.push(status2);
      query += ` AND status2 = $${params.length}`;
    }
    if (q) {
      params.push(`%${q}%`);
      query += ` AND (mat_item ILIKE $${params.length} OR requester_receiver ILIKE $${params.length} OR mat_code ILIKE $${params.length})`;
    }

    query += ' ORDER BY log_order DESC NULLS LAST, id DESC LIMIT 1500';

    const result = await querySite(query, params);
    const headers = [
      'ลำดับ', 'วันที่ขอเบิก', 'วันที่รับของ', 'สถานะ', 'Mat. Code', 
      'ประเภทวัสดุ', 'รายการวัสดุ', 'อาคาร', 'ชั้น', 'จำนวนที่เบิก/ย้าย', 
      'หน่วย', 'คลังจัดเก็บ', 'สถานะ2', 'ผู้ขอเบิก/ผู้รับ', 'หมายเหตุ'
    ];

    res.json({
      ok: true,
      result: {
        headers,
        rows: result.rows,
        updatedAt: new Date().toISOString()
      }
    });
  } catch (err) {
    console.error('Error fetching transport logs:', err);
    res.status(500).json({ ok: false, error: err.message });
  }
});

// POST /api/transport/add - สร้างรายการเบิกจ่ายใหม่
router.post('/add', async (req, res) => {
  try {
    const {
      request_date,
      receive_date,
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
    } = req.body;

    const maxOrderRes = await querySite('SELECT COALESCE(MAX(log_order), 0) + 1 AS next_order FROM material_transport_logs');
    const nextOrder = maxOrderRes.rows[0].next_order;

    const insertSql = `
      INSERT INTO material_transport_logs (
        log_order, request_date, receive_date, status, mat_code,
        mat_type, mat_item, building, floor, quantity, unit,
        warehouse, status2, requester_receiver, note
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15)
      RETURNING *
    `;

    const result = await querySite(insertSql, [
      nextOrder,
      request_date || new Date(),
      receive_date || null,
      status || 'รอดำเนินการ',
      mat_code || '',
      mat_type || 'ทั่วไป',
      mat_item || '',
      building || '',
      floor || '',
      parseFloat(quantity) || 0,
      unit || 'ชิ้น',
      warehouse || '',
      status2 || 'เบิก',
      requester_receiver || '',
      note || ''
    ]);

    res.json({ ok: true, result: result.rows[0] });
  } catch (err) {
    console.error('Error adding transport log:', err);
    res.status(500).json({ ok: false, error: err.message });
  }
});

module.exports = router;
