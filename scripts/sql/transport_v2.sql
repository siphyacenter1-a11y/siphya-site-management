-- ============================================================
-- ระบบติดตามขนส่งวัสดุภายในไซต์ (หลายโครงการ) — โครงตาราง
-- รันซ้ำได้ ไม่ลบข้อมูลเดิม   วิธีรัน:  node scripts/migrate_transport.js
-- ============================================================

-- รายการเบิก/รับ (ตารางเดิมของระบบ เพิ่มคอลัมน์โครงการ)
CREATE TABLE IF NOT EXISTS material_transport_logs (
  id                 SERIAL PRIMARY KEY,
  log_order          INT,
  request_date       DATE,
  receive_date       DATE,
  status             TEXT,
  mat_code           TEXT,
  mat_type           TEXT,
  mat_item           TEXT,
  building           TEXT,
  floor              TEXT,
  quantity           NUMERIC,
  unit               TEXT,
  warehouse          TEXT,
  status2            TEXT,
  requester_receiver TEXT,
  note               TEXT,
  created_at         TIMESTAMPTZ DEFAULT NOW()
);
ALTER TABLE material_transport_logs ADD COLUMN IF NOT EXISTS project_code TEXT;
ALTER TABLE material_transport_logs ADD COLUMN IF NOT EXISTS source       TEXT;         -- 'sheet' = นำเข้าจาก Google Sheet, 'web' = กรอกบนเว็บ
ALTER TABLE material_transport_logs ADD COLUMN IF NOT EXISTS updated_at   TIMESTAMPTZ;
ALTER TABLE material_transport_logs ADD COLUMN IF NOT EXISTS updated_by   TEXT;
CREATE INDEX IF NOT EXISTS material_transport_logs_project_idx
  ON material_transport_logs (project_code, request_date, id);

-- โครงการ (แทนแท็บ Projects)
CREATE TABLE IF NOT EXISTS transport_projects (
  code       VARCHAR(10) PRIMARY KEY,
  name       TEXT NOT NULL,
  logo_text  TEXT DEFAULT '',
  active     BOOLEAN NOT NULL DEFAULT TRUE,
  note       TEXT DEFAULT '',
  sort_order INT NOT NULL DEFAULT 0
);

-- อาคาร/ชั้น ของแต่ละโครงการ (แทนแท็บ Build_<รหัส>) 1 แถว = 1 ชั้น
CREATE TABLE IF NOT EXISTS transport_floors (
  project_code VARCHAR(10) NOT NULL REFERENCES transport_projects(code) ON DELETE CASCADE,
  building     TEXT NOT NULL,
  floor        TEXT NOT NULL,
  b_order      INT NOT NULL DEFAULT 0,
  f_order      INT NOT NULL DEFAULT 0,
  PRIMARY KEY (project_code, building, floor)
);

-- รายการวัสดุ (แทนแท็บ MasterData) ค้นจาก Mat. Code 7 ตัวแรก
CREATE TABLE IF NOT EXISTS material_master (
  mat_code    VARCHAR(20) PRIMARY KEY,   -- เช่น PC15070
  type_code   TEXT, type_name TEXT,
  group_code  TEXT, group_name TEXT,     -- group_name = ประเภทวัสดุ
  sub_group   TEXT,
  description TEXT,                      -- รายการวัสดุ
  unit        TEXT
);
