// ============================================================
// แผนประจำวัน — หน้า /daily-plan (ธุรการ + admin)
//   kind 'vehicle' = FM-GM-01-07 ตารางสรุปแผนรถเข้า-ออกหน่วยงานประจำวัน
//   kind 'machine' = FM-GM-01-03 ตารางการใช้เครื่องจักรประจำวัน (ช่วง OT ของวันก่อน + วันทำงานปกติ)
//
//   DPLAN_meta()                                 ฟอร์ม, ช่องเวลา, โครงการ, เหตุผลไม่นับ
//   DPLAN_resources(kind, code)                  รายชื่อรถ/เครื่องจักรของโครงการ
//   DPLAN_saveResources(kind, code, list)        บันทึกรายชื่อ (แถวที่เอาออก = ปิดใช้ ไม่ลบ)
//   DPLAN_template(kind)                         รายชื่อตั้งต้นจากแบบฟอร์ม
//   DPLAN_month(kind, code, 'YYYY-MM')           แผนทั้งเดือน (สรุปสั้น)
//   DPLAN_get(kind, code, date)                  แผน 1 ใบ (ยังไม่มี = ใบเปล่า)
//   DPLAN_previous(kind, code, date)             รายการของแผนล่าสุดก่อนวันนั้น (ปุ่ม "คัดลอกจากแผนก่อน")
//   DPLAN_save(req)                              บันทึกร่าง / ส่งแผน / แก้ไขหลังส่ง
//   DPLAN_setExcluded(id, excluded, reason)      ไม่นับใน KPI
//   DPLAN_review(req)                            ผู้ตรวจปรับผลเป็น "ไม่สมบูรณ์" (KPI ใช้ผลหลังปรับ)
//   DPLAN_delete(id)                             ลบ (ร่าง = ธุรการลบได้ · ส่งแล้ว = admin เท่านั้น)
//   DPLAN_deleteMany(ids)                        ลบหลายแผน (admin เท่านั้น)
//   DPLAN_kpi({ from, to, code })                KPI แยกฟอร์ม × โครงการ × เดือน
//
// KPI = (จำนวนแผนที่ข้อมูลครบถ้วน ÷ จำนวนแผนทั้งหมดที่จัดทำ) × 100
//   - "จัดทำ" = กดส่งแผนแล้ว · ร่างที่ยังไม่ส่งไม่นับ · แผนที่ติ๊ก "ไม่นับ" ไม่อยู่ในตัวหาร
//   - ครบถ้วน = ตรวจอัตโนมัติตอนส่งครั้งแรก แล้วเก็บผลไว้ — แก้ไข/เพิ่มรายการทีหลังไม่เปลี่ยนผล KPI
//     หัวหน้างาน / ผู้ตรวจ ตรวจทานใบพิมพ์แล้วปรับเป็น "ไม่สมบูรณ์" ได้ (เช่น ข้อมูลไม่ชัด) — KPI ใช้ผลหลังปรับ
//   - รถ:        ทุกแถวต้องมี ทะเบียนรถ · ประเภทรถ · จุดกอง/จุดลงของ · เวลา
//   - เครื่องจักร: ทุกแถวต้องมี เครื่องจักร · ช่วงเวลา · งานที่ทำ · ผู้ขอใช้ (ลิฟท์ไม่มีช่องผู้ขอใช้ในฟอร์ม → ไม่บังคับ)
//   - เวลาที่ส่ง (ทัน 16:00 ของวันทำงานก่อนหน้าหรือไม่) แสดงประกอบ ไม่อยู่ในสูตร
// ============================================================
const { sitePool } = require('../db');
const { UserError, withTx } = require('./common');
const PROJECTS = require('./checklist_projects');

const TZ = 'Asia/Bangkok';
const KINDS = ['vehicle', 'machine'];
const DEADLINE_HOUR = 16;

const VEHICLE_SLOTS = ['ก่อน 08.00'].concat(
  Array.from({ length: 14 }, (_, i) => `${pad(8 + i)}.00-${pad(9 + i)}.00`), ['หลัง 22.00']);
const MACHINE_SLOTS = Array.from({ length: 5 }, (_, i) => `${17 + i}.00-${18 + i}.00`)
  .concat(['22.00 เป็นต้นไป'])
  .concat(Array.from({ length: 10 }, (_, i) => `${pad(7 + i)}.00-${pad(8 + i)}.00`));
const MACHINE_OT_SLOTS = 6;   // ช่อง 0–5 = ช่วง OT (วัน ot_date) · 6–15 = วันทำงานปกติ (plan_date)

