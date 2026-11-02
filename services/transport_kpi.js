// ============================================================
// KPI ระบบขนส่งวัสดุ — ส่งภายใน 2 วันทำการหลังวันที่ออกใบเบิก (ไม่นับวันที่เบิก)
//   วันทำการ = จันทร์–เสาร์ ข้ามวันอาทิตย์และวันหยุดในตาราง transport_holidays (admin ใส่)
//   ไม่นับรายการ ย้าย / ยกเลิก
//
//   TRANSPORT_kpi(code)            ข้อมูลรายแถวสำหรับคำนวณ KPI (หน้า Dashboard รวมผลตามเดือนเอง)
//   TRANSPORT_listHolidays()       วันหยุดทั้งหมด
//   TRANSPORT_saveHolidays(text)   (admin) แทนที่รายการวันหยุดทั้งหมด — บรรทัดละวัน "วว/ดด/ปปปป ชื่อ"
// ============================================================
const { sitePool } = require('../db');
const { UserError, withTx } = require('./common');

const SLA_DAYS = 2;
const EXCLUDE = ['ย้าย', 'ยกเลิก'];

const iso = d => d.toISOString().slice(0, 10);
const addDays = (s, n) => { const d = new Date(s + 'T00:00:00Z'); d.setUTCDate(d.getUTCDate() + n); return iso(d); };
const isWorkDay = (s, hol) => new Date(s + 'T00:00:00Z').getUTCDay() !== 0 && !hol.has(s);

// วันสุดท้ายที่ส่งได้: นับวันทำการถัดจากวันที่เบิก ไป SLA_DAYS วัน
function deadlineOf(requestDate, hol) {
  let d = requestDate, n = 0;
  while (n < SLA_DAYS) { d = addDays(d, 1); if (isWorkDay(d, hol)) n++; }
  return d;
}
// ช้ากี่วันทำการ (หลังกำหนด จนถึงวันที่รับ/วันนี้)
function workDaysAfter(deadline, until, hol) {
  let d = deadline, n = 0;
  while (d < until) { d = addDays(d, 1); if (isWorkDay(d, hol)) n++; }
  return n;
}
function todayBkk() { return iso(new Date(Date.now() + 7 * 3600 * 1000)); }
function codeOf(code) {
  const c = String(code || '').trim().toUpperCase();
  if (!/^[A-Z0-9]{2,10}$/.test(c)) throw new UserError('รหัสโครงการไม่ถูกต้อง');
  return c;
}

async function holidaySet(client) {
  const r = await (client || sitePool).query(`SELECT TO_CHAR(holiday_date, 'YYYY-MM-DD') AS d FROM transport_holidays`);
  return new Set(r.rows.map(x => x.d));
}

async function TRANSPORT_kpi(projectCode) {
  const code = codeOf(projectCode);
  const hol = await holidaySet();
  const r = await sitePool.query(
    `SELECT l.id, TO_CHAR(l.request_date, 'YYYY-MM-DD') AS req, TO_CHAR(l.receive_date, 'YYYY-MM-DD') AS rec,
            COALESCE(l.status, '') AS status, COALESCE(l.mat_item, '') AS item, COALESCE(l.building, '') AS building,
            COALESCE(l.floor, '') AS floor, l.quantity::float AS qty, COALESCE(l.unit, '') AS unit,
            COALESCE(l.requester_receiver, '') AS requester, COALESCE(l.source, '') AS source,
            TO_CHAR(l.created_at AT TIME ZONE 'Asia/Bangkok', 'YYYY-MM-DD') AS entered,
            (d.doc_no IS NOT NULL) AS "hasDoc"
       FROM material_transport_logs l
       LEFT JOIN transport_docs d ON d.project_code = l.project_code AND d.doc_no = l.doc_no
      WHERE l.project_code = $1 AND l.request_date IS NOT NULL
      ORDER BY l.request_date, l.id`, [code]);
  const today = todayBkk();
  const rows = r.rows.filter(x => !EXCLUDE.includes(x.status)).map(x => {
    const due = deadlineOf(x.req, hol);
    let state, lateDays = 0;
    if (x.rec) {
      state = x.rec <= due ? 'ontime' : 'late';
      if (state === 'late') lateDays = workDaysAfter(due, x.rec, hol);
    } else if (today > due) {
      state = 'overdue'; lateDays = workDaysAfter(due, today, hol);
    } else {
      state = 'pending';
    }
    // กรอกทันเวลา: เฉพาะรายการที่กรอกบนเว็บ (นำเข้าจากชีตไม่รู้วันที่กรอกจริง)
    const timely = x.source === 'web' && x.rec ? (x.entered <= addDays(x.rec, 1)) : null;
    return { id: x.id, month: x.req.slice(0, 7), req: x.req, rec: x.rec || '', due, state, lateDays,
      item: x.item, building: x.building, floor: x.floor, qty: x.qty, unit: x.unit, requester: x.requester,
      hasDoc: x.hasDoc, timely };
  });
  return { slaDays: SLA_DAYS, today, rows };
}

async function TRANSPORT_listHolidays() {
  const r = await sitePool.query(
    `SELECT TO_CHAR(holiday_date, 'DD/MM/YYYY') AS date, name FROM transport_holidays ORDER BY holiday_date`);
  return r.rows;
}

async function TRANSPORT_saveHolidays(text) {
  if (!(this && this.user && this.user.role === 'admin')) throw new UserError('ต้องใช้บัญชีผู้ดูแลระบบ (admin)');
  const list = [], bad = [];
  String(text || '').split(/\r?\n/).map(s => s.trim()).filter(Boolean).forEach((line, i) => {
    const m = line.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})\s*(.*)$/) || line.match(/^(\d{4})-(\d{2})-(\d{2})\s*(.*)$/);
    if (!m) { bad.push(`บรรทัด ${i + 1}: "${line.slice(0, 30)}"`); return; }
    let y, mo, d;
    if (m[1].length === 4) { y = +m[1]; mo = +m[2]; d = +m[3]; } else { d = +m[1]; mo = +m[2]; y = +m[3]; }
    if (y > 2400) y -= 543;
    const s = `${y}-${String(mo).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
    const dt = new Date(s + 'T00:00:00Z');
    if (isNaN(dt) || iso(dt) !== s) { bad.push(`บรรทัด ${i + 1}: วันที่ไม่ถูกต้อง`); return; }
    list.push([s, m[4].slice(0, 100)]);
  });
  if (bad.length) throw new UserError('รูปแบบวันหยุดไม่ถูกต้อง (ใช้ วว/ดด/ปปปป ชื่อวันหยุด):\n' + bad.slice(0, 5).join('\n'));
  await withTx(async client => {
    await client.query('DELETE FROM transport_holidays');
    for (const [d, n] of list) {
      await client.query('INSERT INTO transport_holidays (holiday_date, name) VALUES ($1, $2) ON CONFLICT (holiday_date) DO UPDATE SET name = EXCLUDED.name', [d, n]);
    }
  });
  return { saved: list.length };
}

module.exports = {
  deadlineOf, workDaysAfter,
  functions: { TRANSPORT_kpi, TRANSPORT_listHolidays, TRANSPORT_saveHolidays }
};
