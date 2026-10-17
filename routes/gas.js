// ============================================================
// POST /api/gas — ช่องทางเดียวกับ Api.gs (doPost) ของ Google Apps Script เดิม
//
// หน้าเว็บส่ง:   { fn: 'ชื่อฟังก์ชัน', args: [ ... ] }   (ผ่าน public/js/gas-shim.js)
// ตอบกลับ:      { ok: true, result: ... }  หรือ  { ok: false, error: 'ข้อความภาษาไทย' }
//
// เรียกได้เฉพาะฟังก์ชันใน ALLOWED และต้อง login แล้ว (cookie token จาก /login)
// ============================================================
const express = require('express');
const router = express.Router();
const { authenticateToken } = require('../middleware/auth');
const { UserError } = require('../services/common');
const checklist = require('../services/checklist');
const waste = require('../services/waste');
const route = require('../services/route');
const transport = require('../services/transport');
const transportDocs = require('../services/transport_docs');

const ALLOWED = Object.assign({}, checklist.functions, waste.functions, route.functions, transport.functions, transportDocs.functions);

// รับทั้ง application/json และ text/plain (gas-shim ส่งเป็น text/plain เหมือนตอนใช้ Apps Script)
router.use(express.text({ type: 'text/plain', limit: '30mb' }));

router.post('/', authenticateToken, async (req, res) => {
  let body = req.body;
  try {
    if (typeof body === 'string') body = JSON.parse(body || '{}');
  } catch (e) {
    return res.json({ ok: false, error: 'รูปแบบคำขอไม่ถูกต้อง' });
  }

  const fn = String((body && body.fn) || '');
  const handler = Object.prototype.hasOwnProperty.call(ALLOWED, fn) ? ALLOWED[fn] : null;
  if (!handler) return res.json({ ok: false, error: 'ไม่อนุญาตให้เรียกฟังก์ชัน: ' + fn });

  const args = Array.isArray(body.args) ? body.args : [];
  try {
    const result = await handler.apply({ user: req.user }, args); // this.user = ผู้ที่ login
    res.json({ ok: true, result: result === undefined ? null : result });
  } catch (err) {
    if (err instanceof UserError) {
      return res.json({ ok: false, error: err.message });
    }
    console.error(`[api/gas] ${fn} error:`, err);
    res.json({ ok: false, error: 'เกิดข้อผิดพลาดที่เซิร์ฟเวอร์ กรุณาลองใหม่อีกครั้ง' });
  }
});

module.exports = router;
