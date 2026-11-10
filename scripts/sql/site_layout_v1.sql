-- ============================================================
-- เช็คลิสต์ตาม SITE LAYOUT — ตรวจการใช้พื้นที่ (ธุรการทั่วไป) / ตรวจการจัดกองวัสดุ (ธุรการขนส่ง)
-- + ใบแจ้งแก้ไข + รูป Before/After
--   วิธีรัน:  node scripts/migrate_site_layout.js   (รันซ้ำได้ ไม่ลบข้อมูล)
--   kind = 'area' (การใช้พื้นที่) | 'material' (การจัดกองวัสดุ)
-- ============================================================

-- จุดตรวจตาม Layout ของแต่ละโครงการ (A01 / B01 / M01 / R01 ...)
CREATE TABLE IF NOT EXISTS sl_points (
  id           SERIAL PRIMARY KEY,
  project_code VARCHAR(10) NOT NULL,
  kind         TEXT NOT NULL,
  code         TEXT NOT NULL DEFAULT '',
  name         TEXT NOT NULL,
  section      TEXT NOT NULL DEFAULT '',   -- หัวข้อย่อย เช่น "ชั้นใต้ดิน"
  owner        TEXT NOT NULL DEFAULT '',   -- เจ้าภาพพื้นที่
  sort_order   INT NOT NULL DEFAULT 0,
  active       BOOLEAN NOT NULL DEFAULT TRUE
);
CREATE INDEX IF NOT EXISTS sl_points_proj_idx ON sl_points (project_code, kind, sort_order);

-- รูป Layout ของโครงการ (แสดงข้างเช็คลิสต์ + ในใบพิมพ์)
CREATE TABLE IF NOT EXISTS sl_layouts (
  project_code VARCHAR(10) NOT NULL,
  kind         TEXT NOT NULL,
  image_url    TEXT NOT NULL,
  updated_by   TEXT,
  updated_at   TIMESTAMPTZ DEFAULT NOW(),
  PRIMARY KEY (project_code, kind)
);

-- รอบตรวจ (เป้าหมาย 4 รอบ/เดือน/โครงการ/ประเภท)
CREATE TABLE IF NOT EXISTS sl_rounds (
  id            SERIAL PRIMARY KEY,
  kind          TEXT NOT NULL,
  project_code  VARCHAR(10) NOT NULL,
  inspect_date  DATE NOT NULL,
  inspect_time  TEXT DEFAULT '',
  inspector     TEXT DEFAULT '',
  pm_name       TEXT DEFAULT '',           -- ผู้จัดการโครงการ (รับทราบ)
  total         INT NOT NULL DEFAULT 0,
  ok            INT NOT NULL DEFAULT 0,
  ng            INT NOT NULL DEFAULT 0,
  note          TEXT DEFAULT '',
  created_by    TEXT,
  created_at    TIMESTAMPTZ DEFAULT NOW(),
  updated_by    TEXT,
  updated_at    TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS sl_rounds_idx ON sl_rounds (kind, project_code, inspect_date);

CREATE TABLE IF NOT EXISTS sl_round_items (
  id         SERIAL PRIMARY KEY,
  round_id   INT NOT NULL REFERENCES sl_rounds(id) ON DELETE CASCADE,
  point_id   INT,
  code       TEXT DEFAULT '',
  name       TEXT NOT NULL,
  section    TEXT DEFAULT '',
  owner      TEXT DEFAULT '',
  result     TEXT NOT NULL,                -- ok | ng
  remark     TEXT DEFAULT '',
  notice_id  INT,
  sort_order INT NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS sl_round_items_idx ON sl_round_items (round_id, sort_order);

-- ใบแจ้งแก้ไข (1 ใบ ต่อ 1 จุดที่ ✗)
CREATE TABLE IF NOT EXISTS sl_notices (
  id             SERIAL PRIMARY KEY,
  notice_no      TEXT NOT NULL UNIQUE,     -- เช่น 0DJ-SM2611-001
  kind           TEXT NOT NULL,
  project_code   VARCHAR(10) NOT NULL,
  round_id       INT REFERENCES sl_rounds(id) ON DELETE SET NULL,
  issued_date    DATE NOT NULL,
  found_date     DATE,
  found_time     TEXT DEFAULT '',
  location       TEXT DEFAULT '',          -- ตำแหน่งที่พบ
  zone_found     TEXT DEFAULT '',          -- รหัสโซน/พื้นที่ที่พบ
  zone_correct   TEXT DEFAULT '',          -- ที่ถูกต้องตาม Layout
  reasons        JSONB DEFAULT '[]'::jsonb,
  reason_other   TEXT DEFAULT '',
  owner_company  TEXT DEFAULT '',          -- บริษัท/ผรม./เจ้าภาพ
  responsible    TEXT DEFAULT '',          -- ผู้รับปฏิบัติ
  cooperation    TEXT DEFAULT '',          -- signed | refused
  due_date       DATE,
  detail         TEXT DEFAULT '',
  before_photos  JSONB DEFAULT '[]'::jsonb, -- [{ url, at, by }]
  after_photos   JSONB DEFAULT '[]'::jsonb,
  fixed_date     DATE,
  status         TEXT NOT NULL DEFAULT 'open',  -- open | closed
  close_result   TEXT DEFAULT '',          -- pass | fail
  close_note     TEXT DEFAULT '',
  closed_by      TEXT,
  closed_at      TIMESTAMPTZ,
  created_by     TEXT,
  created_at     TIMESTAMPTZ DEFAULT NOW(),
  updated_by     TEXT,
  updated_at     TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS sl_notices_idx ON sl_notices (project_code, kind, status);
