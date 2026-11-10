const express = require('express');
const router = express.Router();
const { querySite } = require('../db');

// GET /api/hub/summary - รวบรวมสถิติภาพรวมทุกระบบ
router.get('/summary', async (req, res) => {
  try {
    const [transportRes, wasteRes, routeRes, checklistRes, projectsRes, dplanRes, slRes] = await Promise.all([
      querySite('SELECT COUNT(*) AS total, COUNT(*) FILTER (WHERE status2 = $1) AS completed FROM material_transport_logs', ['ส่งแล้ว']),
      querySite('SELECT COUNT(*) AS total, COALESCE(SUM(volume_m3), 0) AS total_volume, COALESCE(SUM(cost), 0) AS total_cost FROM waste_records'),
      // บันทึกการเปลี่ยนแผนเดินรถ: จำนวนสัปดาห์ที่อัปโหลดแผนแล้ว (ยังไม่รัน migration = 0)
      querySite('SELECT COUNT(DISTINCT week_start) AS total FROM rplan_revisions').catch(() => ({ rows: [{ total: 0 }] })),
      querySite('SELECT COUNT(*) AS total FROM site_supervisor_checklists'),
      querySite('SELECT id, name FROM projects ORDER BY name ASC'),
      // แผนประจำวัน (รถเข้า-ออก / เครื่องจักร): จำนวนแผนที่ส่งแล้ว (ยังไม่รัน migration = 0)
      querySite("SELECT COUNT(*) AS total FROM dplan_plans WHERE status = 'submitted'").catch(() => ({ rows: [{ total: 0 }] })),
      // เช็คลิสต์ Site Layout: ใบแจ้งแก้ไขที่ยังไม่ปิด
      querySite("SELECT COUNT(*) AS total FROM sl_notices WHERE status = 'open'").catch(() => ({ rows: [{ total: 0 }] }))
    ]);

    res.json({
      ok: true,
      data: {
        projects: projectsRes.rows,
        systems: {
          transport: {
            title: 'ติดตามขนส่งวัสดุภายในไซต์',
            total: parseInt(transportRes.rows[0].total, 10),
            completed: parseInt(transportRes.rows[0].completed, 10),
            path: '/transport',
            badge: `${transportRes.rows[0].total} รายการ`
          },
          waste: {
            title: 'ติดตามขยะภายในไซต์',
            total: parseInt(wasteRes.rows[0].total, 10),
            totalVolume: parseFloat(wasteRes.rows[0].total_volume).toFixed(1),
            totalCost: parseFloat(wasteRes.rows[0].total_cost),
            path: '/waste',
            badge: `${wasteRes.rows[0].total} เที่ยว`
          },
          route: {
            title: 'บันทึกการเปลี่ยนแผนเดินรถ',
            total: parseInt(routeRes.rows[0].total, 10),
            path: '/route-plan',
            badge: `${routeRes.rows[0].total} สัปดาห์`
          },
          dailyPlan: {
            title: 'แผนรถเข้า-ออก / เครื่องจักรประจำวัน',
            total: parseInt(dplanRes.rows[0].total, 10),
            path: '/daily-plan',
            badge: `${dplanRes.rows[0].total} แผน`
          },
          siteLayout: {
            title: 'เช็คลิสต์ตาม Site Layout',
            total: parseInt(slRes.rows[0].total, 10),
            path: '/site-layout',
            badge: `ค้างแก้ ${slRes.rows[0].total}`
          },
          checklist: {
            title: 'เช็กลิสต์ตรวจพื้นที่ประจำวัน',
            total: parseInt(checklistRes.rows[0].total, 10),
            path: '/checklist',
            badge: `${checklistRes.rows[0].total} บันทึก`
          }
        }
      }
    });
  } catch (error) {
    console.error('Hub summary error:', error);
    res.status(500).json({ ok: false, error: error.message });
  }
});

module.exports = router;
