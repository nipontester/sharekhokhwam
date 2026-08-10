// ============================================================
// แชร์ข้อความ (ShareKhoKhwam) — สมุดแชร์เรียลไทม์ด้วย Supabase
// พิมพ์ → หน่วงสั้น ๆ แล้วบันทึกอัตโนมัติ → ทุกเบราว์เซอร์ที่เปิด
// ห้องเดียวกันได้รับข้อความใหม่ผ่าน Supabase Realtime ทันที
// ฟีเจอร์: สุ่มชื่อห้อง, เตือนเมื่อมีคนแก้พร้อมกัน, แถบบอกจำนวนคนในห้อง,
//          คัดลอก/ดาวน์โหลด, จำห้องที่เคยเข้า (5 ห้องล่าสุด · ลบ/ล้าง/เรียกคืนได้)
// ============================================================

import { createClient } from 'https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2/+esm'
import { SUPABASE_URL, SUPABASE_ANON_KEY, TABLE_NAME } from './config.js'
import { POKEMON } from './pokemon.js'

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
  recentLive: document.getElementById('recent-live'),
  presence:  document.getElementById('presence-pill'),
  presenceN: document.getElementById('presence-count'),
}

const DEBOUNCE_MS = 500
const RECENT_MAX = 5
const UNDO_MS = 8000     // ช่วงเวลาที่ยังกด "เรียกคืน" ได้ หลังลบ/ล้าง
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
let recentNote = null    // ข้อความชั่วคราวท้ายแถวห้อง + ของที่รอ "เรียกคืน" (แหล่งความจริงเดียว)
let noteTimer = null
let noteDeadline = 0     // เวลาที่ยืดได้มากที่สุด กันข้อความค้างถาวรตอนชี้เมาส์/โฟกัสค้าง
let suppressRemember = null  // ห้องที่เพิ่งกด × ตอนกำลังเข้าห้องนั้นพอดี — ข้ามการจำหนึ่งครั้ง

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

function randomRoomName() {
  const name = POKEMON[Math.floor(Math.random() * POKEMON.length)]
  const num = Math.floor(1000 + Math.random() * 9000)
  return `${name}-${num}`   // เช่น pikachu-7681
}

// ---------- จำห้องที่เคยเข้า (localStorage) ----------

// หลักคิดของส่วนนี้:
//   บัฟเฟอร์ "เรียกคืน" ไม่ได้เก็บภาพลิสต์ทั้งก้อน แต่เก็บ "สิ่งที่เพิ่งลบไป" เท่านั้น
//   ตอนกดเรียกคืนจึงอ่านลิสต์สดใหม่ แล้วแทรกกลับที่ตำแหน่งเดิม
//   ผลคือไม่มีสแนปช็อตเก่าให้ต้องคอยยกเลิก — ห้องที่เพิ่งเข้าไม่หาย

function loadRecent() {
  let raw
  try { raw = JSON.parse(localStorage.getItem('skx.recent') || '[]') }
  catch (_) { return [] }              // JSON เสีย หรือเบราว์เซอร์ไม่ให้อ่าน
  if (!Array.isArray(raw)) return []   // ของเก่า/ของแปลกปลอม
  const seen = new Set()
  const out = []
  for (const r of raw) {
    if (!r || typeof r.name !== 'string') continue
    const name = r.name.trim().slice(0, 64)
    if (!name || seen.has(name)) continue
    seen.add(name)
    out.push({ name, ts: Number(r.ts) || 0 })
    if (out.length >= RECENT_MAX) break
  }
  return out
}

// ทางเดียวที่เขียน skx.recent — คุมความยาวและรายงานความล้มเหลวที่นี่ที่เดียว
function saveRecent(list) {
  try {
    localStorage.setItem('skx.recent', JSON.stringify(list.slice(0, RECENT_MAX)))
    return true
  } catch (_) { return false }         // โหมดส่วนตัว / พื้นที่เต็ม
}

