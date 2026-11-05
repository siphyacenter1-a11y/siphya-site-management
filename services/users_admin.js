// ============================================================
// จัดการบัญชีผู้ใช้ + สิทธิ์ลงนามเช็คลิสต์ ในที่เดียว (เฉพาะ admin) — หน้า /users
//
//   USERS_list()                 บัญชีทั้งหมด + สิทธิ์ลงนาม + รหัส PIN สำรอง
//   USERS_save(req)              สร้าง/แก้บัญชี: ชื่อ, รหัสผ่าน, ประเภทบัญชี, สิทธิ์ลงนาม (แทนที่ทั้งชุด)
//   USERS_delete(id)             ลบบัญชี (สิทธิ์ลงนามหายตาม)
//   USERS_savePin(req)           เพิ่ม/แก้รหัส PIN สำรอง (MASTER)
//   USERS_deletePin(id)          ลบรหัส PIN สำรอง
//
// ประเภทบัญชี (users.role):
//   staff  = ใช้ได้ทุกระบบ (หน้างาน, ธุรการ)
//   signer = ลงนามเช็คลิสต์อย่างเดียว (GF/GE) — middleware/role_guard.js
//   admin  = ผู้ดูแลระบบ — สร้าง/แก้จากหน้านี้ไม่ได้ (ให้ IT ตั้ง หรือใช้ scripts)
// สิทธิ์ลงนาม (checklist_pins ที่มี user_id): GM = ช่อง 2 + แก้ไข, GF = ช่อง 3, MASTER = ทุกอย่าง
// ============================================================
const bcrypt = require('bcryptjs');
const { sitePool } = require('../db');
const { UserError, withTx } = require('./common');
const { forget } = require('../middleware/role_guard');
const PROJECTS = require('./checklist_projects');

const TZ = 'Asia/Bangkok';
const str = (v, max) => String(v == null ? '' : v).trim().slice(0, max || 200);
const USERNAME_RE = /^[A-Za-z0-9._-]{3,50}$/;
const ACCOUNT_ROLES = ['staff', 'signer'];
const SIGN_ROLES = ['GM', 'GF', 'MASTER'];

function requireAdmin(ctx) {
  if (!(ctx && ctx.user && ctx.user.role === 'admin')) throw new UserError('ต้องใช้บัญชีผู้ดูแลระบบ (admin)');
}
function byName(ctx) { return (ctx && ctx.user && (ctx.user.username || ctx.user.full_name)) || ''; }

async function USERS_list() {
  requireAdmin(this);
  const users = (await sitePool.query(
    `SELECT id, username, full_name AS "fullName", role,
            TO_CHAR(last_login::timestamptz AT TIME ZONE '${TZ}', 'DD/MM/YYYY HH24:MI') AS "lastLogin"
       FROM users ORDER BY CASE role WHEN 'admin' THEN 1 WHEN 'staff' THEN 2 ELSE 3 END, full_name, username`)).rows;
  const rights = (await sitePool.query(
    `SELECT user_id, role, COALESCE(site_code, '') AS "siteCode"
       FROM checklist_pins WHERE user_id IS NOT NULL AND active
      ORDER BY CASE role WHEN 'MASTER' THEN 1 WHEN 'GM' THEN 2 ELSE 3 END, site_code NULLS FIRST`)).rows;
  const map = {};
  rights.forEach(r => { (map[r.user_id] = map[r.user_id] || []).push({ role: r.role, siteCode: r.siteCode }); });
  users.forEach(u => { u.rights = map[u.id] || []; u.self = !!(this.user && this.user.id === u.id); });
  const pins = (await sitePool.query(
    `SELECT id, role, COALESCE(site_code, '') AS "siteCode", COALESCE(label, '') AS label, active
       FROM checklist_pins WHERE user_id IS NULL ORDER BY role, id`)).rows;
  return { users, pins, projects: PROJECTS };
}

