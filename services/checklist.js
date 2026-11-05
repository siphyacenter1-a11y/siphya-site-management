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
  if (!str(payload.building)) missing.push('อาคาร');
  if (!str(payload.floor)) missing.push('ชั้น');
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

// อาคาร/ชั้นต้องอยู่ในรายชื่อของโครงการ (ตั้งที่ระบบขนส่ง → ⚙ ตั้งค่าโครงการ)
async function assertBuildingFloor(client, site, building, floor) {
  const code = siteCodeOf(site);
  const r = await client.query(
    'SELECT 1 FROM transport_floors WHERE project_code = $1 AND building = $2 AND floor = $3', [code, str(building, 100), str(floor, 50)]);
  if (r.rows.length) return;
  const any = await client.query('SELECT 1 FROM transport_floors WHERE project_code = $1 LIMIT 1', [code]);
  throw new UserError(any.rows.length
    ? 'อาคาร/ชั้นที่เลือกไม่มีในรายชื่อของโครงการนี้ กรุณาโหลดหน้าใหม่แล้วเลือกอีกครั้ง'
    : 'โครงการนี้ยังไม่ได้ตั้งรายชื่ออาคาร/ชั้น กรุณาแจ้ง admin (ตั้งที่ระบบขนส่ง → ตั้งค่าโครงการ)');
}

