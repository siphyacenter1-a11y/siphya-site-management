// GET /api/route-plan-file/rev/:id  — เปิด PDF แผนเดินรถที่อัปโหลด
// GET /api/route-plan-file/att/:id  — เปิดไฟล์แนบ (รูป/PDF ใบแจ้งยกเลิก/จองด่วน)
// เฉพาะ admin · เปิดจากเบราว์เซอร์ตรงๆ จึงพาไปหน้า login แทนการตอบ JSON
const express = require('express');
const path = require('path');
const fs = require('fs');
const jwt = require('jsonwebtoken');
const router = express.Router();
const { JWT_SECRET } = require('../middleware/auth');
const { sitePool } = require('../db');

const STORAGE = path.join(__dirname, '..', 'storage');
const msg = (res, code, t) => res.status(code).type('html').send(`<meta charset="utf-8"><p style="font-family:Tahoma;padding:30px">${t}</p>`);

router.get('/:what(rev|att)/:id(\\d+)', (req, res) => {
  const auth = req.headers['authorization'];
  const token = (auth && auth.split(' ')[1]) || (req.cookies && req.cookies.token);
  const toLogin = () => res.redirect('/login?next=' + encodeURIComponent(req.originalUrl));
  if (!token) return toLogin();
  jwt.verify(token, JWT_SECRET, async (err, user) => {
    if (err) return toLogin();
    const role = req.liveRole || (user && user.role);
    if (role !== 'admin') return msg(res, 403, 'ใช้ได้เฉพาะบัญชีผู้ดูแลระบบ (admin)');
    try {
      const sql = req.params.what === 'rev'
        ? `SELECT file_path, file_name, 'application/pdf' mime FROM rplan_revisions WHERE id = $1`
        : `SELECT file_path, file_name, mime FROM rplan_attachments WHERE id = $1`;
      const r = await sitePool.query(sql, [Number(req.params.id)]);
      const f = r.rows[0] && path.resolve(STORAGE, r.rows[0].file_path || '');
      if (!f || !f.startsWith(STORAGE + path.sep) || !fs.existsSync(f)) return msg(res, 404, 'ไม่พบไฟล์');
      res.setHeader('Content-Type', r.rows[0].mime || 'application/octet-stream');
      res.setHeader('Content-Disposition', `inline; filename*=UTF-8''${encodeURIComponent(r.rows[0].file_name || path.basename(f))}`);
      res.sendFile(f);
    } catch (e) {
      msg(res, 400, 'ลิงก์ไม่ถูกต้อง');
    }
  });
});

module.exports = router;