// สิทธิ์ลงนามจากหน้าเว็บ → [{ role, siteCode }] ที่ถูกต้องและไม่ซ้ำ
function cleanRights(list) {
  const out = [], seen = new Set();
  (Array.isArray(list) ? list : []).forEach(r => {
    const role = str(r && r.role, 10).toUpperCase();
    if (!SIGN_ROLES.includes(role)) throw new UserError('บทบาทลงนามไม่ถูกต้อง');
    const site = role === 'MASTER' ? '' : str(r.siteCode, 10).toUpperCase();
    if (site && !/^[A-Z0-9]{2,10}$/.test(site)) throw new UserError('รหัสโครงการไม่ถูกต้อง');
    const key = role + '|' + site;
    if (seen.has(key)) return;
    seen.add(key);
    out.push({ role, site });
  });
  if (out.length > 50) throw new UserError('สิทธิ์ลงนามมากเกินไป');
  return out;
}

// req = { id?, username (เฉพาะสร้างใหม่), fullName, password? (สร้างใหม่ต้องมี), accountRole, rights: [{ role, siteCode }] }
async function USERS_save(req) {
  requireAdmin(this);
  req = req || {};
  const by = byName(this);
  const id = req.id ? Number(req.id) : null;
  const fullName = str(req.fullName, 100);
  const pw = String(req.password || '');
  const rights = cleanRights(req.rights);
  if (!fullName) throw new UserError('กรุณาพิมพ์ชื่อ-นามสกุล (ชื่อนี้ขึ้นในใบลงนาม)');
  if (pw && pw.length < 6) throw new UserError('รหัสผ่านต้องยาวอย่างน้อย 6 ตัว');

  return withTx(async client => {
    let user = null;
    if (id) {
      user = (await client.query('SELECT id, role FROM users WHERE id = $1 FOR UPDATE', [id])).rows[0];
      if (!user) throw new UserError('ไม่พบบัญชีนี้ (อาจถูกลบไปแล้ว) กรุณาโหลดใหม่');
    }
    const isAdmin = user && user.role === 'admin';
    // ประเภทบัญชี: admin คงเดิม (แก้ได้แค่ชื่อ/สิทธิ์ลงนาม) · อื่น ๆ เลือก staff/signer
    let acct = isAdmin ? 'admin' : (ACCOUNT_ROLES.includes(req.accountRole) ? req.accountRole : 'staff');
    if (acct === 'signer' && rights.some(r => r.role !== 'GF')) {
      throw new UserError('บัญชี "ลงนามอย่างเดียว" ใช้ได้กับ GF/GE เท่านั้น — GM/ธุรการ และ MASTER ต้องเป็นบัญชีหน้างาน/staff เพราะต้องแก้ไขรายการได้');
    }
    if (acct === 'signer' && !rights.length) {
      throw new UserError('บัญชี "ลงนามอย่างเดียว" ต้องมีสิทธิ์ลงนาม GF/GE อย่างน้อย 1 โครงการ');
    }

    if (!user) {
      const uname = str(req.username, 50);
      if (!USERNAME_RE.test(uname)) throw new UserError('ชื่อผู้ใช้ต้องเป็นภาษาอังกฤษ/ตัวเลข 3–50 ตัว (ใช้ . _ - ได้)');
      if (!pw) throw new UserError('กรุณาตั้งรหัสผ่าน (อย่างน้อย 6 ตัว)');
      const dup = await client.query('SELECT 1 FROM users WHERE LOWER(username) = LOWER($1)', [uname]);
      if (dup.rows.length) throw new UserError(`ชื่อผู้ใช้ "${uname}" มีอยู่แล้ว`);
      user = (await client.query(
        `INSERT INTO users (username, password_hash, full_name, role) VALUES ($1, $2, $3, $4) RETURNING id, role`,
        [uname, await bcrypt.hash(pw, 10), fullName, acct])).rows[0];
    } else {
      if (isAdmin && pw && !(this.user && this.user.id === user.id)) {
        throw new UserError('รหัสผ่านของบัญชี admin คนอื่นเปลี่ยนจากหน้านี้ไม่ได้');
      }
      await client.query(
        `UPDATE users SET full_name = $2, role = $3, password_hash = COALESCE($4, password_hash) WHERE id = $1`,
        [user.id, fullName, acct, pw ? await bcrypt.hash(pw, 10) : null]);
    }

    // สิทธิ์ลงนาม: แทนที่ทั้งชุด (ประวัติการลงนามเก็บชื่อไว้แล้ว ไม่กระทบ)
    await client.query('DELETE FROM checklist_pins WHERE user_id = $1', [user.id]);
    for (const r of rights) {
      await client.query(
        `INSERT INTO checklist_pins (role, site_code, label, pin_hash, active, created_by, user_id)
         VALUES ($1, NULLIF($2, ''), '', NULL, TRUE, $3, $4)`, [r.role, r.site, by, user.id]);
    }
    forget(user.id);   // ประเภทบัญชีใหม่มีผลทันที
    return { ok: true, id: user.id };
  });
}

