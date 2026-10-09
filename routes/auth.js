const express = require('express');
const router = express.Router();
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const { querySite } = require('../db');
const { authenticateToken, requireAdmin, JWT_SECRET } = require('../middleware/auth');

// POST /api/auth/login
router.post('/login', async (req, res) => {
  try {
    const { username, password } = req.body;
    if (!username || !password) {
      return res.status(400).json({ ok: false, error: 'กรุณากรอกชื่อผู้ใช้และรหัสผ่าน' });
    }

    const userRes = await querySite('SELECT * FROM users WHERE username = $1', [username.trim()]);
    if (userRes.rows.length === 0) {
      return res.status(401).json({ ok: false, error: 'ชื่อผู้ใช้หรือรหัสผ่านไม่ถูกต้อง' });
    }

    const user = userRes.rows[0];
    const isMatch = await bcrypt.compare(password, user.password_hash);
    if (!isMatch) {
      return res.status(401).json({ ok: false, error: 'ชื่อผู้ใช้หรือรหัสผ่านไม่ถูกต้อง' });
    }

    // Update last_login
    await querySite('UPDATE users SET last_login = NOW() WHERE id = $1', [user.id]);

    // Generate JWT token (expires in 7 days)
    const tokenPayload = {
      id: user.id,
      username: user.username,
      full_name: user.full_name,
      role: user.role
    };
    const token = jwt.sign(tokenPayload, JWT_SECRET, { expiresIn: '7d' });

    res.cookie('token', token, { httpOnly: false, maxAge: 7 * 24 * 60 * 60 * 1000 });

    res.json({
      ok: true,
      token,
      user: tokenPayload,
      message: 'เข้าสู่ระบบสำเร็จ'
    });
  } catch (err) {
    console.error('Login error:', err);
    res.status(500).json({ ok: false, error: err.message });
  }
});

// GET /api/auth/me - ตรวจสอบสถานะผู้ใช้ปัจจุบัน
router.get('/me', authenticateToken, (req, res) => {
  res.json({ ok: true, user: req.user });
});

// POST /api/auth/logout
router.post('/logout', (req, res) => {
  res.clearCookie('token');
  res.json({ ok: true, message: 'ออกจากระบบสำเร็จ' });
});

// GET /api/auth/users - รายชื่อผู้ใช้ทั้งหมด (Admin only)
router.get('/users', authenticateToken, requireAdmin, async (req, res) => {
  try {
    const users = await querySite('SELECT id, username, full_name, role, created_at, last_login FROM users ORDER BY id ASC');
    res.json({ ok: true, users: users.rows });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// POST /api/auth/users - เพิ่มผู้ใช้งานใหม่ (Admin only)
router.post('/users', authenticateToken, requireAdmin, async (req, res) => {
  try {
    const { username, password, full_name, role } = req.body;
    if (!username || !password || !full_name) {
      return res.status(400).json({ ok: false, error: 'กรุณากรอกข้อมูลให้ครบถ้วน' });
    }

    const hash = await bcrypt.hash(password, 10);
    const result = await querySite(
      'INSERT INTO users (username, password_hash, full_name, role) VALUES ($1, $2, $3, $4) RETURNING id, username, full_name, role, created_at',
      [username.trim(), hash, full_name.trim(), role || 'staff']
    );

    res.json({ ok: true, user: result.rows[0], message: 'สร้างผู้ใช้งานสำเร็จ' });
  } catch (err) {
    if (err.code === '23505') {
      return res.status(400).json({ ok: false, error: 'ชื่อผู้ใช้นี้มีอยู่ในระบบแล้ว' });
    }
    res.status(500).json({ ok: false, error: err.message });
  }
});

// DELETE /api/auth/users/:id - ลบผู้ใช้งาน (Admin only)
router.delete('/users/:id', authenticateToken, requireAdmin, async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    if (id === req.user.id) {
      return res.status(400).json({ ok: false, error: 'ไม่สามารถลบบัญชีของตัวเองได้' });
    }
    await querySite('DELETE FROM users WHERE id = $1', [id]);
    res.json({ ok: true, message: 'ลบผู้ใช้งานสำเร็จ' });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// PUT /api/auth/users/:id - แก้ไขสิทธิ์ผู้ใช้งาน (Admin only)
router.put('/users/:id', authenticateToken, requireAdmin, async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    const { full_name, role, password } = req.body;
    
    if (password) {
      const hash = await bcrypt.hash(password, 10);
      await querySite(
        'UPDATE users SET full_name = COALESCE($1, full_name), role = COALESCE($2, role), password_hash = $3 WHERE id = $4',
        [full_name, role, hash, id]
      );
    } else {
      await querySite(
        'UPDATE users SET full_name = COALESCE($1, full_name), role = COALESCE($2, role) WHERE id = $3',
        [full_name, role, id]
      );
    }
    res.json({ ok: true, message: 'อัปเดตข้อมูลผู้ใช้งานสำเร็จ' });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

module.exports = router;
