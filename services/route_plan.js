// ============================================================
// บันทึกการเปลี่ยนแผนเดินรถ — หน้า /route-plan (เฉพาะ admin)
//
// อัปโหลด PDF แผนเดินรถประจำสัปดาห์ของศูนย์สระบุรีทุก Revise → ระบบเทียบกับฉบับก่อนหน้า
// แล้วบันทึกว่าเที่ยวไหน เพิ่ม / ยกเลิก / ย้ายวัน / สลับคัน พร้อม BU · โครงการ · ผู้จอง
// คนตรวจเลือกสาเหตุ + แนบรูปใบแจ้งยกเลิก/จองด่วน · รายงาน % ผิดแผนเทียบ Rev 0
//
//   RPLAN_meta()                       หมวดสาเหตุ, รายชื่อ BU
//   RPLAN_upload({fileName, dataUrl, revNo?})
//   RPLAN_weeks()                      รายการสัปดาห์ + สรุปสั้น
//   RPLAN_week(weekStart)              ฉบับทั้งหมด + รายการเปลี่ยนแปลงของสัปดาห์
//   RPLAN_saveChange(id, {cause, counted, note})
//   RPLAN_attach(changeId, {fileName, dataUrl}) / RPLAN_deleteAttachment(id)
//   RPLAN_deleteRevision(id)
//   RPLAN_report({from, to})           สรุปหลายสัปดาห์ แยก BU / โครงการ / ผู้จอง / สาเหตุ
//
// กติกาการนับ (ค่าเริ่มต้นที่ระบบเดา — แก้ได้ทุกรายการ)
//   - นับเฉพาะงานขนส่ง (ไม่นับเที่ยว "ลง..." ซึ่งตามเที่ยวขึ้นของ) และเฉพาะวัน จ.–อา. ของสัปดาห์นั้น
//   - สลับคัน/เที่ยวในวันเดิม, ผู้จอง ADMIN (สระบุรีแก้เอง), ช่องที่กลายเป็นซ่อมรถ/พขร.ติดงาน → ไม่นับ
//   - % ผิดแผน = รายการที่นับ ÷ จำนวนงานใน Rev 0
// ============================================================
const fs = require('fs');
const path = require('path');
const { sitePool } = require('../db');
const { UserError, withTx } = require('./common');
const { parsePlanPdf, revFromName, dateFromName, BU_LIST, BU_OTHER, BU_FURN_PUCHAO } = require('./route_plan_pdf');

const STORE_DIR = path.join(__dirname, '..', 'storage', 'route-plan');
const MAX_BYTES = 15 * 1024 * 1024;
const TZ = 'Asia/Bangkok';

const CAUSE_SARABURI_ADMIN = 'สระบุรีจัดรถใหม่ (ADMIN)';
const CAUSE_SWAP = 'สระบุรีจัดรถใหม่ (สลับคัน/เที่ยว)';
const CAUSE_TRUCK = 'รถเสีย / พขร.ติดงาน';
const CAUSE_UNLOAD = 'เที่ยวลงของ (ตามเที่ยวขึ้นของ)';
const CAUSE_OUTWEEK = 'วันนอกสัปดาห์ (ไม่นับ)';
// สาเหตุที่เลือกได้ — counted = ค่าเริ่มต้นว่านับเป็นการผิดแผนของ BU/หน้างานหรือไม่
const CAUSES = [
  { name: 'จองซ้ำ / จองผิด (ธุรการหน้างาน)', counted: true },
  { name: 'หน้างานไม่พร้อมรับของ', counted: true },
  { name: 'วัสดุไม่พร้อม (BU ผลิตไม่ทัน)', counted: true },
  { name: 'เปลี่ยนแผนงานก่อสร้าง', counted: true },
  { name: CAUSE_TRUCK, counted: false },
  { name: CAUSE_SARABURI_ADMIN, counted: false },
  { name: CAUSE_SWAP, counted: false },
  { name: 'อื่นๆ', counted: true },
];
const TYPE_TH = { add: 'เพิ่ม', cancel: 'ยกเลิก', move: 'ย้ายวัน', swap: 'สลับคัน/เที่ยว' };

