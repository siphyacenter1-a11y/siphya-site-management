// ============================================================
// อ่าน PDF "แผนเดินรถประจำสัปดาห์ (บริษัทฯ)" จากศูนย์สระบุรี (FM-TS-01-04)
//
//   parsePlanPdf(buffer) → { weekStart, weekEnd, days[], trucks[], items[] }
//
// วิธีอ่าน: ใช้ตำแหน่งตัวหนังสือในหน้า (pdfjs) ไม่ใช่ลำดับข้อความ
//   - คอลัมน์วัน   = หัวตาราง "ต้นทาง ... ผู้จอง" 10 ชุด + วันที่ dd/mm/yy บนหัว
//   - แถว         = เลขเที่ยว 1/2/3 หน้าช่องเวลา (เที่ยว 1 = เริ่มรถคันใหม่)
//   - ทะเบียนรถ    = เลข 00-0000 ด้านซ้ายของแถวรถคันนั้น
//   - ข้อความในช่อง = ตัวหนังสือที่อยู่ในคอลัมน์วันนั้น และใกล้แถวนั้นที่สุด
// แต่ละช่องแยกเป็น
//   job    = งานขนส่ง "ต้นทาง - ปลายทาง, วัสดุ, ผู้จอง"
//   unload = "ลง..." (เที่ยวลงของต่อจากเที่ยวขึ้นของ)
//   status = ไม่ใช่งาน (พขร.ลาหยุด, ซ่อม, สำรอง, รถจอด ...)
// ============================================================
let pdfjsPromise = null;
function pdfjs() {
  if (!pdfjsPromise) pdfjsPromise = import('pdfjs-dist/legacy/build/pdf.mjs');
  return pdfjsPromise;
}

// BU = หน่วยงานของศูนย์สระบุรี
const BU_LIST = ['CUT&BEND', 'FORMWORK', 'FURNITURE', 'MAINTENANCE', 'PRECAST', 'S CRANE', 'STORE', 'TECHFORM'];
const BU_OTHER = 'อื่นๆ (ขนตรง)';
const BU_FURN_PUCHAO = 'FURNITURE ปู่เจ้า';

// ชื่อโครงการ/สถานที่ → ตัวย่อ (ทั้งในช่องงานและช่อง "ลง...")
const PLACES = [
  [/ORIGIN|\bORG\b/i, 'ORG'],
  [/MAVISTA/i, 'MAVISTA'],
  [/16\s*RESIDENCES|16\s*RSD/i, '16RSD'],
  [/SSR\s*CL|CL\s*RESIDENCES|\bSCL\b/i, 'SCL'],
  [/NOBU\s*CARPARK|\bCP\b/i, 'CP'],
  [/NOBU\s*EAC|\bEAC\b/i, 'EAC'],
  [/ซีฟโก้|SEAFCO|\bSG\b/i, 'SG'],
  [/LOGISTICS\s*PUCHAO|\bLGT\b/i, 'LGT'],
  [/65\s*SKV|สุขุมวิท\s*หกสิบห้า/i, '65SKV'],
  [/\bSRS\b|สารสิน/i, 'SRS'],
  [/\bNBH\b|PLAZA|พลาซ่า/i, 'NBH'],
  [/ไทยฟูลมอร์|ไทยฟลูมอร์/, 'ไทยฟูลมอร์'],
];
const SARABURI = /ศูนย์สระบุรี|ศนูยส์ระบรุี|สระบุรี/;