// ประเภทงานของเครื่องจักร → สีไฮไลต์ในใบพิมพ์ 01-03 (ชุดสีเดิมของแบบฟอร์ม Excel)
//   ลิฟท์ / รถโฟล์คลิฟท์ ใช้สีเดียวทั้งกลุ่ม (GROUP_COLORS) ไม่ต้องเลือกประเภทงาน
const WORK_TYPES = [
  { key: 'concrete', label: 'เทคอนกรีต', bg: '#2E7D8C', fg: '#FFFFFF' },
  { key: 'steel', label: 'งานเหล็ก / ยกเหล็กเส้น', bg: '#8C8C8C', fg: '#FFFFFF' },
  { key: 'formwork', label: 'งานไม้แบบ', bg: '#E8731E', fg: '#000000' },
  { key: 'wall', label: 'งานผนังบ่อ / งานเสา', bg: '#F8C9A0', fg: '#000000' },
  { key: 'lifting', label: 'ยกของ / วัสดุทั่วไป', bg: '#CFC6E6', fg: '#000000' },
  { key: 'other', label: 'อื่น ๆ', bg: '#CFE3F5', fg: '#000000' },
];
const GROUP_COLORS = [
  { match: 'ลิฟท์|ลิฟต์', label: 'ลิฟท์', bg: '#FFF200', fg: '#000000' },
  { match: 'โฟล์ค|โฟล์ก|forklift', label: 'รถโฟล์คลิฟท์', bg: '#92D050', fg: '#000000' },
];
const NO_TYPE_COLOR = { bg: '#FFE699', fg: '#000000' };   // ยังไม่เลือกประเภทงาน

const FORMS = {
  vehicle: { title: 'ตารางสรุปแผนรถเข้า - ออกหน่วยงานประจำวัน', short: 'แผนรถเข้า-ออก', formNo: 'FM-GM-01-07', rev: 'Rev.00_25/02/2565', slots: VEHICLE_SLOTS },
  machine: { title: 'ตารางการใช้เครื่องจักร ประจำวัน', short: 'เครื่องจักร', formNo: 'FM-GM-01-03', rev: 'Rev.00_25/02/2565', slots: MACHINE_SLOTS, otSlots: MACHINE_OT_SLOTS },
};
const FIELD_TH = {
  plate: 'ทะเบียนรถ', type: 'ประเภทรถ', location: 'จุดกอง/จุดลงของ', time: 'เวลา',
  machine: 'เครื่องจักร', mtime: 'ช่วงเวลา', job: 'งานที่ทำ', requester: 'ผู้ขอใช้',
};
const EXCLUDE_REASONS = ['ผู้ขอแจ้งหลัง 16:00 น.', 'ผู้ขอไม่ให้ข้อมูล (ธุรการแจ้งขอข้อมูลแล้ว)', 'อื่นๆ'];

// รายชื่อตั้งต้น (จากแบบฟอร์มที่ใช้อยู่ — แก้ได้ทีหลังในแท็บตั้งค่า)
const TEMPLATES = {
  vehicle: [
    ['SPY', '6 ล้อ Hiab', '83-4797'], ['SPY', '6 ล้อ Hiab', '82-7828'], ['SPY', '6 ล้อคอกเตี้ย', ''], ['SPY', '6 ล้อคอกสูง', ''],
    ['SPY', '10 ล้อ Dump', '83-5439'], ['SPY', '12 ล้อคอก', '83-9608'], ['SPY', '12 ล้อพื้นเรียบ', '84-7425'],
    ['SPY', '12 ล้อพื้นเรียบ', '84-5615'], ['SPY', '12 ล้อพื้นเรียบ', '84-5617'], ['SPY', '12 ล้อพื้นเรียบ', '84-5017'],
    ['SPY', '12 ล้อติดเครน', '84-5616'], ['SPY', 'เทรลเลอร์', '83-1394'], ['SPY', 'เทรลเลอร์', '83-6059'],
    ['SPY', 'เทรลเลอร์', '83-6399'], ['SPY', 'เทรลเลอร์', '83-7959'], ['SPY', 'เทรลเลอร์', '84-2659'],
    ['SPY', 'เทรลเลอร์', '84-5614'], ['SPY', 'รถส่งของร้านค้า SPY', ''], ['SPY', 'สโตร์สี่พระยา', ''],
    ['ผู้รับเหมา', 'รถส่งของร้านค้า งานระบบ', ''], ['ผู้รับเหมา', 'รถบรรทุก Tech Form', ''], ['ผู้รับเหมา', 'รถบรรทุก ATT', ''],
    ['ผู้รับเหมา', 'ร้านค้า 6 ล้อ', ''], ['ผู้รับเหมา', 'ผรม 6 ล้อ', ''], ['ผู้รับเหมา', '10 ล้อ CPAC', ''],
    ['ผู้รับเหมา', 'ผรม 6 ล้อ CPAC', ''], ['ผู้รับเหมา', 'เทศกิจ 6 ล้อ', ''],
  ],
  machine: [
    ['Towercrane', 'TC.1', ''], ['Towercrane', 'TC.2', ''], ['Towercrane', 'TC.3', ''],
    ['โมบายเครน', 'โมบายเครน 1', ''], ['เดอริค', 'เดอริค', ''],
    ['รถโฟล์คลิฟท์', 'FD.1', ''], ['รถแบคโฮ', 'แบคโฮ 1', ''],
    ['ลิฟท์โดยสาร', 'NO. 1', ''], ['ลิฟท์โดยสาร', 'NO. 2', ''],
    ['ลิฟท์ขนส่ง', 'NO. 3', ''], ['ลิฟท์ขนส่ง', 'NO. 4', ''],
  ],
};