const str = (v, max) => String(v == null ? '' : v).trim().slice(0, max || 500);
const norm = s => String(s || '').replace(/\s+/g, '').toUpperCase();
const isDate = s => /^\d{4}-\d{2}-\d{2}$/.test(String(s || ''));
function requireAdmin(ctx) {
  if (!(ctx && ctx.user && ctx.user.role === 'admin')) throw new UserError('ใช้ได้เฉพาะบัญชีผู้ดูแลระบบ (admin)');
}
const byName = ctx => (ctx && ctx.user && (ctx.user.full_name || ctx.user.username)) || '';
function decodeDataUrl(dataUrl) {
  const m = String(dataUrl || '').match(/^data:([\w\/+.-]*);base64,(.+)$/);
  if (!m) throw new UserError('ไฟล์ไม่ถูกต้อง');
  const buf = Buffer.from(m[2], 'base64');
  if (!buf.length || buf.length > MAX_BYTES) throw new UserError('ไฟล์ต้องมีขนาดไม่เกิน 15 MB');
  return { mime: m[1], buf };
}

// ------------------------------------------------------------
// เทียบ 2 ฉบับ → รายการเปลี่ยนแปลง
// ------------------------------------------------------------
const loc = it => ({ date: it.plan_date, plate: it.plate || ('#' + it.truck_no), trip: it.trip, truckNo: it.truck_no });
const locKey = l => `${l.date}/${l.plate}/${l.trip}`;

function diffRevisions(prevItems, curItems, weekStart, weekEnd) {
  const inWeek = d => d >= weekStart && d <= weekEnd;
  const group = list => {
    const m = new Map();
    list.filter(i => i.kind === 'job' || i.kind === 'unload').forEach(i => {
      const k = i.kind + '|' + norm(i.raw_text);
      if (!m.has(k)) m.set(k, { sample: i, locs: [] });
      m.get(k).locs.push(loc(i));
    });
    return m;
  };
  const statusAt = new Map();   // ช่องในฉบับใหม่ที่เป็นสถานะรถ (ซ่อม/พขร.ติดงาน)
  curItems.filter(i => i.kind === 'status').forEach(i => statusAt.set(locKey(loc(i)), i.raw_text));
  const A = group(prevItems), B = group(curItems);
  const out = [];
  new Set([...A.keys(), ...B.keys()]).forEach(k => {
    const a = A.get(k), b = B.get(k);
    const sample = (b || a).sample;
    const bKeys = new Set((b ? b.locs : []).map(locKey));
    const aKeys = new Set((a ? a.locs : []).map(locKey));
    const removed = (a ? a.locs : []).filter(l => !bKeys.has(locKey(l)));
    const added = (b ? b.locs : []).filter(l => !aKeys.has(locKey(l)));
    const push = (type, from, to) => out.push({ type, sample, from, to });
    // จับคู่ "หายจากที่เดิม + โผล่ที่ใหม่" ของงานเดียวกัน: วันเดิม = สลับคัน/เที่ยว, คนละวัน = ย้ายวัน
    while (removed.length && added.length) {
      const x = removed.shift();
      added.sort((p, q) => (p.date !== x.date) - (q.date !== x.date) || Math.abs(Date.parse(p.date) - Date.parse(x.date)) - Math.abs(Date.parse(q.date) - Date.parse(x.date)));
      const y = added.shift();
      push(y.date === x.date ? 'swap' : 'move', x, y);
    }
    removed.forEach(x => push('cancel', x, null));
    added.forEach(y => push('add', null, y));
  });

  return out.map(c => {
    const s = c.sample;
    const dates = [c.from && c.from.date, c.to && c.to.date].filter(Boolean);
    const week = dates.some(inWeek);
    let cause = '', counted = true;
    const truckStatus = c.from && statusAt.get(locKey(c.from));
    if (s.kind === 'unload') { cause = CAUSE_UNLOAD; counted = false; }
    else if (!week) { cause = CAUSE_OUTWEEK; counted = false; }
    else if (c.type === 'swap') { cause = CAUSE_SWAP; counted = false; }
    else if ((c.type === 'cancel' || c.type === 'move') && truckStatus && /ซ่อม|พขร|พนักงานขับรถ|รถจอด|ลาหยุด/.test(truckStatus)) {
      cause = CAUSE_TRUCK; counted = false;
    } else if (String(s.booker || '').toUpperCase() === 'ADMIN') { cause = CAUSE_SARABURI_ADMIN; counted = false; }
    const sig = [c.type, s.kind, norm(s.raw_text), c.from ? locKey(c.from) : '-', c.to ? locKey(c.to) : '-'].join('|');
    return { type: c.type, kind: s.kind, sig, raw: s.raw_text, bu: s.bu || '', project: s.project || '', booker: s.booker || '',
      material: s.material || '', from: c.from, to: c.to, inWeek: week, autoCause: cause, autoCounted: counted };
  });
}

