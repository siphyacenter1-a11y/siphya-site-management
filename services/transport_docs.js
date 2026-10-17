// ============================================================
// ใบเบิกวัสดุ (PDF) ของระบบขนส่ง
//
//   TRANSPORT_uploadDoc(code, { fileName, dataUrl, docNo?, rowId? })
//       เก็บไฟล์ + อ่านข้อความใน PDF (เลขที่ / วันที่ / โครงการ / Mat. Code + จำนวน)
//       - ส่ง rowId มา  → ผูกกับแถวนั้นแถวเดียว
//       - ไม่ส่ง rowId  → จับคู่แถวให้อัตโนมัติ: วันที่เบิก + Mat. Code + จำนวน ตรงกับในใบ
//       เลขที่ใบเบิก: ที่พิมพ์มา > ที่อ่านได้จาก PDF > จากชื่อไฟล์
//       ส่งไฟล์เลขเดิมซ้ำ = แทนที่ไฟล์เดิม
//   TRANSPORT_listDocs(code)       ใบเบิกที่แนบแล้วของโครงการ
//
// ไฟล์เก็บที่ storage/transport-docs/<โครงการ>/ (นอก public) เปิดผ่าน /api/transport-doc/<โครงการ>/<เลขที่>
// ซึ่งต้อง login ก่อน
// ============================================================
const fs = require('fs');
const path = require('path');
const { sitePool } = require('../db');
const { UserError, withTx } = require('./common');
const { pdfText } = require('./pdftext');

const DOC_DIR = path.join(__dirname, '..', 'storage', 'transport-docs');
const MAX_BYTES = 15 * 1024 * 1024;

const str = (v, max) => String(v == null ? '' : v).trim().slice(0, max || 500);
function codeOf(code) {
  const c = str(code, 10).toUpperCase();
  if (!/^[A-Z0-9]{2,10}$/.test(c)) throw new UserError('รหัสโครงการไม่ถูกต้อง');
  return c;
}
function userName(ctx) { return (ctx && ctx.user && (ctx.user.username || ctx.user.full_name)) || ''; }

// เลขที่ใบเบิก เช่น M-2023006-06285
function normDocNo(v) {
  const s = str(v, 40).toUpperCase().replace(/\s+/g, '');
  return /^[A-Z0-9][A-Z0-9\-_.]{2,39}$/.test(s) ? s : '';
}
const DOC_RE = /\b([A-Z]{1,3}-\d{5,}-\d{3,})\b/;
const fileSafe = s => s.replace(/[^A-Z0-9\-_.]/g, '_');

// แปลงข้อความใน PDF เป็นข้อมูลใบเบิก
function parseRequisition(text) {
  const t = String(text || '').replace(/ /g, ' ');
  const out = { docNo: '', date: '', project: '', items: [] };
  let m = t.match(/เลขที่\s*:?\s*([A-Z]{1,3}-\d{5,}-\d{3,})/) || t.match(DOC_RE);
  if (m) out.docNo = m[1];
  m = t.match(/วันที่\s*:\s*(\d{1,2})\/(\d{1,2})\/(\d{4})/);
  if (m) {
    let y = Number(m[3]);
    if (y > 2400) y -= 543;   // ปี พ.ศ.
    out.date = `${y}-${m[2].padStart(2, '0')}-${m[1].padStart(2, '0')}`;
  }
  m = t.match(/\(\s*([A-Z0-9]{2,6})\s*\)/);
  if (m) out.project = m[1];
  // รายการ: Mat. Code แล้วตามด้วยจำนวนทศนิยม 2 ตำแหน่ง ก่อนถึง Mat. Code ถัดไป
  const codeRe = /\b([A-Z]{2}\d{10,14})\b/g;
  const hits = [];
  let h;
  while ((h = codeRe.exec(t))) hits.push({ code: h[1], at: h.index, end: codeRe.lastIndex });
  hits.forEach((x, i) => {
    const seg = t.slice(x.end, i + 1 < hits.length ? hits[i + 1].at : undefined);
    const q = seg.match(/(\d{1,3}(?:,\d{3})+|\d+)\.\d{1,3}\b/);
    // พื้นที่ เช่น "อาคาร C ชั้น 9" ใช้ช่วยเลือกแถวเมื่อมีหลายแถวตรงกัน
    const a = seg.match(/อาคาร\s*([A-Za-z0-9ก-๙]+)\s*ชั้น\s*([A-Za-z0-9]+)/);
    out.items.push({ matCode: x.code, qty: q ? Number(q[0].replace(/,/g, '')) : null,
      building: a ? 'อาคาร' + a[1].toUpperCase() : '', floor: a ? a[2].toUpperCase() : '' });
  });
  return out;
}