function rememberRoom(name) {
  if (!name) return
  // เพิ่งกด × ชิปห้องนี้ตอนที่กำลังเข้าห้องนี้พอดี → เคารพเจตนา ข้ามการจำหนึ่งรอบ
  if (suppressRemember === name) {
    suppressRemember = null
    renderRecent()
    return
  }
  const list = loadRecent().filter((r) => r.name !== name)
  list.unshift({ name, ts: Date.now() })
  if (saveRecent(list)) pruneNote(name)   // ห้องนี้กลับเข้ารายการเองแล้ว ไม่ต้องค้างปุ่มเรียกคืน
  renderRecent()                          // ล้มเหลวก็เงียบ — ผู้ใช้ไม่ได้สั่งเอง
}

// ---------- ลบ / ล้าง / เรียกคืน ----------

// ลบทันที ไม่ถามยืนยัน แล้วเปิดช่อง "เรียกคืน" ไว้ชั่วครู่
function forgetRoom(name, hold) {
  const list = loadRecent()
  const index = list.findIndex((r) => r.name === name)
  if (index < 0) { renderRecent(); return }   // แท็บอื่นลบไปก่อนแล้ว
  const [item] = list.splice(index, 1)

  if (!saveRecent(list)) {
    setNote({ kind: 'error', items: [], text: 'ลบไม่สำเร็จ — เบราว์เซอร์นี้บันทึกรายการไม่ได้', hold })
    renderRecent()
    announce('ลบไม่สำเร็จ เบราว์เซอร์นี้บันทึกรายการไม่ได้')
    return
  }

  // ถ้า hash ชี้มาห้องนี้แล้ว (อาจกำลัง await flushNow อยู่) enterRoom จะ rememberRoom ตามมา
  // ต้องกันไว้หนึ่งรอบ ไม่งั้นชิปจะเด้งกลับ เหมือนปุ่มลบเสีย
  if (name === readRoom()) suppressRemember = name

  const here = name === room && name === readRoom()
  setNote({
    kind: 'undo',
    items: [{ name: item.name, ts: item.ts, index }],
    text: here ? `ลบห้อง ${name} แล้ว — ยังอยู่ในห้องนี้ตามปกติ` : `ลบห้อง ${name} แล้ว`,
    hold,
  })
  renderRecent()
  focusAfterDelete(index)   // ย้ายโฟกัสก่อน แล้วค่อยประกาศ ไม่งั้นข้อความจะโดนกลืน
  announce(here
    ? `ลบห้อง ${name} ออกจากรายการแล้ว ยังอยู่ในห้องนี้ตามปกติ และจะจำใหม่เมื่อเข้าห้องนี้อีกครั้ง กดเรียกคืนที่ท้ายแถวเพื่อนำกลับ`
    : `ลบห้อง ${name} ออกจากรายการแล้ว กดเรียกคืนที่ท้ายแถวเพื่อนำกลับ`)
}

// ล้างทั้งหมด — ลบทันทีเหมือนกัน ใช้บัฟเฟอร์เดียวกัน เก็บทุกชิ้นพร้อมตำแหน่งเดิม
function clearRecent(hold) {
  const list = loadRecent()
  if (!list.length) return

  if (!saveRecent([])) {
    setNote({ kind: 'error', items: [], text: 'ล้างไม่สำเร็จ — เบราว์เซอร์นี้บันทึกรายการไม่ได้', hold })
    renderRecent()
    announce('ล้างไม่สำเร็จ เบราว์เซอร์นี้บันทึกรายการไม่ได้')
    return
  }

  const here = readRoom()
  if (here && list.some((r) => r.name === here)) suppressRemember = here

  setNote({
    kind: 'undo',
    items: list.map((r, index) => ({ name: r.name, ts: r.ts, index })),
    text: 'ล้างประวัติแล้ว',
    hold,
  })
  renderRecent()
  els.recent.querySelector('[data-act="undo"]')?.focus()
  announce(`ล้างรายการห้องที่เคยเข้าทั้ง ${list.length} ห้องแล้ว กดเรียกคืนเพื่อนำกลับ`)
}