// คำนวณรายการเปลี่ยนแปลงของทั้งสัปดาห์ใหม่ (เรียกหลังอัปโหลด/ลบฉบับ) — เก็บสาเหตุ/หมายเหตุ/ไฟล์แนบเดิมไว้
async function recompute(client, weekStart) {
  const revs = (await client.query(
    `SELECT id, rev_no, TO_CHAR(week_start,'YYYY-MM-DD') ws, TO_CHAR(week_end,'YYYY-MM-DD') we
       FROM rplan_revisions WHERE week_start = $1 ORDER BY rev_no`, [weekStart])).rows;
  const itemsOf = async id => (await client.query(
    `SELECT TO_CHAR(plan_date,'YYYY-MM-DD') plan_date, truck_no, plate, trip, kind, raw_text, material, booker, bu, project
       FROM rplan_items WHERE revision_id = $1`, [id])).rows;
  const seen = new Set();
  let prev = revs.length ? await itemsOf(revs[0].id) : null;
  for (let i = 1; i < revs.length; i++) {
    const cur = await itemsOf(revs[i].id);
    const changes = diffRevisions(prev, cur, revs[i].ws, revs[i].we);
    for (const c of changes) {
      const sig = revs[i].rev_no + '|' + c.sig;
      seen.add(sig);
      await client.query(
        `INSERT INTO rplan_changes (week_start, rev_no, sig, change_type, kind, raw_text, bu, project, booker, material,
            from_date, from_plate, from_trip, to_date, to_plate, to_trip, in_week, auto_cause, auto_counted, stale)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,FALSE)
         ON CONFLICT (week_start, sig) DO UPDATE SET rev_no = EXCLUDED.rev_no, raw_text = EXCLUDED.raw_text, bu = EXCLUDED.bu,
            project = EXCLUDED.project, booker = EXCLUDED.booker, material = EXCLUDED.material, in_week = EXCLUDED.in_week,
            auto_cause = EXCLUDED.auto_cause, auto_counted = EXCLUDED.auto_counted, stale = FALSE`,
        [weekStart, revs[i].rev_no, sig, c.type, c.kind, c.raw, c.bu, c.project, c.booker, c.material,
          c.from ? c.from.date : null, c.from ? c.from.plate : null, c.from ? c.from.trip : null,
          c.to ? c.to.date : null, c.to ? c.to.plate : null, c.to ? c.to.trip : null,
          c.inWeek, c.autoCause, c.autoCounted]);
    }
    prev = cur;
  }
  // รายการเดิมที่ไม่เกิดแล้ว: ถ้ามีข้อมูลที่คนกรอก/แนบ → เก็บไว้แต่ทำเครื่องหมาย, ไม่มี → ลบ
  const old = (await client.query(
    `SELECT c.id, c.sig, (c.cause IS NOT NULL OR c.counted IS NOT NULL OR COALESCE(c.note,'') <> ''
              OR EXISTS (SELECT 1 FROM rplan_attachments a WHERE a.change_id = c.id)) AS has_input
       FROM rplan_changes c WHERE c.week_start = $1`, [weekStart])).rows;
  for (const o of old) {
    if (seen.has(o.sig)) continue;
    if (o.has_input) await client.query('UPDATE rplan_changes SET stale = TRUE WHERE id = $1', [o.id]);
    else await client.query('DELETE FROM rplan_changes WHERE id = $1', [o.id]);
  }
}

