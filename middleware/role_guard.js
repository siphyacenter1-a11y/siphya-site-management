// ============================================================
// บัญชี "ลงนามอย่างเดียว" (users.role = 'signer') — ใช้กับ GF/GE
//   - เปิดได้เฉพาะหน้าเช็คลิสต์ (/checklist) และหน้า login; หน้าอื่นพากลับไป /checklist
//   - API: ได้เฉพาะ /api/auth/* และ /api/gas (ฟังก์ชันที่อนุญาตตรวจใน routes/gas.js)
//   - อ่านสิทธิ์จากฐานข้อมูลจริง (ไม่เชื่อ role ใน token อย่างเดียว) — เปลี่ยนประเภทบัญชีแล้วมีผลภายใน ~15 วินาที
//     ไม่ต้องรอ token หมดอายุ
// ============================================================
const jwt = require('jsonwebtoken');
const { querySite } = require('../db');
const { JWT_SECRET } = require('./auth');

const TTL_MS = 15 * 1000;
const cache = new Map();   // user id → { role, at }

async function liveRole(user) {
  if (!user || !user.id) return null;
  const hit = cache.get(user.id);
  if (hit && Date.now() - hit.at < TTL_MS) return hit.role;
  let role = user.role;
  try {
    const r = await querySite('SELECT role FROM users WHERE id = $1', [user.id]);
    role = r.rows.length ? r.rows[0].role : null;
  } catch (e) { /* ฐานข้อมูลล่ม: ใช้ role ใน token */ }
  cache.set(user.id, { role, at: Date.now() });
  return role;
}
function forget(userId) { cache.delete(Number(userId)); }

function tokenUser(req) {
  const h = req.headers['authorization'];
  const token = (h && h.split(' ')[1]) || (req.cookies && req.cookies.token);
  if (!token) return null;
  try { return jwt.verify(token, JWT_SECRET); } catch (e) { return null; }
}

const OPEN_PAGES = new Set(['/checklist', '/checklist.html', '/login', '/login.html']);

async function roleGuard(req, res, next) {
  const user = tokenUser(req);
  if (!user) return next();
  const role = await liveRole(user);
  req.liveRole = role;
  if (role !== 'signer') return next();

  const p = req.path;
  if (p.startsWith('/api/')) {
    if (p.startsWith('/api/auth/') || p === '/api/gas' || p === '/api/gas/') return next();
    return res.status(403).json({ ok: false, error: 'บัญชีนี้ใช้ได้เฉพาะลงนามเช็คลิสต์' });
  }
  const isPage = p === '/' || /\.html$/i.test(p) || !/\.[a-z0-9]+$/i.test(p);
  if (isPage && !OPEN_PAGES.has(p)) return res.redirect('/checklist');
  next();
}

module.exports = { roleGuard, liveRole, forget };
