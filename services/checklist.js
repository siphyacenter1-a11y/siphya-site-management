// ============================================================
// เช็คลิสต์ตรวจควบคุมพื้นที่ประจำวัน — ตรรกะฝั่ง server
// แปลงมาจาก Code.gs (Google Apps Script) ส่วน "ระบบที่ 4: CHECKLIST"
// ชื่อฟังก์ชัน อินพุต และคำตอบ เหมือนเดิมทุกตัว เพื่อให้หน้าเว็บเดิมใช้ได้ทันที
//
//   CHECKLIST_saveSubmission(payload)   บันทึกฟอร์ม
//   CHECKLIST_getSubmissions()          รายการทั้งหมด (ใหม่สุดก่อน)
//   CHECKLIST_signSubmission(req)       ลงนามช่อง GM / GF ด้วยรหัส
//   CHECKLIST_checkEditPin(req)         ตรวจรหัสก่อนแก้ไข
//   CHECKLIST_updateSubmission(req)     บันทึกการแก้ไข (ล้างลายเซ็นช่อง 2-3)
//   CHECKLIST_getPrintPdf(req)          สร้าง PDF จาก HTML ใบพิมพ์
//   CHECKLIST_signerList()              รายชื่อผู้ลงนาม (admin)
//   CHECKLIST_saveSigner(req)           เพิ่ม/แก้ผู้ลงนาม เปลี่ยนรหัส เปิด/ปิด (admin)
//   CHECKLIST_updateSignerAccount(req)  แก้ชื่อ/ตั้งรหัสผ่านใหม่ บัญชีผู้ลงนาม (admin)
//   CHECKLIST_deleteSigner(id)          ลบสิทธิ์ลงนาม (admin)
//
// ข้อผิดพลาดที่ผู้ใช้ควรเห็น โยนเป็น UserError (ข้อความภาษาไทย)
// ============================================================
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const { sitePool } = require('../db');
const { UserError, withTx, htmlToPdf } = require('./common');

const ITEM_IDS = ['1.1', '1.2', '2.1', '2.2', '3.1', '4.1', '4.2', '4.3', '5.1', '5.2',
  '6.1', '6.2', '7.1', '8.1', '8.2', '9.1', '10.1'];
const STATUSES = ['ok', 'area', 'room', 'na'];
const TZ = 'Asia/Bangkok';