// เรียกคืน: อ่านลิสต์สด แล้วแทรกของที่เพิ่งลบกลับที่ตำแหน่งเดิม
// ไม่ทับทั้งก้อน — ห้องที่เข้าใหม่ระหว่างรอจะได้ไม่หาย และของใหม่ไม่ถูกดันตกขอบ
function restoreRecent() {
  const note = recentNote
  if (!note || note.kind !== 'undo' || !note.items.length) return

  const list = loadRecent()
  const done = []
  for (const it of note.items) {
    if (list.some((r) => r.name === it.name)) continue   // กลับมาเองแล้ว
    if (list.length >= RECENT_MAX) break                 // เต็ม — ไม่ดันของใหม่ตกขอบ
    list.splice(Math.min(it.index, list.length), 0, { name: it.name, ts: it.ts })
    done.push(it.name)
  }

  // ไม่ได้คืนสักห้อง — แยกให้ออกว่าเพราะ "กลับมาเองหมดแล้ว" หรือ "รายการเต็มด้วยห้องอื่น"
  // (done ว่าง = ยังไม่ได้แตะ list เลย เช็กตรงนี้จึงยังตรงกับความจริง)
  if (!done.length) {
    if (note.items.every((it) => list.some((r) => r.name === it.name))) {
      clearNote()
      renderRecent()
      announce('ห้องที่ลบไปกลับมาอยู่ในรายการแล้ว')
      return
    }
    setNote({ kind: 'error', items: [], text: 'เรียกคืนไม่ได้ — รายการห้องเต็มแล้ว' })
    renderRecent()
    announce('เรียกคืนไม่ได้ รายการห้องเต็มแล้ว')
    return
  }

  if (!saveRecent(list)) {               // เก็บบัฟเฟอร์ไว้ ให้กดซ้ำได้
    setNote({ ...note, err: 'เรียกคืนไม่สำเร็จ — ลองอีกครั้ง' })
    renderRecent()
    els.recent.querySelector('[data-act="undo"]')?.focus()
    announce('เรียกคืนไม่สำเร็จ ลองกดเรียกคืนอีกครั้ง')
    return
  }

  const short = done.length < note.items.length
  if (done.includes(suppressRemember)) suppressRemember = null
  clearNote()
  renderRecent()
  focusChip(done[0])
  announce(short
    ? `เรียกคืนได้ ${done.length} จาก ${note.items.length} ห้อง`
    : done.length === 1
      ? `เรียกคืนห้อง ${done[0]} แล้ว`
      : `เรียกคืนรายการห้องที่เคยเข้า ${done.length} ห้องแล้ว`)
}

// ---------- ข้อความชั่วคราวท้ายแถว + ตัวจับเวลา ----------

// recentNote คือแหล่งความจริงเดียว — renderRecent() เป็นคนวาด/ลบ DOM ให้เอง
// จึงไม่มีโหนดค้าง และตัวจับเวลาที่ยิงช้าไม่มีทางซ่อนแถวที่มีชิปอยู่
function setNote(note) {
  recentNote = note
  noteDeadline = Date.now() + UNDO_MS * 4   // เพดานสูงสุดที่ยอมให้ยืด
  armNoteTimer()
}

function clearNote() {
  clearTimeout(noteTimer)
  noteTimer = null
  noteDeadline = 0
  recentNote = null
}

// ถอดห้องชื่อนี้ออกจากบัฟเฟอร์ เพราะมันกลับเข้ารายการเองแล้ว
function pruneNote(name) {
  if (!recentNote || recentNote.kind !== 'undo') return
  recentNote.items = recentNote.items.filter((it) => it.name !== name)
  if (!recentNote.items.length) clearNote()
}

