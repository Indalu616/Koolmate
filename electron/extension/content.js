// Runs on Blackboard pages. Works out which course the page belongs to and tells the
// extension's background worker. Nothing is sent anywhere except to that worker.
(() => {
  const courseIdOf = url => {
    const m = url.match(/\/courses\/(_\d+_\d+)/) || url.match(/[?&]course_id=(_\d+_\d+)/)
    return m ? m[1] : null
  }

  const clean = s => String(s || '').replace(/\s+/g, ' ').trim().slice(0, 200)

  // Blackboard's own web app reads course details from these endpoints with the student's
  // session, so the same request from the page works without any extra sign-in.
  async function fromApi(id) {
    for (const url of [`/learn/api/v1/courses/${id}`, `/learn/api/public/v1/courses/${id}`]) {
      try {
        const r = await fetch(url, { credentials: 'same-origin', headers: { Accept: 'application/json' } })
        if (!r.ok) continue
        const j = await r.json()
        if (j && (j.name || j.courseId)) return { title: clean(j.name), code: clean(j.courseId || j.displayId || '') }
      } catch { /* try the next one */ }
    }
    return null
  }

  function fromPage() {
    // Only places that show the *course* name. A page's main heading (h1) or tab title is often an
    // assignment or folder ("Term Project - Report Submission"), so those are never used.
    const sel = ['[data-analytics-id*="course.title"]', '.course-title', 'bb-base-course-title', '#courseMenu_link', '.courseName']
    for (const s of sel) {
      const el = document.querySelector(s)
      const t = clean(el && (el.getAttribute('title') || el.textContent))
      if (t && t.length > 2 && !/^(content|calendar|announcements|courses)$/i.test(t)) return { title: t, code: '' }
    }
    return null
  }

  let lastId = null
  let info = null
  let sentAt = 0
  const tell = id => {
    sentAt = Date.now()
    try { chrome.runtime.sendMessage({ type: 'course', courseId: id, title: info.title, code: info.code, page: location.href }) } catch { /* extension reloaded */ }
  }
  async function check() {
    const id = courseIdOf(location.href)
    if (!id || id === lastId) return
    lastId = id
    info = (await fromApi(id)) || fromPage()
    if (!info) { lastId = null; return }
    tell(id)
  }

  // Blackboard Ultra changes pages without reloading, so look again whenever the address changes.
  // While the student is on a course page, say so again every few minutes and when they come back
  // to the tab, so the app (maybe restarted since) knows which course is open.
  check()
  setInterval(() => {
    if (courseIdOf(location.href) !== lastId) check()
    else if (lastId && info && document.visibilityState === 'visible' && Date.now() - sentAt > 3 * 60 * 1000) tell(lastId)
  }, 1500)
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible' && lastId && info) tell(lastId) })
})()