async function TRANSPORT_uploadDoc(projectCode, req) {
  const code = codeOf(projectCode);
  req = req || {};
  const by = userName(this);
  const m = String(req.dataUrl || '').match(/^data:([\w\/+.-]*);base64,(.+)$/);
  if (!m) throw new UserError('ไฟล์ไม่ถูกต้อง');
  const buf = Buffer.from(m[2], 'base64');
  if (!buf.length || buf.length > MAX_BYTES) throw new UserError('ไฟล์ต้องมีขนาดไม่เกิน 15 MB');
  if (buf.slice(0, 5).toString('latin1') !== '%PDF-') throw new UserError('รองรับเฉพาะไฟล์ PDF');

  let info = { docNo: '', date: '', project: '', items: [] };
  let readable = true;
  try { info = parseRequisition(await pdfText(buf, 10)); } catch (e) { readable = false; }

  const fromName = (str(req.fileName, 200).toUpperCase().match(DOC_RE) || [])[1] || '';
  const docNo = normDocNo(req.docNo) || normDocNo(info.docNo) || normDocNo(fromName);
  if (!docNo) {
    throw new UserError(`${req.fileName || 'ไฟล์นี้'}: หาเลขที่ใบเบิกไม่เจอ ` +
      '(ไฟล์อาจเป็นภาพสแกน) — พิมพ์เลขที่ใบเบิกในแถวนั้นก่อน แล้วกด 📎 แนบในแถว');
  }
  if (info.project && info.project !== code) {
    throw new UserError(`ใบเบิก ${docNo} เป็นของโครงการ ${info.project} ไม่ใช่ ${code}`);
  }

  return withTx(async client => {
    const p = await client.query('SELECT 1 FROM transport_projects WHERE code = $1', [code]);
    if (!p.rows.length) throw new UserError('ไม่พบโครงการ ' + code);
    await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', ['tdoc_' + code]);

    // เก็บไฟล์
    const dir = path.join(DOC_DIR, code);
    fs.mkdirSync(dir, { recursive: true });
    const fileName = fileSafe(docNo) + '.pdf';
    await fs.promises.writeFile(path.join(dir, fileName), buf);
    await client.query(
      `INSERT INTO transport_docs (project_code, doc_no, file_name, original_name, doc_date, uploaded_by)
       VALUES ($1,$2,$3,$4,$5,$6)
       ON CONFLICT (project_code, doc_no) DO UPDATE SET file_name = EXCLUDED.file_name,
         original_name = EXCLUDED.original_name, doc_date = COALESCE(EXCLUDED.doc_date, transport_docs.doc_date),
         uploaded_by = EXCLUDED.uploaded_by, uploaded_at = NOW()`,
      [code, docNo, fileName, str(req.fileName, 200), info.date || null, by]);

    const linked = [];
    const unmatched = [];
    if (req.rowId) {
      const u = await client.query(
        `UPDATE material_transport_logs SET doc_no = $1, updated_at = NOW(), updated_by = $2
          WHERE id = $3 AND project_code = $4 RETURNING id`, [docNo, by, Number(req.rowId), code]);
      if (!u.rowCount) throw new UserError('ไม่พบแถวที่จะแนบ (อาจถูกลบไปแล้ว) กรุณาโหลดใหม่');
      linked.push(Number(req.rowId));
    } else if (info.date && info.items.length) {
      const used = [];   // แถวที่นับให้ใบนี้แล้วในรอบนี้ (กันผูกซ้ำเมื่ออัปไฟล์เดิมอีกครั้ง)
      for (const it of info.items) {
        const byArea = `ORDER BY (REPLACE(COALESCE(building, ''), ' ', '') = $6 AND UPPER(COALESCE(floor, '')) = $7) DESC, id LIMIT 1`;
        const base = `project_code = $1 AND request_date = $2 AND UPPER(mat_code) = $3
              AND ($4::numeric IS NULL OR quantity = $4) AND NOT (id = ANY($5::int[]))`;
        const args = [code, info.date, it.matCode, it.qty, used, it.building, it.floor];
        // 1) มีแถวที่ผูกใบนี้อยู่แล้ว → นับว่าครบ ไม่ผูกเพิ่ม
        const had = await client.query(`SELECT id FROM material_transport_logs WHERE ${base} AND doc_no = $8 ${byArea}`, [...args, docNo]);
        if (had.rows.length) { used.push(had.rows[0].id); continue; }
        // 2) ผูกแถวที่ยังไม่มีใบเบิก (อาคาร/ชั้นตรงก่อน)
        const r = await client.query(`SELECT id FROM material_transport_logs WHERE ${base} AND COALESCE(doc_no, '') = '' ${byArea}`, args);
        if (r.rows.length) {
          await client.query(
            `UPDATE material_transport_logs SET doc_no = $1, updated_at = NOW(), updated_by = $2 WHERE id = $3`,
            [docNo, by, r.rows[0].id]);
          used.push(r.rows[0].id);
          linked.push(r.rows[0].id);
        } else {
          unmatched.push(it);
        }
      }
    }
    const total = (await client.query(
      'SELECT COUNT(*)::int AS n FROM material_transport_logs WHERE project_code = $1 AND doc_no = $2', [code, docNo])).rows[0].n;
    return { docNo, date: info.date, readable, items: info.items, linked, unmatched, rowsWithDoc: total };
  });
}