// ------------------------------------------------------------
async function RPLAN_meta() {
  requireAdmin(this);
  return { causes: CAUSES, buList: BU_LIST.concat([BU_FURN_PUCHAO, BU_OTHER]), types: TYPE_TH };
}

async function RPLAN_upload(req) {
  requireAdmin(this);
  req = req || {};
  const { buf } = decodeDataUrl(req.dataUrl);
  if (buf.slice(0, 5).toString('latin1') !== '%PDF-') throw new UserError('รองรับเฉพาะไฟล์ PDF แผนเดินรถ');
  const fileName = str(req.fileName, 200);

  let revNo = req.revNo === '' || req.revNo == null ? null : Number(req.revNo);
  if (revNo == null) revNo = revFromName(fileName).rev;
  if (revNo == null || !Number.isInteger(revNo) || revNo < 0 || revNo > 99) {
    throw new UserError(`ระบุเลข Revise ของไฟล์ "${fileName}" ไม่ได้จากชื่อไฟล์ — กรุณาใส่เลข Revise เอง (ฉบับแรก = 0)`);
  }
  let plan;
  try { plan = await parsePlanPdf(buf); }
  catch (e) { throw new UserError(`อ่านไฟล์ "${fileName}" ไม่ได้: ${e.message}`); }
  const jobs = plan.items.filter(i => i.kind === 'job').length;
  if (!jobs) throw new UserError(`ไม่พบงานขนส่งในไฟล์ "${fileName}" — ไม่ใช่แผนเดินรถ หรือรูปแบบไฟล์เปลี่ยน`);

  const dir = path.join(STORE_DIR, plan.weekStart);
  fs.mkdirSync(dir, { recursive: true });
  const rel = path.join('route-plan', plan.weekStart, `rev${revNo}.pdf`);
  fs.writeFileSync(path.join(STORE_DIR, plan.weekStart, `rev${revNo}.pdf`), buf);

  const by = byName(this);
  const replaced = await withTx(async client => {
    const ex = await client.query('SELECT id FROM rplan_revisions WHERE week_start = $1 AND rev_no = $2', [plan.weekStart, revNo]);
    let revId;
    if (ex.rows.length) {
      revId = ex.rows[0].id;
      await client.query('DELETE FROM rplan_items WHERE revision_id = $1', [revId]);
      await client.query(`UPDATE rplan_revisions SET file_name=$2, file_path=$3, rev_date=$4, uploaded_by=$5, uploaded_at=NOW(), week_end=$6 WHERE id=$1`,
        [revId, fileName, rel, dateFromName(fileName), by, plan.weekEnd]);
    } else {
      revId = (await client.query(
        `INSERT INTO rplan_revisions (week_start, week_end, rev_no, rev_date, file_name, file_path, uploaded_by)
         VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id`,
        [plan.weekStart, plan.weekEnd, revNo, dateFromName(fileName), fileName, rel, by])).rows[0].id;
    }
    for (const it of plan.items) {
      await client.query(
        `INSERT INTO rplan_items (revision_id, plan_date, truck_no, plate, trip, kind, raw_text, origin, destination, material, booker, bu, project, in_week)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)`,
        [revId, it.planDate, it.truckNo, it.plate, it.trip, it.kind, it.text, it.origin, it.destination, it.material, it.booker, it.bu, it.project, it.inWeek]);
    }
    await recompute(client, plan.weekStart);
    return ex.rows.length > 0;
  });
  return { weekStart: plan.weekStart, weekEnd: plan.weekEnd, revNo, jobs, replaced };
}

const effCause = `COALESCE(c.cause, c.auto_cause, '')`;
const effCounted = `COALESCE(c.counted, c.auto_counted)`;
// เงื่อนไข "รายการที่นับเป็นการผิดแผน"
const COUNTED_SQL = `c.kind = 'job' AND c.in_week AND NOT c.stale AND ${effCounted}`;

