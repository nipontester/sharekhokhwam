// ============================================================
// แชร์ข้อความ (ShareKhoKhwam) — สมุดแชร์เรียลไทม์ด้วย Supabase
// พิมพ์ → หน่วงสั้น ๆ แล้วบันทึกอัตโนมัติ → ทุกเบราว์เซอร์ที่เปิด
// ห้องเดียวกันได้รับข้อความใหม่ผ่าน Supabase Realtime ทันที
// ============================================================

import { createClient } from 'https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2/+esm'
import { SUPABASE_URL, SUPABASE_ANON_KEY, TABLE_NAME } from './config.js'

const els = {
  loading:  document.getElementById('loading'),
  setup:    document.getElementById('setup'),
  app:      document.getElementById('app'),
  editor:   document.getElementById('editor'),
  pill:     document.getElementById('live-pill'),
  pillText: document.getElementById('live-text'),
  saveMsg:  document.getElementById('save-state'),
  updated:  document.getElementById('updated-at'),
  count:    document.getElementById('char-count'),
  roomTab:   document.getElementById('room-tab'),
  roomInput: document.getElementById('room-input'),
  copyBtn:  document.getElementById('copy-link'),
}

const DEBOUNCE_MS = 500
const BASE_TITLE = 'แชร์ข้อความ — เห็นพร้อมกันแบบเรียลไทม์'
const timeFmt = new Intl.DateTimeFormat('th-TH', {
  day: '2-digit', month: '2-digit', year: 'numeric',
  hour: '2-digit', minute: '2-digit',
})

let supabase = null
let room = readRoom()
let channel = null
let saveTimer = null
let retryTimer = null
let reconnectTimer = null
let dirty = false   // มีข้อความในช่องที่ยังไม่ได้บันทึกลง Supabase
let saving = false

// ---------- เครื่องมือเล็ก ๆ ----------

function configMissing() {
  return !SUPABASE_URL || !SUPABASE_ANON_KEY ||
    SUPABASE_URL.includes('YOUR-PROJECT') ||
    SUPABASE_ANON_KEY.includes('YOUR-ANON')
}