const PUBLIC_DIR = path.join(__dirname, '..', 'public');
const PHOTO_DIR = path.join(PUBLIC_DIR, 'uploads', 'checklist');
const PDF_DIR = path.join(PUBLIC_DIR, 'uploads', 'checklist-pdf');
const MIME_EXT = { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp' };

const MAX_PIN_FAILS = 5;
const LOCK_MINUTES = 15;

// ---------- helpers ----------
const str = (v, max) => String(v == null ? '' : v).trim().slice(0, max || 500);

function siteCodeOf(site) {
  const m = String(site || '').match(/\(([A-Za-z0-9]+)\)\s*$/);
  return m ? m[1].toUpperCase() : '';
}

function parseRowId(rowId) {
  const m = String(rowId || '').match(/^row_(\d+)$/);
  if (!m) throw new UserError('ไม่พบรายการนี้ กรุณารีเฟรชแดชบอร์ด');
  return Number(m[1]);
}

function fmtTs(d) {
  if (!d) return '';
  const p = new Intl.DateTimeFormat('en-GB', {
    timeZone: TZ, day: '2-digit', month: '2-digit', year: 'numeric',
    hour: '2-digit', minute: '2-digit', hour12: false
  }).formatToParts(d).reduce((o, x) => (o[x.type] = x.value, o), {});
  return `${p.day}/${p.month}/${p.year} ${p.hour}:${p.minute}`;
}

function validatePayload(payload) {
  const missing = [];
  if (!str(payload.site)) missing.push('หน่วยงาน');
  if (!str(payload.date)) missing.push('วันที่ตรวจ');
  else if (!/^\d{4}-\d{2}-\d{2}$/.test(str(payload.date))) missing.push('วันที่ตรวจ (รูปแบบ ปปปป-ดด-วว)');
  if (!str(payload.recordedBy)) missing.push('ผู้บันทึกข้อมูล');
  const signers = Array.isArray(payload.signers) ? payload.signers : [];
  if (!str(signers[0])) missing.push('ลงนามผู้ดูแลพื้นที่ควบคุม');

  const items = (payload.items && typeof payload.items === 'object') ? payload.items : {};
  const bad = [];
  ITEM_IDS.forEach(id => {
    const it = items[id] || {};
    const notOk = it.status === 'area' || it.status === 'room';
    if (!STATUSES.includes(it.status) ||
        (notOk && !str(it.worker)) ||
        (notOk && !str(it.location))) bad.push(id);
  });
  if (bad.length) missing.push('ข้อ ' + bad.join(', '));
  if (missing.length) throw new UserError('กรุณากรอกให้ครบ: ' + missing.join(' / '));
}

// บันทึกรูป base64 เป็นไฟล์ คืนลิงก์ /uploads/checklist/<ปี-เดือน>/<ไฟล์>
function savePhotoFile(photo, checklistId, itemId, n) {
  const data = String((photo && photo.data) || '');
  const m = data.match(/^data:(image\/[a-z]+);base64,(.+)$/);
  if (!m) throw new Error('ไม่ใช่รูปแบบ data URL');
  const mime = m[1];
  if (!MIME_EXT[mime]) throw new Error('ชนิดไฟล์ไม่รองรับ: ' + mime);
  const buf = Buffer.from(m[2], 'base64');
  if (!buf.length || buf.length > 8 * 1024 * 1024) throw new Error('ขนาดรูปไม่ถูกต้อง');
  const month = new Date().toISOString().slice(0, 7);
  const dir = path.join(PHOTO_DIR, month);
  fs.mkdirSync(dir, { recursive: true });
  const name = `${checklistId}_${itemId.replace('.', '-')}_${n}_${crypto.randomBytes(4).toString('hex')}.${MIME_EXT[mime]}`;
  fs.writeFileSync(path.join(dir, name), buf);
  return `/uploads/checklist/${month}/${name}`;
}

function removePhotoFile(url) {
  if (!String(url).startsWith('/uploads/checklist/')) return;
  const file = path.join(PUBLIC_DIR, url);
  if (!file.startsWith(PHOTO_DIR)) return;
  fs.promises.unlink(file).catch(() => {});
}

// เขียนคำตอบ 17 ข้อ + รูป ลงตารางลูก (ใช้ทั้งตอนบันทึกใหม่และตอนแก้ไข)
// keepUrls = ลิงก์รูปเดิมของรายการนี้ที่ยอมให้เก็บไว้ (ตอนแก้ไข)
async function writeItems(client, checklistId, items, keepUrls) {
  const summary = {};
  for (const id of ITEM_IDS) {
    const it = items[id] || {};
    await client.query(
      `INSERT INTO checklist_items (checklist_id, item_id, status, worker, location, remark)
       VALUES ($1,$2,$3,$4,$5,$6)`,
      [checklistId, id, it.status, str(it.worker, 200), str(it.location, 200), str(it.remark, 1000)]);

    const urls = [];
    (Array.isArray(it.photos) ? it.photos : []).forEach((p, idx) => {
      if (p && p.url) {
        if (keepUrls && keepUrls.has(String(p.url))) urls.push(String(p.url));
        return;
      }
      try {
        urls.push(savePhotoFile(p, checklistId, id, idx));
      } catch (err) {
        // รูปใดรูปหนึ่งบันทึกไม่สำเร็จ ไม่ให้ทั้งฟอร์มล้ม (เหมือนระบบเดิม)
        console.warn(`[checklist] บันทึกรูปข้อ ${id} ไม่สำเร็จ:`, err.message);
      }
    });
    for (let i = 0; i < urls.length; i++) {
      await client.query(
        'INSERT INTO checklist_photos (checklist_id, item_id, sort_order, url) VALUES ($1,$2,$3,$4)',
        [checklistId, id, i, urls[i]]);
    }
    summary[id] = { status: it.status, worker: str(it.worker, 200), location: str(it.location, 200),
      remark: str(it.remark, 1000), photos: urls };
  }
  // เก็บสำเนาไว้ใน checklist_data ด้วย ให้ API เดิม (/api/checklist/logs) ยังอ่านได้
  await client.query('UPDATE site_supervisor_checklists SET checklist_data = $2 WHERE id = $1',
    [checklistId, JSON.stringify(summary)]);
}

// อ่านหัวฟอร์มพร้อมล็อกแถว และตรวจว่ายังเป็นรายการเดิม (submittedAt ต้องตรง)
async function lockRow(client, rowId, submittedAt) {
  const id = parseRowId(rowId);
  const r = await client.query('SELECT * FROM site_supervisor_checklists WHERE id = $1 FOR UPDATE', [id]);
  if (!r.rows.length) throw new UserError('ไม่พบรายการนี้ กรุณารีเฟรชแดชบอร์ด');
  const row = r.rows[0];
  if (new Date(row.submission_time).toISOString() !== String(submittedAt || '')) {
    throw new UserError('ข้อมูลมีการเปลี่ยนแปลง กรุณารีเฟรชแดชบอร์ดแล้วลองใหม่');
  }
  return row;
}

// ---------- รหัสลงนาม ----------
// slot 1 = GM/ธุรการสนาม (ใช้แก้ไขด้วย), slot 2 = GF/GE
// ผู้ลงนามที่ใช้ได้ = บทบาทนั้นของโครงการนี้ + บทบาทนั้นแบบ "ทุกโครงการ" + MASTER (เฉพาะที่เปิดใช้)
// แต่ละแถวเป็นได้ 2 แบบ: ผูกบัญชี login (ตรวจ username + รหัสผ่านบัญชี) หรือรหัส PIN (ไม่ต้องใส่ username)
async function expectedPins(client, slot, siteCode) {
  const role = slot === 2 ? 'GF' : 'GM';
  const r = await client.query(
    `SELECT p.id, p.user_id, COALESCE(u.full_name, p.label) AS label, p.pin_hash,
            u.username, u.password_hash
       FROM checklist_pins p LEFT JOIN users u ON u.id = p.user_id
      WHERE p.active AND (p.user_id IS NULL OR u.id IS NOT NULL)
        AND (p.role = 'MASTER' OR (p.role = $1 AND (p.site_code IS NULL OR p.site_code = $2)))
      ORDER BY (p.role = 'MASTER'), (p.site_code IS NULL), p.id`, [role, siteCode || '']);
  return r.rows;
}

// คืนข้อมูลผู้ลงนามที่ตรง { id, label }
//   username ว่าง → pin คือรหัส PIN · มี username → pin คือรหัสผ่านบัญชี
async function assertPin(client, { slot, siteCode, pin, username, failKey, notSetMsg, wrongMsg }) {
  const all = await expectedPins(client, slot, siteCode);
  if (!all.length) throw new UserError(notSetMsg);
  const uname = str(username, 50).toLowerCase();
  const pins = uname
    ? all.filter(p => p.user_id && String(p.username || '').toLowerCase() === uname)
    : all.filter(p => !p.user_id && p.pin_hash);

  const f = (await client.query(
    `SELECT fails, locked_until > NOW() AS locked,
            updated_at < NOW() - make_interval(mins => $2) AS stale
       FROM checklist_pin_failures WHERE fail_key = $1`, [failKey, LOCK_MINUTES])).rows[0];
  if (f && f.locked) {
    throw new UserError(`ใส่รหัสผิดหลายครั้ง ระบบล็อกชั่วคราว กรุณาลองใหม่ใน ${LOCK_MINUTES} นาที`);
  }

  const given = str(pin, 50);
  let match = null;
  if (given) {
    for (const p of pins) {
      const hash = p.user_id ? p.password_hash : p.pin_hash;
      if (hash && await bcrypt.compare(given, hash)) { match = { id: p.id, label: str(p.label, 100) }; break; }
    }
  }
  if (!match) {
    const prev = (f && !f.stale && !(f.fails >= MAX_PIN_FAILS)) ? f.fails : 0;
    const fails = prev + 1;
    // บันทึกนอก transaction หลัก เพื่อให้นับครั้งที่ผิดแม้ transaction ถูกยกเลิก
    await sitePool.query(
      `INSERT INTO checklist_pin_failures (fail_key, fails, locked_until, updated_at)
       VALUES ($1, $2::int, CASE WHEN $2::int >= $3::int THEN NOW() + make_interval(mins => $4::int) END, NOW())
       ON CONFLICT (fail_key) DO UPDATE
         SET fails = EXCLUDED.fails, locked_until = EXCLUDED.locked_until, updated_at = NOW()`,
      [failKey, fails, MAX_PIN_FAILS, LOCK_MINUTES]);
    throw new UserError(wrongMsg);
  }
  await sitePool.query('DELETE FROM checklist_pin_failures WHERE fail_key = $1', [failKey]);
  return match;
}

function assertEditPin(client, site, pin, username) {
  const siteCode = siteCodeOf(site);
  return assertPin(client, {
    slot: 1, siteCode, pin, username,
    failKey: 'edit_' + siteCode,
    notSetMsg: 'ยังไม่ได้ตั้งรหัสสำหรับโครงการนี้ กรุณาติดต่อผู้ดูแลระบบ',
    wrongMsg: username ? 'ชื่อผู้ใช้หรือรหัสผ่านไม่ถูกต้อง หรือบัญชีนี้ไม่มีสิทธิ์แก้ไขโครงการนี้' : 'รหัสไม่ถูกต้อง'
  });
}

// ============================================================
// ฟังก์ชันที่หน้าเว็บเรียก
// ============================================================

async function CHECKLIST_saveSubmission(payload) {
  if (!payload || typeof payload !== 'object') throw new UserError('ข้อมูลไม่ถูกต้อง (invalid payload)');
  validatePayload(payload);
  const signers = payload.signers || [];

  await withTx(async client => {
    // ตอนส่งฟอร์ม รับเฉพาะลายเซ็นช่องที่ 1 — ช่อง 2, 3 ต้องลงนามผ่านแดชบอร์ดเท่านั้น
    const r = await client.query(
      `INSERT INTO site_supervisor_checklists
         (submission_time, site_name, inspection_date, lang, recorded_by, signer1, signer2, signer3)
       VALUES (date_trunc('milliseconds', NOW()), $1, $2, $3, $4, $5, '', '')
       RETURNING id`,
      [str(payload.site, 200), str(payload.date), str(payload.lang, 5) || 'th',
        str(payload.recordedBy, 100), str(signers[0], 100)]);
    await writeItems(client, r.rows[0].id, payload.items || {}, null);
  });
  return { ok: true };
}

async function CHECKLIST_getSubmissions() {
  const heads = (await sitePool.query(
    `SELECT id, submission_time, site_name, TO_CHAR(inspection_date, 'YYYY-MM-DD') AS date, lang,
            recorded_by, signer1, signer2, signer3, signer2_at, signer3_at
       FROM site_supervisor_checklists
      ORDER BY submission_time DESC, id DESC`)).rows;
  if (!heads.length) return [];

  const ids = heads.map(h => h.id);
  const items = (await sitePool.query(
    'SELECT checklist_id, item_id, status, worker, location, remark FROM checklist_items WHERE checklist_id = ANY($1)',
    [ids])).rows;
  const photos = (await sitePool.query(
    'SELECT checklist_id, item_id, url FROM checklist_photos WHERE checklist_id = ANY($1) ORDER BY sort_order, id',
    [ids])).rows;

  const itemMap = new Map();
  items.forEach(it => itemMap.set(it.checklist_id + '|' + it.item_id, it));
  const photoMap = new Map();
  photos.forEach(p => {
    const k = p.checklist_id + '|' + p.item_id;
    if (!photoMap.has(k)) photoMap.set(k, []);
    photoMap.get(k).push(p.url);
  });

  return heads.map(h => ({
    id: 'row_' + h.id,
    submittedAt: new Date(h.submission_time).toISOString(),
    site: h.site_name || '',
    date: h.date || '',
    lang: h.lang || '',
    recordedBy: h.recorded_by || '',
    signers: [h.signer1 || '', h.signer2 || '', h.signer3 || ''],
    signedAt: ['', fmtTs(h.signer2_at), fmtTs(h.signer3_at)],
    items: ITEM_IDS.map(id => {
      const it = itemMap.get(h.id + '|' + id) || {};
      return {
        id,
        status: it.status || null,
        worker: it.worker || '',
        location: it.location || '',
        remark: it.remark || '',
        photos: photoMap.get(h.id + '|' + id) || []
      };
    })
  }));
}

async function CHECKLIST_signSubmission(req) {
  if (!req || (req.slot !== 1 && req.slot !== 2)) throw new UserError('ช่องลงนามไม่ถูกต้อง');
  let name = str(req.name, 100);

  await withTx(async client => {
    const row = await lockRow(client, req.rowId, req.submittedAt);
    // อ่านโครงการจาก database เสมอ (ไม่เชื่อค่าจากหน้าเว็บ)
    const siteCode = siteCodeOf(row.site_name);
    const who = await assertPin(client, {
      slot: req.slot, siteCode, pin: req.pin, username: req.username,
      failKey: 'sign' + req.slot + (req.slot === 1 ? '_' + siteCode : ''),
      notSetMsg: 'ยังไม่ได้ตั้งรหัสลงนามสำหรับโครงการนี้ กรุณาติดต่อผู้ดูแลระบบ',
      wrongMsg: str(req.username) ? 'ชื่อผู้ใช้หรือรหัสผ่านไม่ถูกต้อง หรือบัญชีนี้ไม่มีสิทธิ์ลงนามช่องนี้ของโครงการนี้' : 'รหัสลงนามไม่ถูกต้อง'
    });
    // รหัสเป็นของใคร ใช้ชื่อคนนั้น (พิมพ์ชื่ออื่นแทนไม่ได้)
    if (who.label) name = who.label;
    if (!name) throw new UserError('กรุณาพิมพ์ชื่อผู้ลงนาม');
    const col = req.slot === 1 ? 'signer2' : 'signer3';
    const existing = str(row[col]);
    if (existing) throw new UserError('ช่องนี้ลงนามไปแล้วโดย ' + existing);
    await client.query(
      `UPDATE site_supervisor_checklists SET ${col} = $2, ${col}_at = NOW() WHERE id = $1`,
      [row.id, name]);
  });
  return { ok: true };
}

async function CHECKLIST_checkEditPin(req) {
  req = req || {};
  let who;
  await withTx(async client => {
    const row = await lockRow(client, req.rowId, req.submittedAt);
    who = await assertEditPin(client, row.site_name, req.pin, req.username);
  });
  return { ok: true, name: who.label };
}

async function CHECKLIST_updateSubmission(req) {
  if (!req || !req.payload || typeof req.payload !== 'object') throw new UserError('ข้อมูลไม่ถูกต้อง');
  const removed = [];

  await withTx(async client => {
    const row = await lockRow(client, req.rowId, req.submittedAt);
    const who = await assertEditPin(client, row.site_name, req.pin, req.username);

    const payload = req.payload;
    payload.site = row.site_name; // ล็อกโครงการเดิม ห้ามเปลี่ยน
    validatePayload(payload);
    const signers = payload.signers || [];

    // รูปเดิมของรายการนี้เท่านั้นที่เก็บไว้ได้ (กันส่งลิงก์แปลกปลอมเข้ามา)
    const oldUrls = (await client.query('SELECT url FROM checklist_photos WHERE checklist_id = $1', [row.id]))
      .rows.map(r => r.url);
    const keep = new Set(oldUrls);

    await client.query('DELETE FROM checklist_items WHERE checklist_id = $1', [row.id]);
    await client.query('DELETE FROM checklist_photos WHERE checklist_id = $1', [row.id]);
    await client.query(
      `UPDATE site_supervisor_checklists
          SET inspection_date = $2, lang = $3, recorded_by = $4, signer1 = $5,
              signer2 = '', signer3 = '', signer2_at = NULL, signer3_at = NULL,
              edited_at = NOW(), edited_by = $6
        WHERE id = $1`,
      [row.id, str(payload.date), str(payload.lang, 5) || 'th', str(payload.recordedBy, 100), str(signers[0], 100),
        who.label || userName(this)]);
    await writeItems(client, row.id, payload.items || {}, keep);

    const still = new Set((await client.query('SELECT url FROM checklist_photos WHERE checklist_id = $1', [row.id]))
      .rows.map(r => r.url));
    oldUrls.forEach(u => { if (!still.has(u)) removed.push(u); });
  });

  removed.forEach(removePhotoFile); // ลบไฟล์รูปที่ผู้ใช้กดลบ หลังบันทึกสำเร็จแล้วเท่านั้น
  return { ok: true };
}

// ---------- ตั้งค่าผู้ลงนาม (admin) ----------
function userName(ctx) { return (ctx && ctx.user && (ctx.user.username || ctx.user.full_name)) || ''; }
function requireAdmin(ctx) {
  if (!(ctx && ctx.user && ctx.user.role === 'admin')) throw new UserError('ต้องใช้บัญชีผู้ดูแลระบบ (admin)');
}
const SIGNER_ROLES = ['GM', 'GF', 'MASTER'];

async function CHECKLIST_signerList() {
  requireAdmin(this);
  const r = await sitePool.query(
    `SELECT p.id, p.role, COALESCE(p.site_code, '') AS "siteCode", p.active,
            CASE WHEN p.user_id IS NULL THEN 'pin' ELSE 'user' END AS kind,
            p.user_id AS "userId", COALESCE(u.username, '') AS username, COALESCE(u.role, '') AS "userRole",
            COALESCE(u.full_name, p.label, '') AS name,
            TO_CHAR(COALESCE(p.updated_at, p.created_at) AT TIME ZONE '${TZ}', 'DD/MM/YYYY HH24:MI') AS "updatedAt",
            COALESCE(NULLIF(p.updated_by, ''), p.created_by, '') AS "updatedBy"
       FROM checklist_pins p LEFT JOIN users u ON u.id = p.user_id
      WHERE p.user_id IS NULL OR u.id IS NOT NULL
      ORDER BY CASE p.role WHEN 'GM' THEN 1 WHEN 'GF' THEN 2 ELSE 3 END, p.site_code NULLS FIRST, name, p.id`);
  const users = await sitePool.query(
    `SELECT id, username, full_name AS "fullName", role FROM users ORDER BY full_name, username`);
  return { signers: r.rows, users: users.rows };
}

const USERNAME_RE = /^[A-Za-z0-9._-]{3,50}$/;
// ประเภทบัญชีที่ตั้งจากหน้านี้ได้: signer = ลงนามอย่างเดียว (เข้าได้แค่เช็คลิสต์), staff = ใช้ได้ทุกระบบ
const ACCOUNT_ROLES = ['signer', 'staff'];
function checkPassword(pw) {
  if (pw.length < 6) throw new UserError('รหัสผ่านต้องยาวอย่างน้อย 6 ตัว');
}

// req = { id?, kind: 'user'|'pin', role, siteCode, active,
//         kind=user: userId  หรือ newUser { username, fullName, password } (สร้างบัญชีใหม่ role staff)
//         kind=pin:  label, pin? (เพิ่มใหม่ต้องมี · แก้ไขไม่ใส่ = ใช้รหัสเดิม) — เพิ่มใหม่ได้เฉพาะ MASTER }
async function CHECKLIST_saveSigner(req) {
  requireAdmin(this);
  req = req || {};
  const by = userName(this);
  const id = req.id ? Number(req.id) : null;
  const role = str(req.role, 10).toUpperCase();
  if (!SIGNER_ROLES.includes(role)) throw new UserError('กรุณาเลือกบทบาท');
  const site = role === 'MASTER' ? '' : str(req.siteCode, 10).toUpperCase();
  if (site && !/^[A-Z0-9]{2,10}$/.test(site)) throw new UserError('รหัสโครงการไม่ถูกต้อง');
  const active = req.active !== false;

  return withTx(async client => {
    await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', ['checklist_pins']);
    let cur = null;
    if (id) {
      cur = (await client.query('SELECT id, user_id FROM checklist_pins WHERE id = $1', [id])).rows[0];
      if (!cur) throw new UserError('ไม่พบผู้ลงนามนี้ (อาจถูกลบไปแล้ว) กรุณาโหลดใหม่');
    }
    const kind = cur ? (cur.user_id ? 'user' : 'pin') : (req.kind === 'pin' ? 'pin' : 'user');

    if (kind === 'user') {
      let userId = cur ? cur.user_id : Number(req.userId) || null;
      if (!cur && req.newUser) {
        const nu = req.newUser;
        const uname = str(nu.username, 50);
        const fullName = str(nu.fullName, 100);
        const pw = String(nu.password || '');
        const acctRole = ACCOUNT_ROLES.includes(nu.accountRole) ? nu.accountRole : (role === 'GF' ? 'signer' : 'staff');
        if (!USERNAME_RE.test(uname)) throw new UserError('ชื่อผู้ใช้ต้องเป็นภาษาอังกฤษ/ตัวเลข 3–50 ตัว (ใช้ . _ - ได้)');
        if (!fullName) throw new UserError('กรุณาพิมพ์ชื่อ-นามสกุล');
        checkPassword(pw);
        const dup = await client.query('SELECT 1 FROM users WHERE LOWER(username) = LOWER($1)', [uname]);
        if (dup.rows.length) throw new UserError(`ชื่อผู้ใช้ "${uname}" มีอยู่แล้ว — เลือกจากรายชื่อบัญชีที่มีอยู่แทน`);
        userId = (await client.query(
          `INSERT INTO users (username, password_hash, full_name, role) VALUES ($1, $2, $3, $4) RETURNING id`,
          [uname, await bcrypt.hash(pw, 10), fullName, acctRole])).rows[0].id;
      }
      if (!userId) throw new UserError('กรุณาเลือกบัญชีผู้ใช้');
      const u = await client.query('SELECT id FROM users WHERE id = $1', [userId]);
      if (!u.rows.length) throw new UserError('ไม่พบบัญชีผู้ใช้นี้');
      const dup = await client.query(
        `SELECT 1 FROM checklist_pins WHERE user_id = $1 AND role = $2 AND COALESCE(site_code, '') = $3 AND id <> $4`,
        [userId, role, site, id || 0]);
      if (dup.rows.length) throw new UserError('บัญชีนี้มีสิทธิ์บทบาทนี้ในโครงการนี้อยู่แล้ว');
      if (id) {
        await client.query(
          `UPDATE checklist_pins SET role = $2, site_code = NULLIF($3, ''), active = $4, updated_at = NOW(), updated_by = $5
            WHERE id = $1`, [id, role, site, active, by]);
        return { ok: true, id };
      }
      const r = await client.query(
        `INSERT INTO checklist_pins (role, site_code, label, pin_hash, active, created_by, user_id)
         VALUES ($1, NULLIF($2, ''), '', NULL, $3, $4, $5) RETURNING id`, [role, site, active, by, userId]);
      return { ok: true, id: r.rows[0].id, userId };
    }

    // แบบรหัส PIN
    if (!cur && role !== 'MASTER') throw new UserError('รหัส PIN แยกใช้ได้เฉพาะ MASTER — GM/GF ให้ใช้บัญชีผู้ใช้');
    const label = str(req.label, 100);
    if (!label) throw new UserError('กรุณาพิมพ์ชื่อผู้ลงนาม');
    const pin = str(req.pin, 50);
    if (!id && !pin) throw new UserError('กรุณาตั้งรหัส PIN');
    if (pin && !/^\d{4,12}$/.test(pin)) throw new UserError('รหัส PIN ต้องเป็นตัวเลข 4–12 หลัก');
    if (pin) {
      const others = (await client.query(
        'SELECT label, pin_hash FROM checklist_pins WHERE active AND user_id IS NULL AND pin_hash IS NOT NULL AND id <> $1',
        [id || 0])).rows;
      for (const o of others) {
        if (await bcrypt.compare(pin, o.pin_hash)) {
          throw new UserError(`รหัสนี้ซ้ำกับของ "${o.label || 'ผู้ลงนามอื่น'}" กรุณาตั้งรหัสอื่น`);
        }
      }
    }
    const hash = pin ? await bcrypt.hash(pin, 10) : null;
    if (id) {
      await client.query(
        `UPDATE checklist_pins SET role = $2, site_code = NULLIF($3, ''), label = $4, active = $5,
                pin_hash = COALESCE($6, pin_hash), updated_at = NOW(), updated_by = $7
          WHERE id = $1`, [id, role, site, label, active, hash, by]);
      return { ok: true, id };
    }
    const r = await client.query(
      `INSERT INTO checklist_pins (role, site_code, label, pin_hash, active, created_by)
       VALUES ($1, NULLIF($2, ''), $3, $4, $5, $6) RETURNING id`, [role, site, label, hash, active, by]);
    return { ok: true, id: r.rows[0].id };
  });
}

// แก้ชื่อ-นามสกุล / ตั้งรหัสผ่านใหม่ / ประเภทบัญชี ของบัญชีผู้ลงนาม (บัญชี admin แก้จากหน้านี้ไม่ได้)
async function CHECKLIST_updateSignerAccount(req) {
  requireAdmin(this);
  req = req || {};
  const userId = Number(req.userId) || 0;
  const u = (await sitePool.query('SELECT id, role FROM users WHERE id = $1', [userId])).rows[0];
  if (!u) throw new UserError('ไม่พบบัญชีผู้ใช้นี้');
  if (u.role === 'admin') throw new UserError('บัญชี admin แก้ไขได้ที่หน้าจัดการผู้ใช้ (/admin) เท่านั้น');
  const fullName = str(req.fullName, 100);
  const pw = String(req.password || '');
  const acctRole = ACCOUNT_ROLES.includes(req.accountRole) ? req.accountRole : null;
  if (!fullName && !pw && !acctRole) throw new UserError('ไม่มีข้อมูลที่จะแก้ไข');
  if (pw) checkPassword(pw);
  await sitePool.query(
    `UPDATE users SET full_name = COALESCE(NULLIF($2, ''), full_name),
            password_hash = COALESCE($3, password_hash), role = COALESCE($4, role) WHERE id = $1`,
    [userId, fullName, pw ? await bcrypt.hash(pw, 10) : null, acctRole]);
  if (acctRole) require('../middleware/role_guard').forget(userId);   // มีผลทันที
  return { ok: true };
}

// ลบสิทธิ์ลงนาม (บัญชีผู้ใช้ยังอยู่ ลบบัญชีได้ที่หน้า /admin)
async function CHECKLIST_deleteSigner(id) {
  requireAdmin(this);
  const r = await sitePool.query('DELETE FROM checklist_pins WHERE id = $1', [Number(id) || 0]);
  if (!r.rowCount) throw new UserError('ไม่พบผู้ลงนามนี้ (อาจถูกลบไปแล้ว)');
  return { ok: true };
}

// ---------- PDF ----------
let fontCss = null;
function getFontCss() {
  if (fontCss !== null) return fontCss;
  try {
    const dir = path.join(__dirname, '..', 'fonts');
    const reg = fs.readFileSync(path.join(dir, 'tahoma.ttf')).toString('base64');
    const bold = fs.readFileSync(path.join(dir, 'tahomabd.ttf')).toString('base64');
    fontCss =
      `@font-face{font-family:"ThaiPdf";src:url(data:font/ttf;base64,${reg});font-weight:normal;}` +
      `@font-face{font-family:"ThaiPdf";src:url(data:font/ttf;base64,${bold});font-weight:bold;}`;
  } catch (e) {
    fontCss = '';
  }
  return fontCss;
}

// แทนรูปในใบพิมพ์ด้วยข้อมูลรูปจริง (ไฟล์ในเครื่อง หรือดึงรูปเก่าจาก Google Drive)
async function inlineImages(html) {
  const re = /<img\b[^>]*?\bsrc="([^"]+)"[^>]*>/g;
  const srcs = [...new Set([...html.matchAll(re)].map(m => m[1]))];
  const map = {};
  let failed = false;

  await Promise.all(srcs.map(async raw => {
    const src = raw.replace(/&amp;/g, '&');
    if (src.startsWith('data:')) { map[raw] = raw; return; }
    try {
      const local = src.match(/^(?:https?:\/\/[^/]+)?(\/uploads\/checklist\/[\w\-/.]+)$/);
      if (local) {
        const file = path.join(PUBLIC_DIR, local[1]);
        if (!file.startsWith(PHOTO_DIR)) throw new Error('bad path');
        const ext = path.extname(file).slice(1).toLowerCase();
        const mime = ext === 'png' ? 'image/png' : ext === 'webp' ? 'image/webp' : 'image/jpeg';
        map[raw] = `data:${mime};base64,` + (await fs.promises.readFile(file)).toString('base64');
        return;
      }
      const drive = src.match(/[?&]id=([a-zA-Z0-9_-]+)/) || src.match(/\/d\/([a-zA-Z0-9_-]+)/);
      if (drive) {
        const res = await fetch(`https://drive.google.com/thumbnail?id=${drive[1]}&sz=w1000`);
        const type = res.headers.get('content-type') || '';
        if (!res.ok || !type.startsWith('image/')) throw new Error('HTTP ' + res.status);
        map[raw] = `data:${type};base64,` + Buffer.from(await res.arrayBuffer()).toString('base64');
        return;
      }
      throw new Error('unknown image source');
    } catch (err) {
      failed = true;
    }
  }));

  const out = html.replace(re, (tag, src) => {
    if (!map[src]) return '<span style="color:#999">[โหลดรูปไม่ได้]</span>';
    return src.startsWith('data:') ? tag : '<img class="p-photo" src="' + map[src] + '">';
  });
  return { html: out, failed };
}

