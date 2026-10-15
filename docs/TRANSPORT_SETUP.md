# ระบบขนส่งวัสดุในไซต์ (ย้ายจาก Google Sheet)

ระบบนี้ **มีข้อมูลจริงใช้งานอยู่** ต่างจากเช็คลิสต์/ขยะ/แผนเดินรถที่เป็นข้อมูลทดลอง

## หน้าเว็บ
| URL | ใช้ทำอะไร |
|---|---|
| `/transport?project=0DJ` | Dashboard รายงาน (หน้าเดิมจาก Netlify ดึงข้อมูลจากฐานข้อมูลแทนชีต) |
| `/transport-entry?project=0DJ` | กรอก/แก้ไขข้อมูลแบบตาราง (แทนการพิมพ์ในชีต) |

หน้ากรอก:
- พิมพ์ Mat. Code แล้ว ประเภท/รายการวัสดุ/หน่วย ขึ้นเองจาก MasterData (ไม่พบ → "ไม่พบข้อมูล")
- สถานะคำนวณจากวันที่เหมือนสคริปต์ในชีต: วันเดียวกัน = เบิกด่วน, คนละวัน = เบิก, ยังไม่มีวันที่รับ = ว่าง (เลือกเองได้เฉพาะ ย้าย/ยกเลิก)
- สถานะ2 คำนวณจากสถานะ หรือเลือกเองได้; คลังว่าง = คลังไซต์
- ชั้นต้องเป็นของอาคารที่เลือก; วันที่รับต้องไม่ก่อนวันที่เบิก
- วางข้อมูลหลายแถวที่ copy จาก Excel/Google Sheet ได้ (Ctrl+V) รองรับวันที่ ว/ด/ป และปี พ.ศ.
- บันทึกแบบ "ทั้งหมดหรือไม่บันทึกเลย" ถ้ามีแถวผิดจะบอกเลขแถว
- ปุ่ม **ตั้งค่าโครงการ** (เฉพาะ role admin): เพิ่ม/แก้โครงการ, เปิด/ปิด, ตั้งอาคารและชั้น

## ติดตั้ง
```
npm install
node scripts/migrate_transport.js
```
สร้าง/เพิ่มคอลัมน์โดยไม่ลบข้อมูลเดิม: `material_transport_logs` (+ project_code, source, updated_at, updated_by),
`transport_projects`, `transport_floors`, `material_master`  — รันซ้ำได้

## นำเข้าข้อมูลจาก Google Sheet
1. ใน Google Sheet: ไฟล์ → ดาวน์โหลด → Microsoft Excel (.xlsx) **ไม่ต้องแก้ไฟล์** (สคริปต์อ่านค่าที่ชีตคำนวณไว้แล้ว ไม่ได้ใช้สูตร)
2. ตรวจก่อน (ไม่บันทึก):
   ```
   node scripts/import_transport_xlsx.js ไฟล์.xlsx --dry-run
   ```
3. นำเข้าจริง:
   ```
   node scripts/import_transport_xlsx.js ไฟล์.xlsx
   ```

อ่านแท็บ `Projects`, `MasterData`, `Build_<รหัส>`, `Log_<รหัส>`
- รันซ้ำได้: แถวที่มาจากชีต (`source='sheet'`) ของแต่ละโครงการจะถูกแทนที่ทั้งชุด แถวที่กรอกบนเว็บ (`source='web'`) ไม่ถูกแตะ
- อาคาร/ชั้นของโครงการที่มีแท็บ `Build_` จะถูกแทนที่ตามไฟล์
- MasterData อัปเดตทับตาม Mat code (อยากเพิ่มวัสดุใหม่ → แก้ในชีตแล้วนำเข้าซ้ำ)

### วันย้ายระบบจริง
1. แจ้งหน้างานหยุดกรอกใน Google Sheet
2. ดาวน์โหลด .xlsx ล่าสุด → `import_transport_xlsx.js` (ทำ --dry-run ก่อน)
3. เปิดให้หน้างานกรอกที่ `/transport-entry` ตั้งแต่นั้น
4. ห้ามนำเข้าไฟล์ชีตเก่าทับหลังจากหน้างานเริ่มแก้แถวเก่าบนเว็บแล้ว (แถว sheet ที่แก้บนเว็บจะถูกแทนที่ด้วยค่าจากไฟล์)

### ข้อควรรู้เรื่องข้อมูลในไฟล์ปัจจุบัน
- มีข้อมูลจริงเฉพาะ `Log_0DJ` (109 แถว) โครงการอื่นยังว่าง
- `Build_` ของทุกโครงการยกเว้น 0DJ เป็นค่าตัวอย่าง (อาคารชื่อ "อาคาร" ชั้น 1..N) → admin ควรแก้ในหน้า **ตั้งค่าโครงการ** ก่อนให้หน้างานใช้

## API
ทุกฟังก์ชันผ่าน `POST /api/gas` (ต้อง login): `TRANSPORT_getProjects`, `TRANSPORT_getReportMeta`, `TRANSPORT_getLogData`,
`TRANSPORT_entryData`, `TRANSPORT_getMaster`, `TRANSPORT_saveRows`, `TRANSPORT_deleteRows`
และเฉพาะ admin: `TRANSPORT_listProjects`, `TRANSPORT_saveProject`, `TRANSPORT_saveBuildings`
API เดิม `/api/transport/logs` ยังใช้ได้
