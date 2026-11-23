'use strict'
/**
 * Study Buddy: reads a document section by section with a local model (Ollama + Qwen3), then
 * produces learning objectives, a concept checklist and, on demand, a per-concept lesson
 * (explanation, worked example, check question). Plans are cached on disk (keyed by file path,
 * size and modified time) together with the student's progress, so re-opening a file is instant.
 *
 * Source locations (page / slide) always come from the code, never from the model, so they can
 * be trusted; examples are written by the model and are labelled as AI-added in the UI.
 */
const fs = require('fs')
const path = require('path')
const crypto = require('crypto')

const SYSTEM = 'You are a patient, accurate teaching assistant helping a student study their own course material. ' +
  'Rely on the provided text. Answer in the same language as the document. Be concise and concrete.'

const MAX_CHUNKS = 24
const norm = s => String(s || '').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim()
const words = s => norm(s).split(' ').filter(w => w.length > 2)
const clip = (s, n) => String(s || '').trim().slice(0, n)
const arr = v => (Array.isArray(v) ? v : [])

const MAP_SCHEMA = {
  type: 'object',
  properties: {
    summary: { type: 'string' },
    concepts: { type: 'array', items: { type: 'object', properties: { title: { type: 'string' }, definition: { type: 'string' } }, required: ['title', 'definition'] } }
  },
  required: ['summary', 'concepts']
}
const OBJECTIVES_SCHEMA = {
  type: 'object',
  properties: { title: { type: 'string' }, objectives: { type: 'array', items: { type: 'string' } } },
  required: ['title', 'objectives']
}
const CONCEPTS_SCHEMA = {
  type: 'object',
  properties: {
    concepts: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          title: { type: 'string' },
          importance: { type: 'string', enum: ['high', 'medium', 'low'] },
          prerequisites: { type: 'array', items: { type: 'string' } }
        },
        required: ['title', 'importance', 'prerequisites']
      }
    }
  },
  required: ['concepts']
}
const LESSON_SCHEMA = {
  type: 'object',
  properties: {
    explanation: { type: 'string' },
    example: { type: 'string' },
    checkQuestion: { type: 'string' },
    checkAnswer: { type: 'string' }
  },
  required: ['explanation', 'example', 'checkQuestion', 'checkAnswer']
}
const ASK_SCHEMA = {
  type: 'object',
  properties: { answer: { type: 'string' }, found: { type: 'boolean' } },
  required: ['answer', 'found']
}

/** Merges adjacent sections into chunks of up to `maxChars`, keeping a readable label ("Pages 3–5"). */
function chunkSections(sections, maxChars = 6500) {
  const chunks = []
  let cur = null
  const flush = () => { if (cur) { chunks.push({ label: cur.labels.length > 1 ? rangeLabel(cur.labels) : cur.labels[0], text: cur.text }); cur = null } }
  for (const s of sections) {
    const t = s.text.length > maxChars * 1.5 ? null : s.text
    if (t === null) { // oversized single section: split it
      flush()
      for (let i = 0, n = 1; i < s.text.length; i += maxChars, n++) chunks.push({ label: `${s.label} (part ${n})`, text: s.text.slice(i, i + maxChars) })
      continue
    }
    if (cur && cur.text.length + t.length > maxChars) flush()
    if (!cur) cur = { labels: [], text: '' }
    cur.labels.push(s.label)
    cur.text += (cur.text ? '\n\n' : '') + `[${s.label}]\n${t}`
  }
  flush()
  return chunks
}

function rangeLabel(labels) {
  const first = labels[0], last = labels[labels.length - 1]
  const a = first.match(/^(Page|Slide)\s+(\d+)$/), b = last.match(/^(Page|Slide)\s+(\d+)$/)
  if (a && b && a[1] === b[1]) return `${a[1]}s ${a[2]}–${b[2]}`
  return `${first} – ${last}`
}

