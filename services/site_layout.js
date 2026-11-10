// ============================================================
// เช็คลิสต์ตาม SITE LAYOUT — หน้า /site-layout (ธุรการ + admin)
//   kind 'area'     = แบบตรวจการใช้พื้นที่ตาม SITE LAYOUT (ธุรการทั่วไป)
//   kind 'material' = แบบตรวจการจัดกองวัสดุตาม SITE LAYOUT (ธุรการขนส่ง)
//   จุดที่ ✗ → ระบบออกใบแจ้งแก้ไข 1 ใบต่อ 1 จุด → กรอกรายละเอียด + รูป Before → แก้แล้วแนบ After → ผู้ตรวจปิดงาน
//
// KPI (แยก 2 ประเภท) = (จำนวนครั้งที่เข้าตรวจ ÷ จำนวนครั้งทั้งหมด) × 100
//   จำนวนครั้งทั้งหมด = 4 ครั้ง/เดือน/โครงการ · เดือนไหนตรวจเกิน 4 นับแค่ 4
//   เริ่มนับตั้งแต่เดือนแรกที่โครงการมีรอบตรวจในระบบ (เดือนก่อนเริ่มใช้ระบบไม่นับ)
//
//   SL_meta()                                   ประเภท, เหตุผลในใบแจ้ง, โครงการ
//   SL_setup(kind, code)                        จุดตรวจ + รูป Layout
//   SL_template(kind)                           จุดตรวจตั้งต้นจากแบบฟอร์ม
//   SL_savePoints(kind, code, list)             บันทึกจุดตรวจ (เอาออก = ปิดใช้)
//   SL_saveLayout(kind, code, dataUrl)          อัปโหลด/ลบรูป Layout
//   SL_rounds(kind, code, 'YYYY-MM')            รอบตรวจของเดือน
//   SL_getRound(id)                             รอบตรวจ 1 รอบ + ใบแจ้งที่ออก
//   SL_saveRound(req)                           บันทึก/แก้รอบตรวจ (✗ ใหม่ = ออกใบแจ้งอัตโนมัติ)
//   SL_deleteRound(id)                          admin เท่านั้น
//   SL_notices({ kind, code, status })          รายการใบแจ้งแก้ไข
//   SL_getNotice(id) / SL_saveNotice(req)       ใบแจ้ง 1 ใบ (รูป Before/After, ปิดงาน)
//   SL_kpi({ from, to, code })
// ============================================================
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { sitePool } = require('../db');
const { UserError, withTx } = require('./common');
const { projectList } = require('./daily_plan');

