const express = require('express');
const router = express.Router();
const { querySite } = require('../db');

// GET /api/hub/summary - รวบรวมสถิติภาพรวมทุกระบบ
router.get('/summary', async (req, res) => {
  try {
    const [transportRes, wasteRes, routeRes, checklistRes, projectsRes] = await Promise.all([
      querySite('SELECT COUNT(*) AS total, COUNT(*) FILTER (WHERE status2 = $1) AS completed FROM material_transport_logs', ['ส่งแล้ว']),
      querySite('SELECT COUNT(*) AS total, COALESCE(SUM(volume_m3), 0) AS total_volume, COALESCE(SUM(cost), 0) AS total_cost FROM waste_records'),
      querySite('SELECT COUNT(*) AS total FROM vehicle_transport_requests'),
      querySite('SELECT COUNT(*) AS total FROM site_supervisor_checklists'),
      querySite('SELECT id, name FROM projects ORDER BY name ASC')
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
            title: 'ระบบแผนการเดินรถ',
            total: parseInt(routeRes.rows[0].total, 10),
            path: '/route',
            badge: `${routeRes.rows[0].total} ทริป`
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
