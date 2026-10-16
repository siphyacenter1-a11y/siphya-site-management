const express = require('express');
const cors = require('cors');
const path = require('path');
const cookieParser = require('cookie-parser');
require('dotenv').config();

const app = express();
const PORT = process.env.PORT || 5000;

// Middleware
app.use(cors());
app.use(cookieParser());
app.use(express.json({ limit: '30mb' })); // ฟอร์มเช็คลิสต์ส่งรูปมาเป็น base64 (ค่าเริ่มต้น 100kb ไม่พอ)
app.use(express.urlencoded({ extended: true }));

// Static frontend assets
app.use(express.static(path.join(__dirname, 'public')));

// API Routes
app.use('/api/auth', require('./routes/auth'));
app.use('/api/admin', require('./routes/admin'));
app.use('/api/hub', require('./routes/hub'));
app.use('/api/transport', require('./routes/transport'));
app.use('/api/waste', require('./routes/waste'));
app.use('/api/route', require('./routes/route'));
app.use('/api/checklist', require('./routes/checklist'));
app.use('/api/export', require('./routes/export'));
app.use('/api/gas', require('./routes/gas')); // หน้าเว็บที่ย้ายมาจาก Apps Script (เช็คลิสต์ฉบับเต็ม)

// HTML Page Rewrites for clean URLs
app.get('/login', (req, res) => res.sendFile(path.join(__dirname, 'public', 'login.html')));
app.get('/admin', (req, res) => res.sendFile(path.join(__dirname, 'public', 'admin.html')));
app.get('/transport', (req, res) => res.sendFile(path.join(__dirname, 'public', 'transport.html')));
app.get('/waste', (req, res) => res.sendFile(path.join(__dirname, 'public', 'waste.html')));
app.get('/route', (req, res) => res.sendFile(path.join(__dirname, 'public', 'route.html')));
app.get('/checklist', (req, res) => res.sendFile(path.join(__dirname, 'public', 'checklist.html')));
app.get('/npo', (req, res) => res.sendFile(path.join(__dirname, 'public', 'npo.html')));
app.get('/transport-entry', (req, res) => res.sendFile(path.join(__dirname, 'public', 'transport-entry.html')));

// Health check endpoint
app.get('/api/health', (req, res) => {
  res.json({ ok: true, timestamp: new Date(), message: 'Site Management Hub API connected to PostgreSQL' });
});

// Start Server on all network interfaces (0.0.0.0)
app.listen(PORT, '0.0.0.0', () => {
  console.log(`=======================================================`);
  console.log(`🚀 Site Management Hub is running:`);
  console.log(`   - ภายในเครื่องนี้:   http://localhost:${PORT}`);
  // เลข IP จริงของเครื่องนี้ (อ่านตอนเปิด) ให้เครื่องอื่นในวงเดียวกันเข้าได้
  const lan = Object.values(require('os').networkInterfaces()).flat()
    .filter(n => n && n.family === 'IPv4' && !n.internal).map(n => n.address);
  if (lan.length) lan.forEach(ip => console.log(`   - สำหรับเครื่องอื่นในวง LAN: http://${ip}:${PORT}`));
  else console.log('   - ยังไม่ได้ต่อเครือข่าย (เครื่องอื่นเข้าไม่ได้)');
  console.log(`📦 Database: PostgreSQL on ${process.env.PGHOST || 'localhost'}:${process.env.PGPORT || 5432}`);
  console.log(`🔐 Auth & Admin Overview: Enabled`);
  console.log(`=======================================================`);
});
