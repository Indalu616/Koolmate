chrome.runtime.sendMessage({ type: 'status' }, res => {
  const app = document.getElementById('app')
  if (res?.app) { app.className = 'row ok'; app.lastChild.textContent = 'Connected to the KoolMate app' }
  else { app.className = 'row bad'; app.lastChild.textContent = 'KoolMate app is not running'; document.getElementById('getapp').style.display = 'block' }
  if (res?.last) {
    const el = document.getElementById('course')
    el.className = 'course'
    el.textContent = [res.last.code, res.last.title].filter(Boolean).join(' · ') || res.last.courseId
  }
})