// WCAG 2.2.1: ยืดเวลาให้ถ้ายังสั่งงานด้วยคีย์บอร์ดอยู่ในแถวนี้ หรือชี้เมาส์ค้างที่ข้อความ
// แต่ยืดได้ไม่เกิน noteDeadline เพื่อไม่ให้กลายเป็นแถบค้างถาวร
function armNoteTimer() {
  clearTimeout(noteTimer)
  noteTimer = setTimeout(() => {
    noteTimer = null
    if (noteHeld() && Date.now() < noteDeadline) { armNoteTimer(); return }
    clearNote()
    renderRecent()
  }, UNDO_MS)
}

function noteHeld() {
  if (!recentNote) return false
  const el = els.recent.querySelector('.recent-note')
  if (!el) return false
  if (recentNote.hold && els.recent.contains(document.activeElement)) return true
  return window.matchMedia('(hover: hover)').matches && el.matches(':hover')
}

function announce(msg) {
  if (!els.recentLive) return
  // สลับ zero-width space ท้ายข้อความ กันกรณีข้อความซ้ำเดิมแล้วโปรแกรมอ่านหน้าจอไม่อ่านซ้ำ
  els.recentLive.textContent = els.recentLive.textContent === msg ? msg + '\u200B' : msg
}

// ---------- โฟกัสหลังลบ / หลังเรียกคืน ----------

// ห้ามย้ายโฟกัสไปที่ปุ่ม × เด็ดขาด — กด Enter ค้างแล้วจะลบรัวไปทีละห้อง
function focusAfterDelete(index) {
  const gos = els.recent.querySelectorAll('.chip-go')
  const target = gos.length
    ? gos[Math.min(index, gos.length - 1)]
    : els.recent.querySelector('[data-act="undo"]')
  target?.focus()
}

function focusChip(name) {
  for (const b of els.recent.querySelectorAll('.chip-go')) {
    if (b.dataset.name === name) { b.focus(); return }
  }
  els.recent.querySelector('.chip-go')?.focus()
}

// ---------- วาดแถวห้องที่เคยเข้า (สร้าง DOM ล้วน ไม่ผูก listener รายปุ่ม) ----------

