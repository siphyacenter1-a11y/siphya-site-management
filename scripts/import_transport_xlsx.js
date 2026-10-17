// ============================================================
// นำเข้าข้อมูลระบบขนส่งวัสดุจาก Google Sheet (ดาวน์โหลดเป็น .xlsx)
//
//   node scripts/import_transport_xlsx.js <ไฟล์.xlsx>            นำเข้าทุกอย่าง
//   node scripts/import_transport_xlsx.js <ไฟล์.xlsx> --dry-run  ดูว่าจะนำเข้าอะไรบ้าง ไม่บันทึก
//   node scripts/import_transport_xlsx.js <ไฟล์.xlsx> --replace-buildings
//        ใช้อาคาร/ชั้นจากแท็บ Build_ ทับของเดิมทุกโครงการ (ปกติจะไม่ทับโครงการที่ตั้งอาคารไว้แล้ว)
//
// อ่านแท็บ:  Projects, MasterData, Build_<รหัส>, Log_<รหัส>
// รันซ้ำได้: รายการที่เคยนำเข้าจากชีต (source = 'sheet') ของโครงการนั้นจะถูกแทนที่ด้วยชุดใหม่
//            รายการที่กรอกบนเว็บ (source = 'web') ไม่ถูกแตะ
//            เลขที่ใบเบิกที่แนบไว้กับแถวจากชีต จะถูกผูกกลับให้แถวเดิมหลังนำเข้า (เทียบ ลำดับ+วันที่+Mat. Code+จำนวน)
//            อาคาร/ชั้น: นำเข้าเฉพาะโครงการที่ยังไม่มีอาคารในระบบ (ที่ตั้งไว้บนเว็บจะไม่ถูกทับ)
//            ถ้าต้องการทับให้ใส่ --replace-buildings
// ใช้ค่าที่คำนวณไว้แล้วในชีต (ไม่ใช่สูตร) ไม่ต้องแก้ไฟล์ก่อน และไม่ต้องเปิด/Save ใน Excel
// ============================================================
const path = require('path');
const ExcelJS = require('exceljs');
const { sitePool } = require('../db');
const { cellText } = require('../services/transport');

function val(cell) {
  let v = cell && cell.value;
  if (v && typeof v === 'object' && !(v instanceof Date)) {
    if ('result' in v) v = v.result;                       // สูตร → ใช้ผลลัพธ์
    else if (v.richText) v = v.richText.map(t => t.text).join('');
    else if ('text' in v) v = v.text;                      // hyperlink
    else if (v.error) v = null;
  }
  return v === undefined ? null : v;
}
function text(v) { return v == null ? '' : (v instanceof Date ? dateKey(v) : cellText(v)); }
function dateKey(v) {
  if (v instanceof Date && !isNaN(v)) {
    return `${v.getUTCFullYear()}-${String(v.getUTCMonth() + 1).padStart(2, '0')}-${String(v.getUTCDate()).padStart(2, '0')}`;
  }
  const s = String(v || '').trim();
  let m = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  if (m) return `${m[3]}-${m[2].padStart(2, '0')}-${m[1].padStart(2, '0')}`;
  m = s.match(/^(\d{4})-(\d{2})-(\d{2})/);
  return m ? `${m[1]}-${m[2]}-${m[3]}` : null;
}
function rowsOf(ws) {
  const out = [];
  ws.eachRow({ includeEmpty: false }, (row, n) => {
    const vals = [];
    for (let c = 1; c <= Math.max(ws.columnCount, 16); c++) vals.push(val(row.getCell(c)));
    out.push({ n, vals });
  });
  return out;
}

