'use strict'
/**
 * Suggestion engine: given a newly downloaded file, decide where it most likely belongs.
 * Signals: course codes/names in the file name or download source, material type (lecture, lab...),
 * week number, similarity to files already in a folder, and what the user chose before.
 * Nothing here reads file contents, and nothing is moved without the caller's confirmation.
 */
const fs = require('fs')
const path = require('path')
const { SKIP_DIR_NAMES, tokenize, tokenizeWithCodes, extOf, isInside, categoryOfExt } = require('./common')

const TYPE_RULES = [
  { type: 'Lectures', words: ['lecture', 'lectures', 'lec', 'lect', 'slides', 'slide', 'chapter', 'ch'] },
  { type: 'Assignments', words: ['assignment', 'assignments', 'asg', 'assign', 'hw', 'homework', 'coursework', 'worksheet', 'tutorial'] },
  { type: 'Labs', words: ['lab', 'labs', 'practical', 'experiment'] },
  { type: 'Exams', words: ['exam', 'exams', 'midterm', 'final', 'quiz', 'quizzes', 'mock', 'revision'] },
  { type: 'Syllabus', words: ['syllabus', 'outline', 'schedule'] },
  { type: 'Projects', words: ['project', 'proj', 'capstone', 'proposal'] },
  { type: 'Notes', words: ['notes', 'note', 'summary', 'cheatsheet'] },
  { type: 'Readings', words: ['paper', 'article', 'journal', 'reading', 'book'] }
]
const TYPE_FOLDER_ALIASES = {
  Lectures: ['lecture', 'lectures', 'slides', 'lec'],
  Assignments: ['assignment', 'assignments', 'homework', 'hw', 'coursework'],
  Labs: ['lab', 'labs', 'practical'],
  Exams: ['exam', 'exams', 'midterm', 'final', 'quizzes', 'quiz'],
  Syllabus: ['syllabus', 'outline'],
  Projects: ['project', 'projects'],
  Notes: ['notes', 'note'],
  Readings: ['readings', 'reading', 'papers', 'articles']
}

// ---------------------------------------------------------------- signals

function parseSource(sourceUrl, fileName) {
  const out = { host: '', label: '', raw: sourceUrl || '' }
  if (/^whatsapp/i.test(fileName)) out.label = 'WhatsApp'
  if (/^(screenshot|screen shot)/i.test(fileName)) out.label = 'Screenshot'
  if (!sourceUrl) return out
  try {
    const u = new URL(sourceUrl)
    out.host = u.hostname
    const h = u.hostname.toLowerCase()
    if (/blackboard|(^|\.)bb\./.test(h) || /webapps\/blackboard|learn\./.test(sourceUrl.toLowerCase())) out.label = 'Blackboard'
    else if (/mail\.google|outlook\./.test(h)) out.label = 'Email'
    else if (/drive\.google|docs\.google/.test(h)) out.label = 'Google Drive'
    else if (/whatsapp/.test(h)) out.label = 'WhatsApp'
    else out.label = out.label || u.hostname.replace(/^www\./, '')
  } catch { /* not a URL */ }
  return out
}

function detectCourse(text, courses) {
  const compact = text.toLowerCase().replace(/[\s_-]/g, '')
  const toks = ' ' + tokenize(text).join(' ') + ' '
  for (const c of courses || []) {
    const code = (c.code || '').toLowerCase().replace(/[\s_-]/g, '')
    if (code && compact.includes(code)) return { code: c.code, name: c.name || '', keywords: c.keywords || [], known: true }
  }
  for (const c of courses || []) {
    const names = [c.name, ...(c.keywords || [])].filter(Boolean).map(s => tokenize(s).join(' ')).filter(s => s.length >= 2)
    if (names.some(n => toks.includes(' ' + n + ' '))) return { code: c.code, name: c.name || '', keywords: c.keywords || [], known: true }
  }
  const m = text.match(/(?<![A-Za-z])([A-Za-z]{2,4})[\s_-]?(\d{3,4})(?!\d)/)
  if (m && !/^(19|20)\d\d$/.test(m[2])) return { code: (m[1] + m[2]).toUpperCase(), name: '', keywords: [], known: false }
  return null
}