async function RPLAN_weeks() {
  requireAdmin(this);
  return (await sitePool.query(`
    SELECT TO_CHAR(r.week_start,'YYYY-MM-DD') "weekStart", TO_CHAR(MAX(r.week_end),'YYYY-MM-DD') "weekEnd",
           COUNT(*)::int "revCount", MAX(r.rev_no)::int "lastRev", MIN(r.rev_no)::int "firstRev",
           (SELECT COUNT(*) FROM rplan_items i JOIN rplan_revisions r0 ON r0.id = i.revision_id
             WHERE r0.week_start = r.week_start AND r0.rev_no = MIN(r.rev_no) AND i.kind = 'job' AND i.in_week)::int "baseJobs",
           (SELECT COUNT(*) FROM rplan_changes c WHERE c.week_start = r.week_start AND ${COUNTED_SQL})::int "counted",
           (SELECT COUNT(*) FROM rplan_changes c WHERE c.week_start = r.week_start AND ${COUNTED_SQL} AND c.cause IS NULL)::int "pending"
      FROM rplan_revisions r GROUP BY r.week_start ORDER BY r.week_start DESC`)).rows;
}

async function RPLAN_week(weekStart) {
  requireAdmin(this);
  if (!isDate(weekStart)) throw new UserError('สัปดาห์ไม่ถูกต้อง');
  const revisions = (await sitePool.query(`
    SELECT r.id, r.rev_no "revNo", TO_CHAR(r.rev_date,'DD/MM/YYYY') "revDate", r.file_name "fileName", r.uploaded_by "uploadedBy",
           TO_CHAR(r.uploaded_at AT TIME ZONE '${TZ}','DD/MM/YYYY HH24:MI') "uploadedAt",
           TO_CHAR(r.week_end,'YYYY-MM-DD') "weekEnd",
           (SELECT COUNT(*) FROM rplan_items i WHERE i.revision_id = r.id AND i.kind = 'job' AND i.in_week)::int "jobs"
      FROM rplan_revisions r WHERE r.week_start = $1 ORDER BY r.rev_no`, [weekStart])).rows;
  if (!revisions.length) throw new UserError('ไม่พบข้อมูลสัปดาห์นี้');
  const changes = (await sitePool.query(`
    SELECT c.id, c.rev_no "revNo", c.change_type "type", c.kind, c.raw_text "text", c.bu, c.project, c.booker, c.material,
           TO_CHAR(c.from_date,'YYYY-MM-DD') "fromDate", c.from_plate "fromPlate", c.from_trip "fromTrip",
           TO_CHAR(c.to_date,'YYYY-MM-DD') "toDate", c.to_plate "toPlate", c.to_trip "toTrip",
           c.in_week "inWeek", c.auto_cause "autoCause", c.auto_counted "autoCounted", c.cause, c.counted, c.note, c.stale,
           ${effCause} "effCause", ${effCounted} "effCounted", c.reviewed_by "reviewedBy",
           TO_CHAR(c.reviewed_at AT TIME ZONE '${TZ}','DD/MM/YYYY HH24:MI') "reviewedAt",
           COALESCE((SELECT json_agg(json_build_object('id', a.id, 'name', a.file_name, 'mime', a.mime) ORDER BY a.id)
                       FROM rplan_attachments a WHERE a.change_id = c.id), '[]') "attachments"
      FROM rplan_changes c WHERE c.week_start = $1
     ORDER BY c.rev_no, COALESCE(c.to_date, c.from_date), c.change_type, c.id`, [weekStart])).rows;
  const base = revisions[0];
  const counted = changes.filter(c => c.kind === 'job' && c.inWeek && !c.stale && c.effCounted);
  return {
    weekStart, weekEnd: revisions[revisions.length - 1].weekEnd, revisions, changes,
    summary: {
      baseRev: base.revNo, baseJobs: base.jobs, counted: counted.length,
      pending: counted.filter(c => c.cause == null).length,
      pct: base.jobs ? Math.round(counted.length / base.jobs * 1000) / 10 : null,
      byType: ['add', 'cancel', 'move'].reduce((o, t) => (o[t] = counted.filter(c => c.type === t).length, o), {})
    }
  };
}

