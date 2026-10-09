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
app.use(express.json());
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

// HTML Page Rewrites for clean URLs
app.get('/login', (req, res) => res.sendFile(path.join(__dirname, 'public', 'login.html')));
app.get('/admin', (req, res) => res.sendFile(path.join(__dirname, 'public', 'admin.html')));
app.get('/transport', (req, res) => res.sendFile(path.join(__dirname, 'public', 'transport.html')));
app.get('/waste', (req, res) => res.sendFile(path.join(__dirname, 'public', 'waste.html')));
app.get('/route', (req, res) => res.sendFile(path.join(__dirname, 'public', 'route.html')));
app.get('/checklist', (req, res) => res.sendFile(path.join(__dirname, 'public', 'checklist.html')));

// Health check endpoint
app.get('/api/health', (req, res) => {
  res.json({ ok: true, timestamp: new Date(), message: 'Site Management Hub API connected to PostgreSQL' });
});

// Start Server on all network interfaces (0.0.0.0)
app.listen(PORT, '0.0.0.0', () => {
  console.log(`=======================================================`);
  console.log(`🚀 Site Management Hub is running:`);
  console.log(`   - ภายในเครื่องนี้:   http://localhost:${PORT}`);
  console.log(`   - สำหรับคนภายในวง LAN: http://192.168.5.190:${PORT}`);
  console.log(`📦 Database: PostgreSQL on ${process.env.PGHOST || 'localhost'}:${process.env.PGPORT || 5432}`);
  console.log(`🔐 Auth & Admin Overview: Enabled`);
  console.log(`=======================================================`);
});
