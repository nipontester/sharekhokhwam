-- ============================================================
-- แชร์ข้อความ (ShareKhoKhwam) — โครงสร้างฐานข้อมูลสำหรับ Supabase
-- วิธีใช้: เปิด Supabase Dashboard → SQL Editor → วางทั้งไฟล์นี้ → กด Run
-- รันซ้ำได้ ไม่พังของเดิม
-- ============================================================

-- 1) ตารางเก็บข้อความ (1 แถว = 1 ห้อง)
create table if not exists public.notes (
  id         text primary key,                 -- ชื่อห้อง เช่น 'main'
  content    text not null default '',         -- ข้อความที่แชร์
  updated_at timestamptz not null default now()
);

-- 2) อัปเดตเวลา updated_at อัตโนมัติทุกครั้งที่มีการแก้ไข
create or replace function public.set_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

drop trigger if exists notes_set_updated_at on public.notes;
create trigger notes_set_updated_at
  before update on public.notes
  for each row execute function public.set_updated_at();

-- 3) เปิด Row Level Security แล้วอนุญาตให้ทุกคนอ่าน/เขียนได้
--    (สาธารณะเหมือนเดโมต้นฉบับ — ถ้าจะทำห้องส่วนตัวค่อยเพิ่ม Auth ทีหลัง)
alter table public.notes enable row level security;

drop policy if exists "public read"   on public.notes;
drop policy if exists "public insert" on public.notes;
drop policy if exists "public update" on public.notes;

create policy "public read"   on public.notes for select using (true);
create policy "public insert" on public.notes for insert with check (true);
create policy "public update" on public.notes for update using (true) with check (true);

-- 4) เปิด Realtime ให้ตารางนี้ (เบราว์เซอร์จะได้รับการเปลี่ยนแปลงสด ๆ)
do $$
begin
  alter publication supabase_realtime add table public.notes;
exception
  when duplicate_object then null;  -- เคยเพิ่มไว้แล้ว ข้ามไป
end;
$$;