function readRoom() {
  const h = decodeURIComponent(location.hash.replace(/^#/, '')).trim()
  return (h || 'main').slice(0, 64)
}

function updateRoomUI() {
  els.roomInput.value = room
  fitRoomInput()
  document.title = room === 'main' ? BASE_TITLE : `#${room} · แชร์ข้อความ`
}

function fitRoomInput() {
  els.roomInput.style.width = Math.max(4, els.roomInput.value.length + 1) + 'ch'
}

function updateCount() {
  const n = els.editor.value.length
  els.count.textContent = `${n.toLocaleString('th-TH')} ตัวอักษร`
}

function setUpdated(date) {
  els.updated.textContent = date ? `อัปเดตล่าสุด ${timeFmt.format(date)}` : ''
}

function setSaveState(state) {
  const el = els.saveMsg
  el.classList.remove('ok', 'err')
  if (state === 'saving') el.textContent = 'กำลังบันทึก…'
  else if (state === 'saved') { el.textContent = 'บันทึกแล้ว ✓'; el.classList.add('ok') }
  else if (state === 'error') { el.textContent = 'บันทึกไม่สำเร็จ — จะลองใหม่อัตโนมัติ'; el.classList.add('err') }
  else el.textContent = ''
}

function setPill(state) {
  els.pill.className = `pill ${state}`
  els.pillText.textContent =
    state === 'live' ? 'เรียลไทม์' :
    state === 'offline' ? 'หลุดการเชื่อมต่อ' : 'กำลังเชื่อมต่อ'
}

// ---------- โหลดข้อความของห้อง ----------

async function loadRoom() {
  const { data, error } = await supabase
    .from(TABLE_NAME)
    .select('content, updated_at')
    .eq('id', room)
    .maybeSingle()

  if (error) {
    console.error('โหลดข้อความไม่สำเร็จ:', error)
    // ตารางยังไม่ถูกสร้าง = ยังไม่ได้รัน supabase/schema.sql
    if (error.code === '42P01' || String(error.message || '').includes('does not exist')) {
      return 'no-table'
    }
    setSaveState('error')
    return 'error'
  }

  els.editor.value = data?.content ?? ''
  dirty = false
  updateCount()
  setUpdated(data?.updated_at ? new Date(data.updated_at) : null)
  setSaveState('idle')
  return 'ok'
}

// ---------- รับการเปลี่ยนแปลงแบบเรียลไทม์ ----------

function onRemoteChange(payload) {
  const rec = payload.new
  if (!rec || rec.id !== room) return

  // ถ้าเรามีของที่ยังไม่ได้บันทึก ให้ยึดของเราไว้ก่อน
  // (เดี๋ยวการบันทึกของเราจะทับไปเอง — ผู้เขียนล่าสุดชนะ เหมือนต้นฉบับ)
  if (dirty) return

  if (typeof rec.content === 'string' && rec.content !== els.editor.value) {
    const { selectionStart, selectionEnd } = els.editor
    els.editor.value = rec.content
    const len = rec.content.length
    els.editor.setSelectionRange(Math.min(selectionStart, len), Math.min(selectionEnd, len))
    updateCount()
  }
  if (rec.updated_at) setUpdated(new Date(rec.updated_at))
}

function resubscribe() {
  if (channel) { supabase.removeChannel(channel); channel = null }
  clearTimeout(reconnectTimer)
  setPill('connecting')

  // ชื่อห้องแบบ a-z 0-9 - _ กรองที่ server ได้เลย
  // ชื่อห้องภาษาไทย/อักขระอื่นอาจทำ filter ฝั่ง server เพี้ยน
  // จึงรับทั้งตารางแล้วกรองใน onRemoteChange (rec.id !== room) แทน
  const listenOpts = { event: '*', schema: 'public', table: TABLE_NAME }
  if (/^[A-Za-z0-9_-]+$/.test(room)) listenOpts.filter = `id=eq.${room}`

  const ch = supabase
    .channel(`note-${room}`)
    .on('postgres_changes', listenOpts, onRemoteChange)
    .subscribe((status) => {
      if (channel !== ch) return  // สถานะของ channel เก่าที่ถูกถอดไปแล้ว
      if (status === 'SUBSCRIBED') {
        setPill('live')
      } else if (status === 'CHANNEL_ERROR' || status === 'TIMED_OUT' || status === 'CLOSED') {
        setPill('offline')
        clearTimeout(reconnectTimer)
        reconnectTimer = setTimeout(resubscribe, 4000)
      }
    })

  channel = ch
}

// ---------- บันทึกอัตโนมัติ ----------

function scheduleSave() {
  clearTimeout(saveTimer)
  saveTimer = setTimeout(save, DEBOUNCE_MS)
}

async function save() {
  clearTimeout(saveTimer)
  if (!dirty || saving) return

  const content = els.editor.value
  const target = room
  saving = true
  setSaveState('saving')

  const { error } = await supabase
    .from(TABLE_NAME)
    .upsert({ id: target, content })

  saving = false

  if (error) {
    console.error('บันทึกไม่สำเร็จ:', error)
    setSaveState('error')
    clearTimeout(retryTimer)
    retryTimer = setTimeout(() => { if (dirty) save() }, 3000)
    return
  }

  if (room === target && els.editor.value === content) {
    dirty = false
    setSaveState('saved')
    setUpdated(new Date())
  } else if (room === target) {
    scheduleSave()  // มีการพิมพ์เพิ่มระหว่างรอบันทึก — บันทึกรอบใหม่
  }
}

async function flushNow() {
  clearTimeout(saveTimer)
  while (saving) await new Promise((r) => setTimeout(r, 60))
  if (dirty) await save()
}

// ก่อนปิดแท็บ/สลับแอป: ยิงบันทึกรอบสุดท้ายแบบ keepalive
function flushOnLeave() {
  if (!dirty || configMissing()) return
  try {
    fetch(`${SUPABASE_URL}/rest/v1/${TABLE_NAME}`, {
      method: 'POST',
      keepalive: true,
      headers: {
        'Content-Type': 'application/json',
        apikey: SUPABASE_ANON_KEY,
        Authorization: `Bearer ${SUPABASE_ANON_KEY}`,
        Prefer: 'resolution=merge-duplicates',
      },
      body: JSON.stringify({ id: room, content: els.editor.value }),
    })
  } catch (_) { /* สุดทางแล้ว ปล่อยไป */ }
}

// ---------- เหตุการณ์ต่าง ๆ ----------

els.editor.addEventListener('input', () => {
  dirty = true
  updateCount()
  setSaveState('saving')
  scheduleSave()
})

// ปุ่ม Tab ในช่องพิมพ์ = ย่อหน้า (สะดวกเวลาแปะโค้ด)
els.editor.addEventListener('keydown', (e) => {
  if (e.key === 'Tab' && !e.shiftKey) {
    e.preventDefault()
    els.editor.setRangeText('\t', els.editor.selectionStart, els.editor.selectionEnd, 'end')
    els.editor.dispatchEvent(new Event('input', { bubbles: true }))
  }
})

// Ctrl/Cmd + S = บันทึกทันที
window.addEventListener('keydown', (e) => {
  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's') {
    e.preventDefault()
    flushNow()
  }
})

// เปลี่ยนห้องผ่าน #hash ใน URL
window.addEventListener('hashchange', async () => {
  const next = readRoom()
  if (next === room) return
  await flushNow()          // เก็บของห้องเดิมให้เรียบร้อยก่อน
  room = next
  updateRoomUI()
  await loadRoom()
  resubscribe()
})

// ช่องชื่อห้องในป้ายแท็บ: พิมพ์แล้วกด Enter เพื่อเปลี่ยนห้อง (Esc = ยกเลิก)
els.roomTab.addEventListener('click', () => els.roomInput.focus())
els.roomInput.addEventListener('input', fitRoomInput)

els.roomInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') {
    e.preventDefault()
    els.roomInput.blur()
  } else if (e.key === 'Escape') {
    els.roomInput.value = room
    fitRoomInput()
    els.roomInput.blur()
  }
})