async function RPLAN_saveChange(id, req) {
  requireAdmin(this);
  req = req || {};
  const cause = req.cause == null || req.cause === '' ? null : str(req.cause, 200);
  if (cause && !CAUSES.some(c => c.name === cause)) throw new UserError('สาเหตุไม่ถูกต้อง');
  const counted = req.counted == null ? null : !!req.counted;
  const r = await sitePool.query(
    `UPDATE rplan_changes SET cause = $2, counted = $3, note = $4, reviewed_by = $5, reviewed_at = NOW() WHERE id = $1 RETURNING id`,
    [Number(id), cause, counted, str(req.note, 1000), byName(this)]);
  if (!r.rowCount) throw new UserError('ไม่พบรายการ');
  return { ok: true };
}

async function RPLAN_attach(changeId, req) {
  requireAdmin(this);
  req = req || {};
  const { mime, buf } = decodeDataUrl(req.dataUrl);
  let ext = '';
  if (buf.slice(0, 5).toString('latin1') === '%PDF-') ext = 'pdf';
  else if (buf[0] === 0xFF && buf[1] === 0xD8) ext = 'jpg';
  else if (buf.slice(1, 4).toString('latin1') === 'PNG') ext = 'png';
  else if (buf.slice(8, 12).toString('latin1') === 'WEBP') ext = 'webp';
  if (!ext) throw new UserError('รองรับไฟล์รูป (JPG/PNG/WEBP) หรือ PDF');
  const c = await sitePool.query('SELECT id, TO_CHAR(week_start,\'YYYY-MM-DD\') ws FROM rplan_changes WHERE id = $1', [Number(changeId)]);
  if (!c.rows.length) throw new UserError('ไม่พบรายการ');
  const dir = path.join(STORE_DIR, c.rows[0].ws, 'att');
  fs.mkdirSync(dir, { recursive: true });
  const name = `${c.rows[0].id}_${Date.now()}.${ext}`;
  fs.writeFileSync(path.join(dir, name), buf);
  const r = await sitePool.query(
    `INSERT INTO rplan_attachments (change_id, file_name, file_path, mime, uploaded_by) VALUES ($1,$2,$3,$4,$5) RETURNING id`,
    [c.rows[0].id, str(req.fileName, 200) || name, path.join('route-plan', c.rows[0].ws, 'att', name),
      ext === 'pdf' ? 'application/pdf' : (mime || 'image/' + ext), byName(this)]);
  return { id: r.rows[0].id };
}

async function RPLAN_deleteAttachment(id) {
  requireAdmin(this);
  const r = await sitePool.query('DELETE FROM rplan_attachments WHERE id = $1 RETURNING file_path', [Number(id)]);
  if (r.rows.length) fs.rmSync(path.join(__dirname, '..', 'storage', r.rows[0].file_path), { force: true });
  return { ok: true };
}

async function RPLAN_deleteRevision(id) {
  requireAdmin(this);
  const r = await sitePool.query('SELECT TO_CHAR(week_start,\'YYYY-MM-DD\') ws, file_path FROM rplan_revisions WHERE id = $1', [Number(id)]);
  if (!r.rows.length) throw new UserError('ไม่พบไฟล์');
  await withTx(async client => {
    await client.query('DELETE FROM rplan_revisions WHERE id = $1', [Number(id)]);
    await recompute(client, r.rows[0].ws);
  });
  if (r.rows[0].file_path) fs.rmSync(path.join(__dirname, '..', 'storage', r.rows[0].file_path), { force: true });
  return { ok: true };
}

