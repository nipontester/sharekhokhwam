// ============================================================
// แชร์ข้อความ (ShareKhoKhwam) — สมุดแชร์เรียลไทม์ด้วย Supabase
// พิมพ์ → หน่วงสั้น ๆ แล้วบันทึกอัตโนมัติ → ทุกเบราว์เซอร์ที่เปิด
// ห้องเดียวกันได้รับข้อความใหม่ผ่าน Supabase Realtime ทันที
// ฟีเจอร์: สุ่มชื่อห้อง, เตือนเมื่อมีคนแก้พร้อมกัน, แถบบอกจำนวนคนในห้อง,
//          คัดลอก/ดาวน์โหลด, จำห้องที่เคยเข้า (5 ห้องล่าสุด)
// ============================================================

import { createClient } from 'https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2/+esm'
import { SUPABASE_URL, SUPABASE_ANON_KEY, TABLE_NAME } from './config.js'

const els = {
  loading:   document.getElementById('loading'),
  setup:     document.getElementById('setup'),
  app:       document.getElementById('app'),
  editor:    document.getElementById('editor'),
  pill:      document.getElementById('live-pill'),
  pillText:  document.getElementById('live-text'),
  saveMsg:   document.getElementById('save-state'),
  updated:   document.getElementById('updated-at'),
  count:     document.getElementById('char-count'),
  roomTab:   document.getElementById('room-tab'),
  roomInput: document.getElementById('room-input'),
  diceBtn:   document.getElementById('dice-btn'),
  copyBtn:   document.getElementById('copy-link'),
  copyText:  document.getElementById('copy-text'),
  dlBtn:     document.getElementById('download-txt'),
  conflict:  document.getElementById('conflict'),
  conflictLoad: document.getElementById('conflict-load'),
  conflictDismiss: document.getElementById('conflict-dismiss'),
  recent:    document.getElementById('recent'),
  presence:  document.getElementById('presence-pill'),
  presenceN: document.getElementById('presence-count'),
}

const DEBOUNCE_MS = 500
const RECENT_MAX = 5
const BASE_TITLE = 'แชร์ข้อความ — เห็นพร้อมกันแบบเรียลไทม์'
const timeFmt = new Intl.DateTimeFormat('th-TH', {
  day: '2-digit', month: '2-digit', year: 'numeric',
  hour: '2-digit', minute: '2-digit',
})

// รหัสประจำเครื่องนี้ (ไว้ให้ presence แยกแต่ละคนออกจากกัน)
const CLIENT_ID = Math.random().toString(36).slice(2) + Date.now().toString(36)

let supabase = null
let room = readRoom()
let channel = null
let saveTimer = null
let retryTimer = null
let reconnectTimer = null
let dirty = false        // มีข้อความในช่องที่ยังไม่ได้บันทึกลง Supabase
let saving = false
let lastKnownRemote = '' // เนื้อหาล่าสุดที่ตรงกับฐานข้อมูล (ไว้ตรวจว่าใคร "แก้จริง")
let pendingRemote = null // เนื้อหาของคนอื่นที่รอเราตัดสินใจตอนเกิดการแก้ชนกัน

// ---------- เครื่องมือเล็ก ๆ ----------

function configMissing() {
  return !SUPABASE_URL || !SUPABASE_ANON_KEY ||
    SUPABASE_URL.includes('YOUR-PROJECT') ||
    SUPABASE_ANON_KEY.includes('YOUR-ANON')
}