// รายชื่ออาคาร/ชั้นของโครงการ → [{ building, floors: [...] }] ตามลำดับที่ตั้งไว้
async function CHECKLIST_buildings(siteOrCode) {
  const code = siteCodeOf(siteOrCode) || str(siteOrCode, 10).toUpperCase();
  const r = await sitePool.query(
    'SELECT building, floor FROM transport_floors WHERE project_code = $1 ORDER BY b_order, building, f_order, floor', [code]);
  const out = [];
  r.rows.forEach(x => {
    let b = out[out.length - 1];
    if (!b || b.building !== x.building) { b = { building: x.building, floors: [] }; out.push(b); }
    b.floors.push(x.floor);
  });
  return out;
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

// ---------- สิทธิ์ลงนาม ----------
// slot 1 = ช่อง 2 GM/ธุรการสนาม (แก้ไขรายการได้ด้วย), slot 2 = ช่อง 3 GF/GE
// สิทธิ์ในแต่ละโครงการ = บทบาทนั้นของโครงการนั้น + บทบาทนั้นแบบ "ทุกโครงการ" + MASTER (เฉพาะที่เปิดใช้)
// ผู้ลงนามต้อง login ด้วยบัญชีของตัวเอง แล้วลงนาม/แก้ไขได้เลย (ไม่ต้องพิมพ์รหัสซ้ำ)
// สำรองฉุกเฉิน: รหัส PIN (MASTER หรือรหัสแบบเก่า) ใช้ได้จากบัญชีใดก็ได้

// ---------- นับรหัสผิด / ล็อกชั่วคราว ----------
async function lockState(client, failKey) {
  const f = (await client.query(
    `SELECT fails, locked_until > NOW() AS locked,
            updated_at < NOW() - make_interval(mins => $2) AS stale
       FROM checklist_pin_failures WHERE fail_key = $1`, [failKey, LOCK_MINUTES])).rows[0];
  if (f && f.locked) {
    throw new UserError(`ใส่รหัสผิดหลายครั้ง ระบบล็อกชั่วคราว กรุณาลองใหม่ใน ${LOCK_MINUTES} นาที`);
  }
  return f;
}
async function recordFail(failKey, f) {
  const prev = (f && !f.stale && !(f.fails >= MAX_PIN_FAILS)) ? f.fails : 0;
  // บันทึกนอก transaction หลัก เพื่อให้นับครั้งที่ผิดแม้ transaction ถูกยกเลิก
  await sitePool.query(
    `INSERT INTO checklist_pin_failures (fail_key, fails, locked_until, updated_at)
     VALUES ($1, $2::int, CASE WHEN $2::int >= $3::int THEN NOW() + make_interval(mins => $4::int) END, NOW())
     ON CONFLICT (fail_key) DO UPDATE
       SET fails = EXCLUDED.fails, locked_until = EXCLUDED.locked_until, updated_at = NOW()`,
    [failKey, prev + 1, MAX_PIN_FAILS, LOCK_MINUTES]);
}

// สิทธิ์ของบัญชีที่ login อยู่ → [{ id, role, site_code, label, username }]
async function sessionEntries(client, ctx) {
  const uid = ctx && ctx.user && Number(ctx.user.id);
  if (!uid) return [];
  return (await client.query(
    `SELECT p.id, p.role, p.site_code, u.full_name AS label, u.username
       FROM checklist_pins p JOIN users u ON u.id = p.user_id
      WHERE p.active AND p.user_id = $1`, [uid])).rows;
}

// ผู้ลงนาม: ส่ง pin มา = ใช้รหัส PIN (สำรอง) · ไม่ส่ง = บัญชีที่ login อยู่
// คืน { entries, name, username, via: 'session'|'pin' }
async function resolveSigner(client, ctx, req) {
  const pin = str(req && req.pin, 50);
  if (pin) {
    const failKey = 'pin_fallback';
    const f = await lockState(client, failKey);
    const pins = (await client.query(
      `SELECT id, role, site_code, label, pin_hash FROM checklist_pins
        WHERE active AND user_id IS NULL AND pin_hash IS NOT NULL`)).rows;
    let hit = null;
    for (const p of pins) { if (await bcrypt.compare(pin, p.pin_hash)) { hit = p; break; } }
    if (!hit) { await recordFail(failKey, f); throw new UserError('รหัส PIN ไม่ถูกต้อง'); }
    await sitePool.query('DELETE FROM checklist_pin_failures WHERE fail_key = $1', [failKey]);
    return { entries: [hit], name: str(hit.label, 100), username: '', via: 'pin' };
  }
  const rows = await sessionEntries(client, ctx);
  if (!rows.length) {
    throw new UserError('บัญชีที่ login อยู่ไม่มีสิทธิ์ลงนาม — ผู้ลงนามต้อง login ด้วยบัญชีของตัวเอง');
  }
  const name = str(rows[0].label, 100);
  if (!name) throw new UserError('บัญชีนี้ยังไม่มีชื่อ-นามสกุล กรุณาให้ admin ใส่ชื่อในหน้าจัดการผู้ใช้งาน');
  return { entries: rows, name, username: str(rows[0].username, 50), via: 'session' };
}

// มีสิทธิ์บทบาท role (GM/GF) ในโครงการ code ไหม
function canRole(entries, role, code) {
  return entries.some(e => e.role === 'MASTER' || (e.role === role && (!e.site_code || e.site_code === code)));
}

// ช่องที่คนนี้ลงได้ในใบนี้ (ช่อง 2 ก่อน แล้วช่อง 3) — ไม่มี slot = ลงไม่ได้ พร้อมเหตุผล
function pickSlot(entries, row, name) {
  const code = siteCodeOf(row.site_name);
  const s2 = str(row.signer2), s3 = str(row.signer3);
  if (!canRole(entries, 'GM', code) && !canRole(entries, 'GF', code)) return { reason: 'ไม่มีสิทธิ์ลงนามโครงการนี้' };
  if (name && (s2 === name || s3 === name)) return { reason: 'ลงนามใบนี้ไปแล้ว (คนเดียวลงสองช่องไม่ได้)' };
  if (!s2 && canRole(entries, 'GM', code)) return { slot: 1 };
  if (!s3 && canRole(entries, 'GF', code)) return { slot: 2 };
  return { reason: 'ช่องที่มีสิทธิ์ลงนามครบแล้ว' };
}

async function logSign(client, row, o) {
  await client.query(
    `INSERT INTO checklist_sign_log (checklist_id, site_name, inspection_date, action, slot, signer_name, username,
                                     method, viewed, confirmed, login_user)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
    [row.id, row.site_name, row.inspection_date, o.action, o.slot || null, o.name || '', o.username || '',
      o.method || '', o.viewed == null ? null : !!o.viewed, o.confirmed == null ? null : !!o.confirmed, o.sessionUser || '']);
}

// แก้ไขรายการได้: GM/ธุรการของโครงการนั้น หรือ MASTER
async function assertCanEdit(client, ctx, site, req) {
  const who = await resolveSigner(client, ctx, req);
  if (!canRole(who.entries, 'GM', siteCodeOf(site))) {
    throw new UserError('ไม่มีสิทธิ์แก้ไขโครงการนี้ (ต้องเป็น GM/ธุรการของโครงการ หรือ MASTER)');
  }
  return who;
}

// ============================================================
// ฟังก์ชันที่หน้าเว็บเรียก
// ============================================================

async function CHECKLIST_saveSubmission(payload) {
  if (!payload || typeof payload !== 'object') throw new UserError('ข้อมูลไม่ถูกต้อง (invalid payload)');
  validatePayload(payload);
  const signers = payload.signers || [];

  await withTx(async client => {
    await assertBuildingFloor(client, payload.site, payload.building, payload.floor);
    // ตอนส่งฟอร์ม รับเฉพาะลายเซ็นช่องที่ 1 — ช่อง 2, 3 ต้องลงนามผ่านแดชบอร์ดเท่านั้น
    const r = await client.query(
      `INSERT INTO site_supervisor_checklists
         (submission_time, site_name, inspection_date, lang, recorded_by, signer1, signer2, signer3, building, floor)
       VALUES (date_trunc('milliseconds', NOW()), $1, $2, $3, $4, $5, '', '', $6, $7)
       RETURNING id`,
      [str(payload.site, 200), str(payload.date), str(payload.lang, 5) || 'th',
        str(payload.recordedBy, 100), str(signers[0], 100), str(payload.building, 100), str(payload.floor, 50)]);
    await writeItems(client, r.rows[0].id, payload.items || {}, null);
  });
  return { ok: true };
}

async function CHECKLIST_getSubmissions() {
  const heads = (await sitePool.query(
    `SELECT id, submission_time, site_name, TO_CHAR(inspection_date, 'YYYY-MM-DD') AS date, lang,
            recorded_by, signer1, signer2, signer3, signer2_at, signer3_at, building, floor
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
    building: h.building || '',
    floor: h.floor || '',
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
  if (req.confirm !== true) throw new UserError('กรุณาติ๊กยืนยันว่าได้ตรวจสอบเช็คลิสต์แล้ว');
  const ctx = this;
  let full = false;

  await withTx(async client => {
    const row = await lockRow(client, req.rowId, req.submittedAt);
    // อ่านโครงการจาก database เสมอ (ไม่เชื่อค่าจากหน้าเว็บ)
    const code = siteCodeOf(row.site_name);
    const who = await resolveSigner(client, ctx, req);
    if (!canRole(who.entries, req.slot === 1 ? 'GM' : 'GF', code)) {
      throw new UserError('ไม่มีสิทธิ์ลงนามช่องนี้ของโครงการนี้');
    }
    const name = who.name;
    if (!name) throw new UserError('ผู้ลงนามยังไม่มีชื่อ กรุณาให้ admin ใส่ชื่อในหน้าจัดการผู้ใช้งาน');
    const col = req.slot === 1 ? 'signer2' : 'signer3';
    const existing = str(row[col]);
    if (existing) throw new UserError('ช่องนี้ลงนามไปแล้วโดย ' + existing);
    const other = str(row[req.slot === 1 ? 'signer3' : 'signer2']);
    if (other && other === name) throw new UserError('คุณลงนามอีกช่องของใบนี้ไปแล้ว — คนเดียวลงสองช่องไม่ได้');
    await client.query(
      `UPDATE site_supervisor_checklists SET ${col} = $2, ${col}_at = NOW() WHERE id = $1`,
      [row.id, name]);
    await logSign(client, row, { action: 'sign', slot: req.slot + 1, name, username: who.username || (who.via === 'pin' ? '(PIN)' : ''),
      method: 'single', viewed: !!req.viewed, confirmed: true, sessionUser: userName(ctx) });
    full = !!other;
  });
  return { ok: true, fullySigned: full };
}

// ลงนามหลายใบพร้อมกัน
// req = { items: [{ rowId, submittedAt, viewed }], confirm: true, pin? (สำรอง) }
// ระบบเลือกช่องให้ตามสิทธิ์ (GM/ธุรการ → ช่อง 2, GF/GE → ช่อง 3) ใบที่ลงไม่ได้จะข้ามพร้อมเหตุผล
async function CHECKLIST_signMany(req) {
  req = req || {};
  if (req.confirm !== true) throw new UserError('กรุณาติ๊กยืนยันว่าได้ตรวจสอบเช็คลิสต์ทุกใบที่เลือกแล้ว');
  const items = Array.isArray(req.items) ? req.items : [];
  if (!items.length) throw new UserError('ยังไม่ได้เลือกรายการ');
  if (items.length > 200) throw new UserError('เลือกได้ครั้งละไม่เกิน 200 ใบ');
  const sessionUser = userName(this);
  const who = await resolveSigner(sitePool, this, req);
  const name = who.name;
  if (!name) throw new UserError('ผู้ลงนามยังไม่มีชื่อ กรุณาให้ admin ใส่ชื่อในหน้าจัดการผู้ใช้งาน');
  const uname = who.username || (who.via === 'pin' ? '(PIN)' : '');

  const results = [];
  await withTx(async client => {
    for (const it of items) {
      const res = { rowId: str(it && it.rowId, 30) };
      try {
        const row = await lockRow(client, it.rowId, it.submittedAt);
        res.site = row.site_name;
        const pick = pickSlot(who.entries, row, name);
        if (!pick.slot) { res.skipped = pick.reason; results.push(res); continue; }
        const col = pick.slot === 1 ? 'signer2' : 'signer3';
        await client.query(`UPDATE site_supervisor_checklists SET ${col} = $2, ${col}_at = NOW() WHERE id = $1`, [row.id, name]);
        await logSign(client, row, { action: 'sign', slot: pick.slot + 1, name, username: uname,
          method: 'bulk', viewed: !!(it && it.viewed), confirmed: true, sessionUser });
        res.signedSlot = pick.slot + 1;
        res.fullySigned = !!str(row[pick.slot === 1 ? 'signer3' : 'signer2']);
      } catch (e) {
        if (!(e instanceof UserError)) throw e;
        res.skipped = e.message;
      }
      results.push(res);
    }
  });
  return { name, signed: results.filter(r => r.signedSlot).length, results };
}

// สิทธิ์ของบัญชีที่ login อยู่ — หน้าเว็บใช้ซ่อน/แสดงปุ่มลงนาม/แก้ไข (server ตรวจซ้ำทุกครั้ง)
async function CHECKLIST_myRights() {
  const rows = await sessionEntries(sitePool, this);
  return {
    name: rows.length ? str(rows[0].label, 100) : '',
    rights: rows.map(r => ({ role: r.role, siteCode: r.site_code || '' })),
    // admin ไม่มีสิทธิ์ลงนามในบัญชีก็ยังใช้รหัส PIN สำรองได้
    pinFallback: !!(this && this.user && this.user.role === 'admin')
  };
}

async function CHECKLIST_checkEditPin(req) {
  req = req || {};
  const ctx = this;
  let who;
  await withTx(async client => {
    const row = await lockRow(client, req.rowId, req.submittedAt);
    who = await assertCanEdit(client, ctx, row.site_name, req);
  });
  return { ok: true, name: who.name };
}

async function CHECKLIST_updateSubmission(req) {
  if (!req || !req.payload || typeof req.payload !== 'object') throw new UserError('ข้อมูลไม่ถูกต้อง');
  const removed = [];

  await withTx(async client => {
    const row = await lockRow(client, req.rowId, req.submittedAt);
    const who = await assertCanEdit(client, this, row.site_name, req);
    if (str(row.signer2) || str(row.signer3)) {
      await logSign(client, row, { action: 'cleared', name: who.name || '', username: who.username || (who.via === 'pin' ? '(PIN)' : ''),
        method: 'edit', sessionUser: userName(this) });
      await client.query(
        `UPDATE checklist_pdf_archive SET superseded_at = NOW(), superseded_reason = 'รายการถูกแก้ไขหลังลงนาม'
          WHERE checklist_id = $1 AND superseded_at IS NULL`, [row.id]);
    }

    const payload = req.payload;
    payload.site = row.site_name; // ล็อกโครงการเดิม ห้ามเปลี่ยน
    validatePayload(payload);
    const signers = payload.signers || [];

    // รูปเดิมของรายการนี้เท่านั้นที่เก็บไว้ได้ (กันส่งลิงก์แปลกปลอมเข้ามา)
    const oldUrls = (await client.query('SELECT url FROM checklist_photos WHERE checklist_id = $1', [row.id]))
      .rows.map(r => r.url);
    const keep = new Set(oldUrls);

    await assertBuildingFloor(client, row.site_name, payload.building, payload.floor);
    await client.query('DELETE FROM checklist_items WHERE checklist_id = $1', [row.id]);
    await client.query('DELETE FROM checklist_photos WHERE checklist_id = $1', [row.id]);
    await client.query(
      `UPDATE site_supervisor_checklists
          SET inspection_date = $2, lang = $3, recorded_by = $4, signer1 = $5,
              signer2 = '', signer3 = '', signer2_at = NULL, signer3_at = NULL,
              edited_at = NOW(), edited_by = $6, building = $7, floor = $8
        WHERE id = $1`,
      [row.id, str(payload.date), str(payload.lang, 5) || 'th', str(payload.recordedBy, 100), str(signers[0], 100),
        who.name || userName(this), str(payload.building, 100), str(payload.floor, 50)]);
    await writeItems(client, row.id, payload.items || {}, keep);

    const still = new Set((await client.query('SELECT url FROM checklist_photos WHERE checklist_id = $1', [row.id]))
      .rows.map(r => r.url));
    oldUrls.forEach(u => { if (!still.has(u)) removed.push(u); });
  });

  removed.forEach(removePhotoFile); // ลบไฟล์รูปที่ผู้ใช้กดลบ หลังบันทึกสำเร็จแล้วเท่านั้น
  return { ok: true };
}

function userName(ctx) { return (ctx && ctx.user && (ctx.user.username || ctx.user.full_name)) || ''; }

// ตั้งค่าบัญชีและสิทธิ์ลงนาม อยู่ที่หน้า /users (services/users_admin.js)

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

async function archivePdf(row, filePath, hash, by) {
  await sitePool.query(
    `INSERT INTO checklist_pdf_archive (checklist_id, site_name, inspection_date, recorded_by, signer2, signer3,
                                        signer2_at, signer3_at, file_path, content_hash, created_by, building, floor)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13) ON CONFLICT (checklist_id, content_hash) DO NOTHING`,
    [row.id, row.site_name, row.inspection_date, row.recorded_by, row.signer2, row.signer3,
      row.signer2_at, row.signer3_at, filePath, hash, by || '', row.building || '', row.floor || '']);
}

async function CHECKLIST_getPrintPdf(req) {
  if (!req || !req.html) throw new UserError('ไม่มีข้อมูลสำหรับสร้าง PDF');
  let body = String(req.html)
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/\son\w+="[^"]*"/gi, '');
  if (body.length > 3000000) throw new UserError('ข้อมูลใหญ่เกินไป');

  const id = parseRowId(req.rowId);
  const row = (await sitePool.query(
    `SELECT id, site_name, TO_CHAR(inspection_date, 'DD-MM-YYYY') AS d, inspection_date, pdf_path, pdf_hash,
            recorded_by, signer2, signer3, signer2_at, signer3_at, building, floor
       FROM site_supervisor_checklists WHERE id = $1`, [id])).rows[0];
  if (!row) throw new UserError('ไม่พบรายการนี้ กรุณารีเฟรชแดชบอร์ด');
  // ลงนามครบทั้ง 2 ช่อง (ตรวจจากฐานข้อมูล) → เก็บเข้าคลัง ไม่ลบทับ
  const signed = !!(str(row.signer2) && str(row.signer3));

  // ถ้าเนื้อหาเหมือนเดิม ใช้ไฟล์เดิมซ้ำ
  const hash = crypto.createHash('md5').update(body).digest('hex');
  if (row.pdf_hash === hash && row.pdf_path && fs.existsSync(path.join(PUBLIC_DIR, row.pdf_path))) {
    if (signed) await archivePdf(row, row.pdf_path, hash, userName(this));
    return { url: encodeURI(row.pdf_path), archived: signed };
  }

  const inl = await inlineImages(body);
  const full = '<!doctype html><html><head><meta charset="UTF-8"><style>' + getFontCss() + PDF_CSS +
    '</style></head><body>' + inl.html + '</body></html>';

  const pdf = await htmlToPdf(full, { format: 'A4' });

  const safe = s => String(s).replace(/[\\/:*?"<>|#%&{}$!'@+`=]/g, '').replace(/\s+/g, ' ').trim();
  // ฉบับที่ลงนามครบตั้งชื่อตามเวลา (ไม่ทับฉบับเก่า)
  const stamp = signed ? '_ลงนาม_' + new Date().toISOString().replace(/\D/g, '').slice(0, 14) : '';
  const where = row.building ? `_${safe(row.building)}_ชั้น${safe(row.floor)}` : '';
  const fileName = `เช็คลิสต์_${safe(row.site_name || 'ไม่ระบุหน่วยงาน')}${where}_${safe(row.d || 'ไม่ระบุวันที่')}_${row.id}${stamp}.pdf`;
  fs.mkdirSync(PDF_DIR, { recursive: true });
  await fs.promises.writeFile(path.join(PDF_DIR, fileName), pdf);
  const rel = '/uploads/checklist-pdf/' + fileName;

  // ฉบับที่ยังไม่ลงนามครบ เก็บไว้แค่ฉบับล่าสุด · ฉบับที่อยู่ในคลังไม่ลบ
  if (row.pdf_path && row.pdf_path !== rel) {
    const inArchive = (await sitePool.query('SELECT 1 FROM checklist_pdf_archive WHERE file_path = $1', [row.pdf_path])).rows.length;
    if (!inArchive) fs.promises.unlink(path.join(PUBLIC_DIR, row.pdf_path)).catch(() => {});
  }
  if (signed && !inl.failed) await archivePdf(row, rel, hash, userName(this));
  // ถ้ารูปขาด ไม่จำไว้ใช้ซ้ำ ครั้งหน้าจะลองดึงรูปใหม่
  await sitePool.query('UPDATE site_supervisor_checklists SET pdf_path = $2, pdf_hash = $3 WHERE id = $1',
    [row.id, rel, inl.failed ? null : hash]);
  return { url: encodeURI(rel), archived: signed && !inl.failed };
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
    CHECKLIST_signMany,
    CHECKLIST_myRights,
    CHECKLIST_buildings
  }
};