async function USERS_delete(id) {
  requireAdmin(this);
  id = Number(id) || 0;
  if (this.user && this.user.id === id) throw new UserError('ลบบัญชีที่กำลังใช้อยู่ไม่ได้');
  const u = (await sitePool.query('SELECT role FROM users WHERE id = $1', [id])).rows[0];
  if (!u) throw new UserError('ไม่พบบัญชีนี้ (อาจถูกลบไปแล้ว)');
  if (u.role === 'admin') {
    const n = (await sitePool.query("SELECT COUNT(*)::int AS n FROM users WHERE role = 'admin'")).rows[0].n;
    if (n <= 1) throw new UserError('ต้องเหลือบัญชี admin อย่างน้อย 1 บัญชี');
  }
  await sitePool.query('DELETE FROM users WHERE id = $1', [id]);   // checklist_pins ลบตาม (ON DELETE CASCADE)
  forget(id);
  return { ok: true };
}

// รหัส PIN สำรอง (ไม่ผูกบัญชี) — req = { id?, label, pin? }  เพิ่มใหม่ได้เฉพาะ MASTER
async function USERS_savePin(req) {
  requireAdmin(this);
  req = req || {};
  const id = req.id ? Number(req.id) : null;
  const label = str(req.label, 100);
  const pin = str(req.pin, 50);
  if (!label) throw new UserError('กรุณาพิมพ์ชื่อที่จะขึ้นในใบเมื่อใช้รหัสนี้');
  if (!id && !pin) throw new UserError('กรุณาตั้งรหัส PIN');
  if (pin && !/^\d{4,12}$/.test(pin)) throw new UserError('รหัส PIN ต้องเป็นตัวเลข 4–12 หลัก');
  return withTx(async client => {
    await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', ['checklist_pins']);
    if (pin) {
      const others = (await client.query(
        'SELECT label, pin_hash FROM checklist_pins WHERE user_id IS NULL AND pin_hash IS NOT NULL AND id <> $1', [id || 0])).rows;
      for (const o of others) {
        if (await bcrypt.compare(pin, o.pin_hash)) throw new UserError(`รหัสนี้ซ้ำกับ "${o.label}" กรุณาตั้งรหัสอื่น`);
      }
    }
    const hash = pin ? await bcrypt.hash(pin, 10) : null;
    if (id) {
      const r = await client.query(
        `UPDATE checklist_pins SET label = $2, pin_hash = COALESCE($3, pin_hash), active = TRUE, updated_at = NOW(), updated_by = $4
          WHERE id = $1 AND user_id IS NULL`, [id, label, hash, byName(this)]);
      if (!r.rowCount) throw new UserError('ไม่พบรหัสนี้ กรุณาโหลดใหม่');
      return { ok: true, id };
    }
    const r = await client.query(
      `INSERT INTO checklist_pins (role, site_code, label, pin_hash, active, created_by)
       VALUES ('MASTER', NULL, $1, $2, TRUE, $3) RETURNING id`, [label, hash, byName(this)]);
    return { ok: true, id: r.rows[0].id };
  });
}

async function USERS_deletePin(id) {
  requireAdmin(this);
  const r = await sitePool.query('DELETE FROM checklist_pins WHERE id = $1 AND user_id IS NULL', [Number(id) || 0]);
  if (!r.rowCount) throw new UserError('ไม่พบรหัสนี้ (อาจถูกลบไปแล้ว)');
  return { ok: true };
}

module.exports = { functions: { USERS_list, USERS_save, USERS_delete, USERS_savePin, USERS_deletePin } };