function extractSignals(fileName, { sourceUrl = '', courses = [] } = {}) {
  const base = fileName.replace(/\.[^.]+$/, '')
  const source = parseSource(sourceUrl, fileName)
  const text = `${base} ${sourceUrl || ''}`
  const tokens = tokenizeWithCodes(base)
  const course = detectCourse(text, courses)
  let type = null
  for (const r of TYPE_RULES) { if (r.words.some(w => tokens.includes(w))) { type = r.type; break } }
  let week = null
  const wm = base.match(/(?:week|wk|lecture|lec|lect|chapter|ch)[\s_-]?0?(\d{1,2})(?!\d)/i)
  if (wm) week = parseInt(wm[1], 10)
  const ext = extOf(fileName)
  return { tokens, course, type, week, ext, category: categoryOfExt(ext), source }
}

// ---------------------------------------------------------------- folder catalog

async function buildCatalog(roots, excluded = [], { maxDepth = 4, maxFolders = 4000 } = {}) {
  const folders = []
  const queue = roots.filter(Boolean).map(r => ({ dir: path.resolve(r), root: path.resolve(r), depth: 0 }))
  const ex = excluded.map(e => path.resolve(e))
  while (queue.length && folders.length < maxFolders) {
    const { dir, root, depth } = queue.shift()
    let entries
    try { entries = await fs.promises.readdir(dir, { withFileTypes: true }) } catch { continue }
    const fileNames = []
    for (const e of entries) {
      if (e.isDirectory() && !e.isSymbolicLink()) {
        const n = e.name
        if (n.startsWith('.') || SKIP_DIR_NAMES.has(n.toLowerCase())) continue
        const full = path.join(dir, n)
        if (ex.some(x => isInside(full, x))) continue
        if (depth < maxDepth) queue.push({ dir: full, root, depth: depth + 1 })
      } else if (e.isFile() && !e.name.startsWith('.')) fileNames.push(e.name)
    }
    if (depth > 0) {
      const rel = path.relative(root, dir).split(path.sep)
      folders.push({
        path: dir, root, depth, rel, name: path.basename(dir),
        pathTokens: tokenizeWithCodes(rel.join(' ')),
        leafTokens: tokenizeWithCodes(rel[rel.length - 1]),
        fileCount: fileNames.length,
        samples: fileNames.slice(0, 25).map(n => ({ tokens: tokenizeWithCodes(n.replace(/\.[^.]+$/, '')), ext: extOf(n) }))
      })
    }
  }
  return folders
}

// ---------------------------------------------------------------- scoring

function jaccardMax(tokens, samples) {
  const t = new Set(tokens.filter(x => x.length > 1 && !/^\d+$/.test(x)))
  if (!t.size) return 0
  let best = 0
  for (const s of samples) {
    const st = new Set(s.tokens.filter(x => x.length > 1 && !/^\d+$/.test(x)))
    if (!st.size) continue
    let inter = 0
    for (const x of t) if (st.has(x)) inter++
    const j = inter / (t.size + st.size - inter)
    if (j > best) best = j
  }
  return best
}

function scoreFolder(f, sig, learning) {
  let score = 0
  const reasons = []
  const course = sig.course
  if (course) {
    const code = (course.code || '').toLowerCase().replace(/[\s_-]/g, '')
    const nameToks = tokenize(course.name || '').filter(t => t.length > 2)
    const kw = (course.keywords || []).map(k => k.toLowerCase())
    if (code && f.pathTokens.includes(code)) { score += 5; reasons.push(`folder matches course ${course.code}`) }
    else if ((nameToks.length >= 1 && nameToks.every(t => f.pathTokens.includes(t))) || kw.some(k => f.pathTokens.includes(k))) {
      score += 3.5; reasons.push(`folder matches course "${course.name || course.code}"`)
    }
    const learned = learning.courseFolders?.[(course.code || '').toLowerCase()]
    if (learned) {
      if (f.path === learned) { score += 4; reasons.push('you filed this course here before') }
      else if (isInside(f.path, learned)) { score += 2.5; reasons.push('inside your usual course folder') }
    }
  }
  if (sig.type) {
    const aliases = TYPE_FOLDER_ALIASES[sig.type] || []
    if (aliases.some(a => f.leafTokens.includes(a))) { score += 2.5; reasons.push(`${sig.type.toLowerCase()} folder`) }
    else if (aliases.some(a => f.pathTokens.includes(a))) score += 0.8
  }
  if (sig.week != null) {
    const wk = String(sig.week)
    if (f.leafTokens.includes('week') && f.leafTokens.some(t => t === wk || t === wk.padStart(2, '0'))) { score += 3; reasons.push(`week ${sig.week} folder`) }
  }
  const sim = jaccardMax(sig.tokens, f.samples)
  if (sim > 0) { score += Math.min(2.5, sim * 5); if (sim >= 0.3) reasons.push('similar to files already there') }
  const extCount = learning.extFolders?.[sig.ext]?.[f.path] || 0
  if (extCount) { score += Math.min(2, extCount * 0.5); reasons.push('you often file this type here') }
  if (f.samples.length && f.samples.filter(s => s.ext === sig.ext).length / f.samples.length > 0.6) score += 0.4
  // prefer deeper, more specific folders slightly when scores tie
  score += Math.min(f.depth, 3) * 0.05
  return { score, reasons }
}

