# แชร์ข้อความ (ShareKhoKhwam) × Supabase

Shared notepad เรียลไทม์ — พิมพ์ที่นี่ ทุกคนที่เปิดลิงก์เดียวกันเห็นพร้อมกันทันที
ต่อยอดจากต้นฉบับ [แบ่งกันดู / BangGunDo-Demo](https://github.com/phongsakornm/BangGunDo-Demo) โดยเปลี่ยนจาก Firebase → **Supabase** และเปลี่ยนจาก Next.js → **เว็บ static ล้วน** เพื่อให้ deploy บน **Netlify** ได้ง่ายที่สุด (ไม่ต้อง build ไม่ต้องมี server)

## โครงสร้างไฟล์

```
sharekhokhwam/
├── index.html            # หน้าเว็บ
├── css/style.css         # สไตล์
├── js/app.js             # โลจิก: บันทึกอัตโนมัติ + Supabase Realtime
├── js/config.js          # ★ ใส่ค่า Supabase ของคุณที่ไฟล์นี้
├── supabase/schema.sql   # ★ SQL สำหรับรันใน Supabase ครั้งแรก
├── netlify.toml          # ตั้งค่า Netlify (publish = ".")
└── README.md
```

## 1) ตั้งค่า Supabase (ครั้งเดียว ~3 นาที)

1. สร้างโปรเจกต์ใหม่ที่ [supabase.com](https://supabase.com) (ฟรี)
2. เมนูซ้าย **SQL Editor** → New query → วางเนื้อหาทั้งไฟล์ `supabase/schema.sql` → กด **Run**
   (สร้างตาราง `notes`, เปิด Row Level Security แบบสาธารณะ และเปิด Realtime ให้ตาราง)
3. เมนู **Project Settings → API** คัดลอก 2 ค่า:
   - **Project URL** เช่น `https://abcdefgh.supabase.co`
   - **anon public key** (หรือ publishable key)
4. เปิดไฟล์ `js/config.js` วางค่าทั้งสองลงไปแทนที่ placeholder

> คีย์ anon ออกแบบมาให้อยู่ฝั่งเบราว์เซอร์ได้ ความปลอดภัยควบคุมด้วย Row Level Security
> โปรเจกต์นี้ตั้ง policy แบบ "ทุกคนอ่าน/เขียนได้" เหมือนเดโมต้นฉบับที่เป็นกระดานสาธารณะ

## 2) ทดลองรันบนเครื่อง

เพราะใช้ ES modules ต้องเปิดผ่าน http (เปิดไฟล์ตรง ๆ แบบ `file://` ไม่ได้):

```bash
npx serve .
# หรือ
python3 -m http.server 8000
```

เปิด `http://localhost:3000` (หรือ 8000) **สองแท็บ** พิมพ์ในแท็บหนึ่ง อีกแท็บจะขยับตามทันที 🎉

## 3) Deploy ขึ้น Netlify

**วิธี A — ลากวาง (เร็วสุด):** ไปที่ [app.netlify.com/drop](https://app.netlify.com/drop) แล้วลากทั้งโฟลเดอร์ (หรือไฟล์ zip) วางลงไป เสร็จเลย

**วิธี B — เชื่อม Git (อัปเดตอัตโนมัติ):** push โฟลเดอร์นี้ขึ้น GitHub → Netlify กด **Add new site → Import an existing project** → เลือก repo → ค่า build ปล่อยว่าง, **Publish directory = `.`** (netlify.toml ตั้งไว้ให้แล้ว) → Deploy

## ฟีเจอร์

- **บันทึกอัตโนมัติ** ระหว่างพิมพ์ (หน่วง 500ms กันยิงฐานข้อมูลถี่เกิน — ต้นฉบับยิงทุกตัวอักษร) + บันทึกรอบสุดท้ายตอนปิดแท็บ + กด `Ctrl/Cmd+S` บันทึกทันทีได้
- **เรียลไทม์** ผ่าน Supabase Realtime (postgres_changes) พร้อมสถานะการเชื่อมต่อและต่อใหม่อัตโนมัติ
- **ระบบห้อง** — เพิ่ม `#ชื่อห้อง` ต่อท้าย URL (เช่น `https://your-site.netlify.app/#ทีมเรา`) แต่ละห้องมีข้อความแยกกัน กดที่ป้าย "ห้อง" เพื่อเปลี่ยนก็ได้ ปุ่ม "คัดลอกลิงก์ห้องนี้" ไว้ส่งให้เพื่อน
- ปุ่ม Tab ในช่องพิมพ์ = ย่อหน้า (แปะโค้ดสะดวก), ตัวนับตัวอักษร, เวลาอัปเดตล่าสุด (พ.ศ.)
- ถ้ายังไม่ได้ใส่ค่าใน `config.js` หน้าเว็บจะแสดงขั้นตอนตั้งค่าให้เอง

## ข้อควรรู้

- กระดานเป็น **สาธารณะ**: ใครมีลิงก์ก็อ่าน/แก้ได้ทุกห้อง (ตามคอนเซปต์ต้นฉบับ) — อย่าใส่ข้อมูลลับ ถ้าต้องการห้องส่วนตัวค่อยเพิ่ม Supabase Auth + ปรับ RLS policy ทีหลัง
- ถ้าสองคนพิมพ์พร้อมกันเป๊ะ ๆ ใช้กติกา "ผู้เขียนล่าสุดชนะ" (เหมือนต้นฉบับ) ไม่ได้ merge ระดับตัวอักษรแบบ Google Docs
