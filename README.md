# ศูนย์รวมระบบบริหารจัดการหน้างาน (Site Management Hub) — PostgreSQL Edition

ระบบ Portal และเว็บแอปพลิเคชันบริหารจัดการหน้างานสำหรับไซต์ก่อสร้าง เชื่อมต่อกับฐานข้อมูล **PostgreSQL** โดยตรงผ่าน Node.js (Express) เพื่อประสิทธิภาพ ความรวดเร็ว และรองรับปริมาณข้อมูลขนาดใหญ่

---

## 📌 สถาปัตยกรรมระบบ (System Architecture)

- **Frontend:** HTML5, CSS3 (ธีม Prompt, CSS Variables, Responsive Grid), JavaScript ES6+ (Native Fetch API), Chart.js
- **Backend:** Node.js + Express.js REST API
- **Database:** PostgreSQL 17 (เชื่อมต่อผ่าน connection pool `pg`)
- **Port:** `http://localhost:5000`

---

## 🗄️ โครงสร้างฐานข้อมูลที่เชื่อมต่อ

| ระบบ | Path | ตารางใน PostgreSQL | ฐานข้อมูล |
|---|---|---|---|
| 🔐 **ระบบเข้าสู่ระบบ (Login)** | `/login` | `users` | `waste_tracking_db` |
| 👑 **แผงควบคุมแอดมิน (Admin Console)** | `/admin` | ทุกตารางสรุปรวม | `waste_tracking_db` |
| 1. ติดตามขนส่งวัสดุภายในไซต์ | `/transport` | `material_transport_logs` | `waste_tracking_db` |
| 2. ติดตามขยะภายในไซต์ (พร้อม Export รูป) | `/waste` | `waste_records` + `projects` | `waste_tracking_db` |
| 3. ระบบแผนการเดินรถ | `/route` | `vehicle_transport_requests` | `waste_tracking_db` |
| 4. เช็กลิสต์ตรวจพื้นที่ประจำวัน | `/checklist` | `site_supervisor_checklists` | `waste_tracking_db` |

---

## 📥 ฟังก์ชันส่งออกข้อมูล (Export Excel & PDF พร้อมรูปภาพ)

- **Export ขยะไซต์งาน Excel (.xlsx):** `GET /api/export/waste/excel` (มีลิงก์และรูปภาพหลักฐาน)
- **Export ขยะไซต์งาน PDF (พร้อมรูป):** `GET /api/export/waste/pdf` (ฝังรูปถ่ายหน้ารถ รูปกองขยะ รูปผ้าใบลงในเอกสาร PDF ทันที)
- **Export ขนส่งวัสดุ Excel (.xlsx):** `GET /api/export/transport/excel` (สรุปสถานะการเบิก-จ่ายและยอดรวม)

---

## 🔑 บัญชีเข้าสู่ระบบเริ่มต้น (Default Accounts)

| บัญชี | Username | Password | สิทธิ์การใช้งาน |
|---|---|---|---|
| **ผู้ดูแลระบบ (Admin)** | `admin` | `admin1234` | เข้าถึงแดชบอร์ดสรุปภาพรวมทั้งหมด (`/admin`) และจัดการผู้ใช้ |
| **เจ้าหน้าที่ไซต์ (Staff)** | `staff` | `staff1234` | ใช้งานระบบบันทึกและดูรายการของแต่ละไซต์งาน |

---

## 🚀 วิธีการรันระบบ

### 1. ติดตั้ง Dependencies (ทำครั้งแรก)
```bash
npm install
```

### 2. ตั้งค่าไฟล์ `.env`
```env
PORT=5000
PGHOST=localhost
PGPORT=5432
PGUSER=postgres
PGPASSWORD=
PGDATABASE=waste_tracking_db
PGDATABASE_REPAIR=machine_repair_tracking
```

### 3. เริ่มต้นการทำงาน (Start Server)
```bash
# โหมดปกติ
npm start

# หรือโหมด Development (Auto-reload เมื่อแก้ไฟล์)
npm run dev
```

เปิดบราวเซอร์ไปที่: **`http://localhost:5000`**

---

## ➕ วิธีการเพิ่ม "ระบบใหม่" ในอนาคต (3 ขั้นตอนง่ายๆ)

1. **เพิ่มตารางใน PostgreSQL:** สร้างตารางสำหรับเก็บข้อมูลของระบบใหม่
2. **สร้าง Router ในโฟลเดอร์ `routes/`:** 
   - เช่น `routes/inventory.js` กำหนด endpoint `GET /api/inventory/logs` และ `POST /api/inventory/add`
   - นำไปผูกใน [server.js](file:///d:/thaitech/server.js) ด้วย `app.use('/api/inventory', require('./routes/inventory'));`
3. **สร้างหน้าเว็บในโฟลเดอร์ `public/`:** 
   - คัดลอกโครงสร้างจากหน้าเดิม เช่น `transport.html` หรือ `repair.html`
   - เพิ่มการ์ดเข้าสู่หน้าหลัก [public/index.html](file:///d:/thaitech/public/index.html) ในส่วน `<div class="grid">`
