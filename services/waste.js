// ============================================================
// ระบบติดตามขยะภายในไซต์ + รายงาน NPO — ตรรกะฝั่ง server
//
// ส่วนหน้างาน (ชื่อ/อินพุต/คำตอบ เหมือน Code.gs ของ hub เดิม เพื่อให้ public/waste.html ใช้ได้ทันที)
//   WASTE_getProjects()            รายชื่อโครงการ
//   WASTE_saveNewProject(name)     เพิ่มโครงการ
//   WASTE_saveData(data)           บันทึก 1 เที่ยว (รูป 3 รูป)
//   WASTE_getDashboardData()       ข้อมูลแดชบอร์ด (key เป็นหัวคอลัมน์ภาษาไทยเดิม)
//   WASTE_listRecords({project, q})  รายการสำหรับแก้ไข (ล่าสุด 200 รายการ)
//   WASTE_getRecord(id)            ข้อมูล 1 รายการสำหรับเปิดในฟอร์ม
//   WASTE_updateRecord(id, data)   แก้ไข (รูปที่ไม่ได้เปลี่ยนใช้รูปเดิม) — เที่ยวที่ออก NPO แล้วแก้ไม่ได้
//   WASTE_deleteRecord(id)         ลบ — เที่ยวที่ออก NPO แล้วลบไม่ได้
//
// ส่วนธุรการออก NPO (ใหม่ ใช้กับ public/npo.html)
//   WASTE_npoOptions()                         โครงการ + ประเภทรถ
//   WASTE_npoPending(projectId, truckType)     เที่ยวที่ยังไม่เคยออก NPO
//   WASTE_npoPreview(projectId, truckType, n)  ดูก่อนออก (ไม่บันทึก)
//   WASTE_npoCreate({projectId, truckType, npoNo, trips})  ออก NPO + PDF
//   WASTE_npoList(projectId)                   NPO ที่เคยออก
//   WASTE_npoCancel({npoId, reason})           ยกเลิก NPO (เที่ยวกลับเป็นยังไม่ออก)
//   WASTE_npoPdf(npoId)                        ลิงก์ PDF (สร้างใหม่ถ้าไฟล์หาย)
// ============================================================
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { sitePool } = require('../db');
const { UserError, withTx, htmlToPdf } = require('./common');