function renderRecent() {
  const list = loadRecent()

  // จำไว้ก่อนล้าง: ถ้าโฟกัสอยู่ในแถวนี้ จะได้พากลับไปที่ปุ่มเดิม (โหนดคนละตัวแล้ว)
  const act = document.activeElement
  const keep = els.recent.contains(act) && act.dataset && act.dataset.act
    ? { act: act.dataset.act, name: act.dataset.name || '' }
    : null

  els.recent.innerHTML = ''
  // แถวนี้โผล่เมื่อ "มีชิป" หรือ "มีข้อความชั่วคราวค้างอยู่" — คิดที่นี่ที่เดียว
  els.recent.hidden = !list.length && !recentNote
  if (els.recent.hidden) return

  if (list.length) {
    const label = document.createElement('span')
    label.className = 'recent-label'
    label.textContent = 'ห้องที่เคยเข้า:'
    els.recent.appendChild(label)
  }

  list.forEach((r) => {
    const isCurrent = r.name === room
    const chip = document.createElement('span')      // กรอบเฉย ๆ ไม่ใช่ปุ่ม
    chip.className = 'chip' + (isCurrent ? ' current' : '')

    const go = document.createElement('button')
    go.type = 'button'
    go.className = 'chip-go'
    go.dataset.act = 'go'
    go.dataset.name = r.name
    go.textContent = r.name                          // textContent เสมอ ชื่อห้องมาจาก URL
    go.setAttribute('aria-label', isCurrent
      ? `ห้อง ${r.name} — ห้องที่อยู่ตอนนี้`
      : `เปิดห้อง ${r.name}`)
    if (isCurrent) go.setAttribute('aria-current', 'true')

    const x = document.createElement('button')       // พี่น้องกับ go ไม่ได้ซ้อนอยู่ข้างใน
    x.type = 'button'
    x.className = 'chip-x'
    x.dataset.act = 'del'
    x.dataset.name = r.name
    x.title = `ลบห้อง ${r.name} ออกจากรายการ`
    x.setAttribute('aria-label', `ลบห้อง ${r.name} ออกจากรายการห้องที่เคยเข้า`)
    const glyph = document.createElement('span')
    glyph.setAttribute('aria-hidden', 'true')
    glyph.textContent = '×'
    x.appendChild(glyph)

    chip.append(go, x)
    els.recent.appendChild(chip)
  })

  if (list.length) {
    const clear = document.createElement('button')
    clear.type = 'button'
    clear.className = 'link-btn muted-btn recent-clear'
    clear.dataset.act = 'clear'
    clear.textContent = 'ล้างประวัติ'
    clear.title = 'ล้างรายการห้องที่เคยเข้าทั้งหมด'
    clear.setAttribute('aria-label', 'ล้างรายการห้องที่เคยเข้าทั้งหมด')
    els.recent.appendChild(clear)
  }

  // ข้อความชั่วคราววางท้ายแถวเสมอ ชิปที่อยู่ก่อนหน้าจึงไม่ถูกดันให้ขยับ
  if (recentNote) {
    const note = document.createElement('span')
    note.className = 'recent-note'

    const text = document.createElement('span')
    text.className = 'recent-note-text' + (recentNote.err || recentNote.kind === 'error' ? ' warn' : '')
    text.id = 'recent-note-text'
    text.textContent = recentNote.err || recentNote.text
    note.appendChild(text)

    if (recentNote.kind === 'undo') {
      const undo = document.createElement('button')
      undo.type = 'button'
      undo.className = 'link-btn'
      undo.dataset.act = 'undo'
      undo.textContent = 'เรียกคืน'
      undo.setAttribute('aria-label', recentNote.items.length === 1
        ? `เรียกคืนห้อง ${recentNote.items[0].name} กลับเข้ารายการ`
        : `เรียกคืนรายการห้องที่เคยเข้า ${recentNote.items.length} ห้อง`)
      undo.setAttribute('aria-describedby', 'recent-note-text')
      note.appendChild(undo)
    }
    els.recent.appendChild(note)
  }

  // โฟกัสเดิมอยู่ในแถวนี้ → พากลับไปที่ปุ่มเดิม (เช่นตอนบันทึกไม่สำเร็จ ชิปยังอยู่ที่เดิม)
  if (keep) {
    for (const b of els.recent.querySelectorAll('[data-act]')) {
      if (b.dataset.act === keep.act && (b.dataset.name || '') === keep.name) { b.focus(); return }
    }
  }
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
  // กำลังไปห้องอื่น → เลิกกันการจำห้องที่เพิ่งกด × ไว้ (เข้าห้องนั้นใหม่ต้องจำตามปกติ)
  if (suppressRemember !== next) suppressRemember = null
  await flushNow()          // เก็บของห้องเดิมให้เรียบร้อยก่อน
  room = next
  updateRoomUI()
  renderRecent()            // room เปลี่ยนแล้ว ไฮไลต์ชิป "ห้องปัจจุบัน" ให้ตรงทันที
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

// ---------- เหตุการณ์: ห้องที่เคยเข้า ----------

// ตัวฟังเดียวคุมทั้งแถว — ชิปถูกสร้างใหม่ทุกรอบ ผูกทีละปุ่มจะรั่ว
els.recent.addEventListener('click', (e) => {
  const btn = e.target.closest('button[data-act]')
  if (!btn || !els.recent.contains(btn)) return
  const name = btn.dataset.name || ''
  const hold = e.detail === 0        // detail 0 = สั่งด้วยคีย์บอร์ด → ไม่ต้องรีบนับถอยหลัง
  if (btn.dataset.act === 'go') {
    if (name && name !== room) location.hash = encodeURIComponent(name)
  } else if (btn.dataset.act === 'del') {
    forgetRoom(name, hold)
  } else if (btn.dataset.act === 'clear') {
    clearRecent(hold)
  } else if (btn.dataset.act === 'undo') {
    restoreRecent()
  }
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