const clean = s => fixThai(s).replace(/\s+/g, ' ').replace(/\s+([,)])/g, '$1').trim();
const PLATE_RE = /(?<![\d-])(\d{2})\s*-\s*(\d{4})(?![\d-])/;
const plateOf = s => { const m = String(s).match(PLATE_RE); return m ? `${m[1]}-${m[2]}` : ''; };
// ฟอนต์ในไฟล์บางตัวให้ "า" ออกมาเป็น "ำ" (เช่น กระเช้ำ, สัปดำห์) — แก้ให้อ่านง่าย คงคำที่ใช้ "ำ" จริง
const KEEP_AM = ['สำรอง', 'ประจำ', 'ทำ', 'จำนวน', 'น้ำ', 'กำหนด', 'ดำเนิน', 'สำนักงาน', 'คำ', 'ตำแหน่ง'];
function fixThai(s) {
  let t = String(s || '').replace(/ำ/g, 'า');
  KEEP_AM.forEach(w => { t = t.split(w.replace(/ำ/g, 'า')).join(w); });
  return t;
}

function placeOf(s) {
  for (const [re, code] of PLACES) if (re.test(s)) return code;
  return '';
}
function buOf(s) {
  if (/FURNITURE/i.test(s) && /PUCHAO|ปู่เจ้า/i.test(s)) return BU_FURN_PUCHAO;
  if (SARABURI.test(s)) {
    for (const b of BU_LIST) if (s.toUpperCase().includes(b)) return b;
  }
  return BU_OTHER;
}

// แยกข้อความในช่อง → ชนิด + รายละเอียด
function parseCell(text) {
  const t = clean(text);
  if (!t) return null;
  if (/^ลง/.test(t)) {
    const m = t.match(/^ลง(.+?)\s+([A-Z0-9]{2,6})\b/);
    return { kind: 'unload', text: t, material: m ? m[1].trim() : t.slice(2), project: placeOf(t), bu: '', booker: '', origin: '', destination: '' };
  }
  // งานขนส่ง: ต้องมี "ต้นทาง - ปลายทาง" และคั่นวัสดุ/ผู้จองด้วยจุลภาค
  const parts = t.split(',').map(x => x.trim());
  const route = parts.length >= 3 ? parts.slice(0, -2).join(', ') : '';
  const dash = route.match(/^(.*?\S)\s*-\s+(.+)$/) || route.match(/^(.*?)\s+-\s*(.+)$/);
  if (parts.length >= 3 && dash) {
    const origin = clean(dash[1]), destination = clean(dash[2]);
    const fromSaraburi = SARABURI.test(origin);
    const site = fromSaraburi ? destination : origin;           // ฝั่งโครงการ
    const center = fromSaraburi ? origin : destination;         // ฝั่งศูนย์ (ถ้ามี)
    let bu = buOf(center);
    if (bu === BU_OTHER) bu = buOf(route);
    return {
      kind: 'job', text: t, origin, destination,
      material: parts[parts.length - 2], booker: parts[parts.length - 1].toUpperCase(),
      bu, project: placeOf(site) || placeOf(route)
    };
  }
  return { kind: 'status', text: t, material: '', booker: '', bu: '', project: '', origin: '', destination: '' };
}

