const express = require('express');
const router = express.Router();
const { querySite } = require('../db');
const { authenticateToken, requireAdmin } = require('../middleware/auth');

// GET /api/admin/overview - สรุปภาพรวมระดับผู้บริหารทุกระบบ
router.get('/overview', authenticateToken, requireAdmin, async (req, res) => {
  try {
    const [
      transportSummary,
      wasteSummary,
      routeSummary,
      checklistSummary,
      projectBreakdown,
      matTypeBreakdown,
      wasteTypeBreakdown,
      recentTransport,
      recentWaste,
      recentRoute
    ] = await Promise.all([
      // 1. สรุปขนส่งวัสดุ
      querySite(`
        SELECT 
          COUNT(*) as total_transports,
          COUNT(*) FILTER (WHERE status2 = 'ส่งแล้ว' OR status2 = 'ส่งด่วนแล้ว') as completed_transports,
          COUNT(*) FILTER (WHERE status2 = 'เบิกด่วน') as urgent_transports,
          COUNT(DISTINCT mat_type) as unique_materials,
          COUNT(DISTINCT building) as unique_buildings,
          COALESCE(SUM(quantity), 0) as total_qty
        FROM material_transport_logs
      `),

      // 2. สรุปขยะ
      querySite(`
        SELECT 
          COUNT(*) as total_records,
          COALESCE(SUM(trips), 0) as total_trips,
          COALESCE(SUM(volume_m3), 0) as total_volume,
          COALESCE(SUM(cost), 0) as total_cost,
          COALESCE(SUM(waste_construction), 0) as sum_construction,
          COALESCE(SUM(waste_packing), 0) as sum_packing,
          COALESCE(SUM(waste_system), 0) as sum_system,
          COALESCE(SUM(waste_concrete), 0) as sum_concrete
        FROM waste_records
      `),

      // 3. สรุปเดินรถ
      querySite(`
        SELECT 
          COUNT(*) as total_requests,
          COUNT(*) FILTER (WHERE doc_type = 'ขอด่วน') as urgent_requests,
          COUNT(DISTINCT truck_type) as truck_types_count
        FROM vehicle_transport_requests
      `),

      // 4. สรุปเช็กลิสต์
      querySite(`
        SELECT 
          COUNT(*) as total_checklists,
          COUNT(DISTINCT site_name) as unique_sites
        FROM site_supervisor_checklists
      `),

      // 5. สรุปแยกรายโครงการ (Projects aggregated with waste)
      querySite(`
        SELECT 
          p.id,
          p.name as project_name,
          COUNT(w.id) as waste_record_count,
          COALESCE(SUM(w.trips), 0) as total_trips,
          COALESCE(SUM(w.volume_m3), 0) as total_volume,
          COALESCE(SUM(w.cost), 0) as total_cost
        FROM projects p
        LEFT JOIN waste_records w ON p.id = w.project_id
        GROUP BY p.id, p.name
        ORDER BY total_cost DESC, p.name ASC
      `),

      // 6. สัดส่วนประเภทวัสดุ (Top 6)
      querySite(`
        SELECT mat_type, COUNT(*) as count, COALESCE(SUM(quantity), 0) as total_qty
        FROM material_transport_logs
        WHERE mat_type IS NOT NULL AND mat_type != ''
        GROUP BY mat_type
        ORDER BY count DESC
        LIMIT 6
      `),

      // 7. สัดส่วนประเภทขยะ
      querySite(`
        SELECT 
          'ขยะก่อสร้าง' as type, COALESCE(SUM(waste_construction), 0) as volume FROM waste_records
        UNION ALL
        SELECT 'ขยะบรรจุภัณฑ์', COALESCE(SUM(waste_packing), 0) FROM waste_records
        UNION ALL
        SELECT 'ขยะระบบ/เศษสายไฟ', COALESCE(SUM(waste_system), 0) FROM waste_records
        UNION ALL
        SELECT 'เศษคอนกรีต', COALESCE(SUM(waste_concrete), 0) FROM waste_records
      `),

      // 8. กิจกรรมล่าสุด: วัสดุ
      querySite(`
        SELECT 
          'transport' as system_type,
          'เบิกจ่ายวัสดุ' as system_title,
          mat_item as title,
          requester_receiver as actor,
          status2 as status,
          TO_CHAR(COALESCE(receive_date, request_date), 'YYYY-MM-DD') as event_date,
          created_at
        FROM material_transport_logs
        ORDER BY created_at DESC NULLS LAST, id DESC
        LIMIT 5
      `),

      // 9. กิจกรรมล่าสุด: ขยะ
      querySite(`
        SELECT 
          'waste' as system_type,
          'ขนย้ายขยะ' as system_title,
          CONCAT('บิล ', bill_no, ' (', plate_no, ')') as title,
          recorder as actor,
          CONCAT(volume_m3, ' m³') as status,
          TO_CHAR(record_date, 'YYYY-MM-DD') as event_date,
          created_at
        FROM waste_records
        ORDER BY created_at DESC NULLS LAST, id DESC
        LIMIT 5
      `),

      // 10. กิจกรรมล่าสุด: แผนเดินรถ
      querySite(`
        SELECT 
          'route' as system_type,
          'แผนการเดินรถ' as system_title,
          CONCAT(origin, ' ➔ ', destination) as title,
          requester as actor,
          doc_type as status,
          TO_CHAR(recorded_at, 'YYYY-MM-DD') as event_date,
          created_at
        FROM vehicle_transport_requests
        ORDER BY created_at DESC NULLS LAST, id DESC
        LIMIT 5
      `)
    ]);

    // รวม Recent Activities
    const recentActivities = [
      ...recentTransport.rows,
      ...recentWaste.rows,
      ...recentRoute.rows
    ].sort((a, b) => new Date(b.created_at || b.event_date) - new Date(a.created_at || a.event_date)).slice(0, 10);

    res.json({
      ok: true,
      data: {
        kpi: {
          transport: transportSummary.rows[0],
          waste: wasteSummary.rows[0],
          route: routeSummary.rows[0],
          checklist: checklistSummary.rows[0]
        },
        projectBreakdown: projectBreakdown.rows,
        matTypeBreakdown: matTypeBreakdown.rows,
        wasteTypeBreakdown: wasteTypeBreakdown.rows,
        recentActivities
      }
    });
  } catch (err) {
    console.error('Admin overview error:', err);
    res.status(500).json({ ok: false, error: err.message });
  }
});

module.exports = router;
