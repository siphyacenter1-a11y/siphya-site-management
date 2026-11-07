// สร้างตารางของบันทึกการเปลี่ยนแผนเดินรถ ถ้ายังไม่มี (รันซ้ำได้ ไม่ลบข้อมูลเดิม)
//   node scripts/migrate_route_plan.js
const fs = require('fs');
const path = require('path');
const { sitePool } = require('../db');

(async () => {
  const sql = fs.readFileSync(path.join(__dirname, 'sql', 'route_plan_v1.sql'), 'utf8');
  try {
    await sitePool.query(sql);
    console.log('✅ ตารางบันทึกการเปลี่ยนแผนเดินรถพร้อมใช้งาน');
  } catch (err) {
    console.error('❌ สร้างตารางไม่สำเร็จ:', err.message);
    process.exitCode = 1;
  } finally {
    await sitePool.end();
  }
})();
