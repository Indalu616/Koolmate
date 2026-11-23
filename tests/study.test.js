'use strict'
const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('fs')
const os = require('os')
const path = require('path')
const http = require('http')

const { createOllama, parseJson } = require('../electron/services/ollama')
const { createStudy, chunkSections } = require('../electron/services/study')
const { readSections } = require('../electron/services/contentReader')

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'km-study-'))

/** A fake Ollama: answers /api/tags and /api/chat with canned JSON chosen by the prompt. */
function fakeOllama({ models = ['qwen3:8b'] } = {}) {
  const calls = []
  const server = http.createServer((req, res) => {
    let body = ''
    req.on('data', d => (body += d))
    req.on('end', () => {
      const send = (obj, code = 200) => { res.writeHead(code, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(obj)) }
      if (req.url === '/api/tags') return send({ models: models.map(name => ({ name })) })
      if (req.url !== '/api/chat') return send({ error: 'nope' }, 404)
      const j = JSON.parse(body)
      calls.push(j)
      const prompt = j.messages.at(-1).content
      let out
      if (/Summarize this section/.test(prompt)) out = { summary: 'About deadlocks and scheduling.', concepts: [{ title: 'Deadlock', definition: 'Processes wait forever.' }, { title: 'Round robin', definition: 'Time slices.' }] }
      else if (/learning objectives/.test(prompt)) out = { title: 'Operating Systems Basics', objectives: ['Explain deadlock', 'Compare scheduling policies'] }
      else if (/most important distinct concepts/.test(prompt)) out = { concepts: [{ title: 'Round robin', importance: 'medium', prerequisites: [] }, { title: 'Deadlock', importance: 'high', prerequisites: ['Round robin', 'Made up'] }] }
      else if (/Concept to teach/.test(prompt)) out = { explanation: 'It is X.', example: 'Two processes...', checkQuestion: 'Why?', checkAnswer: 'Because.' }
      else if (/Student question/.test(prompt)) out = { answer: 'Because of the cycle.', found: true }
      else out = {}
      send({ message: { role: 'assistant', content: '<think>hmm</think>' + JSON.stringify(out) } })
    })
  })
  return new Promise(r => server.listen(0, '127.0.0.1', () => r({ server, calls, url: `http://127.0.0.1:${server.address().port}` })))
}

test('parseJson tolerates fences, think tags and prose', () => {
  assert.deepEqual(parseJson('<think>x</think>```json\n{"a":1}\n```'), { a: 1 })
  assert.deepEqual(parseJson('Sure! {"a":2} hope that helps'), { a: 2 })
  assert.throws(() => parseJson('no json here'), /could not read/)
})

test('status reports not running, missing model and ready', async () => {
  const down = createOllama({ getConfig: () => ({ url: 'http://127.0.0.1:9', model: 'qwen3:8b' }) })
  const s0 = await down.status()
  assert.equal(s0.running, false)
  assert.match(s0.pullCommand, /ollama pull qwen3:8b/)

  const f = await fakeOllama({ models: ['llama3:latest'] })
  const o = createOllama({ getConfig: () => ({ url: f.url, model: 'qwen3:8b' }) })
  const s1 = await o.status()
  assert.equal(s1.running, true); assert.equal(s1.hasModel, false)
  f.server.close()

  const g = await fakeOllama()
  const s2 = await createOllama({ getConfig: () => ({ url: g.url, model: 'qwen3:8b' }) }).status()
  assert.equal(s2.hasModel, true)
  g.server.close()
})

test('chat disables thinking, raises the context window and reports a stopped server clearly', async () => {
  const f = await fakeOllama()
  const o = createOllama({ getConfig: () => ({ url: f.url, model: 'qwen3:8b' }) })
  const r = await o.chat({ system: 's', messages: [{ role: 'user', content: 'Concept to teach' }], schema: { type: 'object' }, numCtx: 8192 })
  assert.equal(r.explanation, 'It is X.')
  assert.equal(f.calls[0].think, false)
  assert.equal(f.calls[0].options.num_ctx, 8192)
  assert.equal(f.calls[0].stream, false)
  f.server.close()
  await assert.rejects(o.chat({ messages: [{ role: 'user', content: 'x' }] }), e => e.code === 'DOWN')
})

