const express = require('express');
const router = express.Router();
const { querySite } = require('../db');

// GET /api/checklist/logs
router.get('/logs', async (req, res) => {
  try {
    const { site_name, search } = req.query;
    let sql = `
      SELECT 
        id,
        TO_CHAR(submission_time, 'YYYY-MM-DD HH24:MI') as submission_time,
        site_name,
        TO_CHAR(inspection_date, 'YYYY-MM-DD') as inspection_date,
        lang,
        recorded_by,
        signer1,
        signer2,
        signer3,
        checklist_data
      FROM site_supervisor_checklists
      WHERE 1=1
    `;
    const params = [];
    if (site_name) {
      params.push(site_name);
      sql += ` AND site_name = $${params.length}`;
    }
    if (search) {
      params.push(`%${search}%`);
      sql += ` AND (site_name ILIKE $${params.length} OR recorded_by ILIKE $${params.length})`;
    }
    sql += ' ORDER BY inspection_date DESC, id DESC';

    const result = await querySite(sql, params);
    res.json({ ok: true, result: { rows: result.rows, updatedAt: new Date().toISOString() } });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// POST /api/checklist/add
router.post('/add', async (req, res) => {
  try {
    const { site_name, inspection_date, recorded_by, signer1, signer2, signer3, checklist_data } = req.body;

    const sql = `
      INSERT INTO site_supervisor_checklists (
        submission_time, site_name, inspection_date, lang,
        recorded_by, signer1, signer2, signer3, checklist_data
      ) VALUES (NOW(), $1, $2, 'th', $3, $4, $5, $6, $7)
      RETURNING *
    `;

    const result = await querySite(sql, [
      site_name || '',
      inspection_date || new Date(),
      recorded_by || '',
      signer1 || '',
      signer2 || '',
      signer3 || '',
      checklist_data ? JSON.stringify(checklist_data) : '{}'
    ]);

    res.json({ ok: true, result: result.rows[0] });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

module.exports = router;
