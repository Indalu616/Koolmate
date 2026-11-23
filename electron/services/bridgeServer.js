'use strict'
/**
 * Tiny local server the "KoolMate for Blackboard" browser extension talks to.
 *
 * It listens on 127.0.0.1 only (never on the network) and accepts requests only from browser
 * extensions or local tools: a web page cannot use it, because pages send an http(s) Origin,
 * which is refused. The extension only sends *hints* ("this file name came from this course");
 * KoolMate still finds and checks the real file in the watched Downloads folder itself.
 */
const http = require('http')

const PORT = 47613
const MAX_BODY = 16 * 1024

const str = (v, n = 300) => (typeof v === 'string' ? v.slice(0, n) : '')

function createBridgeServer({ onDownload = () => {}, onCourse = () => {}, onPing = () => {}, version = '' } = {}) {
  const server = http.createServer((req, res) => {
    const origin = req.headers.origin || ''
    if (origin && !/^(chrome|moz|ms-browser)-extension:\/\//i.test(origin)) { res.writeHead(403); return res.end() }
    const cors = {
      'Access-Control-Allow-Origin': origin || '*',
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
      'Access-Control-Allow-Private-Network': 'true'
    }
    const json = (code, obj) => { res.writeHead(code, { ...cors, 'Content-Type': 'application/json' }); res.end(JSON.stringify(obj)) }
    if (req.method === 'OPTIONS') { res.writeHead(204, cors); return res.end() }

    const route = (req.url || '').split('?')[0]
    if (req.method === 'GET' && route === '/ping') { onPing({}); return json(200, { app: 'KoolMate', version }) }
    if (req.method !== 'POST') return json(404, { error: 'not found' })

    let size = 0; const chunks = []
    req.on('data', c => { size += c.length; if (size > MAX_BODY) { req.destroy(); return } chunks.push(c) })
    req.on('end', () => {
      let body
      try { body = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}') } catch { return json(400, { error: 'bad json' }) }
      const hint = {
        fileName: str(body.fileName, 260), path: str(body.path, 1000), state: str(body.state, 20),
        url: str(body.url, 2000), referrer: str(body.referrer, 2000),
        courseId: /^_\d+_\d+$/.test(body.courseId || '') ? body.courseId : '',
        courseTitle: str(body.courseTitle || body.title, 200), courseCode: str(body.courseCode || body.code, 100)
      }
      try {
        if (route === '/ping') { onPing(body); return json(200, { app: 'KoolMate', version }) }
        if (route === '/course') return json(200, { ok: true, course: onCourse(hint) || null })
        if (route === '/download') return json(200, { ok: true, course: onDownload(hint) || null })
      } catch (e) { return json(500, { error: e.message }) }
      return json(404, { error: 'not found' })
    })
  })

  return {
    /** Resolves to the port in use, or null if it is taken (e.g. a second copy of the app). */
    listen(port = PORT, host = '127.0.0.1') {
      return new Promise(resolve => {
        server.once('error', () => resolve(null))
        server.listen(port, host, () => resolve(server.address().port))
      })
    },
    close: () => new Promise(r => server.close(() => r()))
  }
}

module.exports = { createBridgeServer, PORT }
