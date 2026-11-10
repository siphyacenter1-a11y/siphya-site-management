# สรุปสำหรับ IT — ย้าย 4 ระบบหน้างานจาก Google Apps Script มา Node.js + PostgreSQL

| ระบบ | หน้าเว็บ | ข้อมูล | คู่มือ |
|---|---|---|---|
| เช็คลิสต์ตรวจหน้างาน | `/checklist` | ทดลอง (เริ่มจากตารางว่าง) | [CHECKLIST_SETUP.md](CHECKLIST_SETUP.md) |
| ติดตามขยะ + ใบสั่งงาน NPO | `/waste`, `/npo` | ทดลอง (เริ่มจากตารางว่าง) | [WASTE_NPO_SETUP.md](WASTE_NPO_SETUP.md) |
| แผนการเดินรถ (ฟอร์มขอจองรถเดิม) | `/route` | เก็บไว้ ไม่มีลิงก์ใน /admin แล้ว | [ROUTE_SETUP.md](ROUTE_SETUP.md) |
| บันทึกการเปลี่ยนแผนเดินรถ | `/route-plan` | ทดลอง (admin เท่านั้น) | [ROUTE_PLAN_SETUP.md](ROUTE_PLAN_SETUP.md) |
| ขนส่งวัสดุในไซต์ | `/transport`, `/transport-entry` | **ข้อมูลจริง** นำเข้าจาก Google Sheet | [TRANSPORT_SETUP.md](TRANSPORT_SETUP.md) |

## หลักการที่ใช้
- ไม่แก้ระบบ login เดิม ทุกหน้าใหม่ใช้ `authenticateToken` ของ IT (JWT cookie)
- หน้าเว็บเดิมจาก Apps Script เรียก `google.script.run` → ใช้ `public/js/gas-shim.js` แปลงเป็น `POST /api/gas` `{fn, args}`
  ฝั่ง server เรียกได้เฉพาะฟังก์ชันใน allowlist (`routes/gas.js`)
- migration ทุกตัวเป็น SQL แบบรันซ้ำได้ (`IF NOT EXISTS` / `ADD COLUMN IF NOT EXISTS`) **ไม่ลบข้อมูลเดิม**
- ตารางเดิมของ IT ที่ถูกใช้/เพิ่มคอลัมน์: `projects`, `waste_records`, `vehicle_transport_requests`, `material_transport_logs`
- API เดิม (`/api/transport/logs`, `/api/route/logs` ฯลฯ) ยังใช้ได้เหมือนเดิม
- เพิ่ม role ผู้ใช้ `checklist` (ผู้ดูแลพื้นที่ — ใช้ได้แค่ระบบเช็คลิสต์) และ `signer` (ลงนามเช็คลิสต์อย่างเดียว): `middleware/role_guard.js` ติดตั้งใน `server.js` ก่อน static —
  บัญชี role อื่นไม่ได้รับผลกระทบ · admin สร้าง/แก้บัญชีและสิทธิ์ลงนามที่หน้า `/users` (ปุ่ม "จัดการผู้ใช้งาน" ใน /admin ชี้ไปหน้านี้แทน modal เดิม — modal เดิมยังอยู่ในโค้ดแต่ไม่ได้ใช้)
- ลิงก์ Export ในหน้า /admin (`/api/export/*`) เดิมเปิดได้โดยไม่ต้อง login — แก้ให้ต้อง login เป็น admin (ไม่ login → ไปหน้า login, staff → แจ้งว่าไม่มีสิทธิ์)

## ติดตั้งบน server (ตามลำดับ)
```
npm install
npx puppeteer browsers install chrome          # ใช้ทำ PDF (เช็คลิสต์, NPO)
node scripts/init_users.js                     # ตาราง users (server ที่มีอยู่แล้วข้ามได้) — ต้องมีก่อน migrate_checklist
node scripts/migrate_checklist.js
node scripts/migrate_waste.js
node scripts/migrate_route.js
node scripts/migrate_transport.js
node scripts/migrate_route_plan.js                # บันทึกการเปลี่ยนแผนเดินรถ
node scripts/migrate_daily_plan.js                # แผนรถเข้า-ออก / เครื่องจักรประจำวัน (FM-GM-01-07 / 01-03)
node scripts/migrate_site_layout.js               # เช็คลิสต์ตาม Site Layout + ใบแจ้งแก้ไข
node scripts/import_transport_xlsx.js <ไฟล์.xlsx> --dry-run       # ตรวจก่อน
node scripts/import_transport_xlsx.js <ไฟล์.xlsx>                 # นำเข้าจริง (ไฟล์ส่งให้แยก ไม่อยู่ใน repo)
npm start
```
หลังติดตั้ง: login admin → `/users` สร้างบัญชีจริง + สิทธิ์ลงนาม + รหัส PIN สำรอง (ไม่ต้องใช้คำสั่ง)
- migration ทุกตัวรันซ้ำได้ · ถ้ารัน `migrate_checklist.js` ก่อนมีตาราง users ให้รันซ้ำอีกครั้งหลัง `init_users.js` (เพื่อสร้าง FK `checklist_pins_user_fk`)
- ทดสอบติดตั้งใหม่จากฐานข้อมูลว่างตามลำดับนี้แล้ว: ทุกหน้าโหลดได้ ไม่มี error, ขนส่ง/ขยะ+NPO/แผนเดินรถ/เช็คลิสต์+PDF ทำงานครบ