// ---------- helpers ----------
function pad(n) { return String(n).padStart(2, '0'); }
const str = (v, max) => String(v == null ? '' : v).trim().slice(0, max || 300);
const isDate = s => /^\d{4}-\d{2}-\d{2}$/.test(String(s || '')) && !isNaN(Date.parse(s + 'T00:00:00Z'));
const byName = ctx => (ctx && ctx.user && (ctx.user.full_name || ctx.user.username)) || '';
const isAdmin = ctx => !!(ctx && ctx.user && ctx.user.role === 'admin');
function requireStaff(ctx) {
  const r = ctx && ctx.user && ctx.user.role;
  if (r !== 'admin' && r !== 'staff') throw new UserError('ใช้ได้เฉพาะบัญชีธุรการหรือผู้ดูแลระบบ');
}
function kindOf(k) {
  if (!KINDS.includes(k)) throw new UserError('ไม่รู้จักแบบฟอร์มนี้');
  return k;
}
function codeOf(c) {
  const s = str(c, 10).toUpperCase();
  if (!/^[A-Z0-9]{2,10}$/.test(s)) throw new UserError('กรุณาเลือกโครงการ');
  return s;
}
function dateOf(d, label) {
  if (!isDate(d)) throw new UserError('กรุณาเลือก' + (label || 'วันที่'));
  return d;
}
const addDays = (d, n) => { const t = new Date(d + 'T00:00:00Z'); t.setUTCDate(t.getUTCDate() + n); return t.toISOString().slice(0, 10); };
const dow = d => new Date(d + 'T00:00:00Z').getUTCDay();   // 0 = อาทิตย์
function todayBkk() { return new Date(Date.now() + 7 * 3600 * 1000).toISOString().slice(0, 10); }

async function holidaySet(client) {
  try {
    const r = await client.query(`SELECT TO_CHAR(holiday_date, 'YYYY-MM-DD') AS d FROM transport_holidays`);
    return new Set(r.rows.map(x => x.d));
  } catch (e) { return new Set(); }   // ยังไม่ได้รัน migrate_transport
}
// วันทำงาน = จันทร์–เสาร์ ไม่ใช่วันหยุด (ตารางวันหยุดของระบบขนส่ง)
function prevWorkday(d, hol) {
  let x = addDays(d, -1);
  for (let i = 0; i < 14 && (dow(x) === 0 || hol.has(x)); i++) x = addDays(x, -1);
  return x;
}
function nextWorkday(d, hol) {
  let x = addDays(d, 1);
  for (let i = 0; i < 14 && (dow(x) === 0 || hol.has(x)); i++) x = addDays(x, 1);
  return x;
}
// กำหนดส่ง = 16:00 น. ของวันทำงานก่อนวันแผน (เครื่องจักร = วันของช่วง OT)
function deadlineOf(kind, planDate, otDate, hol) {
  const d = kind === 'machine' && otDate ? otDate : prevWorkday(planDate, hol);
  return { date: d, at: new Date(`${d}T${pad(DEADLINE_HOUR)}:00:00+07:00`) };
}

async function projectList() {
  try {
    const r = await sitePool.query('SELECT code, name FROM transport_projects WHERE active ORDER BY sort_order, code');
    if (r.rows.length) return r.rows;
  } catch (e) { /* ยังไม่มีตารางระบบขนส่ง */ }
  return PROJECTS.map(p => ({ code: p.code, name: p.name }));
}
async function projectName(code) {
  const p = (await projectList()).find(x => x.code === code);
  return p ? p.name : code;
}

