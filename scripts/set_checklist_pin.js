// ตั้ง/ลบรหัสลงนามของระบบเช็คลิสต์ (เก็บเป็น bcrypt hash)
//
//   เพิ่มรหัส GM ของโครงการ 0DJ:   node scripts/set_checklist_pin.js add GM 0DJ 123456 "ธุรการ 0DJ"
//   เพิ่มรหัส GM สำรอง (ทุกโครงการ): node scripts/set_checklist_pin.js add GM - 999999 "GM สำรอง"
//   เพิ่มรหัส GF/GE:               node scripts/set_checklist_pin.js add GF - 555555 "GF"
//   เพิ่มรหัส MASTER:              node scripts/set_checklist_pin.js add MASTER - 000000 "Admin"
//   ดูรายการ:                      node scripts/set_checklist_pin.js list
//   ลบรหัส:                        node scripts/set_checklist_pin.js remove <id>
//
// หนึ่งโครงการมีรหัส GM ได้หลายรหัส (เพิ่มทีละรหัส)
const bcrypt = require('bcryptjs');
const { sitePool } = require('../db');

async function main() {
  const [cmd, role, site, pin, label] = process.argv.slice(2);
  if (cmd === 'list') {
    const r = await sitePool.query(
      'SELECT id, role, COALESCE(site_code, \'(ทุกโครงการ)\') AS site_code, label, created_at FROM checklist_pins ORDER BY role, site_code, id');
    console.table(r.rows);
    return;
  }
  if (cmd === 'remove') {
    const r = await sitePool.query('DELETE FROM checklist_pins WHERE id = $1', [Number(role)]);
    console.log(r.rowCount ? '✅ ลบแล้ว' : 'ไม่พบรหัสนี้');
    return;
  }
  if (cmd === 'add') {
    const R = String(role || '').toUpperCase();
    if (!['GM', 'GF', 'MASTER'].includes(R)) throw new Error('role ต้องเป็น GM, GF หรือ MASTER');
    if (!pin || String(pin).trim().length < 4) throw new Error('รหัสต้องยาวอย่างน้อย 4 ตัว');
    const code = (!site || site === '-' || R !== 'GM') ? null : String(site).trim().toUpperCase();
    const hash = await bcrypt.hash(String(pin).trim(), 10);
    const r = await sitePool.query(
      'INSERT INTO checklist_pins (role, site_code, label, pin_hash) VALUES ($1,$2,$3,$4) RETURNING id',
      [R, code, label || '', hash]);
    console.log(`✅ เพิ่มรหัส ${R}${code ? ' โครงการ ' + code : ''} แล้ว (id ${r.rows[0].id})`);
    return;
  }
  console.log('วิธีใช้: ดูคำอธิบายด้านบนของไฟล์ scripts/set_checklist_pin.js');
}

main()
  .catch(err => { console.error('❌', err.message); process.exitCode = 1; })
  .finally(() => sitePool.end());
