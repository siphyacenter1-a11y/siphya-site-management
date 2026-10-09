const express = require('express');
const router = express.Router();
const { querySite } = require('../db');

// GET /api/route/logs
router.get('/logs', async (req, res) => {
  try {
    const { doc_type, search } = req.query;
    let sql = `
      SELECT 
        id,
        TO_CHAR(recorded_at, 'YYYY-MM-DD HH24:MI') as recorded_at,
        doc_type,
        sender_dept,
        receiving_center,
        TO_CHAR(usage_month, 'YYYY-MM') as usage_month,
        usage_week,
        destination,
        origin,
        truck_type,
        TO_CHAR(pickup_schedule, 'YYYY-MM-DD HH24:MI') as pickup_schedule,
        TO_CHAR(dropoff_schedule, 'YYYY-MM-DD HH24:MI') as dropoff_schedule,
        item_list,
        storage_area,
        note,
        requester
      FROM vehicle_transport_requests
      WHERE 1=1
    `;
    const params = [];
    if (doc_type) {
      params.push(doc_type);
      sql += ` AND doc_type = $${params.length}`;
    }
    if (search) {
      params.push(`%${search}%`);
      sql += ` AND (requester ILIKE $${params.length} OR destination ILIKE $${params.length} OR origin ILIKE $${params.length} OR item_list ILIKE $${params.length})`;
    }
    sql += ' ORDER BY recorded_at DESC NULLS LAST, id DESC';

    const result = await querySite(sql, params);
    res.json({ ok: true, result: { rows: result.rows, updatedAt: new Date().toISOString() } });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// POST /api/route/add
router.post('/add', async (req, res) => {
  try {
    const {
      doc_type, sender_dept, receiving_center, destination, origin,
      truck_type, pickup_schedule, dropoff_schedule, item_list, storage_area,
      note, requester
    } = req.body;

    const sql = `
      INSERT INTO vehicle_transport_requests (
        recorded_at, doc_type, sender_dept, receiving_center,
        destination, origin, truck_type, pickup_schedule, dropoff_schedule,
        item_list, storage_area, note, requester
      ) VALUES (NOW(), $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
      RETURNING *
    `;

    const result = await querySite(sql, [
      doc_type || 'ขอจองรถ',
      sender_dept || '',
      receiving_center || '',
      destination || '',
      origin || '',
      truck_type || '6 ล้อ',
      pickup_schedule || null,
      dropoff_schedule || null,
      item_list || '',
      storage_area || '',
      note || '',
      requester || ''
    ]);

    res.json({ ok: true, result: result.rows[0] });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

module.exports = router;