// ---------- ตรวจความสมบูรณ์ ----------
// คืน [{ idx, label, fields: ['plate', ...] }] ของแถวที่ข้อมูลไม่ครบ (นับเฉพาะแถวที่ไม่ใช่ "เพิ่มหลังส่ง")
function checkItems(kind, items) {
  const out = [];
  items.forEach((it, idx) => {
    if (it.added_after) return;
    const f = [];
    const timeOk = Number.isInteger(it.slot_from) && Number.isInteger(it.slot_to);
    if (kind === 'vehicle') {
      if (!str(it.plate)) f.push('plate');
      if (!str(it.resource_label) || /^อื่น/.test(str(it.resource_label))) f.push('type');
      if (!str(it.location)) f.push('location');
      if (!timeOk) f.push('time');
    } else {
      if (!str(it.resource_label)) f.push('machine');
      if (!timeOk) f.push('mtime');
      if (!str(it.job)) f.push('job');
      const lift = /ลิฟท์|ลิฟต์/.test(it.grp || '') && !/โฟล์ค|โฟล์ก|forklift/i.test(it.grp || '');   // รถโฟล์คลิฟท์ ไม่ใช่ลิฟท์
      if (!lift && !str(it.requester)) f.push('requester');
    }
    if (f.length) out.push({ idx: idx + 1, label: [it.resource_label, it.plate].filter(Boolean).join(' '), fields: f });
  });
  return out;
}

// แถวจากหน้าเว็บ → แถวที่บันทึกได้ (ไม่บังคับครบ — ความครบไปวัดที่ KPI)
function cleanItem(kind, raw, resMap) {
  raw = raw || {};
  const res = raw.resourceId ? resMap.get(Number(raw.resourceId)) : null;
  const slots = FORMS[kind].slots.length;
  let a = raw.slotFrom === '' || raw.slotFrom == null ? null : Number(raw.slotFrom);
  let b = raw.slotTo === '' || raw.slotTo == null ? a : Number(raw.slotTo);
  if (!Number.isInteger(a) || a < 0 || a >= slots) a = null;
  if (!Number.isInteger(b) || b < 0 || b >= slots) b = a;
  if (a != null && b != null && b < a) [a, b] = [b, a];
  if (kind === 'machine' && a != null && (a < MACHINE_OT_SLOTS) !== (b < MACHINE_OT_SLOTS)) {
    throw new UserError('ช่วงเวลาของเครื่องจักรต้องอยู่ในช่วง OT หรือช่วงวันทำงานอย่างใดอย่างหนึ่ง (แยกเป็น 2 แถว)');
  }
  const qty = raw.qty === '' || raw.qty == null ? null : Math.max(0, Math.min(999, parseInt(raw.qty, 10) || 0));
  return {
    id: raw.id ? Number(raw.id) : null,
    resource_id: res ? res.id : null,
    resource_label: str(raw.resourceLabel, 120) || (res ? res.name : ''),
    grp: res ? res.grp : str(raw.grp, 60),
    slot_from: a, slot_to: b,
    plate: str(raw.plate, 60) || (res && kind === 'vehicle' ? res.plate : ''),
    job: str(raw.job, 300),
    location: str(raw.location, 200),
    qty,
    requester: str(raw.requester, 120),
    note: str(raw.note, 300),
    work_type: kind === 'machine' && WORK_TYPES.some(w => w.key === raw.workType) ? raw.workType : '',
  };
}

const ITEM_COLS = `id, resource_id AS "resourceId", resource_label AS "resourceLabel", grp, slot_from AS "slotFrom", slot_to AS "slotTo",
  plate, job, location, qty, requester, note, added_after AS "addedAfter", work_type AS "workType"`;
const PLAN_COLS = `id, kind, project_code AS "projectCode", TO_CHAR(plan_date, 'YYYY-MM-DD') AS "planDate",
  TO_CHAR(ot_date, 'YYYY-MM-DD') AS "otDate", status, prepared_by AS "preparedBy", pm_name AS "pmName",
  submitted_at AS "submittedAt", TO_CHAR(submitted_at AT TIME ZONE '${TZ}', 'DD/MM/') || (EXTRACT(YEAR FROM submitted_at AT TIME ZONE '${TZ}')::int + 543) || TO_CHAR(submitted_at AT TIME ZONE '${TZ}', ' HH24:MI') AS "submittedText",
  submitted_by AS "submittedBy", complete, missing, excluded, exclude_reason AS "excludeReason", note, edit_count AS "editCount",
  review_incomplete AS "reviewIncomplete", review_fields AS "reviewFields", review_note AS "reviewNote", reviewer,
  reviewer_position AS "reviewerPosition", TO_CHAR(reviewed_at AT TIME ZONE '${TZ}', 'YYYY-MM-DD') AS "reviewedDate",
  review_entered_by AS "reviewEnteredBy",
  updated_by AS "updatedBy", TO_CHAR(updated_at AT TIME ZONE '${TZ}', 'DD/MM/') || (EXTRACT(YEAR FROM updated_at AT TIME ZONE '${TZ}')::int + 543) || TO_CHAR(updated_at AT TIME ZONE '${TZ}', ' HH24:MI') AS "updatedText"`;