function createStudy({ ollama, readSections, dir, task = () => {}, stream = () => {} }) {
  const live = (scope, extra = {}) => e => stream({ scope, ...extra, ...e })
  const root = path.join(dir, 'study')
  const planFile = id => path.join(root, `${id}.json`)
  const idFor = (file, st) => crypto.createHash('sha1').update(`${path.resolve(file)}|${st.size}|${Math.round(st.mtimeMs)}`).digest('hex').slice(0, 16)

  const load = id => { try { return JSON.parse(fs.readFileSync(planFile(id), 'utf8')) } catch { return null } }
  const save = plan => {
    fs.mkdirSync(root, { recursive: true })
    const tmp = planFile(plan.id) + '.tmp'
    fs.writeFileSync(tmp, JSON.stringify(plan), 'utf8')
    fs.renameSync(tmp, planFile(plan.id))
  }
  const need = id => { const p = load(id); if (!p) throw new Error('This study plan is no longer available. Open the file again.'); return p }

  const progressOf = plan => {
    const total = plan.concepts.length
    const done = plan.concepts.filter(c => c.done).length
    return { done, total }
  }
  /** Plan as the UI sees it: no document text. */
  const publicPlan = plan => ({
    id: plan.id, file: plan.file, title: plan.title, objectives: plan.objectives, model: plan.model, createdAt: plan.createdAt,
    sections: plan.chunks.length, truncated: !!plan.truncated, progress: progressOf(plan),
    concepts: plan.concepts.map(c => ({ id: c.id, title: c.title, importance: c.importance, prerequisites: c.prerequisites, source: c.source, done: !!c.done, lessons: c.lessons || {} }))
  })

  // ---------------------------------------------------------------- building a plan

  async function build(file, { force = false } = {}) {
    const st = await fs.promises.stat(file)
    if (!st.isFile()) throw new Error('That is not a file.')
    const id = idFor(file, st)
    const name = path.basename(file)
    if (!force) {
      const cached = load(id)
      if (cached) { cached.lastOpened = Date.now(); save(cached); return { plan: publicPlan(cached), cached: true } }
    }

    task('study', 'read', 4, name)
    const read = await readSections(file)
    if (!read.ok) throw new Error(read.reason || 'KoolMate could not read this file.')
    const total = read.sections.reduce((n, s) => n + s.text.length, 0)
    const maxChars = Math.min(14000, Math.max(6500, Math.ceil(total / MAX_CHUNKS)))
    let chunks = chunkSections(read.sections, maxChars)
    const truncated = chunks.length > MAX_CHUNKS
    if (truncated) chunks = chunks.slice(0, MAX_CHUNKS)

    // 1) map: what does each section teach?
    const mapped = new Array(chunks.length)
    let next = 0, finished = 0
    const worker = async () => {
      while (next < chunks.length) {
        const i = next++
        const r = await ollama.chat({
          system: SYSTEM, schema: MAP_SCHEMA, numCtx: 8192 + (maxChars > 9000 ? 4096 : 0), maxTokens: 900,
          messages: [{ role: 'user', content: `Section "${chunks[i].label}" of "${name}":\n\n${chunks[i].text}\n\nSummarize this section in 1-2 sentences and list the key concepts a student must learn from it (at most 6). Each concept has a short title (2-6 words) and a one-sentence definition taken from the text.` }]
        })
        mapped[i] = { summary: clip(r.summary, 400), concepts: arr(r.concepts).filter(c => c && c.title).slice(0, 6).map(c => ({ title: clip(c.title, 80), definition: clip(c.definition, 300) })) }
        finished++
        task('study', 'sections', 8 + (finished / chunks.length) * 52, `Read ${finished} of ${chunks.length} sections`)
      }
    }
    task('study', 'sections', 8, `Reading ${chunks.length} sections`)
    const conc = Math.max(1, Math.min(typeof ollama.concurrency === 'function' ? ollama.concurrency() : 1, chunks.length))
    await Promise.all(Array.from({ length: conc }, worker))

    // 2) reduce: objectives, then the concept checklist
    task('study', 'objectives', 66, 'Writing learning objectives')
    const digest = mapped.map((m, i) => `${chunks[i].label}: ${m.summary}`).join('\n')
    const obj = await ollama.chat({
      system: SYSTEM, schema: OBJECTIVES_SCHEMA, maxTokens: 700, onStream: live('build', { step: 'objectives' }),
      messages: [{ role: 'user', content: `Section summaries of "${name}":\n${digest}\n\nGive the document a clear title (max 8 words) and write 3-6 learning objectives, each starting with a verb a student can demonstrate, such as "Explain...", "Compare...", "Apply...".` }]
    })

    task('study', 'concepts', 80, 'Finding key concepts')
    const candidates = mapped.flatMap((m, i) => m.concepts.map(c => ({ ...c, chunk: i })))
    const listing = candidates.map(c => `- ${c.title}`).join('\n')
    let picked = []
    if (candidates.length) {
      const r = await ollama.chat({
        system: SYSTEM, schema: CONCEPTS_SCHEMA, maxTokens: 1400, onStream: live('build', { step: 'concepts' }),
        messages: [{ role: 'user', content: `Concepts found in "${name}":\n${listing}\n\nChoose the 5-12 most important distinct concepts. Merge duplicates. Order them so foundations come first. For each give importance (high, medium or low) and its prerequisites: titles of other chosen concepts that must be understood first (may be empty).` }]
      })
      picked = arr(r.concepts).filter(c => c && c.title).slice(0, 14)
    }
    if (!picked.length) picked = candidates.slice(0, 8).map(c => ({ title: c.title, importance: 'medium', prerequisites: [] }))
    if (!picked.length) throw new Error('KoolMate could not find study concepts in this file.')

    task('study', 'plan', 94, 'Building your study plan')
    const concepts = picked.map((p, i) => ({ id: `c${i + 1}`, title: clip(p.title, 80), importance: ['high', 'medium', 'low'].includes(p.importance) ? p.importance : 'medium', prerequisites: [], chunks: locate(p.title, candidates, chunks), done: false, lessons: {} }))
    concepts.forEach((c, i) => {
      c.prerequisites = arr(picked[i].prerequisites).map(t => concepts.find(o => o.id !== c.id && norm(o.title) === norm(t))).filter(Boolean).map(o => ({ id: o.id, title: o.title }))
      c.source = sourceLabel(c.chunks, chunks)
    })

    const plan = {
      id, file: { path: file, name, size: st.size, mtime: st.mtimeMs }, model: ollama.config().model, createdAt: Date.now(), lastOpened: Date.now(),
      title: clip(obj.title, 100) || name.replace(/\.[^.]+$/, ''), objectives: arr(obj.objectives).map(o => clip(o, 200)).filter(Boolean).slice(0, 7),
      truncated, chunks, concepts
    }
    save(plan)
    return { plan: publicPlan(plan), cached: false }
  }

  /** Which sections cover a concept? Uses the map step's own findings, then keyword overlap. */
  function locate(title, candidates, chunks) {
    const t = norm(title)
    let idx = candidates.filter(c => { const n = norm(c.title); return n === t || n.includes(t) || t.includes(n) }).map(c => c.chunk)
    if (!idx.length) {
      const w = words(title)
      const scored = chunks.map((c, i) => ({ i, s: w.filter(x => norm(c.text).includes(x)).length })).filter(x => x.s).sort((a, b) => b.s - a.s)
      idx = scored.slice(0, 2).map(x => x.i)
    }
    return [...new Set(idx)].sort((a, b) => a - b).slice(0, 4)
  }
  const sourceLabel = (idx, chunks) => idx.map(i => chunks[i].label).join(', ')

  // ---------------------------------------------------------------- lessons

  const MODES = {
    normal: 'Explain it clearly for a student meeting it for the first time.',
    simpler: 'Explain it again in much simpler words, with an everyday analogy. Avoid jargon.',
    deeper: 'Go deeper: add the reasoning behind it, edge cases and how it connects to related ideas.'
  }

  async function lesson(planId, conceptId, mode = 'normal', { force = false } = {}) {
    const plan = need(planId)
    const c = plan.concepts.find(x => x.id === conceptId)
    if (!c) throw new Error('Unknown concept.')
    if (!MODES[mode]) mode = 'normal'
    if (!force && c.lessons?.[mode]) return c.lessons[mode]
    task('lesson', 'lesson', 40, c.title)
    const context = c.chunks.map(i => plan.chunks[i]?.text).filter(Boolean).join('\n\n').slice(0, 9000)
    const r = await ollama.chat({
      system: SYSTEM, schema: LESSON_SCHEMA, numCtx: 8192, maxTokens: 1500, temperature: 0.4, onStream: live('lesson', { conceptId, mode }),
      messages: [{ role: 'user', content: `Course material from "${plan.file.name}" (${c.source || 'various sections'}):\n\n${context}\n\nConcept to teach: "${c.title}".\n${MODES[mode]}\nReturn: explanation (a short paragraph or two), example (a concrete worked example with numbers or a small scenario), checkQuestion (one question that tests understanding) and checkAnswer (a short model answer).` }]
    })
    const out = { explanation: clip(r.explanation, 2500), example: clip(r.example, 2500), checkQuestion: clip(r.checkQuestion, 500), checkAnswer: clip(r.checkAnswer, 1000), at: Date.now() }
    c.lessons = { ...(c.lessons || {}), [mode]: out }
    save(plan)
    return out
  }

  function setDone(planId, conceptId, done) {
    const plan = need(planId)
    const c = plan.concepts.find(x => x.id === conceptId)
    if (!c) throw new Error('Unknown concept.')
    c.done = !!done
    save(plan)
    return progressOf(plan)
  }

  // ---------------------------------------------------------------- questions about the file

  async function ask(planId, question) {
    const plan = need(planId)
    const q = clip(question, 600)
    if (!q) throw new Error('Type a question first.')
    task('lesson', 'lesson', 40, 'Searching the file')
    const w = words(q)
    const ranked = plan.chunks.map((c, i) => ({ i, s: w.reduce((n, x) => n + (norm(c.text).includes(x) ? 1 : 0), 0) })).sort((a, b) => b.s - a.s)
    const use = ranked.slice(0, 3).filter((x, k) => x.s > 0 || k === 0).sort((a, b) => a.i - b.i)
    const context = use.map(x => `[${plan.chunks[x.i].label}]\n${plan.chunks[x.i].text}`).join('\n\n').slice(0, 10000)
    const r = await ollama.chat({
      system: SYSTEM, schema: ASK_SCHEMA, numCtx: 8192, maxTokens: 900, onStream: live('ask'),
      messages: [{ role: 'user', content: `Material from "${plan.file.name}":\n\n${context}\n\nStudent question: ${q}\n\nAnswer using only the material. If the material does not answer it, set found to false and say so briefly.` }]
    })
    return { answer: clip(r.answer, 3000), found: r.found !== false, sources: r.found === false ? [] : use.map(x => plan.chunks[x.i].label) }
  }

  function recent(limit = 12) {
    let names = []
    try { names = fs.readdirSync(root).filter(n => n.endsWith('.json')) } catch { return [] }
    return names.map(n => load(n.slice(0, -5))).filter(Boolean)
      .sort((a, b) => (b.lastOpened || 0) - (a.lastOpened || 0)).slice(0, limit)
      .map(p => ({ id: p.id, title: p.title, file: p.file, progress: progressOf(p), lastOpened: p.lastOpened, exists: fs.existsSync(p.file.path) }))
  }

  return { build, lesson, setDone, ask, recent, load: id => { const p = load(id); return p && publicPlan(p) }, remove: id => { try { fs.unlinkSync(planFile(id)) } catch { /* ignore */ } } }
}

module.exports = { createStudy, chunkSections }