async function RPLAN_report(req) {
  requireAdmin(this);
  req = req || {};
  const params = [];
  let where = '';
  if (isDate(req.from)) { params.push(req.from); where += ` AND w.week_start >= $${params.length}`; }
  if (isDate(req.to)) { params.push(req.to); where += ` AND w.week_start <= $${params.length}`; }
  const weeks = (await sitePool.query(`
    WITH w AS (SELECT week_start, MIN(rev_no) base_rev, MAX(rev_no) last_rev, COUNT(*) revs FROM rplan_revisions GROUP BY week_start)
    SELECT TO_CHAR(w.week_start,'YYYY-MM-DD') "weekStart", w.revs::int "revCount", w.base_rev::int "baseRev",
           (SELECT COUNT(*) FROM rplan_items i JOIN rplan_revisions r ON r.id = i.revision_id
             WHERE r.week_start = w.week_start AND r.rev_no = w.base_rev AND i.kind = 'job' AND i.in_week)::int "baseJobs",
           (SELECT COUNT(*) FROM rplan_changes c WHERE c.week_start = w.week_start AND ${COUNTED_SQL})::int "counted",
           (SELECT COUNT(*) FROM rplan_changes c WHERE c.week_start = w.week_start AND ${COUNTED_SQL} AND c.change_type='add')::int "add",
           (SELECT COUNT(*) FROM rplan_changes c WHERE c.week_start = w.week_start AND ${COUNTED_SQL} AND c.change_type='cancel')::int "cancel",
           (SELECT COUNT(*) FROM rplan_changes c WHERE c.week_start = w.week_start AND ${COUNTED_SQL} AND c.change_type='move')::int "move"
      FROM w WHERE 1=1 ${where} ORDER BY w.week_start`, params)).rows;
  weeks.forEach(w => { w.pct = w.baseJobs ? Math.round(w.counted / w.baseJobs * 1000) / 10 : null; });

  const by = async col => (await sitePool.query(`
    SELECT COALESCE(NULLIF(${col}, ''), '(ไม่ระบุ)') "key",
           COUNT(*)::int total,
           COUNT(*) FILTER (WHERE c.change_type = 'add')::int "add",
           COUNT(*) FILTER (WHERE c.change_type = 'cancel')::int "cancel",
           COUNT(*) FILTER (WHERE c.change_type = 'move')::int "move"
      FROM rplan_changes c JOIN (SELECT DISTINCT week_start FROM rplan_revisions) w ON w.week_start = c.week_start
     WHERE ${COUNTED_SQL} ${where}
     GROUP BY 1 ORDER BY total DESC, 1`, params)).rows;
  // งานตั้งต้นต่อ BU/โครงการ (ใช้คิด % ราย BU)
  const baseBy = async col => (await sitePool.query(`
    WITH w AS (SELECT week_start, MIN(rev_no) base_rev FROM rplan_revisions GROUP BY week_start)
    SELECT COALESCE(NULLIF(${col}, ''), '(ไม่ระบุ)') "key", COUNT(*)::int n
      FROM rplan_items i JOIN rplan_revisions r ON r.id = i.revision_id JOIN w ON w.week_start = r.week_start AND w.base_rev = r.rev_no
     WHERE i.kind = 'job' AND i.in_week ${where} GROUP BY 1`, params)).rows
    .reduce((o, r) => (o[r.key] = r.n, o), {});
  const withBase = (rows, base) => rows.map(r => Object.assign(r, { base: base[r.key] || 0,
    pct: base[r.key] ? Math.round(r.total / base[r.key] * 1000) / 10 : null }));

  const [buRows, projRows, bookerRows, causeRows, buBase, projBase, bookerBase] = await Promise.all([
    by('c.bu'), by('c.project'), by('c.booker'), by(effCause),
    baseBy('i.bu'), baseBy('i.project'), baseBy('i.booker')]);
  const tot = weeks.reduce((o, w) => (o.base += w.baseJobs, o.counted += w.counted, o), { base: 0, counted: 0 });
  return {
    weeks,
    total: { baseJobs: tot.base, counted: tot.counted, pct: tot.base ? Math.round(tot.counted / tot.base * 1000) / 10 : null },
    byBu: withBase(buRows, buBase), byProject: withBase(projRows, projBase), byBooker: withBase(bookerRows, bookerBase),
    byCause: causeRows.map(r => Object.assign(r, { key: r.key === '' || r.key === '(ไม่ระบุ)' ? 'ยังไม่ระบุสาเหตุ' : r.key }))
  };
}

module.exports = {
  diffRevisions, CAUSES, STORE_DIR,
  functions: { RPLAN_meta, RPLAN_upload, RPLAN_weeks, RPLAN_week, RPLAN_saveChange, RPLAN_attach, RPLAN_deleteAttachment, RPLAN_deleteRevision, RPLAN_report }
};