function withOnTime(plan, hol) {
  // ผลตรวจที่ใช้จริง = ระบบตรวจตอนส่ง แล้วถ้าผู้ตรวจปรับเป็นไม่สมบูรณ์ ใช้ผลของผู้ตรวจ
  plan.systemComplete = plan.complete;
  if (plan.complete != null) plan.complete = !!plan.complete && !plan.reviewIncomplete;
  const dl = deadlineOf(plan.kind, plan.planDate, plan.otDate, hol);
  plan.deadlineDate = dl.date;
  plan.onTime = plan.submittedAt ? new Date(plan.submittedAt) <= dl.at : null;
  return plan;
}

// ============================================================
async function DPLAN_meta() {
  requireStaff(this);
  const hol = await holidaySet(sitePool);
  const today = todayBkk();
  return {
    forms: FORMS, fieldNames: FIELD_TH, excludeReasons: EXCLUDE_REASONS,
    workTypes: WORK_TYPES, groupColors: GROUP_COLORS, noTypeColor: NO_TYPE_COLOR,
    projects: await projectList(), today, nextWorkday: nextWorkday(today, hol),
    isAdmin: isAdmin(this), me: byName(this), deadlineHour: DEADLINE_HOUR,
  };
}

async function DPLAN_resources(kind, code) {
  requireStaff(this);
  kind = kindOf(kind); code = codeOf(code);
  const r = await sitePool.query(
    `SELECT id, grp, name, plate, active FROM dplan_resources WHERE project_code = $1 AND kind = $2 AND active
      ORDER BY sort_order, id`, [code, kind]);
  return r.rows;
}

function DPLAN_template(kind) {
  requireStaff(this);
  kind = kindOf(kind);
  return TEMPLATES[kind].map(([grp, name, plate]) => ({ grp, name, plate }));
}

// list = [{ id?, grp, name, plate }] ตามลำดับที่ต้องการ — แถวเดิมที่ไม่อยู่ใน list = ปิดใช้ (แผนเก่ายังอ้างได้)
async function DPLAN_saveResources(kind, code, list) {
  requireStaff(this);
  kind = kindOf(kind); code = codeOf(code);
  const rows = (Array.isArray(list) ? list : [])
    .map(x => ({ id: x && x.id ? Number(x.id) : null, grp: str(x && x.grp, 60), name: str(x && x.name, 120), plate: str(x && x.plate, 40) }))
    .filter(x => x.name);
  if (rows.length > 200) throw new UserError('รายชื่อมากเกินไป (ไม่เกิน 200 แถว)');
  return withTx(async client => {
    const keep = [];
    for (let i = 0; i < rows.length; i++) {
      const x = rows[i];
      let id = null;
      if (x.id) {
        const u = await client.query(
          `UPDATE dplan_resources SET grp = $3, name = $4, plate = $5, sort_order = $6, active = TRUE
            WHERE id = $1 AND project_code = $2 AND kind = $7 RETURNING id`, [x.id, code, x.grp, x.name, x.plate, i, kind]);
        if (u.rows.length) id = u.rows[0].id;
      }
      if (!id) {
        id = (await client.query(
          `INSERT INTO dplan_resources (project_code, kind, grp, name, plate, sort_order) VALUES ($1,$2,$3,$4,$5,$6) RETURNING id`,
          [code, kind, x.grp, x.name, x.plate, i])).rows[0].id;
      }
      keep.push(id);
    }
    await client.query(
      `UPDATE dplan_resources SET active = FALSE WHERE project_code = $1 AND kind = $2 AND NOT (id = ANY($3::int[]))`, [code, kind, keep]);
    return { ok: true, count: keep.length };
  });
}

async function DPLAN_month(kind, code, month) {
  requireStaff(this);
  kind = kindOf(kind); code = codeOf(code);
  if (!/^\d{4}-\d{2}$/.test(String(month || ''))) throw new UserError('เดือนไม่ถูกต้อง');
  const from = month + '-01', to = addDays(addDays(from, 32).slice(0, 8) + '01', -1);
  const hol = await holidaySet(sitePool);
  const r = await sitePool.query(
    `SELECT ${PLAN_COLS}, (SELECT COUNT(*)::int FROM dplan_items i WHERE i.plan_id = p.id) AS "itemCount"
       FROM dplan_plans p WHERE kind = $1 AND project_code = $2 AND plan_date BETWEEN $3 AND $4 ORDER BY plan_date`,
    [kind, code, from, to]);
  return r.rows.map(p => withOnTime(p, hol));
}