els.roomInput.addEventListener('blur', () => {
  const name = els.roomInput.value.trim().replace(/\s+/g, '-').slice(0, 64)
  const target = name || 'main'
  if (target === room) {
    els.roomInput.value = room
    fitRoomInput()
    return
  }
  location.hash = target !== 'main' ? encodeURIComponent(target) : ''
})

els.copyBtn.addEventListener('click', async () => {
  const url = location.origin + location.pathname +
    (room !== 'main' ? '#' + encodeURIComponent(room) : '')
  try {
    await navigator.clipboard.writeText(url)
    const old = els.copyBtn.textContent
    els.copyBtn.textContent = 'คัดลอกแล้ว ✓'
    setTimeout(() => { els.copyBtn.textContent = old }, 1500)
  } catch (_) {
    prompt('คัดลอกลิงก์นี้:', url)
  }
})

window.addEventListener('pagehide', flushOnLeave)
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'hidden') flushOnLeave()
  else if (dirty) scheduleSave()  // กลับมาที่แท็บแล้วยังมีของค้าง → บันทึกต่อ
})

// ---------- เริ่มต้น ----------

async function init() {
  if (configMissing()) {
    els.loading.hidden = true
    els.setup.hidden = false
    return
  }

  supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY)
  updateRoomUI()
  const status = await loadRoom()

  els.loading.hidden = true

  if (status === 'no-table') {
    els.setup.hidden = false
    return
  }

  els.app.hidden = false
  requestAnimationFrame(() => els.app.classList.add('reveal'))
  els.editor.focus()

  resubscribe()
}

init()
