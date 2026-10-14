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

class UserError extends Error {}

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

async function withTx(fn) {
  const client = await sitePool.connect();
  try {
    await client.query('BEGIN');
    const out = await fn(client);
    await client.query('COMMIT');
    return out;
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
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
async function expectedPinHashes(client, slot, siteCode) {
  let rows;
  if (slot === 2) {
    rows = (await client.query("SELECT pin_hash FROM checklist_pins WHERE role = 'GF'")).rows;
  } else {
    rows = siteCode
      ? (await client.query("SELECT pin_hash FROM checklist_pins WHERE role = 'GM' AND site_code = $1", [siteCode])).rows
      : [];
    if (!rows.length) {
      rows = (await client.query("SELECT pin_hash FROM checklist_pins WHERE role = 'GM' AND site_code IS NULL")).rows;
    }
  }
  const master = (await client.query("SELECT pin_hash FROM checklist_pins WHERE role = 'MASTER'")).rows;
  return rows.concat(master).map(r => r.pin_hash);
}

async function assertPin(client, { slot, siteCode, pin, failKey, notSetMsg, wrongMsg }) {
  const hashes = await expectedPinHashes(client, slot, siteCode);
  if (!hashes.length) throw new UserError(notSetMsg);

  const f = (await client.query(
    `SELECT fails, locked_until > NOW() AS locked,
            updated_at < NOW() - make_interval(mins => $2) AS stale
       FROM checklist_pin_failures WHERE fail_key = $1`, [failKey, LOCK_MINUTES])).rows[0];
  if (f && f.locked) {
    throw new UserError(`ใส่รหัสผิดหลายครั้ง ระบบล็อกชั่วคราว กรุณาลองใหม่ใน ${LOCK_MINUTES} นาที`);
  }

  const given = str(pin, 50);
  let match = false;
  if (given) {
    for (const h of hashes) {
      if (await bcrypt.compare(given, h)) { match = true; break; }
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
}

function assertEditPin(client, site, pin) {
  const siteCode = siteCodeOf(site);
  return assertPin(client, {
    slot: 1, siteCode, pin,
    failKey: 'edit_' + siteCode,
    notSetMsg: 'ยังไม่ได้ตั้งรหัสสำหรับโครงการนี้ กรุณาติดต่อผู้ดูแลระบบ',
    wrongMsg: 'รหัสไม่ถูกต้อง'
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
  const name = str(req.name, 100);
  if (!name) throw new UserError('กรุณาพิมพ์ชื่อผู้ลงนาม');

  await withTx(async client => {
    const row = await lockRow(client, req.rowId, req.submittedAt);
    // อ่านโครงการจาก database เสมอ (ไม่เชื่อค่าจากหน้าเว็บ)
    const siteCode = siteCodeOf(row.site_name);
    await assertPin(client, {
      slot: req.slot, siteCode, pin: req.pin,
      failKey: 'sign' + req.slot + (req.slot === 1 ? '_' + siteCode : ''),
      notSetMsg: 'ยังไม่ได้ตั้งรหัสลงนามสำหรับโครงการนี้ กรุณาติดต่อผู้ดูแลระบบ',
      wrongMsg: 'รหัสลงนามไม่ถูกต้อง'
    });
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
  await withTx(async client => {
    const row = await lockRow(client, req.rowId, req.submittedAt);
    await assertEditPin(client, row.site_name, req.pin);
  });
  return { ok: true };
}

async function CHECKLIST_updateSubmission(req) {
  if (!req || !req.payload || typeof req.payload !== 'object') throw new UserError('ข้อมูลไม่ถูกต้อง');
  const removed = [];

  await withTx(async client => {
    const row = await lockRow(client, req.rowId, req.submittedAt);
    await assertEditPin(client, row.site_name, req.pin);

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
              edited_at = NOW()
        WHERE id = $1`,
      [row.id, str(payload.date), str(payload.lang, 5) || 'th', str(payload.recordedBy, 100), str(signers[0], 100)]);
    await writeItems(client, row.id, payload.items || {}, keep);

    const still = new Set((await client.query('SELECT url FROM checklist_photos WHERE checklist_id = $1', [row.id]))
      .rows.map(r => r.url));
    oldUrls.forEach(u => { if (!still.has(u)) removed.push(u); });
  });

  removed.forEach(removePhotoFile); // ลบไฟล์รูปที่ผู้ใช้กดลบ หลังบันทึกสำเร็จแล้วเท่านั้น
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

let browserPromise = null;
function getBrowser() {
  if (!browserPromise) {
    const puppeteer = require('puppeteer');
    browserPromise = puppeteer.launch({
      headless: true,
      executablePath: process.env.PUPPETEER_EXECUTABLE_PATH || undefined,
      args: ['--no-sandbox', '--disable-dev-shm-usage']
    }).catch(err => { browserPromise = null; throw err; });
  }
  return browserPromise;
}

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

  const browser = await getBrowser();
  const page = await browser.newPage();
  let pdf;
  try {
    await page.setJavaScriptEnabled(false);
    await page.setContent(full, { waitUntil: 'load', timeout: 60000 });
    pdf = await page.pdf({ format: 'A4', printBackground: true, preferCSSPageSize: true });
  } finally {
    await page.close().catch(() => {});
  }

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
    CHECKLIST_getPrintPdf
  }
};
