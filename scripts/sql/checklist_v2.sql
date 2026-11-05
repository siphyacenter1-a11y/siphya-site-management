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

-- ผู้ลงนามรายบุคคล (ตั้งในหน้าเว็บ แท็บ "ผู้ลงนาม" เฉพาะ admin)
--   label = ชื่อผู้ลงนาม → ลงนามด้วยรหัสของใคร ระบบใส่ชื่อคนนั้นให้เอง
--   active = false → ปิดใช้ชั่วคราว (รหัสใช้ไม่ได้ แต่ยังเก็บไว้)
ALTER TABLE checklist_pins ADD COLUMN IF NOT EXISTS active     BOOLEAN NOT NULL DEFAULT TRUE;
ALTER TABLE checklist_pins ADD COLUMN IF NOT EXISTS created_by TEXT DEFAULT '';
ALTER TABLE checklist_pins ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ;
ALTER TABLE checklist_pins ADD COLUMN IF NOT EXISTS updated_by TEXT DEFAULT '';
ALTER TABLE site_supervisor_checklists ADD COLUMN IF NOT EXISTS edited_by TEXT DEFAULT '';
-- ผู้ลงนามแบบใช้บัญชี login (ตาราง users): ลงนามด้วย username + รหัสผ่านของตัวเอง ไม่ต้องมีรหัส PIN แยก
--   user_id ว่าง = ผู้ลงนามแบบรหัส PIN (ใช้สำรอง เช่น MASTER)
ALTER TABLE checklist_pins ADD COLUMN IF NOT EXISTS user_id INT;
ALTER TABLE checklist_pins ALTER COLUMN pin_hash DROP NOT NULL;
DO $$ BEGIN
  IF to_regclass('public.users') IS NOT NULL AND NOT EXISTS (
       SELECT 1 FROM pg_constraint WHERE conname = 'checklist_pins_user_fk') THEN
    ALTER TABLE checklist_pins ADD CONSTRAINT checklist_pins_user_fk
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE;
  END IF;
END $$;
CREATE INDEX IF NOT EXISTS checklist_pins_user_idx ON checklist_pins (user_id);

-- ประวัติการลงนาม (ไม่ผูก FK — เก็บไว้แม้รายการถูกลบ)
--   action: sign = ลงนาม · cleared = ลายเซ็นถูกล้างเพราะแก้ไขรายการ
--   method: single = ลงทีละใบ · bulk = ลงหลายใบพร้อมกัน · edit = จากการแก้ไข
--   viewed = เปิดดูใบนั้นก่อนลงนามหรือไม่ · confirmed = ติ๊กยืนยันว่าตรวจสอบแล้ว
CREATE TABLE IF NOT EXISTS checklist_sign_log (
  id              SERIAL PRIMARY KEY,
  checklist_id    INT,
  site_name       TEXT,
  inspection_date DATE,
  action          TEXT NOT NULL,
  slot            INT,
  signer_name     TEXT,
  username        TEXT,
  method          TEXT,
  viewed          BOOLEAN,
  confirmed       BOOLEAN,
  login_user      TEXT,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS checklist_sign_log_row_idx  ON checklist_sign_log (checklist_id);
CREATE INDEX IF NOT EXISTS checklist_sign_log_time_idx ON checklist_sign_log (created_at DESC);

-- คลัง PDF เช็คลิสต์ที่ลงนามครบ — เก็บทุกฉบับ ไม่ลบทับ
--   superseded_at = ฉบับนี้ถูกแทนที่ (รายการถูกแก้ไข/ลบหลังลงนาม)
CREATE TABLE IF NOT EXISTS checklist_pdf_archive (
  id                SERIAL PRIMARY KEY,
  checklist_id      INT,
  site_name         TEXT,
  inspection_date   DATE,
  recorded_by       TEXT,
  signer2           TEXT,
  signer3           TEXT,
  signer2_at        TIMESTAMPTZ,
  signer3_at        TIMESTAMPTZ,
  file_path         TEXT NOT NULL,
  content_hash      TEXT,
  created_by        TEXT,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  superseded_at     TIMESTAMPTZ,
  superseded_reason TEXT
);
-- อาคาร/ชั้นที่ตรวจ (1 ใบ = 1 ชั้น) — เลือกจากรายชื่อของโครงการในตาราง transport_floors
ALTER TABLE site_supervisor_checklists ADD COLUMN IF NOT EXISTS building TEXT NOT NULL DEFAULT '';
ALTER TABLE site_supervisor_checklists ADD COLUMN IF NOT EXISTS floor    TEXT NOT NULL DEFAULT '';
ALTER TABLE checklist_pdf_archive      ADD COLUMN IF NOT EXISTS building TEXT NOT NULL DEFAULT '';
ALTER TABLE checklist_pdf_archive      ADD COLUMN IF NOT EXISTS floor    TEXT NOT NULL DEFAULT '';

CREATE UNIQUE INDEX IF NOT EXISTS checklist_pdf_archive_uq ON checklist_pdf_archive (checklist_id, content_hash);
CREATE INDEX IF NOT EXISTS checklist_pdf_archive_time_idx ON checklist_pdf_archive (created_at DESC);

-- นับรหัสผิด (ผิดเกิน 5 ครั้ง ล็อก 15 นาที)
CREATE TABLE IF NOT EXISTS checklist_pin_failures (
  fail_key     TEXT PRIMARY KEY,
  fails        INT NOT NULL DEFAULT 0,
  locked_until TIMESTAMPTZ,
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