function readRoom() {
  const h = decodeURIComponent(location.hash.replace(/^#/, '')).trim()
  return h.slice(0, 64)   // ไม่มี hash = ยังไม่เลือกห้อง ('')
}

function updateRoomUI() {
  els.roomInput.value = room
  fitRoomInput()
  document.title = room ? `#${room} · แชร์ข้อความ` : BASE_TITLE
}

function fitRoomInput() {
  const len = els.roomInput.value.length
  els.roomInput.style.width = Math.max(len + 1, len ? 4 : 13) + 'ch'
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
    state === 'offline' ? 'หลุดการเชื่อมต่อ' :
    state === 'idle' ? 'ยังไม่ได้เลือกห้อง' : 'กำลังเชื่อมต่อ'
}

function setPresence(n) {
  if (!room || !n) { els.presence.hidden = true; return }
  els.presence.hidden = false
  els.presenceN.textContent = n
  els.presence.title = n === 1
    ? 'มีคุณอยู่ในห้องนี้คนเดียว'
    : `มี ${n} คนอยู่ในห้องนี้ตอนนี้`
}

function setEditorEnabled(on) {
  els.editor.disabled = !on
  els.editor.placeholder = on
    ? 'ใส่ข้อความที่อยากแชร์…'
    : 'ตั้งชื่อห้องที่ป้ายด้านบนก่อน แล้วค่อยเริ่มพิมพ์…'
}

// ---------- สุ่มชื่อห้อง (ascii อ่านง่าย เดายาก) ----------

const NOUN = ['otter','maple','comet','river','panda','ember','lotus','falcon',
  'pixel','willow','mango','koala','tiger','cloud','pearl','lemon','robin','coral']
function randomRoomName() {
  const n = NOUN[Math.floor(Math.random() * NOUN.length)]
  const num = Math.floor(1000 + Math.random() * 9000)
  return `${n}-${num}`   // เช่น willow-7681
}

// ---------- จำห้องที่เคยเข้า (localStorage) ----------

function loadRecent() {
  try { return JSON.parse(localStorage.getItem('skx.recent') || '[]') }
  catch (_) { return [] }
}
function rememberRoom(name) {
  if (!name) return
  let list = loadRecent().filter((r) => r.name !== name)
  list.unshift({ name, ts: Date.now() })
  list = list.slice(0, RECENT_MAX)
  try { localStorage.setItem('skx.recent', JSON.stringify(list)) } catch (_) {}
  renderRecent()
}
function renderRecent() {
  const list = loadRecent()
  els.recent.innerHTML = ''
  if (!list.length) { els.recent.hidden = true; return }
  els.recent.hidden = false
  const label = document.createElement('span')
  label.className = 'recent-label'
  label.textContent = 'ห้องที่เคยเข้า:'
  els.recent.appendChild(label)
  list.forEach((r) => {
    const chip = document.createElement('button')
    chip.type = 'button'
    chip.className = 'chip' + (r.name === room ? ' current' : '')
    chip.textContent = r.name
    chip.addEventListener('click', () => {
      if (r.name === room) return
      location.hash = encodeURIComponent(r.name)
    })
    els.recent.appendChild(chip)
  })
}

// ---------- เตือนเมื่อมีคนแก้พร้อมกัน ----------

function showConflict(remoteContent) {
  pendingRemote = remoteContent
  els.conflict.hidden = false
}
function hideConflict() {
  pendingRemote = null
  els.conflict.hidden = true
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
    if (error.code === '42P01' || String(error.message || '').includes('does not exist')) {
      return 'no-table'
    }
    setSaveState('error')
    return 'error'
  }

  const content = data?.content ?? ''
  els.editor.value = content
  lastKnownRemote = content
  dirty = false
  hideConflict()
  updateCount()
  setUpdated(data?.updated_at ? new Date(data.updated_at) : null)
  setSaveState('idle')
  return 'ok'
}

// ---------- รับการเปลี่ยนแปลงแบบเรียลไทม์ ----------

function onRemoteChange(payload) {
  const rec = payload.new
  if (!rec || rec.id !== room || typeof rec.content !== 'string') return

  // เนื้อหาตรงกับที่เรารู้อยู่แล้ว = เสียงสะท้อนจากการบันทึกของเราเอง ข้ามไป
  if (rec.content === lastKnownRemote) return

  lastKnownRemote = rec.content
  if (rec.updated_at) setUpdated(new Date(rec.updated_at))

  if (!dirty) {
    // เราไม่มีของค้าง → รับของคนอื่นมาแสดงได้เลย
    if (rec.content !== els.editor.value) {
      const { selectionStart, selectionEnd } = els.editor
      els.editor.value = rec.content
      const len = rec.content.length
      els.editor.setSelectionRange(Math.min(selectionStart, len), Math.min(selectionEnd, len))
      updateCount()
    }
    hideConflict()
  } else if (rec.content !== els.editor.value) {
    // เรากำลังแก้อยู่ แต่คนอื่นก็แก้ห้องนี้พร้อมกัน → เตือน ไม่ทับของเรา
    showConflict(rec.content)
  }
}

function resubscribe() {
  if (channel) { supabase.removeChannel(channel); channel = null }
  clearTimeout(reconnectTimer)
  setPill('connecting')

  // ชื่อห้อง ascii กรองที่ server ได้; ชื่อไทย/อักขระอื่นรับทั้งตารางแล้วกรองเอง
  const listenOpts = { event: '*', schema: 'public', table: TABLE_NAME }
  if (/^[A-Za-z0-9_-]+$/.test(room)) listenOpts.filter = `id=eq.${room}`

  const ch = supabase.channel(`note-${room}`, {
    config: { presence: { key: CLIENT_ID } },
  })
  ch.on('postgres_changes', listenOpts, onRemoteChange)

  // นับจำนวนคนในห้อง (แสดงอย่างเดียว)
  ch.on('presence', { event: 'sync' }, () => {
    if (channel !== ch) return
    setPresence(Object.keys(ch.presenceState()).length)
  })

  ch.subscribe((status) => {
    if (channel !== ch) return
    if (status === 'SUBSCRIBED') {
      setPill('live')
      ch.track({ id: CLIENT_ID, at: Date.now() })
    } else if (status === 'CHANNEL_ERROR' || status === 'TIMED_OUT' || status === 'CLOSED') {
      setPill('offline')
      setPresence(0)
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
  if (!room || !dirty || saving) return

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
    lastKnownRemote = content   // ของเราคือเวอร์ชันล่าสุดแล้ว
    hideConflict()
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
  if (!room || !dirty || configMissing()) return
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

// ---------- เข้า/ออกห้อง ----------

// สถานะยังไม่เลือกห้อง: ล้างช่อง ปิดการพิมพ์ ตัดการเชื่อมต่อทั้งหมด
function enterNoRoom() {
  if (channel) { supabase.removeChannel(channel); channel = null }
  clearTimeout(reconnectTimer)
  clearTimeout(saveTimer)
  clearTimeout(retryTimer)
  dirty = false
  lastKnownRemote = ''
  hideConflict()
  els.editor.value = ''
  updateCount()
  setUpdated(null)
  setSaveState('idle')
  setEditorEnabled(false)
  setPresence(0)
  setPill('idle')
  renderRecent()
}

async function enterRoom() {
  setEditorEnabled(true)
  const status = await loadRoom()
  if (status === 'no-table') {
    els.app.hidden = true
    els.setup.hidden = false
    return false
  }
  rememberRoom(room)
  resubscribe()
  els.editor.focus()
  return true
}

// ---------- เหตุการณ์: ช่องพิมพ์ ----------

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

// ---------- เหตุการณ์: การแก้ชนกัน ----------

els.conflictLoad.addEventListener('click', () => {
  if (pendingRemote === null) { hideConflict(); return }
  els.editor.value = pendingRemote
  lastKnownRemote = pendingRemote
  dirty = false
  updateCount()
  setSaveState('idle')
  hideConflict()
})
els.conflictDismiss.addEventListener('click', hideConflict)

// ---------- เหตุการณ์: ชื่อห้อง ----------

window.addEventListener('hashchange', async () => {
  const next = readRoom()
  if (next === room) return
  await flushNow()          // เก็บของห้องเดิมให้เรียบร้อยก่อน
  room = next
  updateRoomUI()
  if (!room) { enterNoRoom(); return }
  await enterRoom()
})

els.roomTab.addEventListener('click', (e) => {
  if (e.target.closest('#dice-btn')) return
  els.roomInput.focus()
})
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
  if (name === room) { els.roomInput.value = room; fitRoomInput(); return }
  location.hash = name ? encodeURIComponent(name) : ''
})

els.diceBtn.addEventListener('click', () => {
  location.hash = encodeURIComponent(randomRoomName())
})

// ---------- เหตุการณ์: คัดลอก / ดาวน์โหลด ----------

function flash(btn, text) {
  const old = btn.dataset.label || btn.textContent
  btn.dataset.label = old
  btn.textContent = text
  setTimeout(() => { btn.textContent = btn.dataset.label }, 1500)
}

els.copyBtn.addEventListener('click', async () => {
  if (!room) { flash(els.copyBtn, 'ตั้งชื่อห้องก่อน'); els.roomInput.focus(); return }
  const url = location.origin + location.pathname + '#' + encodeURIComponent(room)
  try { await navigator.clipboard.writeText(url); flash(els.copyBtn, 'คัดลอกแล้ว ✓') }
  catch (_) { prompt('คัดลอกลิงก์นี้:', url) }
})

els.copyText.addEventListener('click', async () => {
  try { await navigator.clipboard.writeText(els.editor.value); flash(els.copyText, 'คัดลอกแล้ว ✓') }
  catch (_) { flash(els.copyText, 'คัดลอกไม่ได้') }
})

els.dlBtn.addEventListener('click', () => {
  const blob = new Blob([els.editor.value], { type: 'text/plain;charset=utf-8' })
  const a = document.createElement('a')
  a.href = URL.createObjectURL(blob)
  a.download = `${room || 'note'}.txt`
  a.click()
  setTimeout(() => URL.revokeObjectURL(a.href), 1000)
})

// ---------- เหตุการณ์: ปิด/สลับแท็บ ----------

window.addEventListener('pagehide', flushOnLeave)
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'hidden') flushOnLeave()
  else if (dirty) scheduleSave()
})

// ---------- เริ่มต้น ----------

async function init() {
  renderRecent()

  if (configMissing()) {
    els.loading.hidden = true
    els.setup.hidden = false
    return
  }

  supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY)
  updateRoomUI()

  els.loading.hidden = true
  els.app.hidden = false
  requestAnimationFrame(() => els.app.classList.add('reveal'))

  if (!room) {              // ยังไม่เลือกห้อง: ให้ตั้งชื่อห้องก่อนถึงจะพิมพ์ได้
    enterNoRoom()
    els.roomInput.focus()
    return
  }

  await enterRoom()
}

init()
