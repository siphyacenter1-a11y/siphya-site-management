// สร้างตารางของเช็คลิสต์ตาม SITE LAYOUT (การใช้พื้นที่ · การจัดกองวัสดุ · ใบแจ้งแก้ไข) ถ้ายังไม่มี (รันซ้ำได้ ไม่ลบข้อมูลเดิม)
//   node scripts/migrate_site_layout.js
const fs = require('fs');
const path = require('path');
const { sitePool } = require('../db');

(async () => {
  const sql = fs.readFileSync(path.join(__dirname, 'sql', 'site_layout_v1.sql'), 'utf8');
  try {
    await sitePool.query(sql);
    console.log('✅ ตารางเช็คลิสต์ Site Layout พร้อมใช้งาน');
  } catch (err) {
    console.error('❌ สร้างตารางไม่สำเร็จ:', err.message);
    process.exitCode = 1;
  } finally {
    await sitePool.end();
  }
})();