async function main() {
  const file = process.argv[2];
  const dry = process.argv.includes('--dry-run');
  const replaceBuildings = process.argv.includes('--replace-buildings');
  if (!file) { console.log('วิธีใช้: node scripts/import_transport_xlsx.js <ไฟล์.xlsx> [--dry-run]'); process.exitCode = 1; return; }

  const wb = new ExcelJS.Workbook();
  await wb.xlsx.readFile(path.resolve(file));
  const sheet = name => wb.worksheets.find(w => w.name.trim() === name);

  // ---------- Projects ----------
  const projects = [];
  const pws = sheet('Projects');
  if (pws) {
    rowsOf(pws).filter(r => r.n > 1).forEach((r, i) => {
      const code = text(r.vals[0]).toUpperCase();
      if (!/^[A-Z0-9]{2,10}$/.test(code)) return;
      projects.push({ code, name: text(r.vals[1]) || code, logo: text(r.vals[2]), active: text(r.vals[3]).toUpperCase() !== 'N', note: text(r.vals[4]), order: i + 1 });
    });
  }

  // ---------- MasterData ----------
  const master = [];
  const mws = sheet('MasterData');
  if (mws) {
    rowsOf(mws).filter(r => r.n > 1).forEach(r => {
      const code = text(r.vals[0]).toUpperCase();
      if (!code) return;
      master.push([code, text(r.vals[1]), text(r.vals[2]), text(r.vals[3]), text(r.vals[4]), text(r.vals[5]), text(r.vals[6]), text(r.vals[7])]);
    });
  }

  // ---------- Build_<รหัส>: แถว 1 = ชื่ออาคาร (คอลัมน์ละอาคาร), แถวถัดไป = ชั้น ----------
  const floors = {};
  wb.worksheets.filter(w => /^Build_/i.test(w.name)).forEach(ws => {
    const code = ws.name.replace(/^Build_/i, '').trim().toUpperCase();
    const rows = rowsOf(ws);
    const head = rows.find(r => r.n === 1);
    if (!head) return;
    const list = [];
    head.vals.forEach((h, c) => {
      const name = text(h).replace(/^[A-Z0-9]+\|/i, '');   // ตัด "0DJ|" แบบเก่าออก
      if (!name) return;
      const fl = rows.filter(r => r.n > 1).map(r => text(r.vals[c])).filter(Boolean);
      list.push({ name, floors: [...new Set(fl)] });
    });
    floors[code] = list;
  });

  // ---------- Log_<รหัส> ----------
  const logs = {};
  const problems = [];
  wb.worksheets.filter(w => /^Log_/i.test(w.name)).forEach(ws => {
    const code = ws.name.replace(/^Log_/i, '').trim().toUpperCase();
    logs[code] = [];
    rowsOf(ws).filter(r => r.n > 1).forEach(r => {
      const v = r.vals;
      const hasData = [1, 2, 4, 7, 9, 13].some(i => v[i] !== null && v[i] !== '');
      if (!hasData) return;
      const req = dateKey(v[1]), rec = dateKey(v[2]);
      if (v[1] && !req) problems.push(`${ws.name} แถว ${r.n}: วันที่เบิกอ่านไม่ได้ (${v[1]})`);
      const qty = v[9] === null || v[9] === '' ? null : Number(v[9]);
      logs[code].push({
        log_order: Number(v[0]) || null, request_date: req, receive_date: rec, status: text(v[3]),
        mat_code: text(v[4]).toUpperCase(), mat_type: text(v[5]), mat_item: text(v[6]), building: text(v[7]),
        floor: text(v[8]), quantity: isFinite(qty) ? qty : null, unit: text(v[10]), warehouse: text(v[11]),
        status2: text(v[12]), requester_receiver: text(v[13]), note: text(v[14])
      });
    });
  });

  // ---------- สรุป ----------
  console.log('ไฟล์:', path.basename(file));
  console.log(`โครงการ ${projects.length} | MasterData ${master.length} รายการ`);
  Object.keys(floors).forEach(c => console.log(`  Build_${c}: ${floors[c].map(b => `${b.name} (${b.floors.length} ชั้น)`).join(', ')}`));
  Object.keys(logs).forEach(c => console.log(`  Log_${c}: ${logs[c].length} แถว`));
  problems.forEach(p => console.log('  ⚠️ ', p));
  // โครงการที่มีอาคารในระบบอยู่แล้ว → ไม่ทับ (เว้นแต่สั่ง --replace-buildings)
  const existing = new Set((await sitePool.query('SELECT DISTINCT project_code FROM transport_floors').catch(() => ({ rows: [] }))).rows.map(r => r.project_code));
  const keep = replaceBuildings ? [] : Object.keys(floors).filter(c => existing.has(c));
  if (keep.length) console.log(`  อาคาร/ชั้น ที่มีในระบบแล้ว ไม่ทับ: ${keep.join(', ')} (ถ้าต้องการทับให้ใส่ --replace-buildings)`);
  keep.forEach(c => delete floors[c]);
  if (dry) { console.log('\n(--dry-run ไม่ได้บันทึกอะไร)'); return; }

  const client = await sitePool.connect();
  try {
    await client.query('BEGIN');
    for (const p of projects) {
      await client.query(
        `INSERT INTO transport_projects (code, name, logo_text, active, note, sort_order) VALUES ($1,$2,$3,$4,$5,$6)
         ON CONFLICT (code) DO UPDATE SET name = EXCLUDED.name, logo_text = EXCLUDED.logo_text,
           active = EXCLUDED.active, note = EXCLUDED.note, sort_order = EXCLUDED.sort_order`,
        [p.code, p.name, p.logo, p.active, p.note, p.order]);
    }
    for (const code of new Set([...Object.keys(floors), ...Object.keys(logs)])) {
      // โครงการที่มีแท็บแต่ไม่อยู่ใน Projects → สร้างให้ (ปิดไว้ก่อน)
      await client.query(
        `INSERT INTO transport_projects (code, name, active, sort_order) VALUES ($1, $2, FALSE, 999) ON CONFLICT (code) DO NOTHING`, [code, code]);
    }
    for (const m of master) {
      await client.query(
        `INSERT INTO material_master (mat_code, type_code, type_name, group_code, group_name, sub_group, description, unit)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
         ON CONFLICT (mat_code) DO UPDATE SET type_code = EXCLUDED.type_code, type_name = EXCLUDED.type_name,
           group_code = EXCLUDED.group_code, group_name = EXCLUDED.group_name, sub_group = EXCLUDED.sub_group,
           description = EXCLUDED.description, unit = EXCLUDED.unit`, m);
    }
    for (const [code, list] of Object.entries(floors)) {
      await client.query('DELETE FROM transport_floors WHERE project_code = $1', [code]);
      for (let bi = 0; bi < list.length; bi++) {
        for (let fi = 0; fi < list[bi].floors.length; fi++) {
          await client.query(
            'INSERT INTO transport_floors (project_code, building, floor, b_order, f_order) VALUES ($1,$2,$3,$4,$5)',
            [code, list[bi].name, list[bi].floors[fi], bi, fi]);
        }
      }
    }
    let relinked = 0, lostDocs = [];
    for (const [code, list] of Object.entries(logs)) {
      // เก็บเลขที่ใบเบิกของแถวจากชีตไว้ก่อนลบ แล้วผูกกลับหลังนำเข้า
      const keep = (await client.query(
        `SELECT log_order, TO_CHAR(request_date, 'YYYY-MM-DD') AS d, UPPER(mat_code) AS m, quantity::float AS q, doc_no
           FROM material_transport_logs WHERE project_code = $1 AND source = 'sheet' AND COALESCE(doc_no, '') <> ''`, [code])).rows;
      await client.query("DELETE FROM material_transport_logs WHERE project_code = $1 AND source = 'sheet'", [code]);
      for (const r of list) {
        await client.query(
          `INSERT INTO material_transport_logs (log_order, request_date, receive_date, status, mat_code, mat_type, mat_item,
             building, floor, quantity, unit, warehouse, status2, requester_receiver, note, project_code, source, created_at)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,'sheet',NOW())`,
          [r.log_order, r.request_date, r.receive_date, r.status, r.mat_code, r.mat_type, r.mat_item, r.building, r.floor,
            r.quantity, r.unit, r.warehouse, r.status2, r.requester_receiver, r.note, code]);
      }
      for (const k of keep) {
        // ตรงทุกอย่างก่อน (รวมลำดับ) ถ้าไม่เจอค่อยเทียบ วันที่+Mat. Code+จำนวน
        let u = await client.query(
          `UPDATE material_transport_logs SET doc_no = $1 WHERE id = (
             SELECT id FROM material_transport_logs WHERE project_code = $2 AND source = 'sheet' AND COALESCE(doc_no, '') = ''
               AND log_order IS NOT DISTINCT FROM $3 AND request_date = $4 AND UPPER(mat_code) = $5 AND quantity::float = $6
             ORDER BY id LIMIT 1)`, [k.doc_no, code, k.log_order, k.d, k.m, k.q]);
        if (!u.rowCount) {
          u = await client.query(
            `UPDATE material_transport_logs SET doc_no = $1 WHERE id = (
               SELECT id FROM material_transport_logs WHERE project_code = $2 AND source = 'sheet' AND COALESCE(doc_no, '') = ''
                 AND request_date = $3 AND UPPER(mat_code) = $4 AND quantity::float = $5
               ORDER BY id LIMIT 1)`, [k.doc_no, code, k.d, k.m, k.q]);
        }
        if (u.rowCount) relinked++; else lostDocs.push(`${code} ${k.doc_no} (${k.d} ${k.m})`);
      }
    }
    await client.query('COMMIT');
    if (relinked) console.log(`  ผูกเลขที่ใบเบิกกลับให้แถวเดิม ${relinked} แถว`);
    lostDocs.forEach(x => console.log('  ⚠️  แถวในชีตเปลี่ยนไป ผูกใบเบิกกลับไม่ได้:', x, '— แนบใหม่ในหน้ากรอก'));
    console.log('\n✅ นำเข้าเรียบร้อย');
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('\n❌ นำเข้าไม่สำเร็จ (ไม่มีอะไรถูกบันทึก):', err.message);
    process.exitCode = 1;
  } finally {
    client.release();
  }
}

main().catch(e => { console.error('❌', e.message); process.exitCode = 1; }).finally(() => sitePool.end());