const PDF_CSS =
  '@page{size:A4;margin:12mm;}' +
  'body{font-family:"ThaiPdf","Noto Sans Thai",Tahoma,sans-serif;font-size:10pt;color:#000;margin:0;}' +
  '.p-logo{display:block;margin:0 auto 6px;height:56px;}' +
  '.p-title{text-align:center;font-size:15pt;font-weight:bold;margin-bottom:6px;}' +
  'table.p-meta{width:100%;font-size:10pt;margin-bottom:8px;border-collapse:collapse;}' +
  '.p-table{width:100%;border-collapse:collapse;font-size:9pt;}' +
  '.p-table th,.p-table td{border:1px solid #444;padding:4px 5px;vertical-align:top;}' +
  '.p-table th{background:#eee;}' +
  '.p-cat-row td{background:#DCE9F5;font-weight:bold;}' +
  '.p-num{width:28px;text-align:center;}' +
  '.p-check{width:50px;text-align:center;font-weight:bold;}' +
  '.p-name{width:80px;}.p-remark{width:95px;}' +
  '.p-photo-row td{padding:6px;}' +
  '.p-photos img,.p-photo{width:48%;height:auto;max-height:320px;object-fit:contain;margin:3px 1%;border:1px solid #999;vertical-align:top;}' +
  'table.p-sign{width:100%;margin-top:24px;border-collapse:collapse;}' +
  'table.p-sign td{width:33%;text-align:center;font-size:9.5pt;vertical-align:top;padding:0 8px;}' +
  '.p-sign-line{border-bottom:1px solid #444;height:26px;margin-bottom:4px;}' +
  '.p-footnote{font-size:8.5pt;margin-top:8px;}' +
  'tr{page-break-inside:avoid;}' +
  '*{-webkit-print-color-adjust:exact;print-color-adjust:exact;}';