const toConfidence = s => Math.min(0.98, 1 - Math.exp(-Math.max(0, s) / 4.5))

function courseFolderName(course) {
  return course.name ? `${course.code} ${course.name}`.trim() : course.code
}

/**
 * @returns suggestion object (never moves anything)
 */
function suggest({ fileName, sourceUrl = '', courses = [], catalog = [], learning = { courseFolders: {}, extFolders: {}, recent: [] }, destinationRoots = [] }) {
  const sig = extractSignals(fileName, { sourceUrl, courses })
  const scored = catalog
    .map(f => ({ f, ...scoreFolder(f, sig, learning) }))
    .filter(x => x.score > 0.9)
    .sort((a, b) => b.score - a.score)

  const top = scored[0]
  const second = scored[1]
  let primary = null

  const courseSpecific = top && top.reasons.some(r => /course|filed this course|usual course/.test(r))
  if (top && (courseSpecific || !sig.course) && top.score >= 2) {
    let conf = toConfidence(top.score)
    if (second && second.score >= top.score * 0.85) conf = Math.max(0.2, conf - 0.12)
    primary = { folder: top.f.path, isNewFolder: false, confidence: conf, reason: top.reasons.slice(0, 3).join(' · ') || 'best match among your folders' }
  } else if (sig.course) {
    const root = destinationRoots[0] || catalog[0]?.root || ''
    const sub = sig.type || ''
    const folder = path.join(root, courseFolderName(sig.course), sub)
    primary = {
      folder, isNewFolder: true,
      confidence: sig.course.known ? 0.72 : 0.55,
      reason: `${sig.course.known ? 'Course' : 'Detected course code'} ${sig.course.code}${sig.type ? ` · ${sig.type.toLowerCase()}` : ''} — no folder exists yet, will create one`
    }
  } else {
    const root = destinationRoots[0] || catalog[0]?.root || ''
    primary = {
      folder: path.join(root, 'To Review', sig.category === 'Other' ? 'Misc' : sig.category),
      isNewFolder: true, confidence: top ? Math.min(0.45, toConfidence(top.score)) : 0.15,
      reason: 'No course or matching folder detected — please confirm a destination'
    }
  }

  const seen = new Set([primary.folder])
  const alternatives = []
  for (const x of scored) {
    if (alternatives.length >= 3) break
    if (seen.has(x.f.path)) continue
    seen.add(x.f.path)
    alternatives.push({ folder: x.f.path, confidence: toConfidence(x.score), reason: x.reasons.slice(0, 2).join(' · ') || 'possible match' })
  }
  for (const r of learning.recent || []) {
    if (alternatives.length >= 6) break
    if (seen.has(r)) continue
    seen.add(r)
    alternatives.push({ folder: r, confidence: null, reason: 'Recently used' })
  }

  return {
    signals: {
      course: sig.course ? { code: sig.course.code, name: sig.course.name, known: sig.course.known } : null,
      type: sig.type, week: sig.week, source: sig.source.label || null, host: sig.source.host || null, category: sig.category
    },
    primary, alternatives,
    needsReview: primary.confidence < 0.55,
    candidatePaths: scored.slice(0, 12).map(x => x.f.path)
  }
}

module.exports = { suggest, extractSignals, buildCatalog, parseSource, detectCourse, toConfidence, courseFolderName, scoreFolder, jaccardMax, TYPE_RULES, TYPE_FOLDER_ALIASES }