test('chunkSections merges small pages and labels ranges', () => {
  const secs = Array.from({ length: 6 }, (_, i) => ({ label: `Page ${i + 1}`, text: 'word '.repeat(300) }))
  const c = chunkSections(secs, 4000)
  assert.ok(c.length >= 2 && c.length < 6)
  assert.match(c[0].label, /^Pages 1–\d$/)
  assert.ok(c[0].text.includes('[Page 1]'))
  const big = chunkSections([{ label: 'Part', text: 'x'.repeat(30000) }], 6500)
  assert.ok(big.length >= 4 && big[0].label.includes('part 1'))
})

test('readSections reads text/markdown into labelled sections and rejects images', async () => {
  const dir = tmp()
  const md = path.join(dir, 'notes.md')
  fs.writeFileSync(md, '# Deadlock\nProcesses wait for each other forever when resources are held in a cycle.\n\n# Scheduling\nRound robin gives each process a time slice in turn.\n')
  const r = await readSections(md)
  assert.equal(r.ok, true)
  assert.deepEqual(r.sections.map(s => s.label), ['Deadlock', 'Scheduling'])
  fs.writeFileSync(path.join(dir, 'a.png'), Buffer.alloc(50))
  assert.equal((await readSections(path.join(dir, 'a.png'))).ok, false)
})

test('study plan: objectives, concepts with trusted sources, cache, lessons, progress and questions', async () => {
  const f = await fakeOllama()
  const dir = tmp()
  const doc = path.join(dir, 'os-lecture.md')
  fs.writeFileSync(doc, '# Deadlock\nA deadlock happens when processes wait for each other forever because resources are held in a cycle.\n\n# Round robin\nRound robin scheduling gives each process a fixed time slice in turn.\n')
  const events = []
  const o = createOllama({ getConfig: () => ({ url: f.url, model: 'qwen3:8b' }) })
  const study = createStudy({ ollama: o, readSections, dir, task: (k, s, p, d) => events.push([k, s, d]) })

  const { plan, cached } = await study.build(doc)
  assert.equal(cached, false)
  assert.equal(plan.title, 'Operating Systems Basics')
  assert.equal(plan.objectives.length, 2)
  assert.deepEqual(plan.concepts.map(c => c.title), ['Round robin', 'Deadlock'])
  const dead = plan.concepts.find(c => c.title === 'Deadlock')
  assert.deepEqual(dead.prerequisites.map(p => p.title), ['Round robin']) // invented prerequisite dropped
  assert.ok(dead.source) // from the code, not the model
  assert.ok(events.some(e => e[0] === 'study' && /Read 1 of|Reading 1 sections|Read \d of/.test(e[2] || '')))
  assert.equal(JSON.stringify(plan).includes('A deadlock happens'), false) // document text never goes to the UI

  const callsBefore = f.calls.length
  const again = await study.build(doc)
  assert.equal(again.cached, true); assert.equal(f.calls.length, callsBefore) // cache hit: no model calls

  const l = await study.lesson(plan.id, dead.id, 'simpler')
  assert.equal(l.checkQuestion, 'Why?')
  const n = f.calls.length
  await study.lesson(plan.id, dead.id, 'simpler')
  assert.equal(f.calls.length, n) // lesson cached

  assert.deepEqual(study.setDone(plan.id, dead.id, true), { done: 1, total: 2 })
  assert.equal((await study.build(doc)).plan.progress.done, 1) // progress persists

  const a = await study.ask(plan.id, 'Why does deadlock happen?')
  assert.equal(a.found, true); assert.ok(a.sources.length >= 1)
  assert.equal(study.recent()[0].title, 'Operating Systems Basics')
  f.server.close()
})