### บน Linux
- Chrome ของ puppeteer ต้องมี library ระบบ (เช่น `libnss3 libatk-bridge2.0-0 libgbm1 libasound2 libxkbcommon0`)
  หรือใช้ Chromium ที่ติดตั้งในเครื่องแล้วตั้ง `PUPPETEER_EXECUTABLE_PATH=/usr/bin/chromium`
- ฟอนต์ไทยใน PDF ฝังจาก `fonts/tahoma.ttf` ไม่ต้องติดตั้งฟอนต์ในระบบ

## หน้าใหม่สำหรับ admin
- `/users` จัดการบัญชีผู้ใช้ + ประเภทบัญชี + สิทธิ์ลงนามเช็คลิสต์ + รหัส PIN สำรอง
- `/documents` คลังเอกสาร PDF ทุกระบบ + ประวัติการลงนามเช็คลิสต์ (ดู CHECKLIST_SETUP.md)

## ไฟล์ที่ต้องสำรอง
- ฐานข้อมูล PostgreSQL
- โฟลเดอร์ `storage/` (ไฟล์ PDF ใบเบิกวัสดุของระบบขนส่ง) — อยู่ใน `.gitignore` ไม่ขึ้น git
- โฟลเดอร์ `public/uploads/` (รูปจากเช็คลิสต์/ขยะ, PDF) — อยู่ใน `.gitignore` ไม่ขึ้น git

## ⚠️ ก่อนเปิดใช้จริง
1. ตั้ง repo เป็น **private**
2. เปลี่ยนรหัสผ่านผู้ใช้ตั้งต้น `admin` / `staff` และ **ลบปุ่ม login ตัวอย่าง** ในหน้า `/login` (กดแล้วเข้าเป็น admin ได้ทันที)
   แล้วสร้างบัญชีรายคน (admin ของผู้ใช้งานหลัก + admin สำรองของ IT) — บัญชีอื่นสร้างเองได้ที่ `/users`
3. ตั้ง `JWT_SECRET` ใหม่ (ยาว สุ่ม) ใน `.env`
4. ใช้ `npm start` (หรือ pm2 / systemd) **ห้ามใช้ `npm run dev`** — โหมด watch จะรีสตาร์ตกลางการสร้าง PDF
5. ถ้าต้องการชื่อเว็บ/https ให้ตั้ง reverse proxy (nginx ฯลฯ) ชี้มาที่ `PORT` ใน `.env`
6. body limit ตั้งไว้ 30mb เพราะฟอร์มส่งรูปเป็น base64 — ถ้ามี nginx ให้ตั้ง `client_max_body_size 30m`
7. ไฟล์ใน `public/uploads/` (รูปเช็คลิสต์/ขยะ, PDF เช็คลิสต์, PDF NPO) เปิดได้ด้วยลิงก์ตรงโดยไม่ต้อง login (เป็นแบบนี้ตั้งแต่ระบบเดิม)
   ถ้าต้องการให้ต้อง login ให้ย้ายไปเสิร์ฟผ่าน route ที่ตรวจ token เหมือน `/api/transport-doc` (ใบเบิกวัสดุทำแบบนั้นแล้ว)

## วันย้ายระบบขนส่ง (ข้อมูลจริง)
1. แจ้งหน้างานหยุดกรอกใน Google Sheet
2. ดาวน์โหลด Sheet เป็น .xlsx → นำเข้า (dry-run ก่อน)
3. ให้หน้างานกรอกที่ `/transport-entry` ตั้งแต่นั้น
4. admin ตั้งอาคาร/ชั้นของโครงการอื่นนอกจาก 0DJ ในหน้า "ตั้งค่าโครงการ" (ในไฟล์ปัจจุบันเป็นค่าตัวอย่าง)
   — รายชื่อนี้ใช้ร่วมกับช่องอาคาร/ชั้นของเช็คลิสต์ด้วย (เป็นข้อมูลในฐานข้อมูล ตั้งบนเว็บ ไม่ต้องแก้โค้ด)