const TZ = 'Asia/Bangkok';
const KINDS = ['area', 'material'];
const ROUNDS_PER_MONTH = 4;
const PUBLIC_DIR = path.join(__dirname, '..', 'public');
const PHOTO_DIR = path.join(PUBLIC_DIR, 'uploads', 'site-layout');
const MIME_EXT = { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp' };

const FORMS = {
  area: { title: 'Checklist แบบตรวจการใช้พื้นที่ตาม SITE LAYOUT (ธุรการทั่วไป)', short: 'การใช้พื้นที่', role: 'ธุรการทั่วไป', prefix: 'SA', codeLabel: 'รหัส', nameLabel: 'พื้นที่ตาม Layout', hasOwner: true },
  material: { title: 'Checklist แบบตรวจการจัดกองวัสดุตาม SITE LAYOUT (ธุรการขนส่ง)', short: 'การจัดกองวัสดุ', role: 'ธุรการขนส่ง', prefix: 'SM', codeLabel: 'รหัสโซน', nameLabel: 'พื้นที่ / วัสดุตาม Layout', hasOwner: false },
};
const REASONS = {
  material: ['วางผิดโซน / ไม่ตรงตาม Site Layout', 'วางนอกพื้นที่ที่กำหนด (ไม่มีโซนรองรับ)', 'กองเกินขอบเขตพื้นที่ที่กำหนด',
    'กีดขวางเส้นทางสัญจร / ทางรถเข้า-ออก', 'กีดขวาง Safety Walk Way / ทางเดินเท้า', 'วางในพื้นที่ Load / พื้นที่ทำงานเครื่องจักร',
    'กองไม่เป็นระเบียบ / ซ้อนสูงไม่มั่นคง', 'วัสดุต่างชนิดปะปนกันในกองเดียว', 'ไม่มีป้ายชี้บ่งวัสดุ / ป้ายโซน', 'ไม่เก็บวัสดุเหลือใช้เข้าที่หลังเลิกงาน'],
  area: ['ใช้พื้นที่ผิดวัตถุประสงค์ / ไม่ตรงตาม Site Layout', 'ใช้พื้นที่โดยไม่ได้รับอนุญาต / เกินขอบเขตที่กำหนด',
    'วางสิ่งของกีดขวางพื้นที่ส่วนกลาง / หน้าตู้ลิฟท์', 'กีดขวางจุดรวมพล / ทางหนีไฟ / จุดคัดกรอง', 'กีดขวาง Safety Walk Way / เส้นทางสัญจร',
    'จอดรถ / เครื่องจักรผิดที่', 'ต่อเติม ดัดแปลง หรือย้ายสิ่งปลูกสร้างชั่วคราวโดยไม่ได้รับอนุญาต', 'ทิ้งขยะ / ล้างอุปกรณ์ผิดจุดที่กำหนด',
    'สำนักงาน / โรงอาหาร / ห้องน้ำ ใช้ไม่ตรงตามที่กำหนด', 'ไม่มีป้ายชี้บ่งพื้นที่'],
};
// จุดตรวจตั้งต้น (จากแบบฟอร์มที่ใช้อยู่ — แก้ให้ตรงแต่ละโครงการในแท็บตั้งค่า)
const TEMPLATES = {
  area: [
    ['A01', 'จุดคัดกรองคนเข้า-ออก / จุด Scan / ป้อม รปภ.'], ['A02', 'จุดรวมพลหน้าประตู Site'], ['A03', 'ประตูทางเข้า-ออก'],
    ['A04', 'ประตูทางเข้าเดิม'], ['A05', 'Safety Walk Way (ทางเดินมีหลังคา)'], ['A06', 'เส้นทางสัญจรรถภายในโครงการ'],
    ['A07', 'จุดทิ้งขยะเศษอาหารหน้า Site'], ['A08', 'Temp Toilet'], ['A09', 'จุดล้าง'], ['A10', 'จุดล้างปูน'],
    ['A11', 'พื้นที่หน้าตู้ลิฟท์ อาคาร C'], ['A12', 'พื้นที่หน้าตู้ลิฟท์ อาคาร B (กลาง)'], ['A13', 'พื้นที่หน้าตู้ลิฟท์ 1 - 2'],
    ['A14', 'บ่อพัก-บ่อดักขยะก่อนระบาย (หลายจุด)'], ['A15', 'ระบบ Sprinkler ลดฝุ่น (แนวรั้วรอบ Site)'], ['A16', 'กล้อง CCTV รอบ Site (หลายจุด)'],
    ['B01', 'สำนักงานสนาม', 'ชั้นใต้ดิน'], ['B02', 'โรงอาหาร', 'ชั้นใต้ดิน'],
  ],
  material: [
    ['M01', 'พ.ท. วางอุปกรณ์ไม้ (แนวบน)'], ['M02', 'พ.ท. วางผนัง'], ['M03', 'หัวหลักอาคาร C'], ['M04', 'กองเศษเหล็ก (อาคาร C)'],
    ['M05', 'พื้นที่กองวัสดุปูนถุง (อาคาร C)'], ['M06', 'กองขยะ (อาคาร C)'], ['M07', 'งานระบบ'], ['M08', 'พื้นที่กอง PC ตึก C'],
    ['M09', 'LOAD อาคาร C 12 ล้อพื้นเรียบ'], ['M10', 'กองของ S Crane'], ['M11', 'จุดกอง Wire mesh / Protection'],
    ['M12', 'พื้นที่กองวัสดุปูนถุง (อาคาร B)'], ['M13', 'พ.ท. วางอุปกรณ์ไม้แบบ (อาคาร B)'], ['M14', 'พื้นที่กอง PC ตึก B'],
    ['M15', 'กองเศษเหล็ก (อาคาร B)'], ['M16', 'หัวหลักอาคาร B'], ['M17', 'หัวหลักอาคาร A'], ['M18', 'กองเศษเหล็ก (อาคาร A)'],
    ['M19', 'กองขยะรวม'], ['M20', 'พ.ท. วางอุปกรณ์ไม้แบบ (ด้านใต้)'], ['M21', 'พื้นที่กอง PC (ด้านใต้)'],
    ['R01', 'เส้นทางสัญจร / ทางรถเข้า-ออก'], ['R02', 'Safety Walk Way / ทางเดินเท้า'],
  ],
};

// ---------- helpers ----------
const str = (v, max) => String(v == null ? '' : v).trim().slice(0, max || 300);
const isDate = s => /^\d{4}-\d{2}-\d{2}$/.test(String(s || '')) && !isNaN(Date.parse(s + 'T00:00:00Z'));
const optDate = s => (isDate(s) ? s : null);
const byName = ctx => (ctx && ctx.user && (ctx.user.full_name || ctx.user.username)) || '';
const isAdmin = ctx => !!(ctx && ctx.user && ctx.user.role === 'admin');
function requireStaff(ctx) {
  const r = ctx && ctx.user && ctx.user.role;
  if (r !== 'admin' && r !== 'staff') throw new UserError('ใช้ได้เฉพาะบัญชีธุรการหรือผู้ดูแลระบบ');
}
function kindOf(k) { if (!KINDS.includes(k)) throw new UserError('ไม่รู้จักประเภทเช็คลิสต์นี้'); return k; }
function codeOf(c) {
  const s = str(c, 10).toUpperCase();
  if (!/^[A-Z0-9]{2,10}$/.test(s)) throw new UserError('กรุณาเลือกโครงการ');
  return s;
}
const monthEnd = m => { const d = new Date(Date.UTC(+m.slice(0, 4), +m.slice(5, 7), 0)); return d.toISOString().slice(0, 10); };
const todayBkk = () => new Date(Date.now() + 7 * 3600 * 1000).toISOString().slice(0, 10);

function savePhoto(dataUrl, tag) {
  const m = String(dataUrl || '').match(/^data:(image\/[a-z]+);base64,(.+)$/);
  if (!m || !MIME_EXT[m[1]]) throw new UserError('ไฟล์รูปไม่ถูกต้อง (รองรับ JPG / PNG / WEBP)');
  const buf = Buffer.from(m[2], 'base64');
  if (!buf.length || buf.length > 10 * 1024 * 1024) throw new UserError('รูปใหญ่เกินไป (ไม่เกิน 10 MB)');
  const month = todayBkk().slice(0, 7);
  const dir = path.join(PHOTO_DIR, month);
  fs.mkdirSync(dir, { recursive: true });
  const name = `${tag}_${Date.now()}_${crypto.randomBytes(4).toString('hex')}.${MIME_EXT[m[1]]}`;
  fs.writeFileSync(path.join(dir, name), buf);
  return `/uploads/site-layout/${month}/${name}`;
}
function removePhoto(url) {
  if (!String(url || '').startsWith('/uploads/site-layout/')) return;
  const file = path.join(PUBLIC_DIR, url);
  if (!file.startsWith(PHOTO_DIR)) return;
  fs.promises.unlink(file).catch(() => {});
}

// เลขที่ใบแจ้ง: <โครงการ>-SA|SM<ปีพ.ศ.2หลัก><เดือน>-<ลำดับ> เช่น 0DJ-SM6911-001
async function nextNoticeNo(client, kind, code, date) {
  const yy = String(+date.slice(0, 4) + 543).slice(2), mm = date.slice(5, 7);
  const prefix = `${code}-${FORMS[kind].prefix}${yy}${mm}-`;
  await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', ['slno|' + prefix]);
  const r = await client.query(`SELECT notice_no FROM sl_notices WHERE notice_no LIKE $1 ORDER BY notice_no DESC LIMIT 1`, [prefix + '%']);
  const n = r.rows.length ? parseInt(r.rows[0].notice_no.slice(prefix.length), 10) + 1 : 1;
  return prefix + String(n).padStart(3, '0');
}

// ============================================================
async function SL_meta() {
  requireStaff(this);
  return { forms: FORMS, reasons: REASONS, projects: await projectList(), today: todayBkk(), roundsPerMonth: ROUNDS_PER_MONTH, isAdmin: isAdmin(this), me: byName(this) };
}

async function SL_setup(kind, code) {
  requireStaff(this);
  kind = kindOf(kind); code = codeOf(code);
  const points = (await sitePool.query(
    `SELECT id, code, name, section, owner FROM sl_points WHERE project_code = $1 AND kind = $2 AND active ORDER BY sort_order, id`,
    [code, kind])).rows;
  const lay = (await sitePool.query(`SELECT image_url FROM sl_layouts WHERE project_code = $1 AND kind = $2`, [code, kind])).rows[0];
  return { points, layoutUrl: lay ? lay.image_url : '' };
}

function SL_template(kind) {
  requireStaff(this);
  return TEMPLATES[kindOf(kind)].map(([c, n, s]) => ({ code: c, name: n, section: s || '', owner: '' }));
}

async function SL_savePoints(kind, code, list) {
  requireStaff(this);
  kind = kindOf(kind); code = codeOf(code);
  const rows = (Array.isArray(list) ? list : []).map(x => ({
    id: x && x.id ? Number(x.id) : null, code: str(x && x.code, 20), name: str(x && x.name, 200),
    section: str(x && x.section, 100), owner: str(x && x.owner, 120),
  })).filter(x => x.name);
  if (rows.length > 300) throw new UserError('จุดตรวจมากเกินไป (ไม่เกิน 300)');
  return withTx(async client => {
    const keep = [];
    for (let i = 0; i < rows.length; i++) {
      const x = rows[i];
      let id = null;
      if (x.id) {
        const u = await client.query(
          `UPDATE sl_points SET code = $3, name = $4, section = $5, owner = $6, sort_order = $7, active = TRUE
            WHERE id = $1 AND project_code = $2 AND kind = $8 RETURNING id`, [x.id, code, x.code, x.name, x.section, x.owner, i, kind]);
        if (u.rows.length) id = u.rows[0].id;
      }
      if (!id) {
        id = (await client.query(
          `INSERT INTO sl_points (project_code, kind, code, name, section, owner, sort_order) VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id`,
          [code, kind, x.code, x.name, x.section, x.owner, i])).rows[0].id;
      }
      keep.push(id);
    }
    await client.query(`UPDATE sl_points SET active = FALSE WHERE project_code = $1 AND kind = $2 AND NOT (id = ANY($3::int[]))`, [code, kind, keep]);
    return { ok: true, count: keep.length };
  });
}

async function SL_saveLayout(kind, code, dataUrl) {
  requireStaff(this);
  kind = kindOf(kind); code = codeOf(code);
  const old = (await sitePool.query(`SELECT image_url FROM sl_layouts WHERE project_code = $1 AND kind = $2`, [code, kind])).rows[0];
  if (!dataUrl) {
    await sitePool.query(`DELETE FROM sl_layouts WHERE project_code = $1 AND kind = $2`, [code, kind]);
    if (old) removePhoto(old.image_url);
    return { ok: true, layoutUrl: '' };
  }
  const url = savePhoto(dataUrl, `layout_${code}_${kind}`);
  await sitePool.query(
    `INSERT INTO sl_layouts (project_code, kind, image_url, updated_by) VALUES ($1,$2,$3,$4)
     ON CONFLICT (project_code, kind) DO UPDATE SET image_url = $3, updated_by = $4, updated_at = NOW()`, [code, kind, url, byName(this)]);
  if (old) removePhoto(old.image_url);
  return { ok: true, layoutUrl: url };
}

const ROUND_COLS = `id, kind, project_code AS "projectCode", TO_CHAR(inspect_date, 'YYYY-MM-DD') AS "inspectDate", inspect_time AS "inspectTime",
  inspector, pm_name AS "pmName", total, ok, ng, note, created_by AS "createdBy", updated_by AS "updatedBy",
  TO_CHAR(updated_at AT TIME ZONE '${TZ}', 'DD/MM/YYYY HH24:MI') AS "updatedText"`;

// รอบที่ = ลำดับในเดือน (ตามวันที่ตรวจ)
async function SL_rounds(kind, code, month) {
  requireStaff(this);
  kind = kindOf(kind); code = codeOf(code);
  if (!/^\d{4}-\d{2}$/.test(String(month || ''))) throw new UserError('เดือนไม่ถูกต้อง');
  const r = await sitePool.query(
    `SELECT ${ROUND_COLS},
            (SELECT COUNT(*)::int FROM sl_notices n WHERE n.round_id = r.id) AS "noticeCount",
            (SELECT COUNT(*)::int FROM sl_notices n WHERE n.round_id = r.id AND n.status = 'open') AS "openCount"
       FROM sl_rounds r WHERE kind = $1 AND project_code = $2 AND inspect_date BETWEEN $3 AND $4
      ORDER BY inspect_date, id`, [kind, code, month + '-01', monthEnd(month)]);
  return r.rows.map((x, i) => Object.assign(x, { roundNo: i + 1 }));
}

async function SL_getRound(id) {
  requireStaff(this);
  const r = (await sitePool.query(`SELECT ${ROUND_COLS} FROM sl_rounds WHERE id = $1`, [Number(id) || 0])).rows[0];
  if (!r) throw new UserError('ไม่พบรอบตรวจนี้');
  const month = r.inspectDate.slice(0, 7);
  r.roundNo = (await sitePool.query(
    `SELECT COUNT(*)::int AS n FROM sl_rounds WHERE kind = $1 AND project_code = $2 AND inspect_date BETWEEN $3 AND $4
       AND (inspect_date, id) <= ($5::date, $6)`, [r.kind, r.projectCode, month + '-01', monthEnd(month), r.inspectDate, r.id])).rows[0].n;
  r.items = (await sitePool.query(
    `SELECT i.id, i.point_id AS "pointId", i.code, i.name, i.section, i.owner, i.result, i.remark, i.notice_id AS "noticeId",
            n.notice_no AS "noticeNo", n.status AS "noticeStatus"
       FROM sl_round_items i LEFT JOIN sl_notices n ON n.id = i.notice_id WHERE i.round_id = $1 ORDER BY i.sort_order, i.id`, [r.id])).rows;
  return r;
}

// req = { id?, kind, projectCode, inspectDate, inspectTime, inspector, pmName, note, items: [{ pointId?, code, name, section, owner, result: 'ok'|'ng', remark }] }
async function SL_saveRound(req) {
  requireStaff(this);
  req = req || {};
  const kind = kindOf(req.kind), code = codeOf(req.projectCode);
  if (!isDate(req.inspectDate)) throw new UserError('กรุณาเลือกวันที่ตรวจ');
  if (req.inspectDate > todayBkk()) throw new UserError('วันที่ตรวจต้องไม่เกินวันนี้');
  const items = (Array.isArray(req.items) ? req.items : []).map(x => ({
    pointId: x && x.pointId ? Number(x.pointId) : null, code: str(x && x.code, 20), name: str(x && x.name, 200),
    section: str(x && x.section, 100), owner: str(x && x.owner, 120), result: x && x.result, remark: str(x && x.remark, 300),
  })).filter(x => x.name);
  if (!items.length) throw new UserError('ยังไม่มีจุดตรวจ — ตั้งค่าจุดตรวจของโครงการก่อน');
  const unchecked = items.filter(x => x.result !== 'ok' && x.result !== 'ng');
  if (unchecked.length) throw new UserError(`ยังไม่ได้ติ๊ก ✓/✗ อีก ${unchecked.length} จุด: ` + unchecked.slice(0, 5).map(x => x.code || x.name).join(', '));
  const by = byName(this);

  return withTx(async client => {
    let roundId = req.id ? Number(req.id) : null;
    const oldNotice = new Map();   // pointKey → notice_id (ใช้ใบเดิมถ้ายัง ✗ อยู่)
    const key = x => x.pointId ? 'p' + x.pointId : 'n' + x.code + '|' + x.name;
    if (roundId) {
      const cur = (await client.query('SELECT kind, project_code FROM sl_rounds WHERE id = $1 FOR UPDATE', [roundId])).rows[0];
      if (!cur) throw new UserError('ไม่พบรอบตรวจนี้ (อาจถูกลบไปแล้ว)');
      if (cur.kind !== kind || cur.project_code !== code) throw new UserError('เปลี่ยนประเภท/โครงการของรอบตรวจที่บันทึกแล้วไม่ได้');
      (await client.query('SELECT point_id AS "pointId", code, name, notice_id FROM sl_round_items WHERE round_id = $1 AND notice_id IS NOT NULL', [roundId]))
        .rows.forEach(r => oldNotice.set(key(r), r.notice_id));
      await client.query(
        `UPDATE sl_rounds SET inspect_date = $2, inspect_time = $3, inspector = $4, pm_name = $5, note = $6, updated_by = $7, updated_at = NOW() WHERE id = $1`,
        [roundId, req.inspectDate, str(req.inspectTime, 20), str(req.inspector, 100) || by, str(req.pmName, 100), str(req.note, 500), by]);
      await client.query('DELETE FROM sl_round_items WHERE round_id = $1', [roundId]);
    } else {
      roundId = (await client.query(
        `INSERT INTO sl_rounds (kind, project_code, inspect_date, inspect_time, inspector, pm_name, note, created_by, updated_by)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$8) RETURNING id`,
        [kind, code, req.inspectDate, str(req.inspectTime, 20), str(req.inspector, 100) || by, str(req.pmName, 100), str(req.note, 500), by])).rows[0].id;
    }

    const created = [];
    for (let i = 0; i < items.length; i++) {
      const it = items[i];
      let noticeId = null;
      if (it.result === 'ng') {
        noticeId = oldNotice.get(key(it)) || null;
        if (noticeId) oldNotice.delete(key(it));
        else {
          const no = await nextNoticeNo(client, kind, code, req.inspectDate);
          noticeId = (await client.query(
            `INSERT INTO sl_notices (notice_no, kind, project_code, round_id, issued_date, found_date, found_time, location, zone_found,
                                     owner_company, detail, created_by, updated_by)
             VALUES ($1,$2,$3,$4,$5,$5,$6,$7,$8,$9,$10,$11,$11) RETURNING id`,
            [no, kind, code, roundId, req.inspectDate, str(req.inspectTime, 20), it.name, it.code, it.owner, it.remark, by])).rows[0].id;
          created.push(no);
        }
      }
      await client.query(
        `INSERT INTO sl_round_items (round_id, point_id, code, name, section, owner, result, remark, notice_id, sort_order)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
        [roundId, it.pointId, it.code, it.name, it.section, it.owner, it.result, it.remark, noticeId, i]);
    }
    // จุดที่เปลี่ยนจาก ✗ เป็น ✓: ลบใบแจ้งที่ยังไม่ได้กรอกอะไร · ใบที่มีข้อมูลแล้วเก็บไว้ (ไม่ผูกกับรอบนี้)
    let removed = 0;
    for (const nid of oldNotice.values()) {
      const n = (await client.query(`SELECT status, before_photos, after_photos, responsible, reasons FROM sl_notices WHERE id = $1`, [nid])).rows[0];
      if (!n) continue;
      const touched = n.status !== 'open' || (n.before_photos || []).length || (n.after_photos || []).length || n.responsible || (n.reasons || []).length;
      if (touched) continue;
      await client.query('DELETE FROM sl_notices WHERE id = $1', [nid]);
      removed++;
    }
    const ok = items.filter(x => x.result === 'ok').length;
    await client.query('UPDATE sl_rounds SET total = $2, ok = $3, ng = $4 WHERE id = $1', [roundId, items.length, ok, items.length - ok]);
    return { ok: true, id: roundId, created, removed };
  });
}

async function SL_deleteRound(id) {
  requireStaff(this);
  if (!isAdmin(this)) throw new UserError('ลบรอบตรวจได้เฉพาะผู้ดูแลระบบ (admin)');
  return withTx(async client => {
    const notices = (await client.query(`SELECT id, before_photos, after_photos FROM sl_notices WHERE round_id = $1`, [Number(id) || 0])).rows;
    await client.query('DELETE FROM sl_notices WHERE round_id = $1', [Number(id) || 0]);
    const r = await client.query('DELETE FROM sl_rounds WHERE id = $1', [Number(id) || 0]);
    if (!r.rowCount) throw new UserError('ไม่พบรอบตรวจนี้');
    notices.forEach(n => [].concat(n.before_photos || [], n.after_photos || []).forEach(p => removePhoto(p.url)));
    return { ok: true };
  });
}

const NOTICE_COLS = `id, notice_no AS "noticeNo", kind, project_code AS "projectCode", round_id AS "roundId",
  TO_CHAR(issued_date, 'YYYY-MM-DD') AS "issuedDate", TO_CHAR(found_date, 'YYYY-MM-DD') AS "foundDate", found_time AS "foundTime",
  location, zone_found AS "zoneFound", zone_correct AS "zoneCorrect", reasons, reason_other AS "reasonOther",
  owner_company AS "ownerCompany", responsible, cooperation, TO_CHAR(due_date, 'YYYY-MM-DD') AS "dueDate", detail,
  before_photos AS "beforePhotos", after_photos AS "afterPhotos", TO_CHAR(fixed_date, 'YYYY-MM-DD') AS "fixedDate",
  status, close_result AS "closeResult", close_note AS "closeNote", closed_by AS "closedBy",
  TO_CHAR(closed_at AT TIME ZONE '${TZ}', 'YYYY-MM-DD') AS "closedDate", created_by AS "createdBy"`;

async function SL_notices(req) {
  requireStaff(this);
  req = req || {};
  const where = [], args = [];
  if (req.kind) { args.push(kindOf(req.kind)); where.push(`kind = $${args.length}`); }
  if (req.code) { args.push(codeOf(req.code)); where.push(`project_code = $${args.length}`); }
  if (req.status === 'open' || req.status === 'closed') { args.push(req.status); where.push(`status = $${args.length}`); }
  const r = await sitePool.query(
    `SELECT ${NOTICE_COLS} FROM sl_notices ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
      ORDER BY (status = 'open') DESC, issued_date DESC, notice_no DESC LIMIT 500`, args);
  const today = todayBkk();
  return r.rows.map(n => Object.assign(n, { overdue: n.status === 'open' && n.dueDate && n.dueDate < today }));
}

async function SL_getNotice(id) {
  requireStaff(this);
  const n = (await sitePool.query(`SELECT ${NOTICE_COLS} FROM sl_notices WHERE id = $1`, [Number(id) || 0])).rows[0];
  if (!n) throw new UserError('ไม่พบใบแจ้งแก้ไขนี้');
  return n;
}

// req = { id, ...ฟิลด์, newBefore: [dataUrl], newAfter: [dataUrl], keepBefore: [url], keepAfter: [url], close: 'pass'|'fail'|'' , reopen: bool }
async function SL_saveNotice(req) {
  requireStaff(this);
  req = req || {};
  const by = byName(this);
  const id = Number(req.id) || 0;
  const cur = (await sitePool.query(`SELECT * FROM sl_notices WHERE id = $1`, [id])).rows[0];
  if (!cur) throw new UserError('ไม่พบใบแจ้งแก้ไขนี้');
  const reasons = (Array.isArray(req.reasons) ? req.reasons : []).filter(x => REASONS[cur.kind].includes(x));
  const keep = (list, kept) => (list || []).filter(p => (kept || []).includes(p.url));
  const addNew = (arr, tag) => (Array.isArray(arr) ? arr : []).slice(0, 6).map(d => ({ url: savePhoto(d, tag), at: new Date().toISOString(), by }));
  let before = keep(cur.before_photos, req.keepBefore), after = keep(cur.after_photos, req.keepAfter);
  const removed = [].concat(cur.before_photos || [], cur.after_photos || []).filter(p => !before.concat(after).some(k => k.url === p.url));
  before = before.concat(addNew(req.newBefore, 'before_' + cur.notice_no));
  after = after.concat(addNew(req.newAfter, 'after_' + cur.notice_no));
  if (before.length > 6 || after.length > 6) throw new UserError('รูปได้ไม่เกิน 6 รูปต่อฝั่ง');

  let status = cur.status, closeResult = cur.close_result, closedBy = cur.closed_by, closedAt = cur.closed_at;
  if (req.close === 'pass') {
    if (!after.length) throw new UserError('ปิดงานต้องมีรูป After อย่างน้อย 1 รูป');
    status = 'closed'; closeResult = 'pass'; closedBy = by; closedAt = new Date();
  } else if (req.close === 'fail') {
    status = 'open'; closeResult = 'fail'; closedBy = by; closedAt = new Date();
  } else if (req.reopen) {
    status = 'open'; closeResult = ''; closedBy = null; closedAt = null;
  }
  const coop = ['signed', 'refused'].includes(req.cooperation) ? req.cooperation : '';
  await sitePool.query(
    `UPDATE sl_notices SET found_date = $2, found_time = $3, location = $4, zone_found = $5, zone_correct = $6, reasons = $7::jsonb,
            reason_other = $8, owner_company = $9, responsible = $10, cooperation = $11, due_date = $12, detail = $13,
            before_photos = $14::jsonb, after_photos = $15::jsonb, fixed_date = $16, status = $17, close_result = $18,
            close_note = $19, closed_by = $20, closed_at = $21, updated_by = $22, updated_at = NOW() WHERE id = $1`,
    [id, optDate(req.foundDate), str(req.foundTime, 20), str(req.location, 200), str(req.zoneFound, 20), str(req.zoneCorrect, 20),
      JSON.stringify(reasons), str(req.reasonOther, 200), str(req.ownerCompany, 150), str(req.responsible, 150), coop,
      optDate(req.dueDate), str(req.detail, 1000), JSON.stringify(before), JSON.stringify(after), optDate(req.fixedDate),
      status, closeResult, str(req.closeNote, 300), closedBy, closedAt, by]);
  removed.forEach(p => removePhoto(p.url));
  return { ok: true, status };
}

// req = { from: 'YYYY-MM', to: 'YYYY-MM', code? }
async function SL_kpi(req) {
  requireStaff(this);
  req = req || {};
  const cur = todayBkk().slice(0, 7);
  const fromM = /^\d{4}-\d{2}$/.test(req.from || '') ? req.from : cur;
  const toM = /^\d{4}-\d{2}$/.test(req.to || '') && req.to >= fromM ? req.to : fromM;
  const code = req.code ? codeOf(req.code) : null;
  const months = [];
  for (let m = fromM; m <= toM && months.length < 36; ) {
    months.push(m);
    const y = +m.slice(0, 4), mo = +m.slice(5, 7);
    m = mo === 12 ? `${y + 1}-01` : `${y}-${String(mo + 1).padStart(2, '0')}`;
  }
  const rounds = (await sitePool.query(
    `SELECT kind, project_code AS code, TO_CHAR(inspect_date, 'YYYY-MM') AS month, COUNT(*)::int AS n, SUM(ng)::int AS ng, SUM(total)::int AS total
       FROM sl_rounds WHERE inspect_date BETWEEN $1 AND $2 AND ($3::text IS NULL OR project_code = $3)
      GROUP BY 1, 2, 3`, [fromM + '-01', monthEnd(toM), code])).rows;
  // โครงการที่ต้องตรวจ = มีจุดตรวจตั้งไว้ หรือเคยมีรอบตรวจในช่วงนี้
  const setup = (await sitePool.query(
    `SELECT DISTINCT kind, project_code AS code FROM sl_points WHERE active AND ($1::text IS NULL OR project_code = $1)`, [code])).rows;
  const notices = (await sitePool.query(
    `SELECT kind, project_code AS code, COUNT(*)::int AS total,
            COUNT(*) FILTER (WHERE status = 'closed')::int AS closed,
            COUNT(*) FILTER (WHERE status = 'open' AND due_date < $3)::int AS overdue
       FROM sl_notices WHERE issued_date BETWEEN $1 AND $2 AND ($4::text IS NULL OR project_code = $4) GROUP BY 1, 2`,
    [fromM + '-01', monthEnd(toM), todayBkk(), code])).rows;
  // เริ่มนับตั้งแต่เดือนแรกที่โครงการมีรอบตรวจในระบบ (ยังไม่เคยตรวจ = เริ่มเดือนปัจจุบัน) — เดือนก่อนเริ่มใช้ระบบไม่นับ
  const firsts = (await sitePool.query(
    `SELECT kind, project_code AS code, TO_CHAR(MIN(inspect_date), 'YYYY-MM') AS m FROM sl_rounds GROUP BY 1, 2`)).rows;
  const names = new Map((await projectList()).map(p => [p.code, p.name]));

  const out = [];
  KINDS.forEach(kind => {
    const codes = new Set(setup.filter(s => s.kind === kind).map(s => s.code).concat(rounds.filter(r => r.kind === kind).map(r => r.code)));
    const projects = [...codes].sort().map(c => {
      const f = firsts.find(x => x.kind === kind && x.code === c);
      const start = f ? f.m : cur;
      const per = months.map(m => {
        if (m < start) return { month: m, done: 0, counted: 0, required: 0, ng: 0, points: 0, pct: null, current: false, before: true };
        const r = rounds.find(x => x.kind === kind && x.code === c && x.month === m);
        const done = r ? r.n : 0;
        return { month: m, done, counted: Math.min(done, ROUNDS_PER_MONTH), required: ROUNDS_PER_MONTH, ng: r ? r.ng : 0, points: r ? r.total : 0,
          pct: Math.round(Math.min(done, ROUNDS_PER_MONTH) / ROUNDS_PER_MONTH * 1000) / 10, current: m === cur };
      });
      const counted = per.reduce((a, x) => a + x.counted, 0), required = per.reduce((a, x) => a + x.required, 0);
      const n = notices.find(x => x.kind === kind && x.code === c) || { total: 0, closed: 0, overdue: 0 };
      return { code: c, name: names.get(c) || c, months: per, counted, required, pct: required ? Math.round(counted / required * 1000) / 10 : null,
        notices: n.total, closed: n.closed, overdue: n.overdue };
    });
    const counted = projects.reduce((a, p) => a + p.counted, 0), required = projects.reduce((a, p) => a + p.required, 0);
    out.push({ kind, projects, counted, required, pct: required ? Math.round(counted / required * 1000) / 10 : null,
      notices: projects.reduce((a, p) => a + p.notices, 0), closed: projects.reduce((a, p) => a + p.closed, 0), overdue: projects.reduce((a, p) => a + p.overdue, 0) });
  });
  return { from: fromM, to: toM, months, kinds: out };
}

async function summary() {
  const r = await sitePool.query(`SELECT COUNT(*)::int AS n FROM sl_notices WHERE status = 'open'`);
  return r.rows[0].n;
}

module.exports = {
  summary, FORMS,
  functions: {
    SL_meta, SL_setup, SL_template, SL_savePoints, SL_saveLayout, SL_rounds, SL_getRound, SL_saveRound, SL_deleteRound,
    SL_notices, SL_getNotice, SL_saveNotice, SL_kpi,
  },
};
