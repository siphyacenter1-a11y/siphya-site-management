-- ============================================================
-- เช็คลิสต์ตรวจพื้นที่ประจำวัน (ฉบับเต็ม) — โครงตาราง
-- รันซ้ำได้ ไม่ลบข้อมูลเดิม (ใช้ IF NOT EXISTS ทุกคำสั่ง)
--   วิธีรัน:  node scripts/migrate_checklist.js
-- ============================================================

-- หัวฟอร์ม: 1 แถวต่อการตรวจ 1 ครั้ง (ตารางเดิมของระบบ ถ้ามีอยู่แล้วจะข้าม)
CREATE TABLE IF NOT EXISTS site_supervisor_checklists (
  id              SERIAL PRIMARY KEY,
  submission_time TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  site_name       TEXT NOT NULL DEFAULT '',
  inspection_date DATE,
  lang            VARCHAR(5) DEFAULT 'th',
  recorded_by     TEXT DEFAULT '',
  signer1         TEXT DEFAULT '',
  signer2         TEXT DEFAULT '',
  signer3         TEXT DEFAULT '',
  checklist_data  JSONB DEFAULT '{}'::jsonb
);

-- คอลัมน์ใหม่: เวลาลงนามช่อง 2-3 และเวลาแก้ไขล่าสุด
ALTER TABLE site_supervisor_checklists ADD COLUMN IF NOT EXISTS signer2_at TIMESTAMPTZ;
ALTER TABLE site_supervisor_checklists ADD COLUMN IF NOT EXISTS signer3_at TIMESTAMPTZ;
ALTER TABLE site_supervisor_checklists ADD COLUMN IF NOT EXISTS edited_at  TIMESTAMPTZ;
ALTER TABLE site_supervisor_checklists ADD COLUMN IF NOT EXISTS pdf_path   TEXT;
ALTER TABLE site_supervisor_checklists ADD COLUMN IF NOT EXISTS pdf_hash   TEXT;

-- คำตอบรายข้อ: 17 แถวต่อ 1 ฟอร์ม
CREATE TABLE IF NOT EXISTS checklist_items (
  checklist_id INT NOT NULL REFERENCES site_supervisor_checklists(id) ON DELETE CASCADE,
  item_id      VARCHAR(5) NOT NULL,              -- '1.1' ... '10.1'
  status       VARCHAR(4) NOT NULL CHECK (status IN ('ok','area','room','na')),
  worker       TEXT DEFAULT '',
  location     TEXT DEFAULT '',
  remark       TEXT DEFAULT '',
  PRIMARY KEY (checklist_id, item_id)
);

-- รูปแนบรายข้อ (เก็บเป็นไฟล์ใน public/uploads/checklist/ เก็บแค่ลิงก์ใน database)
CREATE TABLE IF NOT EXISTS checklist_photos (
  id           SERIAL PRIMARY KEY,
  checklist_id INT NOT NULL REFERENCES site_supervisor_checklists(id) ON DELETE CASCADE,
  item_id      VARCHAR(5) NOT NULL,
  sort_order   INT NOT NULL DEFAULT 0,
  url          TEXT NOT NULL,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS checklist_photos_cl_idx ON checklist_photos (checklist_id, item_id, sort_order);

-- รหัสลงนาม (เก็บเป็น hash ด้วย bcrypt ห้ามเก็บรหัสจริง)
--   role = 'GM'     ลงนามช่อง 2 + แก้ไขรายการ  (site_code = รหัสโครงการ เช่น '0DJ', หรือ NULL = GM สำรองทุกโครงการ)
--   role = 'GF'     ลงนามช่อง 3 ทุกโครงการ
--   role = 'MASTER' ลงนามและแก้ไขได้ทุกช่อง ทุกโครงการ
--   ตั้งค่าด้วย: node scripts/set_checklist_pin.js
CREATE TABLE IF NOT EXISTS checklist_pins (
  id         SERIAL PRIMARY KEY,
  role       VARCHAR(10) NOT NULL CHECK (role IN ('GM','GF','MASTER')),
  site_code  VARCHAR(10),
  label      TEXT DEFAULT '',
  pin_hash   TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- นับรหัสผิด (ผิดเกิน 5 ครั้ง ล็อก 15 นาที)
CREATE TABLE IF NOT EXISTS checklist_pin_failures (
  fail_key     TEXT PRIMARY KEY,
  fails        INT NOT NULL DEFAULT 0,
  locked_until TIMESTAMPTZ,
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
