// ============================================================
// คลังเอกสาร PDF ทุกระบบ (เฉพาะ admin) — หน้า /documents
//
//   DOCS_list({ system, q, from, to, status })   รวม PDF: เช็คลิสต์ที่ลงนามครบ / ใบสั่งงาน NPO / ใบเบิกวัสดุ
//   DOCS_signLog({ q, from, to })                ประวัติการลงนามเช็คลิสต์
//
// ไฟล์จริงอยู่ที่เดิมของแต่ละระบบ หน้านี้แค่รวมรายการ:
//   เช็คลิสต์  checklist_pdf_archive   → public/uploads/checklist-pdf/
//   NPO       npo_reports.pdf_path    → public/uploads/npo/
//   ใบเบิก    transport_docs          → storage/transport-docs/ (เปิดผ่าน /api/transport-doc ต้อง login)
// ============================================================
const { sitePool } = require('../db');
const { UserError } = require('./common');

const TZ = 'Asia/Bangkok';
const LIMIT = 500;
const str = (v, max) => String(v == null ? '' : v).trim().slice(0, max || 200);

function requireAdmin(ctx) {
  if (!(ctx && ctx.user && ctx.user.role === 'admin')) throw new UserError('ต้องใช้บัญชีผู้ดูแลระบบ (admin)');
}
function isoDate(v) {
  const s = str(v, 10);
  return /^\d{4}-\d{2}-\d{2}$/.test(s) ? s : null;
}
const fmt = col => `TO_CHAR(${col}, 'DD/MM/YYYY')`;
const fmtTs = col => `TO_CHAR(${col} AT TIME ZONE '${TZ}', 'DD/MM/YYYY HH24:MI')`;