async function DPLAN_get(kind, code, date) {
  requireStaff(this);
  kind = kindOf(kind); code = codeOf(code); date = dateOf(date, 'วันที่ของแผน');
  const hol = await holidaySet(sitePool);
  const resources = await DPLAN_resources.call(this, kind, code);
  const p = (await sitePool.query(`SELECT ${PLAN_COLS} FROM dplan_plans p WHERE kind = $1 AND project_code = $2 AND plan_date = $3`,
    [kind, code, date])).rows[0];
  const projName = await projectName(code);
  if (!p) {
    const blank = { id: null, kind, projectCode: code, planDate: date, otDate: kind === 'machine' ? prevWorkday(date, hol) : null,
      status: 'new', preparedBy: '', pmName: '', excluded: false, excludeReason: '', note: '', missing: [], editCount: 0 };
    return { plan: withOnTime(blank, hol), items: [], resources, projectName: projName };
  }
  const items = (await sitePool.query(`SELECT ${ITEM_COLS} FROM dplan_items WHERE plan_id = $1 ORDER BY sort_order, id`, [p.id])).rows;
  // ช่วยหน้าเว็บ: ถ้ายังไม่ได้ตั้ง PE/PM ใช้ชื่อจากแผนล่าสุดของโครงการ
  return { plan: withOnTime(p, hol), items, resources, projectName: projName };
}

async function DPLAN_previous(kind, code, date) {
  requireStaff(this);
  kind = kindOf(kind); code = codeOf(code); date = dateOf(date);
  const p = (await sitePool.query(
    `SELECT id, TO_CHAR(plan_date, 'YYYY-MM-DD') AS d, pm_name FROM dplan_plans
      WHERE kind = $1 AND project_code = $2 AND plan_date < $3 ORDER BY plan_date DESC LIMIT 1`, [kind, code, date])).rows[0];
  if (!p) throw new UserError('ยังไม่มีแผนก่อนหน้าของโครงการนี้');
  const items = (await sitePool.query(`SELECT ${ITEM_COLS} FROM dplan_items WHERE plan_id = $1 ORDER BY sort_order, id`, [p.id])).rows;
  items.forEach(i => { delete i.id; i.addedAfter = false; });
  return { fromDate: p.d, pmName: p.pm_name || '', items };
}

// req = { kind, projectCode, planDate, otDate?, pmName, note, items: [...], submit: bool }
async function DPLAN_save(req) {
  requireStaff(this);
  req = req || {};
  const kind = kindOf(req.kind), code = codeOf(req.projectCode), date = dateOf(req.planDate, 'วันที่ของแผน');
  const otDate = kind === 'machine' ? dateOf(req.otDate, 'วันที่ของช่วง OT') : null;
  if (otDate && otDate > date) throw new UserError('วันที่ช่วง OT ต้องไม่เกินวันที่ของแผน');
  const rawItems = Array.isArray(req.items) ? req.items : [];
  if (rawItems.length > 300) throw new UserError('รายการมากเกินไป');
  const by = byName(this);

  return withTx(async client => {
    await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`dplan|${kind}|${code}|${date}`]);
    const resMap = new Map((await client.query(
      'SELECT id, grp, name, plate FROM dplan_resources WHERE project_code = $1 AND kind = $2', [code, kind])).rows.map(r => [r.id, r]));
    let items = rawItems.map(x => cleanItem(kind, x, resMap))
      .filter(x => x.resource_label || x.job || x.plate || x.location || x.slot_from != null);

    let plan = (await client.query('SELECT id, status FROM dplan_plans WHERE kind = $1 AND project_code = $2 AND plan_date = $3 FOR UPDATE',
      [kind, code, date])).rows[0];
    const wasSubmitted = !!(plan && plan.status === 'submitted');
    const submitNow = !!req.submit && !wasSubmitted;

    // แผนที่ส่งแล้ว: แถวเดิมคงสถานะเดิม · แถวใหม่ = "เพิ่มหลังส่ง" (ไม่นับ KPI)
    const oldAfter = new Map();
    if (plan) {
      (await client.query('SELECT id, added_after FROM dplan_items WHERE plan_id = $1', [plan.id])).rows
        .forEach(r => oldAfter.set(r.id, r.added_after));
    }
    items.forEach(it => {
      it.added_after = wasSubmitted ? (it.id && oldAfter.has(it.id) ? oldAfter.get(it.id) : true) : false;
    });
    if (submitNow && !items.length) throw new UserError('ยังไม่มีรายการในแผน — เพิ่มอย่างน้อย 1 แถวก่อนส่ง');

    if (!plan) {
      plan = (await client.query(
        `INSERT INTO dplan_plans (kind, project_code, plan_date, ot_date, pm_name, note, created_by, updated_by)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$7) RETURNING id, status`,
        [kind, code, date, otDate, str(req.pmName, 100), str(req.note, 500), by])).rows[0];
    } else {
      await client.query(
        `UPDATE dplan_plans SET ot_date = $2, pm_name = $3, note = $4, updated_by = $5, updated_at = NOW(),
                edit_count = edit_count + $6 WHERE id = $1`,
        [plan.id, otDate, str(req.pmName, 100), str(req.note, 500), by, wasSubmitted ? 1 : 0]);
    }

    await client.query('DELETE FROM dplan_items WHERE plan_id = $1', [plan.id]);
    for (let i = 0; i < items.length; i++) {
      const it = items[i];
      await client.query(
        `INSERT INTO dplan_items (plan_id, resource_id, resource_label, grp, slot_from, slot_to, plate, job, location, qty, requester, note, added_after, sort_order, work_type)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)`,
        [plan.id, it.resource_id, it.resource_label, it.grp, it.slot_from, it.slot_to, it.plate, it.job, it.location, it.qty,
          it.requester, it.note, it.added_after, i, it.work_type]);
    }

    let missing = null;
    if (submitNow) {
      missing = checkItems(kind, items);
      await client.query(
        `UPDATE dplan_plans SET status = 'submitted', submitted_at = NOW(), submitted_by = $2, prepared_by = $2,
                complete = $3, missing = $4::jsonb WHERE id = $1`,
        [plan.id, by, missing.length === 0, JSON.stringify(missing)]);
    }
    return { ok: true, id: plan.id, submitted: submitNow, complete: missing ? missing.length === 0 : null, missing };
  });
}

