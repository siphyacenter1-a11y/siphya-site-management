// ============================================================
// ระบบแผนการเดินรถ (คำขอขนส่งภายนอกไซต์) — ตรรกะฝั่ง server
// ชื่อ/อินพุต/คำตอบ เหมือน Code.gs ของ hub เดิม เพื่อให้ public/route.html ใช้ได้ทันที
//
//   ROUTE_saveRequest(data)    บันทึกคำขอ → { result: 'success' } | { result: 'error', message }
//   ROUTE_getDashboardData()   { summary, byVehicle, byMonth, recent } | { error }
// ============================================================
const { sitePool } = require('../db');

const DOC_TYPES = ['NORMAL', 'URGENT', 'CANCEL'];
function fmtTs(d) {
  if (!d) return '';
  const p = new Intl.DateTimeFormat('en-GB', { timeZone: 'Asia/Bangkok', day: '2-digit', month: '2-digit',
    year: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false })
    .formatToParts(new Date(d)).reduce((o, x) => (o[x.type] = x.value, o), {});
  return `${p.day}/${p.month}/${p.year} ${p.hour}:${p.minute}`;
}
const str = (v, max) => String(v == null ? '' : v).trim().slice(0, max || 500);

const REQUIRED = [
  ['siteName', 'หน่วยงาน/โครงการ'], ['recipientHub', 'ศูนย์ที่รับเรื่อง'], ['targetMonth', 'เดือนที่ใช้รถ'],
  ['targetWeek', 'สัปดาห์'], ['origin', 'ต้นทาง'], ['destination', 'ปลายทาง'], ['vehicleType', 'ประเภทรถ'],
  ['loadingTime', 'วันขึ้นของ'], ['unloadingTime', 'วันลงของ'], ['cargoDetail', 'รายละเอียดสินค้า'],
  ['storageArea', 'พื้นที่จัดเก็บ'], ['requester', 'ผู้ขอ']
];

async function ROUTE_saveRequest(data) {
  if (!data || typeof data !== 'object') return { result: 'error', message: 'ไม่มีข้อมูลส่งเข้ามา' };
  if (!DOC_TYPES.includes(data.docType)) return { result: 'error', message: 'ประเภทเอกสารไม่ถูกต้อง' };

  const missing = REQUIRED.filter(f => !str(data[f[0]])).map(f => f[1]);
  if (missing.length) return { result: 'error', message: 'กรุณากรอกให้ครบ: ' + missing.join(', ') };

  const month = str(data.targetMonth);
  if (!/^\d{4}-\d{2}$/.test(month)) return { result: 'error', message: 'เดือนที่ใช้รถไม่ถูกต้อง' };
  const load = str(data.loadingTime), unload = str(data.unloadingTime);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(load) || !/^\d{4}-\d{2}-\d{2}$/.test(unload)) {
    return { result: 'error', message: 'วันขึ้นของ/ลงของไม่ถูกต้อง' };
  }
  if (unload < load) return { result: 'error', message: 'วันลงของต้องไม่ก่อนวันขึ้นของ' };

  await sitePool.query(
    `INSERT INTO vehicle_transport_requests (
       recorded_at, doc_type, sender_dept, receiving_center, usage_month, usage_week,
       origin, destination, truck_type, pickup_schedule, dropoff_schedule,
       item_list, storage_area, note, requester)
     VALUES (NOW(), $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)`,
    [data.docType, str(data.siteName, 200), str(data.recipientHub, 200), month + '-01', str(data.targetWeek, 50),
      str(data.origin, 200), str(data.destination, 200), str(data.vehicleType, 100), load, unload,
      str(data.cargoDetail, 1000), str(data.storageArea, 200), str(data.reason, 2000) || '-', str(data.requester, 200)]);
  return { result: 'success' };
}

async function ROUTE_getDashboardData() {
  const rows = (await sitePool.query(`
    SELECT doc_type, COALESCE(NULLIF(truck_type, ''), 'ไม่ระบุ') AS vehicle,
           COALESCE(TO_CHAR(usage_month, 'YYYY-MM'), 'ไม่ระบุ') AS month
      FROM vehicle_transport_requests`)).rows;

  const summary = { total: rows.length, NORMAL: 0, URGENT: 0, CANCEL: 0 };
  const byVehicle = {};
  const byMonth = {};
  rows.forEach(r => {
    if (summary[r.doc_type] !== undefined && r.doc_type !== 'total') summary[r.doc_type]++;
    byVehicle[r.vehicle] = (byVehicle[r.vehicle] || 0) + 1;
    if (!byMonth[r.month]) byMonth[r.month] = { total: 0, NORMAL: 0, URGENT: 0, CANCEL: 0 };
    byMonth[r.month].total++;
    if (DOC_TYPES.includes(r.doc_type)) byMonth[r.month][r.doc_type]++;
  });

  const recent = (await sitePool.query(`
    SELECT recorded_at AS "timestamp",
           doc_type AS "docType", sender_dept AS "siteName", origin, destination,
           truck_type AS "vehicleType", requester
      FROM vehicle_transport_requests
     ORDER BY recorded_at DESC NULLS LAST, id DESC LIMIT 10`)).rows;

  // แปลงเวลาใน JS (ใช้ได้ทั้งคอลัมน์แบบมี/ไม่มี timezone)
  recent.forEach(r => { r.timestamp = fmtTs(r.timestamp); });
  return { summary, byVehicle, byMonth, recent };
}

module.exports = { functions: { ROUTE_saveRequest, ROUTE_getDashboardData } };
