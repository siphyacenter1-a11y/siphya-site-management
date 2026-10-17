// GET /api/transport-doc/:project/:docNo — เปิดไฟล์ใบเบิก (PDF) ต้อง login ก่อน
// ลิงก์เปิดจากเบราว์เซอร์ตรงๆ จึงพาไปหน้า login แทนการตอบ JSON
const express = require('express');
const jwt = require('jsonwebtoken');
const router = express.Router();
const { JWT_SECRET } = require('../middleware/auth');
const { docFilePath } = require('../services/transport_docs');

router.get('/:project/:docNo', (req, res) => {
  const auth = req.headers['authorization'];
  const token = (auth && auth.split(' ')[1]) || (req.cookies && req.cookies.token);
  const toLogin = () => res.redirect('/login?next=' + encodeURIComponent(req.originalUrl));
  if (!token) return toLogin();
  jwt.verify(token, JWT_SECRET, async (err) => {
    if (err) return toLogin();
    try {
      const f = await docFilePath(req.params.project, req.params.docNo);
      if (!f) return res.status(404).type('html').send('<meta charset="utf-8"><p style="font-family:Tahoma;padding:30px">ไม่พบไฟล์ใบเบิกนี้</p>');
      res.setHeader('Content-Type', 'application/pdf');
      res.setHeader('Content-Disposition', `inline; filename="${encodeURIComponent(f.docNo)}.pdf"`);
      res.sendFile(f.file);
    } catch (e) {
      res.status(400).type('html').send('<meta charset="utf-8"><p style="font-family:Tahoma;padding:30px">ลิงก์ไม่ถูกต้อง</p>');
    }
  });
});

module.exports = router;
