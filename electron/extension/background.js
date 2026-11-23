// KoolMate for Blackboard: background worker.
// Remembers which Blackboard course each tab shows, and when a download starts from Blackboard
// tells the KoolMate app (running on this computer) the file name and the course.
const APP = 'http://127.0.0.1:47613'
const RECENT_MS = 10 * 60 * 1000

const courseIdOf = url => {
  const m = String(url || '').match(/\/courses\/(_\d+_\d+)/) || String(url || '').match(/[?&]course_id=(_\d+_\d+)/)
  return m ? m[1] : null
}
const isBlackboard = url => /^https:\/\/([^/]+\.)?blackboard\.com\/|^https:\/\/blackboard\.adu\.ac\.ae\//i.test(String(url || ''))
const baseName = p => String(p || '').split(/[\\/]/).pop()

async function getState() {
  const s = await chrome.storage.local.get(['courses', 'tabs', 'last', 'appSeen'])
  return { courses: s.courses || {}, tabs: s.tabs || {}, last: s.last || null, appSeen: s.appSeen || 0 }
}

async function post(path, body) {
  try {
    const r = await fetch(APP + path, { method: body ? 'POST' : 'GET', headers: { 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined })
    if (r.ok) await chrome.storage.local.set({ appSeen: Date.now() })
    return r.ok ? await r.json() : null
  } catch { return null } // app not running
}

// ---- course of each Blackboard tab (sent by content.js)
chrome.runtime.onMessage.addListener((msg, sender, reply) => {
  if (msg?.type === 'course' && msg.courseId) {
    (async () => {
      const st = await getState()
      const course = { courseId: msg.courseId, title: msg.title || '', code: msg.code || '', ts: Date.now() }
      st.courses[msg.courseId] = course
      if (sender.tab?.id != null) st.tabs[sender.tab.id] = msg.courseId
      await chrome.storage.local.set({ courses: st.courses, tabs: st.tabs, last: course })
      post('/course', course) // lets the app learn the course even before a download
    })()
  }
  if (msg?.type === 'status') {
    (async () => {
      const st = await getState()
      const ok = await post('/ping', { version: chrome.runtime.getManifest().version })
      reply({ app: !!ok, appVersion: ok?.version || null, last: st.last })
    })()
    return true
  }
})

chrome.tabs.onRemoved.addListener(async id => {
  const st = await getState()
  if (st.tabs[id]) { delete st.tabs[id]; chrome.storage.local.set({ tabs: st.tabs }) }
})

// ---- which course did this download come from?
async function courseFor(item) {
  const st = await getState()
  const id = courseIdOf(item.referrer) || courseIdOf(item.url)
  if (id && st.courses[id]) return st.courses[id]
  if (id) return { courseId: id, title: '', code: '' } // app may already know this course id
  const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true })
  if (tab && st.tabs[tab.id] && st.courses[st.tabs[tab.id]]) return st.courses[st.tabs[tab.id]]
  const tabId = courseIdOf(tab?.url)
  if (tabId) return st.courses[tabId] || { courseId: tabId, title: '', code: '' }
  if (st.last && Date.now() - st.last.ts < RECENT_MS) return st.last
  return null
}

const pending = new Map() // download id -> { course, url, referrer }
const working = new Map() // download id -> promise while its course is being worked out

chrome.downloads.onCreated.addListener(item => {
  const job = (async () => {
    const fromBb = isBlackboard(item.referrer) || isBlackboard(item.url)
    const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true }).catch(() => [])
    if (!fromBb && !isBlackboard(tab?.url)) return
    const course = await courseFor(item)
    if (!course) return
    pending.set(item.id, { course, url: item.url, referrer: item.referrer })
    // a small file can finish (and get its name) while the course was being looked up: check now
    const [now] = await chrome.downloads.search({ id: item.id }).catch(() => [])
    const name = now?.filename || item.filename
    if (name) send(item.id, name, now?.state || item.state)
  })()
  working.set(item.id, job)
  job.finally(() => working.delete(item.id))
})

chrome.downloads.onChanged.addListener(async delta => {
  if (working.has(delta.id)) await working.get(delta.id)
  if (!pending.has(delta.id)) return
  if (delta.filename?.current || delta.state?.current === 'complete') {
    const [item] = await chrome.downloads.search({ id: delta.id })
    if (item?.filename) send(delta.id, item.filename, item.state)
  }
  if (delta.state && delta.state.current !== 'in_progress') setTimeout(() => pending.delete(delta.id), 60000)
})

function send(id, filename, state) {
  const p = pending.get(id)
  if (!p) return
  post('/download', {
    fileName: baseName(filename), path: filename, state, url: p.url, referrer: p.referrer,
    courseId: p.course.courseId, courseTitle: p.course.title, courseCode: p.course.code
  })
}

// keep the app's "extension connected" status fresh
chrome.alarms.create('ping', { periodInMinutes: 5 })
chrome.alarms.onAlarm.addListener(a => { if (a.name === 'ping') post('/ping', { version: chrome.runtime.getManifest().version }) })
chrome.runtime.onStartup.addListener(() => post('/ping', { version: chrome.runtime.getManifest().version }))
chrome.runtime.onInstalled.addListener(() => post('/ping', { version: chrome.runtime.getManifest().version }))
