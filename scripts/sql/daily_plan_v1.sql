-- ============================================================
-- แผนประจำวัน: FM-GM-01-07 แผนรถเข้า-ออก · FM-GM-01-03 ตารางใช้เครื่องจักร — โครงตาราง
--   วิธีรัน:  node scripts/migrate_daily_plan.js   (รันซ้ำได้ ไม่ลบข้อมูล)
--   kind = 'vehicle' (01-07) | 'machine' (01-03)
-- ============================================================

-- รายชื่อรถ / เครื่องจักรของแต่ละโครงการ (แถวในแบบฟอร์ม)
CREATE TABLE IF NOT EXISTS dplan_resources (
  id           SERIAL PRIMARY KEY,
  project_code VARCHAR(10) NOT NULL,
  kind         TEXT NOT NULL,            -- vehicle | machine
  grp          TEXT NOT NULL DEFAULT '', -- รถ: SPY / ผู้รับเหมา · เครื่องจักร: Towercrane / ลิฟท์ขนส่ง ...
  name         TEXT NOT NULL,            -- รถ: ประเภทรถ (6 ล้อ Hiab) · เครื่องจักร: TC.1 / NO. 3 อาคาร B
  plate        TEXT NOT NULL DEFAULT '', -- ทะเบียน (รถ SPY) — ว่าง = ให้ธุรการพิมพ์ทะเบียนเองทุกครั้ง
  sort_order   INT NOT NULL DEFAULT 0,
  active       BOOLEAN NOT NULL DEFAULT TRUE
);
CREATE INDEX IF NOT EXISTS dplan_resources_proj_idx ON dplan_resources (project_code, kind, sort_order);

-- แผน 1 ใบ = 1 โครงการ × 1 วัน × 1 ฟอร์ม
CREATE TABLE IF NOT EXISTS dplan_plans (
  id             SERIAL PRIMARY KEY,
  kind           TEXT NOT NULL,
  project_code   VARCHAR(10) NOT NULL,
  plan_date      DATE NOT NULL,          -- วันที่ของแผน (เครื่องจักร = วันทำงานปกติ 07–17 น.)
  ot_date        DATE,                   -- เครื่องจักร: วันที่ของช่วง OT 17 น.– (ปกติ = วันทำงานก่อนหน้า)
  status         TEXT NOT NULL DEFAULT 'draft',   -- draft | submitted
  prepared_by    TEXT DEFAULT '',        -- ผู้จัดทำ/ธุรการขนส่ง (ชื่อบัญชีที่กดส่ง)
  pm_name        TEXT DEFAULT '',        -- PE/PM
  submitted_at   TIMESTAMPTZ,            -- ส่งครั้งแรก (ใช้วัดทันกำหนด)
  submitted_by   TEXT,
  -- ผลตรวจความสมบูรณ์ ณ ตอนส่งครั้งแรก (KPI ใช้ค่านี้ แก้ไข/เพิ่มรายการทีหลังไม่กระทบ)
  complete       BOOLEAN,
  missing        JSONB DEFAULT '[]'::jsonb,       -- [{ item, fields: ['plate', ...] }]
  -- ไม่นับใน KPI (ผู้ขอแจ้งหลัง 16:00 / ผู้ขอไม่ให้ข้อมูล)
  excluded       BOOLEAN NOT NULL DEFAULT FALSE,
  exclude_reason TEXT DEFAULT '',
  note           TEXT DEFAULT '',
  edit_count     INT NOT NULL DEFAULT 0, -- แก้ไขหลังส่งกี่ครั้ง
  created_by     TEXT,
  created_at     TIMESTAMPTZ DEFAULT NOW(),
  updated_by     TEXT,
  updated_at     TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE (kind, project_code, plan_date)
);
CREATE INDEX IF NOT EXISTS dplan_plans_date_idx ON dplan_plans (kind, plan_date);

-- รายการในแผน (1 แถว = รถ/เครื่อง 1 แถว × ช่วงเวลา 1 ช่วง)
CREATE TABLE IF NOT EXISTS dplan_items (
  id             SERIAL PRIMARY KEY,
  plan_id        INT NOT NULL REFERENCES dplan_plans(id) ON DELETE CASCADE,
  resource_id    INT,                    -- อ้าง dplan_resources (ลบรายชื่อทีหลัง ข้อความด้านล่างยังอยู่)
  resource_label TEXT NOT NULL DEFAULT '', -- ประเภทรถ / ชื่อเครื่อง ณ ตอนบันทึก
  grp            TEXT NOT NULL DEFAULT '',
  slot_from      INT,                    -- ช่องเวลา (ดู SLOTS ใน services/daily_plan.js)
  slot_to        INT,
  plate          TEXT DEFAULT '',        -- รถ: ทะเบียน
  job            TEXT DEFAULT '',        -- งาน / วัสดุ
  location       TEXT DEFAULT '',        -- รถ: จุดกอง / จุดลงของ
  qty            INT,                    -- จำนวนคัน / เที่ยว
  requester      TEXT DEFAULT '',        -- เครื่องจักร: ผู้ขอใช้
  note           TEXT DEFAULT '',
  added_after    BOOLEAN NOT NULL DEFAULT FALSE,  -- เพิ่มหลังส่งแผนแล้ว (ไม่นับ KPI)
  sort_order     INT NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS dplan_items_plan_idx ON dplan_items (plan_id, sort_order);