async function CHECKLIST_getPrintPdf(req) {
  if (!req || !req.html) throw new UserError('ไม่มีข้อมูลสำหรับสร้าง PDF');
  let body = String(req.html)
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/\son\w+="[^"]*"/gi, '');
  if (body.length > 3000000) throw new UserError('ข้อมูลใหญ่เกินไป');

  const id = parseRowId(req.rowId);
  const row = (await sitePool.query(
    `SELECT id, site_name, TO_CHAR(inspection_date, 'DD-MM-YYYY') AS d, pdf_path, pdf_hash
       FROM site_supervisor_checklists WHERE id = $1`, [id])).rows[0];
  if (!row) throw new UserError('ไม่พบรายการนี้ กรุณารีเฟรชแดชบอร์ด');

  // ถ้าเนื้อหาเหมือนเดิม ใช้ไฟล์เดิมซ้ำ
  const hash = crypto.createHash('md5').update(body).digest('hex');
  if (row.pdf_hash === hash && row.pdf_path && fs.existsSync(path.join(PUBLIC_DIR, row.pdf_path))) {
    return { url: encodeURI(row.pdf_path) };
  }

  const inl = await inlineImages(body);
  const full = '<!doctype html><html><head><meta charset="UTF-8"><style>' + getFontCss() + PDF_CSS +
    '</style></head><body>' + inl.html + '</body></html>';

  const pdf = await htmlToPdf(full, { format: 'A4' });

  const safe = s => String(s).replace(/[\\/:*?"<>|#%&{}$!'@+`=]/g, '').replace(/\s+/g, ' ').trim();
  const fileName = `เช็คลิสต์_${safe(row.site_name || 'ไม่ระบุหน่วยงาน')}_${safe(row.d || 'ไม่ระบุวันที่')}_${row.id}.pdf`;
  fs.mkdirSync(PDF_DIR, { recursive: true });
  await fs.promises.writeFile(path.join(PDF_DIR, fileName), pdf);
  const rel = '/uploads/checklist-pdf/' + fileName;

  // เก็บไว้แค่ฉบับล่าสุดของแต่ละรายการ
  if (row.pdf_path && row.pdf_path !== rel) {
    fs.promises.unlink(path.join(PUBLIC_DIR, row.pdf_path)).catch(() => {});
  }
  // ถ้ารูปขาด ไม่จำไว้ใช้ซ้ำ ครั้งหน้าจะลองดึงรูปใหม่
  await sitePool.query('UPDATE site_supervisor_checklists SET pdf_path = $2, pdf_hash = $3 WHERE id = $1',
    [row.id, rel, inl.failed ? null : hash]);
  return { url: encodeURI(rel) };
}

module.exports = {
  UserError,
  ITEM_IDS,
  functions: {
    CHECKLIST_saveSubmission,
    CHECKLIST_getSubmissions,
    CHECKLIST_signSubmission,
    CHECKLIST_checkEditPin,
    CHECKLIST_updateSubmission,
    CHECKLIST_getPrintPdf,
    CHECKLIST_signerList,
    CHECKLIST_saveSigner,
    CHECKLIST_updateSignerAccount,
    CHECKLIST_deleteSigner
  }
};