async function DPLAN_setExcluded(id, excluded, reason) {
  requireStaff(this);
  const on = !!excluded;
  const why = str(reason, 200);
  if (on && !why) throw new UserError('กรุณาเลือกเหตุผลที่ไม่นับ');
  const r = await sitePool.query(
    `UPDATE dplan_plans SET excluded = $2, exclude_reason = $3, updated_by = $4, updated_at = NOW()
      WHERE id = $1 AND status = 'submitted'`, [Number(id) || 0, on, on ? why : '', byName(this)]);
  if (!r.rowCount) throw new UserError('ตั้ง "ไม่นับ" ได้เฉพาะแผนที่ส่งแล้ว');
  return { ok: true };
}

// ผลตรวจทานของหัวหน้างาน / ผู้ตรวจ (กรอกตามที่ผู้ตรวจติ๊ก/เซ็นในใบพิมพ์)
//   req = { id, incomplete: bool, fields: ['plate', ...], note, reviewer, position }
//   ปรับได้แค่ทางเดียว: จาก "สมบูรณ์" → "ไม่สมบูรณ์" (ช่องที่ระบบเห็นว่าว่าง ผู้ตรวจปรับเป็นครบไม่ได้)
async function DPLAN_review(req) {
  requireStaff(this);
  req = req || {};
  const p = (await sitePool.query('SELECT kind, status FROM dplan_plans WHERE id = $1', [Number(req.id) || 0])).rows[0];
  if (!p) throw new UserError('ไม่พบแผนนี้');
  if (p.status !== 'submitted') throw new UserError('บันทึกผลตรวจได้เฉพาะแผนที่ส่งแล้ว');
  const on = !!req.incomplete;
  const allowed = p.kind === 'vehicle' ? ['plate', 'type', 'location', 'time'] : ['machine', 'mtime', 'job', 'requester'];
  const fields = (Array.isArray(req.fields) ? req.fields : []).filter(f => allowed.includes(f));
  const note = str(req.note, 500), reviewer = str(req.reviewer, 100);
  if (on) {
    if (!fields.length && !note) throw new UserError('ระบุช่องที่ขาด / ไม่ชัด หรือรายละเอียด อย่างน้อย 1 อย่าง');
    if (!reviewer) throw new UserError('กรุณาใส่ชื่อผู้ตรวจ (ตามที่ลงชื่อในใบ)');
  }
  await sitePool.query(
    `UPDATE dplan_plans SET review_incomplete = $2, review_fields = $3::jsonb, review_note = $4, reviewer = $5, reviewer_position = $6,
            reviewed_at = CASE WHEN $2 THEN NOW() ELSE NULL END, review_entered_by = $7, updated_by = $7, updated_at = NOW() WHERE id = $1`,
    [Number(req.id), on, JSON.stringify(on ? fields : []), on ? note : '', on ? reviewer : '', on ? str(req.position, 60) : '', byName(this)]);
  return { ok: true };
}

async function DPLAN_delete(id) {
  requireStaff(this);
  const p = (await sitePool.query('SELECT status FROM dplan_plans WHERE id = $1', [Number(id) || 0])).rows[0];
  if (!p) throw new UserError('ไม่พบแผนนี้ (อาจถูกลบไปแล้ว)');
  if (p.status === 'submitted' && !isAdmin(this)) throw new UserError('แผนที่ส่งแล้วลบได้เฉพาะผู้ดูแลระบบ (admin) — ถ้าไม่ต้องการนับ ให้ติ๊ก "ไม่นับ"');
  await sitePool.query('DELETE FROM dplan_plans WHERE id = $1', [Number(id)]);
  return { ok: true };
}

