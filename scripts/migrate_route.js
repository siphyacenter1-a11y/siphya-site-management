// สร้างตารางของระบบแผนการเดินรถ ถ้ายังไม่มี (รันซ้ำได้ ไม่ลบข้อมูลเดิม)
//   node scripts/migrate_route.js
const fs = require('fs');
const path = require('path');
const { sitePool } = require('../db');

(async () => {
  const sql = fs.readFileSync(path.join(__dirname, 'sql', 'route_v2.sql'), 'utf8');
  try {
    await sitePool.query(sql);
    console.log('✅ ตารางระบบแผนการเดินรถพร้อมใช้งาน');
  } catch (err) {
    console.error('❌ สร้างตารางไม่สำเร็จ:', err.message);
    process.exitCode = 1;
  } finally {
    await sitePool.end();
  }
})();
