-- ============================================================
-- ระบบแผนการเดินรถ (คำขอขนส่งภายนอกไซต์) — โครงตาราง
-- ใช้ตารางเดิม vehicle_transport_requests (ถ้ามีอยู่แล้วจะข้าม) ไม่ลบข้อมูลเดิม
--   วิธีรัน:  node scripts/migrate_route.js
-- ============================================================
CREATE TABLE IF NOT EXISTS vehicle_transport_requests (
  id               SERIAL PRIMARY KEY,
  recorded_at      TIMESTAMPTZ DEFAULT NOW(),
  doc_type         TEXT,            -- NORMAL | URGENT | CANCEL
  sender_dept      TEXT,            -- หน่วยงาน/โครงการที่ขอ
  receiving_center TEXT,            -- ศูนย์ที่รับเรื่อง
  usage_month      DATE,            -- เดือนที่ใช้รถ (เก็บเป็นวันที่ 1 ของเดือน)
  usage_week       TEXT,
  destination      TEXT,
  origin           TEXT,
  truck_type       TEXT,
  pickup_schedule  TIMESTAMP,       -- วันขึ้นของ
  dropoff_schedule TIMESTAMP,       -- วันลงของ
  item_list        TEXT,
  storage_area     TEXT,
  note             TEXT,            -- เหตุผล
  requester        TEXT
);
CREATE INDEX IF NOT EXISTS vehicle_transport_requests_recorded_idx ON vehicle_transport_requests (recorded_at DESC);