// req = { from: 'YYYY-MM', to: 'YYYY-MM', code? }
async function DPLAN_kpi(req) {
  requireStaff(this);
  req = req || {};
  const from = /^\d{4}-\d{2}$/.test(req.from || '') ? req.from + '-01' : todayBkk().slice(0, 8) + '01';
  const toM = /^\d{4}-\d{2}$/.test(req.to || '') ? req.to : from.slice(0, 7);
  const to = addDays(addDays(toM + '-01', 32).slice(0, 8) + '01', -1);
  const code = req.code ? codeOf(req.code) : null;
  const hol = await holidaySet(sitePool);
  const rows = (await sitePool.query(
    `SELECT ${PLAN_COLS} FROM dplan_plans p
      WHERE plan_date BETWEEN $1 AND $2 AND ($3::text IS NULL OR project_code = $3) ORDER BY plan_date`, [from, to, code])).rows
    .map(p => withOnTime(p, hol));
  const names = new Map((await projectList()).map(p => [p.code, p.name]));

  const agg = new Map();
  const add = (key, base, p) => {
    if (!agg.has(key)) agg.set(key, Object.assign({ made: 0, complete: 0, excluded: 0, drafts: 0, onTime: 0, late: 0 }, base));
    const a = agg.get(key);
    if (p.status !== 'submitted') { a.drafts++; return; }
    if (p.excluded) { a.excluded++; return; }
    a.made++;
    if (p.complete) a.complete++;
    if (p.onTime) a.onTime++; else a.late++;
  };
  rows.forEach(p => {
    const month = p.planDate.slice(0, 7);
    add(`${p.kind}|ALL|ALL`, { kind: p.kind, code: '', month: '' }, p);
    add(`${p.kind}|${p.projectCode}|ALL`, { kind: p.kind, code: p.projectCode, month: '' }, p);
    add(`${p.kind}|${p.projectCode}|${month}`, { kind: p.kind, code: p.projectCode, month }, p);
  });
  const list = [...agg.values()].map(a => Object.assign(a, {
    projectName: a.code ? (names.get(a.code) || a.code) : '',
    pct: a.made ? Math.round(a.complete / a.made * 1000) / 10 : null,
  }));
  // แผนที่ข้อมูลไม่ครบ (ไว้ดูว่าขาดอะไรบ่อย)
  const incomplete = rows.filter(p => p.status === 'submitted' && !p.excluded && p.complete === false)
    .map(p => ({ id: p.id, kind: p.kind, code: p.projectCode, planDate: p.planDate, missing: p.missing || [],
      reviewIncomplete: !!p.reviewIncomplete, reviewFields: p.reviewFields || [] }));
  const fieldCount = {};
  incomplete.forEach(p => {
    const fs = new Set(p.reviewFields);
    p.missing.forEach(m => m.fields.forEach(f => fs.add(f)));
    fs.forEach(f => { const k = p.kind + '|' + f; fieldCount[k] = (fieldCount[k] || 0) + 1; });
  });
  const reviewed = rows.filter(p => p.status === 'submitted' && !p.excluded && p.reviewIncomplete && p.systemComplete).length;
  return { from: from.slice(0, 7), to: toM, rows: list, incomplete, fieldCount, reviewed };
}

// ลบหลายแผนพร้อมกัน (admin เท่านั้น — ใช้ล้างแผนทดลอง/แผนที่ทำผิด)
async function DPLAN_deleteMany(ids) {
  requireStaff(this);
  if (!isAdmin(this)) throw new UserError('ลบหลายแผนได้เฉพาะผู้ดูแลระบบ (admin)');
  const list = (Array.isArray(ids) ? ids : []).map(Number).filter(n => Number.isInteger(n) && n > 0).slice(0, 400);
  if (!list.length) throw new UserError('ยังไม่ได้เลือกแผน');
  const r = await sitePool.query('DELETE FROM dplan_plans WHERE id = ANY($1::int[])', [list]);
  return { ok: true, deleted: r.rowCount };
}

// สำหรับการ์ดในหน้า /admin
async function summary() {
  const r = await sitePool.query(`SELECT COUNT(*)::int AS n FROM dplan_plans WHERE status = 'submitted'`);
  return r.rows[0].n;
}

module.exports = {
  checkItems, deadlineOf, prevWorkday, summary, FORMS,
  functions: {
    DPLAN_meta, DPLAN_resources, DPLAN_template, DPLAN_saveResources, DPLAN_month, DPLAN_get,
    DPLAN_previous, DPLAN_save, DPLAN_setExcluded, DPLAN_review, DPLAN_delete, DPLAN_deleteMany, DPLAN_kpi,
  },
};
