-- ============================================================
-- บันทึกการเปลี่ยนแผนเดินรถ (PDF แผนเดินรถประจำสัปดาห์จากศูนย์สระบุรี) — โครงตาราง
--   วิธีรัน:  node scripts/migrate_route_plan.js   (รันซ้ำได้ ไม่ลบข้อมูล)
-- ============================================================

-- PDF แต่ละฉบับ (Rev 0 = ฉบับแรกที่ไม่มีเลข)
CREATE TABLE IF NOT EXISTS rplan_revisions (
  id           SERIAL PRIMARY KEY,
  week_start   DATE NOT NULL,          -- วันจันทร์ของสัปดาห์ (จาก "Plan week 09 - 15 ...")
  week_end     DATE NOT NULL,
  rev_no       INT  NOT NULL,
  rev_date     DATE,                   -- วันที่ในชื่อไฟล์ (ถ้ามี)
  file_name    TEXT,
  file_path    TEXT,                   -- storage/route-plan/...
  uploaded_by  TEXT,
  uploaded_at  TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE (week_start, rev_no)
);

-- ทุกช่องในตาราง (งาน / ลงของ / สถานะรถ)
CREATE TABLE IF NOT EXISTS rplan_items (
  id           SERIAL PRIMARY KEY,
  revision_id  INT NOT NULL REFERENCES rplan_revisions(id) ON DELETE CASCADE,
  plan_date    DATE NOT NULL,
  truck_no     INT,
  plate        TEXT,
  trip         INT,
  kind         TEXT NOT NULL,          -- job | unload | status
  raw_text     TEXT,
  origin       TEXT,
  destination  TEXT,
  material     TEXT,
  booker       TEXT,
  bu           TEXT,
  project      TEXT,
  in_week      BOOLEAN DEFAULT TRUE    -- FALSE = วัน ศ.-อา. ของสัปดาห์ก่อนที่ติดมาในไฟล์
);
CREATE INDEX IF NOT EXISTS rplan_items_rev_idx ON rplan_items (revision_id);

-- การเปลี่ยนแปลงระหว่าง Revise (คำนวณใหม่ทุกครั้งที่อัปโหลด — ค่าที่คนกรอก/แนบ เก็บตาม sig)
CREATE TABLE IF NOT EXISTS rplan_changes (
  id           SERIAL PRIMARY KEY,
  week_start   DATE NOT NULL,
  rev_no       INT NOT NULL,           -- เกิดใน Revise นี้ (เทียบกับฉบับก่อนหน้า)
  sig          TEXT NOT NULL,          -- ลายเซ็นของรายการ ใช้จับคู่ตอนคำนวณใหม่
  change_type  TEXT NOT NULL,          -- add | cancel | move | swap
  kind         TEXT NOT NULL,          -- job | unload
  raw_text     TEXT,
  bu           TEXT,
  project      TEXT,
  booker       TEXT,
  material     TEXT,
  from_date    DATE, from_plate TEXT, from_trip INT,
  to_date      DATE, to_plate TEXT, to_trip INT,
  in_week      BOOLEAN DEFAULT TRUE,
  auto_cause   TEXT,                   -- สาเหตุที่ระบบเดา
  auto_counted BOOLEAN DEFAULT TRUE,
  cause        TEXT,                   -- สาเหตุที่ยืนยันแล้ว (NULL = ใช้ auto_cause)
  counted      BOOLEAN,                -- NULL = ใช้ auto_counted
  note         TEXT,
  reviewed_by  TEXT,
  reviewed_at  TIMESTAMPTZ,
  stale        BOOLEAN DEFAULT FALSE,  -- คำนวณใหม่แล้วไม่พบรายการนี้ (เก็บไว้เพราะมีข้อมูลที่คนกรอก)
  UNIQUE (week_start, sig)
);
CREATE INDEX IF NOT EXISTS rplan_changes_week_idx ON rplan_changes (week_start, rev_no);

-- ไฟล์แนบ (รูป/PDF ใบแจ้งยกเลิก/จองด่วน)
CREATE TABLE IF NOT EXISTS rplan_attachments (
  id           SERIAL PRIMARY KEY,
  change_id    INT NOT NULL REFERENCES rplan_changes(id) ON DELETE CASCADE,
  file_name    TEXT,
  file_path    TEXT,
  mime         TEXT,
  uploaded_by  TEXT,
  uploaded_at  TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS rplan_att_change_idx ON rplan_attachments (change_id);
