-- ============================================================
-- ระบบติดตามขยะ + รายงาน NPO — โครงตาราง
-- รันซ้ำได้ ไม่ลบข้อมูลเดิม   วิธีรัน:  node scripts/migrate_waste.js
-- ============================================================

-- ตารางเดิมของระบบ (ถ้ามีอยู่แล้วจะข้าม)
CREATE TABLE IF NOT EXISTS projects (
  id   SERIAL PRIMARY KEY,
  name TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS waste_records (
  id                 SERIAL PRIMARY KEY,
  project_id         INT REFERENCES projects(id),
  record_date        DATE NOT NULL,
  floor_zone         TEXT DEFAULT '',
  time_in            TEXT DEFAULT '',
  time_out           TEXT DEFAULT '',
  bill_no            TEXT DEFAULT '',
  plate_no           TEXT DEFAULT '',
  recorder           TEXT DEFAULT '',
  trips              INT  DEFAULT 1,
  truck_type         TEXT DEFAULT '',
  waste_construction NUMERIC DEFAULT 0,
  waste_packing      NUMERIC DEFAULT 0,
  waste_system       NUMERIC DEFAULT 0,
  waste_concrete     NUMERIC DEFAULT 0,
  volume_m3          NUMERIC DEFAULT 0,
  cost               NUMERIC DEFAULT 0,
  photo_front_url    TEXT,
  photo_waste_url    TEXT,
  photo_canvas_url   TEXT,
  note               TEXT DEFAULT ''
);

-- อัตรารถ (แก้ราคาได้โดยไม่ต้องแก้โค้ด)
CREATE TABLE IF NOT EXISTS truck_types (
  name          TEXT PRIMARY KEY,
  volume_m3     NUMERIC(6,2)  NOT NULL,
  cost_per_trip NUMERIC(10,2) NOT NULL,
  sort_order    INT NOT NULL DEFAULT 0,
  active        BOOLEAN NOT NULL DEFAULT TRUE
);
INSERT INTO truck_types (name, volume_m3, cost_per_trip, sort_order) VALUES
  ('6 ล้อเล็ก', 3, 550, 1),
  ('6 ล้อใหญ่', 6, 1100, 2),
  ('10 ล้อ', 13.5, 2500, 3)
ON CONFLICT (name) DO NOTHING;

-- หัวรายงาน NPO (1 แถวต่อ 1 ใบ)
CREATE TABLE IF NOT EXISTS npo_reports (
  id            SERIAL PRIMARY KEY,
  project_id    INT  NOT NULL REFERENCES projects(id),
  truck_type    TEXT NOT NULL,
  npo_no        TEXT NOT NULL,
  date_from     DATE NOT NULL,
  date_to       DATE NOT NULL,
  trip_count    INT  NOT NULL,
  total_cost    NUMERIC(12,2) NOT NULL,
  seq_start     INT  NOT NULL DEFAULT 1,      -- ลำดับเที่ยวแรกในใบ (นับต่อเนื่องตามโครงการ+ประเภทรถ)
  pdf_path      TEXT,
  status        TEXT NOT NULL DEFAULT 'issued' CHECK (status IN ('issued','cancelled')),
  cancel_reason TEXT,
  created_by    TEXT,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  cancelled_at  TIMESTAMPTZ
);
-- เลข NPO ซ้ำได้เฉพาะใบที่ถูกยกเลิกแล้ว
CREATE UNIQUE INDEX IF NOT EXISTS npo_reports_no_uq ON npo_reports (npo_no) WHERE status = 'issued';

-- ผูกเที่ยวกับ NPO (แทนตัวนับ NPO_PROGRESS_ ของระบบเดิม)
ALTER TABLE waste_records ADD COLUMN IF NOT EXISTS npo_id INT REFERENCES npo_reports(id);
ALTER TABLE waste_records ADD COLUMN IF NOT EXISTS created_at TIMESTAMPTZ DEFAULT NOW();
CREATE INDEX IF NOT EXISTS waste_records_pending_idx
  ON waste_records (project_id, truck_type, record_date, time_in, id) WHERE npo_id IS NULL;

-- แก้ไข/ลบรายการ: เก็บว่าใครแก้ล่าสุด + ประวัติค่าเดิมก่อนแก้/ลบ
ALTER TABLE waste_records ADD COLUMN IF NOT EXISTS created_by TEXT;
ALTER TABLE waste_records ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ;
ALTER TABLE waste_records ADD COLUMN IF NOT EXISTS updated_by TEXT;
CREATE TABLE IF NOT EXISTS waste_record_history (
  id         SERIAL PRIMARY KEY,
  record_id  INT  NOT NULL,                  -- ไม่ผูก FK เพื่อให้ประวัติอยู่ต่อหลังลบ
  action     TEXT NOT NULL CHECK (action IN ('update','delete')),
  old_data   JSONB NOT NULL,
  changed_by TEXT,
  changed_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS waste_record_history_rec_idx ON waste_record_history (record_id);

-- ช่องลงนามท้ายใบ NPO (ชื่อพิมพ์ตอนออกใบ ว่าง = เส้นจุดให้เขียนมือ)
ALTER TABLE npo_reports ADD COLUMN IF NOT EXISTS receiver_name TEXT;
ALTER TABLE npo_reports ADD COLUMN IF NOT EXISTS approver_name TEXT;