async function TRANSPORT_listDocs(projectCode) {
  const code = codeOf(projectCode);
  const r = await sitePool.query(
    `SELECT d.doc_no AS "docNo", TO_CHAR(d.doc_date, 'DD/MM/YYYY') AS date, d.original_name AS "originalName",
            d.uploaded_by AS "uploadedBy", TO_CHAR(d.uploaded_at AT TIME ZONE 'Asia/Bangkok', 'DD/MM/YYYY HH24:MI') AS "uploadedAt",
            (SELECT COUNT(*)::int FROM material_transport_logs l WHERE l.project_code = d.project_code AND l.doc_no = d.doc_no) AS rows
       FROM transport_docs d WHERE d.project_code = $1 ORDER BY d.doc_date DESC NULLS LAST, d.doc_no DESC`, [code]);
  return r.rows;
}

// ใช้กับ route ดาวน์โหลด
async function docFilePath(projectCode, docNo) {
  const code = codeOf(projectCode);
  const no = normDocNo(docNo);
  if (!no) return null;
  const r = await sitePool.query('SELECT file_name FROM transport_docs WHERE project_code = $1 AND doc_no = $2', [code, no]);
  if (!r.rows.length) return null;
  const f = path.join(DOC_DIR, code, path.basename(r.rows[0].file_name));
  return fs.existsSync(f) ? { file: f, docNo: no } : null;
}

module.exports = {
  parseRequisition, normDocNo, docFilePath,
  functions: { TRANSPORT_uploadDoc, TRANSPORT_listDocs }
};