async function DOCS_list(req) {
  requireAdmin(this);
  req = req || {};
  const system = str(req.system, 20);
  const q = str(req.q, 100);
  const from = isoDate(req.from), to = isoDate(req.to);
  const status = str(req.status, 20);   // '' | current | old
  const like = q ? '%' + q.replace(/[\\%_]/g, m => '\\' + m) + '%' : null;
  const out = [];

  if (!system || system === 'checklist') {
    const r = await sitePool.query(
      `SELECT a.id, a.checklist_id, a.site_name, a.building, a.floor, ${fmt('a.inspection_date')} AS doc_date, a.inspection_date AS sort_date,
              a.recorded_by, a.signer2, a.signer3, ${fmtTs('a.signer2_at')} AS s2_at, ${fmtTs('a.signer3_at')} AS s3_at,
              a.file_path, a.created_by, ${fmtTs('a.created_at')} AS created, a.created_at,
              a.superseded_at IS NOT NULL AS old, a.superseded_reason
         FROM checklist_pdf_archive a
        WHERE ($1::text IS NULL OR a.site_name ILIKE $1 OR a.signer2 ILIKE $1 OR a.signer3 ILIKE $1 OR a.recorded_by ILIKE $1
               OR (a.building || ' ชั้น ' || a.floor) ILIKE $1)
          AND ($2::date IS NULL OR a.inspection_date >= $2) AND ($3::date IS NULL OR a.inspection_date <= $3)
          AND ($4 = '' OR ($4 = 'old') = (a.superseded_at IS NOT NULL))
        ORDER BY a.created_at DESC LIMIT ${LIMIT}`, [like, from, to, status]);
    r.rows.forEach(x => out.push({
      system: 'checklist', systemLabel: 'เช็คลิสต์ตรวจพื้นที่',
      title: 'เช็คลิสต์ #' + x.checklist_id + (x.building ? ' · ' + x.building + ' ชั้น ' + x.floor : ''), project: x.site_name, docDate: x.doc_date,
      people: [x.recorded_by && 'บันทึก ' + x.recorded_by, x.signer2 && 'GM/ธุรการ ' + x.signer2 + (x.s2_at ? ' (' + x.s2_at + ')' : ''),
        x.signer3 && 'GF/GE ' + x.signer3 + (x.s3_at ? ' (' + x.s3_at + ')' : '')].filter(Boolean).join(' · '),
      by: x.created_by, created: x.created, status: x.old ? 'old' : 'current',
      statusLabel: x.old ? 'ถูกแทนที่' + (x.superseded_reason ? ' — ' + x.superseded_reason : '') : 'ฉบับปัจจุบัน',
      url: encodeURI(x.file_path), checklistId: x.checklist_id, _sort: x.created_at
    }));
  }

  if (!system || system === 'npo') {
    const r = await sitePool.query(
      `SELECT n.id, n.npo_no, n.truck_type, p.name AS project, ${fmt('n.date_from')} AS d1, ${fmt('n.date_to')} AS d2,
              n.trip_count, n.total_cost, n.pdf_path, n.status, n.cancel_reason, n.created_by,
              n.receiver_name, n.approver_name, ${fmtTs('n.created_at')} AS created, n.created_at
         FROM npo_reports n LEFT JOIN projects p ON p.id = n.project_id
        WHERE n.pdf_path IS NOT NULL AND n.pdf_path <> ''
          AND ($1::text IS NULL OR n.npo_no ILIKE $1 OR p.name ILIKE $1 OR n.truck_type ILIKE $1 OR n.created_by ILIKE $1)
          AND ($2::date IS NULL OR n.date_to >= $2) AND ($3::date IS NULL OR n.date_from <= $3)
          AND ($4 = '' OR ($4 = 'old') = (n.status = 'cancelled'))
        ORDER BY n.created_at DESC LIMIT ${LIMIT}`, [like, from, to, status]);
    r.rows.forEach(x => out.push({
      system: 'npo', systemLabel: 'ใบสั่งงาน NPO (ขยะ)',
      title: x.npo_no + ' · ' + x.truck_type, project: x.project || '', docDate: x.d1 === x.d2 ? x.d1 : x.d1 + ' – ' + x.d2,
      people: [x.trip_count + ' เที่ยว · ' + Number(x.total_cost).toLocaleString('th-TH') + ' บาท',
        x.receiver_name && 'ผู้รับ ' + x.receiver_name, x.approver_name && 'ผู้อนุมัติ ' + x.approver_name].filter(Boolean).join(' · '),
      by: x.created_by || '', created: x.created, status: x.status === 'cancelled' ? 'old' : 'current',
      statusLabel: x.status === 'cancelled' ? 'ยกเลิก' + (x.cancel_reason ? ' — ' + x.cancel_reason : '') : 'ออกแล้ว',
      url: encodeURI(x.pdf_path), _sort: x.created_at
    }));
  }

  if (!system || system === 'transport') {
    const r = await sitePool.query(
      `SELECT d.project_code, d.doc_no, d.original_name, ${fmt('d.doc_date')} AS doc_date, d.uploaded_by,
              ${fmtTs('d.uploaded_at')} AS created, d.uploaded_at, tp.name AS project_name,
              (SELECT COUNT(*)::int FROM material_transport_logs l WHERE l.project_code = d.project_code AND l.doc_no = d.doc_no) AS rows
         FROM transport_docs d LEFT JOIN transport_projects tp ON tp.code = d.project_code
        WHERE ($1::text IS NULL OR d.doc_no ILIKE $1 OR d.project_code ILIKE $1 OR tp.name ILIKE $1 OR d.uploaded_by ILIKE $1)
          AND ($2::date IS NULL OR d.doc_date >= $2) AND ($3::date IS NULL OR d.doc_date <= $3)
          AND ($4 <> 'old')
        ORDER BY d.uploaded_at DESC LIMIT ${LIMIT}`, [like, from, to, status]);
    r.rows.forEach(x => out.push({
      system: 'transport', systemLabel: 'ใบเบิกวัสดุ (ขนส่ง)',
      title: x.doc_no, project: x.project_code + (x.project_name ? ' ' + x.project_name : ''), docDate: x.doc_date || '',
      people: 'ผูกกับ ' + x.rows + ' แถว' + (x.original_name ? ' · ไฟล์ ' + x.original_name : ''),
      by: x.uploaded_by || '', created: x.created, status: 'current', statusLabel: 'แนบแล้ว',
      url: '/api/transport-doc/' + encodeURIComponent(x.project_code) + '/' + encodeURIComponent(x.doc_no), _sort: x.uploaded_at
    }));
  }

  out.sort((a, b) => new Date(b._sort) - new Date(a._sort));
  out.forEach(x => delete x._sort);
  return { rows: out.slice(0, LIMIT), truncated: out.length > LIMIT };
}

async function DOCS_signLog(req) {
  requireAdmin(this);
  req = req || {};
  const q = str(req.q, 100);
  const like = q ? '%' + q.replace(/[\\%_]/g, m => '\\' + m) + '%' : null;
  const from = isoDate(req.from), to = isoDate(req.to);
  const r = await sitePool.query(
    `SELECT id, checklist_id AS "checklistId", site_name AS site, ${fmt('inspection_date')} AS "docDate",
            action, slot, signer_name AS name, username, method, viewed, confirmed, login_user AS "sessionUser",
            ${fmtTs('created_at')} AS at
       FROM checklist_sign_log
      WHERE ($1::text IS NULL OR site_name ILIKE $1 OR signer_name ILIKE $1 OR username ILIKE $1)
        AND ($2::date IS NULL OR (created_at AT TIME ZONE '${TZ}')::date >= $2)
        AND ($3::date IS NULL OR (created_at AT TIME ZONE '${TZ}')::date <= $3)
      ORDER BY created_at DESC LIMIT ${LIMIT}`, [like, from, to]);
  return r.rows;
}

module.exports = { functions: { DOCS_list, DOCS_signLog } };