test('Gemini provider: chatJson sends system prompt + schema and retries on rate limit', async () => {
  const gemini = require('../electron/services/gemini')
  const bodies = []
  const real = globalThis.fetch
  let n = 0
  globalThis.fetch = async (_u, init) => {
    bodies.push(JSON.parse(init.body))
    if (n++ === 0) return { ok: false, status: 429, json: async () => ({}) }
    return { ok: true, status: 200, json: async () => ({ candidates: [{ content: { parts: [{ text: '```json\n{"a":1}\n```' }] } }] }) }
  }
  try {
    const r = await gemini.chatJson({ apiKey: 'k', model: 'm', system: 'sys', prompt: 'hi', schema: { type: 'object' } })
    assert.deepEqual(r, { a: 1 })
    assert.equal(bodies.length, 2)
    assert.equal(bodies[0].systemInstruction.parts[0].text, 'sys')
    assert.match(bodies[0].contents[0].parts[0].text, /JSON schema/)
  } finally { globalThis.fetch = real }
})

test('Gemini provider: an empty (thinking-only) answer is retried with a bigger budget', async () => {
  const gemini = require('../electron/services/gemini')
  const real = globalThis.fetch
  const bodies = []
  globalThis.fetch = async (_u, init) => {
    bodies.push(JSON.parse(init.body))
    if (bodies.length === 1) return { ok: true, status: 200, json: async () => ({ candidates: [{ finishReason: 'MAX_TOKENS', content: { parts: [{ thought: true, text: 'hmm' }] } }] }) }
    return { ok: true, status: 200, json: async () => ({ candidates: [{ finishReason: 'STOP', content: { parts: [{ text: '{"ok":true}' }] } }] }) }
  }
  try {
    assert.deepEqual(await gemini.chatJson({ apiKey: 'k', model: 'gemini-3-flash-preview', prompt: 'x' }), { ok: true })
    assert.equal(bodies[0].generationConfig.thinkingConfig.thinkingLevel, 'low')
    assert.ok(bodies[1].generationConfig.maxOutputTokens > bodies[0].generationConfig.maxOutputTokens)
  } finally { globalThis.fetch = real }
})

test('streaming: Ollama NDJSON and Gemini SSE deliver growing text and a parsed result', async () => {
  const server = http.createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'application/x-ndjson' })
    const parts = ['{"explan', 'ation":"Hel', 'lo"}']
    parts.forEach(c => res.write(JSON.stringify({ message: { content: c }, done: false }) + '\n'))
    res.end(JSON.stringify({ message: { content: '' }, done: true }) + '\n')
  })
  await new Promise(r => server.listen(0, '127.0.0.1', r))
  const seen = []
  const o = createOllama({ getConfig: () => ({ url: `http://127.0.0.1:${server.address().port}`, model: 'qwen3:8b' }) })
  const r = await o.chat({ messages: [{ role: 'user', content: 'x' }], schema: { type: 'object' }, onStream: e => seen.push(e) })
  server.close()
  assert.deepEqual(r, { explanation: 'Hello' })
  assert.equal(seen[0].phase, 'thinking')
  assert.equal(seen.at(-1).text, '{"explanation":"Hello"}')

  const gemini = require('../electron/services/gemini')
  const real = globalThis.fetch
  const sse = ['{"explanation":"Hi', ' there"}'].map(t => 'data: ' + JSON.stringify({ candidates: [{ content: { parts: [{ text: t }] } }] }) + '\n\n').join('')
  let url = ''
  globalThis.fetch = async u => { url = u; return { ok: true, status: 200, body: new Response(sse).body } }
  const g = []
  try {
    const out = await gemini.chatJson({ apiKey: 'k', model: 'm', prompt: 'x', onStream: e => g.push(e) })
    assert.deepEqual(out, { explanation: 'Hi there' })
    assert.match(url, /streamGenerateContent\?alt=sse/)
    assert.equal(g.at(-1).text, '{"explanation":"Hi there"}')
  } finally { globalThis.fetch = real }
})
