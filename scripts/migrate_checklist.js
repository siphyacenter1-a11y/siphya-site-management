// สร้าง/อัปเดตตารางของระบบเช็คลิสต์ฉบับเต็ม (รันซ้ำได้ ไม่ลบข้อมูลเดิม)
//   node scripts/migrate_checklist.js
const fs = require('fs');
const path = require('path');
const { sitePool } = require('../db');

(async () => {
  const sql = fs.readFileSync(path.join(__dirname, 'sql', 'checklist_v2.sql'), 'utf8');
  try {
    await sitePool.query(sql);
    console.log('✅ ตารางเช็คลิสต์พร้อมใช้งาน');
  } catch (err) {
    console.error('❌ สร้างตารางไม่สำเร็จ:', err.message);
    process.exitCode = 1;
  } finally {
    await sitePool.end();
  }
})();
