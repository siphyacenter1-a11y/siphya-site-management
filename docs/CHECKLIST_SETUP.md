# ติดตั้งเช็คลิสต์ตรวจพื้นที่ฉบับเต็ม (บน server บริษัท)

หน้า `/checklist` ฉบับนี้คือหน้าเดียวกับที่หน้างานใช้อยู่บน Google Apps Script (17 ข้อ, รูป, 3 ภาษา, แดชบอร์ด, ลงนาม GM/GF ด้วยรหัส, แก้ไข, PDF)
ย้ายมาใช้ PostgreSQL แทน Google Sheet

## ขั้นตอนติดตั้ง (ทำครั้งเดียว)

```bash
git pull
npm install                      # ติดตั้ง puppeteer เพิ่ม (โหลด Chrome สำหรับทำ PDF ~170 MB ครั้งแรก)
node scripts/migrate_checklist.js   # สร้าง/อัปเดตตาราง รันซ้ำได้ ไม่ลบข้อมูลเดิม
```

ตั้งรหัสลงนาม (เก็บเป็น bcrypt hash ไม่เก็บรหัสจริง):

```bash
node scripts/set_checklist_pin.js add GM 0DJ <รหัส> "ธุรการ 0DJ"   # GM/ธุรการ ของแต่ละโครงการ (เพิ่มได้หลายรหัส)
node scripts/set_checklist_pin.js add GM - <รหัส> "GM สำรอง"        # ใช้กับโครงการที่ยังไม่ได้ตั้งรหัส
node scripts/set_checklist_pin.js add GF - <รหัส> "GF/GE"           # ช่อง 3 ทุกโครงการ
node scripts/set_checklist_pin.js add MASTER - <รหัส> "Admin"       # ลงนาม/แก้ไขได้ทุกช่อง
node scripts/set_checklist_pin.js list
node scripts/set_checklist_pin.js remove <id>
```

รหัสโครงการอ่านจากวงเล็บท้ายชื่อหน่วยงาน เช่น `ORG Origin Thonglor World (0DJ)` → `0DJ`

แล้ว restart server (`npm start`)

## ใช้งาน

- เปิด `http://<server>:5000/checklist` ต้อง login ก่อน (บัญชี staff ใช้ได้) ถ้ายังไม่ login ระบบพาไปหน้า login แล้วกลับมาหน้าเดิม
- หน้าเว็บเรียก `POST /api/gas` ด้วย `{ fn, args }` แบบเดียวกับ Apps Script (`public/js/gas-shim.js`)

## ไฟล์ที่เพิ่ม/แก้

| ไฟล์ | ทำอะไร |
|---|---|
| `public/checklist.html` | หน้าเช็คลิสต์ฉบับเต็ม (แทนตัวย่อเดิม) |
| `public/js/gas-shim.js`, `public/css/checklist-hub.css` | ตัวเรียก API และสไตล์ของหน้านี้ |
| `routes/gas.js` | `POST /api/gas` (ต้อง login, เรียกได้เฉพาะฟังก์ชันในรายการ) |
| `services/checklist.js` | ตรรกะ 6 ฟังก์ชัน แปลงจาก Code.gs |
| `scripts/sql/checklist_v2.sql`, `scripts/migrate_checklist.js` | โครงตาราง |
| `scripts/set_checklist_pin.js` | ตั้งรหัสลงนาม |
| `server.js` | เพิ่ม `/api/gas` และขยาย `express.json` เป็น 30mb (ฟอร์มมีรูป base64) |
| `public/login.html` | รองรับ `?next=` กลับหน้าเดิมหลัง login |

## ตารางใน PostgreSQL

- `site_supervisor_checklists` (เดิม) + คอลัมน์ใหม่ `signer2_at`, `signer3_at`, `edited_at`, `pdf_path`, `pdf_hash`
- `checklist_items` คำตอบรายข้อ 17 แถวต่อฟอร์ม
- `checklist_photos` ลิงก์รูป (ไฟล์อยู่ที่ `public/uploads/checklist/<ปี-เดือน>/`)
- `checklist_pins` รหัสลงนาม (bcrypt)
- `checklist_pin_failures` นับรหัสผิด (ผิด 5 ครั้ง ล็อก 15 นาที)

`checklist_data` (JSONB) ยังถูกเขียนเป็นสำเนา ให้ `/api/checklist/logs` เดิมอ่านได้ต่อ

## ต้องดูแลเพิ่ม

- **สำรองโฟลเดอร์ `public/uploads/`** พร้อมกับ database (รูปและ PDF อยู่ที่นี่ ไม่ได้อยู่ใน git)
- **ฟอนต์ PDF:** ภาษาไทยใช้ `fonts/tahoma.ttf` ที่มีใน repo แล้ว ถ้าฟอร์มกรอกเป็นภาษาเมียนมา/กัมพูชา
  server ต้องมีฟอนต์ภาษานั้น (Windows มี Myanmar Text / Khmer UI อยู่แล้ว, Linux ติดตั้ง `fonts-noto-core`)
- PDF ใช้ Puppeteer ถ้า server ใช้ Chrome ที่ติดตั้งเองแทน ตั้ง `PUPPETEER_EXECUTABLE_PATH` ใน `.env`

## ทดสอบแล้ว (บน PostgreSQL 16 + Node 22)

ผ่านตามรายการตรวจรับในใบสั่งงานทุกข้อ 37/37: บันทึก + รูป, กรอกไม่ครบถูกปฏิเสธ, ช่อง 2-3 ตอนบันทึกต้องว่าง,
รหัส GM ผิดโครงการถูกปฏิเสธ, ลงนามซ้ำไม่ได้, ผิด 5 ครั้งล็อก 15 นาที, แก้ไขแล้วล้างลายเซ็น 2-3,
เปลี่ยนหน่วยงานไม่ได้, รูปเดิมคงอยู่/รูปใหม่เพิ่ม/รูปที่ลบหายทั้งในระบบและไฟล์, ข้อมูลเปลี่ยนระหว่างนั้นต้องรีเฟรช,
ไม่ login เรียก API ไม่ได้, และปุ่ม ดู/พิมพ์ ได้ PDF A4 ภาษาไทยพร้อมรูปจริง