const PUBLIC_DIR = path.join(__dirname, '..', 'public');
const PHOTO_DIR = path.join(PUBLIC_DIR, 'uploads', 'waste');
const NPO_DIR = path.join(PUBLIC_DIR, 'uploads', 'npo');
const MIME_EXT = { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp' };
const TH_MONTHS = ['มกราคม', 'กุมภาพันธ์', 'มีนาคม', 'เมษายน', 'พฤษภาคม', 'มิถุนายน',
  'กรกฎาคม', 'สิงหาคม', 'กันยายน', 'ตุลาคม', 'พฤศจิกายน', 'ธันวาคม'];

const str = (v, max) => String(v == null ? '' : v).trim().slice(0, max || 500);
const num = v => { const n = Number(v); return isFinite(n) ? n : 0; };

// ---------- helpers ----------
function parseDate(raw) {
  const s = str(raw);
  let m = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  if (m) return `${m[3]}-${m[2].padStart(2, '0')}-${m[1].padStart(2, '0')}`;
  m = s.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (m) return s;
  return null;
}

function savePhotoFile(dataUrl, tag) {
  const m = String(dataUrl || '').match(/^data:(image\/[a-z]+);base64,(.+)$/);
  if (!m || !MIME_EXT[m[1]]) throw new Error('รูปไม่ถูกต้อง');
  const buf = Buffer.from(m[2], 'base64');
  if (!buf.length || buf.length > 8 * 1024 * 1024) throw new Error('ขนาดรูปไม่ถูกต้อง');
  const month = new Date().toISOString().slice(0, 7);
  const dir = path.join(PHOTO_DIR, month);
  fs.mkdirSync(dir, { recursive: true });
  const name = `${Date.now()}_${tag}_${crypto.randomBytes(4).toString('hex')}.${MIME_EXT[m[1]]}`;
  fs.writeFileSync(path.join(dir, name), buf);
  return `/uploads/waste/${month}/${name}`;
}

async function truckInfo(client, name) {
  const r = await client.query('SELECT volume_m3, cost_per_trip FROM truck_types WHERE name = $1 AND active', [name]);
  return r.rows[0] || null;
}

function projectCode(name, id) {
  const m = String(name || '').match(/\(([A-Za-z0-9]+)\)\s*$/);
  return m ? m[1].toUpperCase() : 'P' + id;
}

// "วันที่ 2 มกราคม - 24 มีนาคม 2569" (ปี พ.ศ., ข้ามปีใส่ปีทั้งสองฝั่ง)
function thaiRange(from, to) {
  const a = new Date(from + 'T00:00:00Z'), b = new Date(to + 'T00:00:00Z');
  const d = x => `${x.getUTCDate()} ${TH_MONTHS[x.getUTCMonth()]}`;
  const y = x => x.getUTCFullYear() + 543;
  if (from === to) return `วันที่ ${d(a)} ${y(a)}`;
  if (y(a) === y(b)) return `วันที่ ${d(a)} - ${d(b)} ${y(b)}`;
  return `วันที่ ${d(a)} ${y(a)} - ${d(b)} ${y(b)}`;
}

// หา id โครงการจากชื่อ ถ้าไม่มีให้สร้าง (ไม่พึ่ง UNIQUE บนคอลัมน์ name เพราะตารางเดิมอาจไม่มี)
async function ensureProject(client, name) {
  await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', ['project_' + name]);
  const f = await client.query('SELECT id FROM projects WHERE name = $1 ORDER BY id LIMIT 1', [name]);
  if (f.rows.length) return f.rows[0].id;
  return (await client.query('INSERT INTO projects (name) VALUES ($1) RETURNING id', [name])).rows[0].id;
}

const esc = s => String(s == null ? '' : s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

// ============================================================
// ส่วนหน้างาน
// ============================================================

async function WASTE_getProjects() {
  const r = await sitePool.query('SELECT name FROM projects ORDER BY id');
  return r.rows.map(x => x.name).filter(Boolean);
}

async function WASTE_saveNewProject(projectName) {
  const name = str(projectName, 200);
  if (!name) throw new UserError('กรุณากรอกชื่อโครงการ');
  await withTx(client => ensureProject(client, name));
  return true;
}

function userName(ctx) { return (ctx && ctx.user && (ctx.user.username || ctx.user.full_name)) || ''; }

// ตรวจข้อมูลฟอร์ม คืนข้อความผิด หรือ null ถ้าผ่าน (photos = รูปที่มีอยู่แล้วตอนแก้ไข)
function validateForm(data, photos) {
  if (!data || !str(data.project)) return 'กรุณาระบุโครงการ';
  const REQUIRED = [
    ['location', 'ชั้น / โซน'], ['timeIn', 'เวลาเข้า'], ['time', 'เวลารถออก'],
    ['recorder', 'ผู้บันทึกข้อมูล'], ['billNo', 'เลขที่บิล'], ['plateNo', 'เลขทะเบียนรถ'],
    ['truck', 'ประเภทรถ']
  ];
  const missing = REQUIRED.filter(f => !str(data[f[0]])).map(f => f[1]);
  const has = i => data['photo' + i] || (photos && photos[i - 1]);
  if (!has(1)) missing.push('รูปหน้ารถ (ตอนเข้าไซต์ให้เห็นป้ายทะเบียน)');
  if (!has(2)) missing.push('รูปขยะบนรถ (ภาพมุมสูง)');
  if (!has(3)) missing.push('รูปก่อนคลุมผ้า (ให้เห็นปริมาณขยะก่อนคลุมผ้า)');
  if (missing.length) return 'กรุณากรอกให้ครบ: ' + missing.join(', ');
  const sum = num(data.wasteConcrete) + num(data.wasteConstruction) + num(data.wastePacking) + num(data.wasteSystem);
  if (sum !== 100) return 'สัดส่วนขยะต้องรวมเป็น 100% (ปัจจุบัน ' + sum + '%)';
  if (!parseDate(data.date)) return 'กรุณากรอกวันที่ให้ถูกต้อง (วว/ดด/ปปปป)';
  return null;
}

async function WASTE_saveData(data) {
  const bad = validateForm(data);
  if (bad) return { success: false, message: bad };
  const date = parseDate(data.date);
  const by = userName(this);

  return withTx(async client => {
    const truck = await truckInfo(client, str(data.truck));
    if (!truck) return { success: false, message: 'ประเภทรถไม่ถูกต้อง: ' + str(data.truck) };

    const projectId = await ensureProject(client, str(data.project, 200));

    // กันบันทึกซ้ำ: โครงการ + เลขบิล + ทะเบียน ซ้ำกับที่มีอยู่ (ล็อกตามโครงการกันกดซ้ำพร้อมกัน)
    await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', ['waste_' + projectId]);
    const dup = await client.query(
      'SELECT 1 FROM waste_records WHERE project_id = $1 AND bill_no = $2 AND plate_no = $3 LIMIT 1',
      [projectId, str(data.billNo, 50), str(data.plateNo, 50)]);
    if (dup.rows.length) return { success: true, duplicatePrevented: true };

    const urls = [data.photo1, data.photo2, data.photo3].map((d, i) => {
      try { return savePhotoFile(d, ['front', 'waste', 'canvas'][i]); }
      catch (e) { console.warn('[waste] บันทึกรูปไม่สำเร็จ:', e.message); return null; }
    });

    await client.query(
      `INSERT INTO waste_records (
         project_id, record_date, floor_zone, time_in, time_out, bill_no, plate_no, recorder,
         trips, truck_type, waste_concrete, waste_construction, waste_packing, waste_system,
         volume_m3, cost, photo_front_url, photo_waste_url, photo_canvas_url, note, created_at, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,1,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,NOW(),$20)`,
      [projectId, date, str(data.location, 100), str(data.timeIn, 10), str(data.time, 10),
        str(data.billNo, 50), str(data.plateNo, 50), str(data.recorder, 100), str(data.truck),
        num(data.wasteConcrete), num(data.wasteConstruction), num(data.wastePacking), num(data.wasteSystem),
        truck.volume_m3, truck.cost_per_trip, urls[0], urls[1], urls[2], str(data.note, 1000), by]);
    return { success: true };
  });
}

// ---------- แก้ไข / ลบ ----------
const RECORD_SELECT = `
  SELECT w.id, p.name AS project, TO_CHAR(w.record_date, 'DD/MM/YYYY') AS date, w.floor_zone AS location,
         w.time_in AS "timeIn", w.time_out AS time, w.bill_no AS "billNo", w.plate_no AS "plateNo",
         w.recorder, w.truck_type AS truck, w.waste_concrete::float AS "wasteConcrete",
         w.waste_construction::float AS "wasteConstruction", w.waste_packing::float AS "wastePacking",
         w.waste_system::float AS "wasteSystem", w.note, w.cost::float AS cost,
         w.photo_front_url AS "photo1Url", w.photo_waste_url AS "photo2Url", w.photo_canvas_url AS "photo3Url",
         n.npo_no AS "npoNo", COALESCE(w.updated_by, '') AS "updatedBy",
         COALESCE(TO_CHAR(w.updated_at AT TIME ZONE 'Asia/Bangkok', 'DD/MM/YYYY HH24:MI'), '') AS "updatedAt"
    FROM waste_records w
    LEFT JOIN projects p ON p.id = w.project_id
    LEFT JOIN npo_reports n ON n.id = w.npo_id`;

async function WASTE_listRecords(opts) {
  const o = opts || {};
  const params = [];
  const where = [];
  if (str(o.project)) { params.push(str(o.project, 200)); where.push(`p.name = $${params.length}`); }
  if (str(o.q)) {
    params.push('%' + str(o.q, 50).toLowerCase() + '%');
    where.push(`(LOWER(w.bill_no) LIKE $${params.length} OR LOWER(w.plate_no) LIKE $${params.length} OR LOWER(w.recorder) LIKE $${params.length})`);
  }
  const r = await sitePool.query(
    `${RECORD_SELECT} ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
      ORDER BY w.record_date DESC, w.time_in DESC, w.id DESC LIMIT 200`, params);
  return r.rows;
}

async function WASTE_getRecord(id) {
  const r = await sitePool.query(`${RECORD_SELECT} WHERE w.id = $1`, [Number(id) || 0]);
  if (!r.rows.length) throw new UserError('ไม่พบรายการนี้ (อาจถูกลบไปแล้ว)');
  return r.rows[0];
}

// ล็อกแถว + ตรวจว่าแก้/ลบได้ คืนค่าแถวเดิม
async function lockEditable(client, id, verb) {
  const r = await client.query(
    `SELECT w.*, n.npo_no FROM waste_records w LEFT JOIN npo_reports n ON n.id = w.npo_id WHERE w.id = $1 FOR UPDATE OF w`, [id]);
  if (!r.rows.length) throw new UserError('ไม่พบรายการนี้ (อาจถูกลบไปแล้ว)');
  const row = r.rows[0];
  if (row.npo_id) throw new UserError(`เที่ยวนี้ออกใบ NPO ${row.npo_no || ''} แล้ว ${verb}ไม่ได้ — ต้องยกเลิกใบ NPO ก่อน`);
  return row;
}

async function WASTE_updateRecord(id, data) {
  const rid = Number(id) || 0;
  const by = userName(this);
  return withTx(async client => {
    const old = await lockEditable(client, rid, 'แก้ไข');
    const keep = [old.photo_front_url, old.photo_waste_url, old.photo_canvas_url];
    const bad = validateForm(data, keep);
    if (bad) throw new UserError(bad);
    const truck = await truckInfo(client, str(data.truck));
    if (!truck) throw new UserError('ประเภทรถไม่ถูกต้อง: ' + str(data.truck));
    const projectId = await ensureProject(client, str(data.project, 200));
    await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', ['waste_' + projectId]);
    const dup = await client.query(
      'SELECT 1 FROM waste_records WHERE project_id = $1 AND bill_no = $2 AND plate_no = $3 AND id <> $4 LIMIT 1',
      [projectId, str(data.billNo, 50), str(data.plateNo, 50), rid]);
    if (dup.rows.length) throw new UserError('เลขที่บิล + ทะเบียนรถ นี้มีอยู่แล้วในโครงการนี้');

    const urls = [1, 2, 3].map(i => {
      const d = data['photo' + i];
      if (!d) return keep[i - 1];
      try { return savePhotoFile(d, ['front', 'waste', 'canvas'][i - 1]); }
      catch (e) { throw new UserError('รูปที่ ' + i + ' ไม่ถูกต้อง'); }
    });
    await client.query(
      'INSERT INTO waste_record_history (record_id, action, old_data, changed_by) VALUES ($1, $2, $3, $4)',
      [rid, 'update', JSON.stringify(old), by]);
    await client.query(
      `UPDATE waste_records SET project_id=$1, record_date=$2, floor_zone=$3, time_in=$4, time_out=$5, bill_no=$6,
         plate_no=$7, recorder=$8, truck_type=$9, waste_concrete=$10, waste_construction=$11, waste_packing=$12,
         waste_system=$13, volume_m3=$14, cost=$15, photo_front_url=$16, photo_waste_url=$17, photo_canvas_url=$18,
         note=$19, updated_at=NOW(), updated_by=$20
       WHERE id = $21`,
      [projectId, parseDate(data.date), str(data.location, 100), str(data.timeIn, 10), str(data.time, 10),
        str(data.billNo, 50), str(data.plateNo, 50), str(data.recorder, 100), str(data.truck),
        num(data.wasteConcrete), num(data.wasteConstruction), num(data.wastePacking), num(data.wasteSystem),
        truck.volume_m3, truck.cost_per_trip, urls[0], urls[1], urls[2], str(data.note, 1000), by, rid]);
    return { success: true };
  });
}

async function WASTE_deleteRecord(id) {
  const rid = Number(id) || 0;
  const by = userName(this);
  return withTx(async client => {
    const old = await lockEditable(client, rid, 'ลบ');
    await client.query(
      'INSERT INTO waste_record_history (record_id, action, old_data, changed_by) VALUES ($1, $2, $3, $4)',
      [rid, 'delete', JSON.stringify(old), by]);
    await client.query('DELETE FROM waste_records WHERE id = $1', [rid]);
    return { success: true };
  });
}

async function WASTE_getDashboardData() {
  const r = await sitePool.query(`
    SELECT p.name AS "โครงการ",
           TO_CHAR(w.record_date, 'DD/MM/YYYY') AS "วันที่",
           w.floor_zone AS "ชั้น/โซน",
           COALESCE(NULLIF(w.time_in, ''), '-') AS "เวลาเข้า",
           COALESCE(NULLIF(w.time_out, ''), '-') AS "เวลารถออก",
           w.bill_no AS "เลขที่บิล",
           w.plate_no AS "เลขทะเบียนรถ",
           w.recorder AS "ผู้บันทึก",
           w.trips AS "จำนวนเที่ยว",
           w.truck_type AS "ประเภทรถ",
           w.waste_concrete::float AS "% เศษคอนกรีต-ปูน",
           w.waste_construction::float AS "% เศษวัสดุก่อสร้าง",
           w.waste_packing::float AS "% เศษวัสดุ Packing",
           w.waste_system::float AS "% เศษวัสดุงานระบบ",
           w.volume_m3::float AS "ปริมาณขยะ (คิว)",
           w.note AS "หมายเหตุ",
           w.cost::float AS "ค่าใช้จ่ายรวม (บาท)"
      FROM waste_records w
      LEFT JOIN projects p ON p.id = w.project_id
     ORDER BY w.record_date, w.time_in, w.id`);
  return { rows: r.rows };
}

// ============================================================
// ส่วน NPO
// ============================================================

async function WASTE_npoOptions() {
  const p = await sitePool.query(`
    SELECT p.id, p.name, COUNT(w.id) FILTER (WHERE w.npo_id IS NULL)::int AS pending
      FROM projects p LEFT JOIN waste_records w ON w.project_id = p.id
     GROUP BY p.id ORDER BY p.id`);
  const t = await sitePool.query('SELECT name FROM truck_types WHERE active ORDER BY sort_order, name');
  return { projects: p.rows, trucks: t.rows.map(x => x.name) };
}

async function pendingRows(client, projectId, truckType, limit, forUpdate) {
  return (await client.query(
    `SELECT id, TO_CHAR(record_date, 'YYYY-MM-DD') AS d, TO_CHAR(record_date, 'DD/MM/YYYY') AS date,
            time_in, time_out, bill_no, plate_no, cost::float AS cost, trips
       FROM waste_records
      WHERE project_id = $1 AND truck_type = $2 AND npo_id IS NULL
      ORDER BY record_date, time_in, id
      LIMIT $3 ${forUpdate ? 'FOR UPDATE SKIP LOCKED' : ''}`,
    [projectId, truckType, limit])).rows;
}

async function nextSeq(client, projectId, truckType) {
  const r = await client.query(
    `SELECT COALESCE(SUM(trip_count), 0)::int + 1 AS n FROM npo_reports
      WHERE project_id = $1 AND truck_type = $2 AND status = 'issued'`, [projectId, truckType]);
  return r.rows[0].n;
}

function checkArgs(projectId, truckType) {
  if (!(Number(projectId) > 0)) throw new UserError('กรุณาเลือกโครงการ');
  if (!str(truckType)) throw new UserError('กรุณาเลือกประเภทรถ');
}

async function WASTE_npoPending(projectId, truckType) {
  checkArgs(projectId, truckType);
  const r = await sitePool.query(
    `SELECT COUNT(*)::int AS n, TO_CHAR(MIN(record_date), 'DD/MM/YYYY') AS oldest
       FROM waste_records WHERE project_id = $1 AND truck_type = $2 AND npo_id IS NULL`,
    [Number(projectId), str(truckType)]);
  return { pendingCount: r.rows[0].n, oldestDate: r.rows[0].oldest || '', nextSeq: await nextSeq(sitePool, Number(projectId), str(truckType)) };
}

async function WASTE_npoPreview(projectId, truckType, trips) {
  checkArgs(projectId, truckType);
  const n = Math.max(1, Math.min(500, parseInt(trips, 10) || 50));
  const rows = await pendingRows(sitePool, Number(projectId), str(truckType), n, false);
  if (!rows.length) throw new UserError('ไม่มีเที่ยวที่ยังไม่ได้ออก NPO สำหรับโครงการและประเภทรถนี้');
  const seq = await nextSeq(sitePool, Number(projectId), str(truckType));
  return {
    dateFrom: rows[0].date, dateTo: rows[rows.length - 1].date,
    dateText: thaiRange(rows[0].d, rows[rows.length - 1].d),
    totalTrips: rows.reduce((s, r) => s + (r.trips || 1), 0),
    totalCost: rows.reduce((s, r) => s + r.cost, 0),
    seqStart: seq,
    rows: rows.map((r, i) => ({ seq: seq + i, date: r.date, timeIn: r.time_in || '-', timeOut: r.time_out || '-',
      bill: r.bill_no, plate: r.plate_no, cost: r.cost }))
  };
}

async function WASTE_npoCreate(req) {
  req = req || {};
  const projectId = Number(req.projectId), truckType = str(req.truckType);
  checkArgs(projectId, truckType);
  const npoNo = str(req.npoNo, 30);
  if (!npoNo) throw new UserError('กรุณากรอกเลข NPO');
  const n = Math.max(1, Math.min(500, parseInt(req.trips, 10) || 50));
  const user = (this && this.user && (this.user.username || this.user.full_name)) || '';

  try {
    return await withTx(async client => {
      await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', ['npo_' + projectId + '_' + truckType]);
      const used = await client.query("SELECT 1 FROM npo_reports WHERE npo_no = $1 AND status = 'issued'", [npoNo]);
      if (used.rows.length) throw new UserError('เลข NPO ' + npoNo + ' ถูกใช้แล้ว');

      const rows = await pendingRows(client, projectId, truckType, n, true);
      if (!rows.length) throw new UserError('ไม่มีเที่ยวที่ยังไม่ได้ออก NPO สำหรับโครงการและประเภทรถนี้');
      const seq = await nextSeq(client, projectId, truckType);
      const r = await client.query(
        `INSERT INTO npo_reports (project_id, truck_type, npo_no, date_from, date_to, trip_count, total_cost, seq_start, created_by)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING id`,
        [projectId, truckType, npoNo, rows[0].d, rows[rows.length - 1].d,
          rows.reduce((s, x) => s + (x.trips || 1), 0), rows.reduce((s, x) => s + x.cost, 0), seq, user]);
      const npoId = r.rows[0].id;
      await client.query('UPDATE waste_records SET npo_id = $1 WHERE id = ANY($2)', [npoId, rows.map(x => x.id)]);

      // สร้าง PDF ใน transaction เดียวกัน — ถ้า PDF พัง ทุกอย่างถูกยกเลิก เที่ยวไม่หลุด (หลักเดิมของระบบ)
      const pdfUrl = await buildNpoPdf(client, npoId);
      return { npoId, pdfUrl };
    });
  } catch (err) {
    if (err && err.code === '23505') throw new UserError('เลข NPO ' + npoNo + ' ถูกใช้แล้ว');
    throw err;
  }
}

async function WASTE_npoList(projectId) {
  const r = await sitePool.query(
    `SELECT n.id, n.npo_no, n.truck_type, TO_CHAR(n.date_from,'DD/MM/YYYY') AS date_from,
            TO_CHAR(n.date_to,'DD/MM/YYYY') AS date_to, n.trip_count, n.total_cost::float AS total_cost,
            n.seq_start, n.status, n.cancel_reason, n.created_by,
            TO_CHAR(n.created_at AT TIME ZONE 'Asia/Bangkok','DD/MM/YYYY HH24:MI') AS created_at,
            p.name AS project
       FROM npo_reports n JOIN projects p ON p.id = n.project_id
      WHERE ($1::int IS NULL OR n.project_id = $1)
      ORDER BY n.created_at DESC, n.id DESC`, [Number(projectId) > 0 ? Number(projectId) : null]);
  return r.rows;
}

async function WASTE_npoCancel(req) {
  req = req || {};
  const id = Number(req.npoId);
  const reason = str(req.reason, 300);
  if (!reason) throw new UserError('กรุณาระบุเหตุผลที่ยกเลิก');
  let oldPdf = null;
  await withTx(async client => {
    const r = await client.query('SELECT status, pdf_path FROM npo_reports WHERE id = $1 FOR UPDATE', [id]);
    if (!r.rows.length) throw new UserError('ไม่พบ NPO นี้');
    if (r.rows[0].status !== 'issued') throw new UserError('NPO นี้ถูกยกเลิกไปแล้ว');
    oldPdf = r.rows[0].pdf_path;
    await client.query('UPDATE waste_records SET npo_id = NULL WHERE npo_id = $1', [id]);
    await client.query(
      `UPDATE npo_reports SET status = 'cancelled', cancel_reason = $2, cancelled_at = NOW(), pdf_path = NULL WHERE id = $1`,
      [id, reason]);
  });
  if (oldPdf) fs.promises.unlink(path.join(PUBLIC_DIR, oldPdf)).catch(() => {});
  return true;
}

async function WASTE_npoPdf(npoId) {
  const id = Number(npoId);
  const r = await sitePool.query('SELECT status, pdf_path FROM npo_reports WHERE id = $1', [id]);
  if (!r.rows.length) throw new UserError('ไม่พบ NPO นี้');
  if (r.rows[0].status !== 'issued') throw new UserError('NPO นี้ถูกยกเลิกแล้ว');
  const p = r.rows[0].pdf_path;
  if (p && fs.existsSync(path.join(PUBLIC_DIR, p))) return { url: encodeURI(p) };
  return { url: await buildNpoPdf(sitePool, id) };
}

// ---------- PDF ----------

// โหลดรูป แล้วย่อเป็น 800x600 (4:3) JPEG คุณภาพ 70 — คมพอสำหรับกรอบ 69 มม. และไฟล์ไม่ใหญ่
async function loadImage(url) {
  if (!url) return null;
  try {
    let buf;
    const u = String(url);
    const local = u.match(/^(?:https?:\/\/[^/]+)?(\/uploads\/[\w\-/.]+)$/);
    const drive = u.match(/drive\.google\.com\/.*[?&]id=([a-zA-Z0-9_-]+)/) || u.match(/\/d\/([a-zA-Z0-9_-]+)/);
    if (local) {
      const file = path.join(PUBLIC_DIR, local[1]);
      if (!file.startsWith(path.join(PUBLIC_DIR, 'uploads'))) return null;
      buf = await fs.promises.readFile(file);
    } else if (drive) {
      const res = await fetch(`https://drive.google.com/thumbnail?id=${drive[1]}&sz=w1600`);
      if (!res.ok) return null;
      buf = Buffer.from(await res.arrayBuffer());
    } else if (/^https?:\/\//.test(u)) {
      const res = await fetch(u);
      if (!res.ok) return null;
      buf = Buffer.from(await res.arrayBuffer());
    } else return null;
    const sharp = require('sharp');
    const out = await sharp(buf).rotate().resize(800, 600, { fit: 'cover' }).jpeg({ quality: 70 }).toBuffer();
    return 'data:image/jpeg;base64,' + out.toString('base64');
  } catch (e) {
    console.warn('[npo] โหลดรูปไม่ได้:', url, e.message);
    return null;
  }
}

let fontCss = null;
function getFontCss() {
  if (fontCss !== null) return fontCss;
  try {
    const dir = path.join(__dirname, '..', 'fonts');
    fontCss =
      `@font-face{font-family:"NpoThai";src:url(data:font/ttf;base64,${fs.readFileSync(path.join(dir, 'tahoma.ttf')).toString('base64')});font-weight:normal;}` +
      `@font-face{font-family:"NpoThai";src:url(data:font/ttf;base64,${fs.readFileSync(path.join(dir, 'tahomabd.ttf')).toString('base64')});font-weight:bold;}`;
  } catch (e) { fontCss = ''; }
  return fontCss;
}

// ความกว้างคอลัมน์ (มม.) คำนวณจากความกว้างคอลัมน์ของชีตรายงานเดิม (พิมพ์แบบ fit-to-width บน A4 แนวนอน)
const COLS_MM = [6.7, 12.5, 9.5, 9.5, 9.5, 13.8, 8.6, 10.4, 69.7, 69.7, 69.7]; // B กว้างขึ้นให้วันที่ไม่ถูกตัด
const ROW_MM = 52.3;

async function buildNpoPdf(client, npoId) {
  const h = (await client.query(
    `SELECT n.*, TO_CHAR(n.date_from,'YYYY-MM-DD') AS f, TO_CHAR(n.date_to,'YYYY-MM-DD') AS t, p.name AS project
       FROM npo_reports n JOIN projects p ON p.id = n.project_id WHERE n.id = $1`, [npoId])).rows[0];
  const rows = (await client.query(
    `SELECT TO_CHAR(record_date,'DD/MM/YYYY') AS date, time_in, time_out, bill_no, plate_no,
            cost::float AS cost, trips, photo_front_url, photo_waste_url, photo_canvas_url
       FROM waste_records WHERE npo_id = $1 ORDER BY record_date, time_in, id`, [npoId])).rows;

  // โหลดรูปทีละ 6 รูปพร้อมกัน
  const urls = rows.flatMap(r => [r.photo_front_url, r.photo_waste_url, r.photo_canvas_url]);
  const imgs = new Array(urls.length);
  for (let i = 0; i < urls.length; i += 6) {
    const part = await Promise.all(urls.slice(i, i + 6).map(loadImage));
    part.forEach((v, j) => { imgs[i + j] = v; });
  }

  const img = src => src ? `<img src="${src}">` : '<span class="noimg">ไม่มีรูป</span>';
  const fmt = n => Number.isInteger(n) ? String(n) : n.toFixed(2);
  const body = rows.map((r, i) => `
    <tr class="trip">
      <td>${h.seq_start + i}</td><td>${esc(r.date)}</td><td>${esc(r.time_in || '-')}</td><td>${esc(r.time_out || '-')}</td>
      <td>${esc(r.bill_no)}</td><td>${esc(r.plate_no)}</td><td>${fmt(r.cost)}</td><td>${r.trips || 1}</td>
      <td class="ph">${img(imgs[i * 3])}</td><td class="ph">${img(imgs[i * 3 + 1])}</td><td class="ph">${img(imgs[i * 3 + 2])}</td>
    </tr>`).join('');
  const totalCost = rows.reduce((s, r) => s + r.cost, 0);
  const totalTrips = rows.reduce((s, r) => s + (r.trips || 1), 0);

  const html = `<!doctype html><html><head><meta charset="utf-8"><style>
    ${getFontCss()}
    @page { size: A4 landscape; margin: 3.8mm; }
    * { box-sizing: border-box; -webkit-print-color-adjust: exact; print-color-adjust: exact; }
    body { margin: 0; font-family: "NpoThai", Tahoma, sans-serif; font-size: 7pt; color: #000; }
    table { width: ${COLS_MM.reduce((a, b) => a + b, 0)}mm; border-collapse: collapse; table-layout: fixed; }
    td, th { border: 0.6pt solid #000; text-align: center; vertical-align: middle; padding: 0 1mm; overflow: hidden; }
    .t1 td { height: 6mm; font-weight: bold; font-size: 8pt; }
    .t2 td { height: 6mm; font-weight: bold; font-size: 8pt; }
    th { height: 7mm; font-weight: bold; font-size: 6.5pt; line-height: 1.15; }
    tr.trip { height: ${ROW_MM}mm; break-inside: avoid; page-break-inside: avoid; }
    tr.trip td { height: ${ROW_MM}mm; font-size: 6pt; padding: 0 0.4mm; white-space: nowrap; }
    td.ph { padding: 0; }
    td.ph img { display: block; width: 100%; height: ${ROW_MM}mm; object-fit: cover; }
    .noimg { color: #999; }
    tr.sum td { height: 6mm; background: #D3D3D3; font-weight: bold; }
    thead { display: table-header-group; }
  </style></head><body>
  <table>
    <colgroup>${COLS_MM.map(w => `<col style="width:${w}mm">`).join('')}</colgroup>
    <thead>
      <tr class="t1"><td colspan="4">สรุปรถขยะ ${esc(h.truck_type)}</td><td colspan="3">NPO ${esc(h.npo_no)}</td>
          <td colspan="4">${esc(thaiRange(h.f, h.t))}</td></tr>
      <tr class="t2"><td colspan="11">โครงการ ${esc(h.project)}</td></tr>
      <tr><th>ลำดับ</th><th>วัน/เดือน/ปี</th><th>เวลาเข้า</th><th>เวลาออก</th><th>เลขที่บิล</th><th>เลขทะเบียนรถ</th>
          <th>ราคา</th><th>จำนวนเที่ยว</th><th>รูปหน้ารถ (เห็นป้ายทะเบียน)</th><th>รูปขยะในรถ</th><th>รูปหลังคลุมผ้าใบ</th></tr>
    </thead>
    <tbody>${body}
      <tr class="sum"><td colspan="5"></td><td style="text-align:right">รวม</td><td>${fmt(totalCost)}</td><td>${totalTrips}</td><td colspan="3"></td></tr>
    </tbody>
  </table></body></html>`;

  const pdf = await htmlToPdf(html, { landscape: true, format: 'A4' });

  const safe = s => String(s).replace(/[\\/:*?"<>|#%&{}$!'@+`=\s]+/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '');
  const code = projectCode(h.project, h.project_id);
  const dir = path.join(NPO_DIR, safe(code));
  fs.mkdirSync(dir, { recursive: true });
  const name = `NPO_${safe(code)}_${safe(h.truck_type)}_${safe(h.npo_no)}_${h.f.replace(/-/g, '')}-${h.t.replace(/-/g, '')}.pdf`;
  await fs.promises.writeFile(path.join(dir, name), pdf);
  const rel = `/uploads/npo/${safe(code)}/${name}`;
  await client.query('UPDATE npo_reports SET pdf_path = $2 WHERE id = $1', [npoId, rel]);
  return encodeURI(rel);
}

module.exports = {
  thaiRange,
  functions: {
    WASTE_getProjects, WASTE_saveNewProject, WASTE_saveData, WASTE_getDashboardData,
    WASTE_listRecords, WASTE_getRecord, WASTE_updateRecord, WASTE_deleteRecord,
    WASTE_npoOptions, WASTE_npoPending, WASTE_npoPreview, WASTE_npoCreate,
    WASTE_npoList, WASTE_npoCancel, WASTE_npoPdf
  }
};