const MONTHS = { JANUARY: 1, FEBRUARY: 2, MARCH: 3, APRIL: 4, MAY: 5, JUNE: 6, JULY: 7, AUGUST: 8, SEPTEMBER: 9, OCTOBER: 10, NOVEMBER: 11, DECEMBER: 12 };
const iso = (y, m, d) => `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;

async function parsePlanPdf(buffer) {
  const lib = await pdfjs();
  const doc = await lib.getDocument({ data: new Uint8Array(buffer), isEvalSupported: false, useSystemFonts: false, verbosity: 0 }).promise;
  let raw;
  try {
    const page = await doc.getPage(1);
    const vp = page.getViewport({ scale: 1 });
    const tc = await page.getTextContent();
    raw = tc.items.filter(i => i.str && i.str.trim()).map(i => ({
      s: i.str, x: i.transform[4], y: vp.height - i.transform[5], w: i.width
    }));
  } finally {
    await doc.destroy();
  }
  const all = raw.map(r => r.s).join(' ');

  // ---- สัปดาห์ (หัวมุมขวา: "Plan week 09 - 15 NOVEMBER 2026")
  const wk = all.match(/Plan\s*week\s*(\d{1,2})\s*-\s*(\d{1,2})\s+([A-Z]+)\s+(\d{4})/i);
  if (!wk || !MONTHS[wk[3].toUpperCase()]) throw new Error('ไม่พบ "Plan week" ในไฟล์ — ไม่ใช่แผนเดินรถประจำสัปดาห์ หรือรูปแบบไฟล์เปลี่ยน');
  let ey = Number(wk[4]), em = MONTHS[wk[3].toUpperCase()];
  const ed = Number(wk[2]), sd = Number(wk[1]);
  let sy = ey, sm = em;
  if (sd > ed) { sm = em - 1; if (sm < 1) { sm = 12; sy--; } }   // สัปดาห์คร่อมเดือน
  const weekStart = iso(sy, sm, sd), weekEnd = iso(ey, em, ed);

  // ---- คอลัมน์วัน
  const tons = raw.filter(r => r.s.trim() === 'ต้นทาง').sort((a, b) => a.x - b.x);
  const jongs = raw.filter(r => r.s.trim() === 'ผู้จอง').sort((a, b) => a.x - b.x);
  if (tons.length < 5) throw new Error('อ่านหัวตาราง (ต้นทาง/ผู้จอง) ไม่ได้ — รูปแบบไฟล์อาจเปลี่ยน');
  const headerY = tons[0].y;
  const cols = tons.map((t, i) => ({
    left: t.x - 4,
    right: i + 1 < tons.length ? tons[i + 1].x - 4 : (jongs.length ? jongs[jongs.length - 1].x + jongs[jongs.length - 1].w + 10 : t.x + 130)
  }));
  // วันที่บนหัวคอลัมน์ dd/mm/yy
  const dateItems = raw.filter(r => r.y < headerY && r.y > headerY - 45 && /\d{2}\/\d{2}\/\d{2}/.test(r.s));
  cols.forEach(c => {
    const hits = dateItems.filter(d => d.x + d.w / 2 >= c.left - 20 && d.x <= c.right);
    const m = hits.length && hits[0].s.match(/(\d{2})\/(\d{2})\/(\d{2})/);
    c.date = m ? iso(2000 + Number(m[3]), Number(m[2]), Number(m[1])) : '';
  });
  if (cols.some(c => !c.date)) throw new Error('อ่านวันที่บนหัวตารางไม่ครบ — รูปแบบไฟล์อาจเปลี่ยน');

  // ---- แถว (เลขเที่ยว 1/2/3 ทางซ้ายของคอลัมน์แรก)
  const tripItems = raw.filter(r => /^[1-3]$/.test(r.s.trim()) && r.y > headerY + 15 &&
    r.x > cols[0].left - 60 && r.x < cols[0].left - 25).sort((a, b) => a.y - b.y);
  const rows = [];
  let truck = 0;
  tripItems.forEach(r => {
    const trip = Number(r.s.trim());
    if (trip === 1 || !rows.length) truck++;
    rows.push({ truck, trip, y: r.y });
  });
  if (rows.length < 5) throw new Error('อ่านแถวรถ/เที่ยวไม่ได้ — รูปแบบไฟล์อาจเปลี่ยน');
  const lastY = rows[rows.length - 1].y;

  // ---- ทะเบียนรถ (ด้านซ้ายของแถว)
  const left = raw.filter(r => r.x < cols[0].left - 60);
  const trucks = [];
  for (let n = 1; n <= truck; n++) {
    const rs = rows.filter(r => r.truck === n);
    const top = rs[0].y - 14, bot = rs[rs.length - 1].y + 14, mid = (rs[0].y + rs[rs.length - 1].y) / 2;
    // ต่อตัวหนังสือแต่ละบรรทัดก่อน (บางไฟล์แยก "82" "-" "6320" เป็นคนละชิ้น)
    const lines = [];
    left.filter(p => p.y >= top && p.y <= bot).sort((a, b) => a.y - b.y || a.x - b.x).forEach(p => {
      const ln = lines.find(l => Math.abs(l.y - p.y) <= 2);
      if (ln) ln.parts.push(p); else lines.push({ y: p.y, parts: [p] });
    });
    const cands = lines.map(l => ({ y: l.y, plate: plateOf(l.parts.sort((a, b) => a.x - b.x).map(p => p.s).join(' ')) }))
      .filter(c => c.plate).sort((a, b) => Math.abs(a.y - mid) - Math.abs(b.y - mid));
    trucks.push({ truckNo: n, plate: cands.length ? cands[0].plate : '', trips: rs.length });
  }

  // ---- ข้อความในช่อง
  const cells = new Map();
  raw.forEach(r => {
    if (r.y < headerY + 15 || r.y > lastY + 14) return;
    const xc = r.x + r.w / 2;
    const ci = cols.findIndex(c => xc >= c.left && xc < c.right);
    if (ci < 0) return;
    let best = null;
    rows.forEach((row, ri) => { const d = Math.abs(row.y - r.y); if (!best || d < best.d) best = { ri, d }; });
    if (!best || best.d > 12) return;
    const k = best.ri + ':' + ci;
    if (!cells.has(k)) cells.set(k, []);
    cells.get(k).push(r);
  });

  const items = [];
  cells.forEach((list, k) => {
    const [ri, ci] = k.split(':').map(Number);
    // เรียงตามบรรทัด แล้วซ้าย→ขวา; ต่อคำที่ติดกันโดยไม่เว้นวรรค
    list.sort((a, b) => (Math.abs(a.y - b.y) > 3 ? a.y - b.y : a.x - b.x));
    let text = '', prev = null;
    list.forEach(r => {
      if (prev && Math.abs(prev.y - r.y) > 3) text += ' ';
      else if (prev && r.x - (prev.x + prev.w) > 1.5) text += ' ';
      text += r.s; prev = r;
    });
    const cell = parseCell(text);
    if (!cell) return;
    const row = rows[ri];
    const t = trucks[row.truck - 1];
    items.push(Object.assign(cell, {
      planDate: cols[ci].date, truckNo: row.truck, plate: t.plate, trip: row.trip,
      inWeek: cols[ci].date >= weekStart && cols[ci].date <= weekEnd
    }));
  });
  items.sort((a, b) => a.planDate.localeCompare(b.planDate) || a.truckNo - b.truckNo || a.trip - b.trip);
  return { weekStart, weekEnd, days: cols.map(c => c.date), trucks, items };
}

// เลข Revise จากชื่อไฟล์: "...Revise_3_06.11.2026.pdf" → 3, "...Revise_05.11.2026.pdf" → 0 (ฉบับแรก)
function revFromName(name) {
  const n = String(name || '');
  let m = n.match(/Rev(?:ise)?[\s_.-]*(\d{1,2})[\s_.-]+\d{1,2}[._-]\d{1,2}[._-]\d{2,4}/i);
  if (m) return { rev: Number(m[1]) };
  m = n.match(/Rev(?:ise)?[\s_.-]*(\d{1,2})(?!\d|[._-]\d)/i);
  if (m) return { rev: Number(m[1]) };
  if (/Rev(?:ise)?[\s_.-]*\d{1,2}[._-]\d{1,2}[._-]\d{2,4}/i.test(n)) return { rev: 0 };
  return { rev: null };
}
function dateFromName(name) {
  const m = String(name || '').match(/(\d{1,2})[._-](\d{1,2})[._-](\d{4})/);
  if (!m) return null;
  let y = Number(m[3]); if (y > 2400) y -= 543;
  return iso(y, Number(m[2]), Number(m[1]));
}

module.exports = { parsePlanPdf, parseCell, revFromName, dateFromName, BU_LIST, BU_OTHER, BU_FURN_PUCHAO };
