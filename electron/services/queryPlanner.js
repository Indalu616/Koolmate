'use strict'
/**
 * Turns a natural-language request ("PDF lecture slides for distributed systems from last week")
 * into a structured query. Works fully offline with rules; Gemini can refine it (see gemini.js).
 */
const { tokenize, STOP_WORDS, EXT_CATEGORY } = require('./common')

// Hard type filters: the user explicitly asked for a file format.
const TYPE_FILTERS = [
  { re: /\b(pdfs?)\b/, label: 'PDF', exts: ['pdf'] },
  { re: /\b(word (?:docs?|documents?|files?)|docx|\.docx)\b/, label: 'Word', exts: ['doc', 'docx'] },
  { re: /\b(excel|spreadsheets?|xlsx|csv)\b/, label: 'Spreadsheet', exts: EXT_CATEGORY.Spreadsheets },
  { re: /\b(images?|photos?|pictures?|screenshots?|jpe?gs?|pngs?)\b/, label: 'Images', exts: EXT_CATEGORY.Images },
  { re: /\b(videos?|recordings?|mp4)\b/, label: 'Videos', exts: EXT_CATEGORY.Videos },
  { re: /\b(audio|music|podcasts?|mp3)\b/, label: 'Audio', exts: EXT_CATEGORY.Audio },
  { re: /\b(zip|zips|archives?|rar)\b/, label: 'Archives', exts: EXT_CATEGORY.Archives },
  { re: /\b(powerpoints?|pptx?|presentations?)\b/, label: 'Presentations', exts: ['ppt', 'pptx', 'key', 'odp', 'pdf'] }
]

// Soft synonym groups: each keyword expands into alternatives that may appear in file names.
const SYNONYMS = {
  lecture: ['lecture', 'lectures', 'lec', 'lect', 'slides', 'week'],
  lectures: ['lecture', 'lectures', 'lec', 'lect', 'slides'],
  slides: ['slides', 'slide', 'lecture', 'lec', 'ppt', 'presentation'],
  assignment: ['assignment', 'assignments', 'asg', 'assign', 'hw', 'homework', 'coursework'],
  assignments: ['assignment', 'assignments', 'asg', 'assign', 'hw', 'homework'],
  homework: ['homework', 'hw', 'assignment'],
  exam: ['exam', 'exams', 'midterm', 'final', 'quiz', 'test', 'past', 'paper'],
  exams: ['exam', 'exams', 'midterm', 'final', 'quiz', 'test'],
  midterm: ['midterm', 'mid', 'exam'],
  quiz: ['quiz', 'quizzes', 'test'],
  lab: ['lab', 'labs', 'practical', 'experiment'],
  labs: ['lab', 'labs', 'practical', 'experiment'],
  notes: ['notes', 'note', 'summary', 'cheatsheet', 'cheat'],
  syllabus: ['syllabus', 'outline', 'plan'],
  project: ['project', 'proj', 'capstone'],
  report: ['report', 'paper', 'writeup'],
  resume: ['resume', 'cv', 'curriculum'],
  cv: ['cv', 'resume', 'curriculum'],
  invoice: ['invoice', 'receipt', 'bill'],
  receipt: ['receipt', 'invoice', 'bill'],
  paper: ['paper', 'article', 'journal', 'report'],
  papers: ['paper', 'papers', 'article', 'journal'],
  picture: ['img', 'image', 'photo', 'picture'],
  photo: ['img', 'image', 'photo', 'picture', 'whatsapp'],
  screenshot: ['screenshot', 'screen', 'capture']
}

const MONTHS = ['january', 'february', 'march', 'april', 'may', 'june', 'july', 'august', 'september', 'october', 'november', 'december']

function startOfDay(d) { const x = new Date(d); x.setHours(0, 0, 0, 0); return x }
function addDays(d, n) { const x = new Date(d); x.setDate(x.getDate() + n); return x }

function parseDates(text, now) {
  const t = text.toLowerCase()
  const today = startOfDay(now)
  let m
  if (/\btoday\b/.test(t)) return { from: today, to: null, label: 'today' }
  if (/\byesterday\b/.test(t)) return { from: addDays(today, -1), to: today, label: 'yesterday' }
  if ((m = t.match(/\b(?:last|past|previous)\s+(\d{1,3})\s+(day|week|month)s?\b/))) {
    const n = +m[1]; const days = m[2] === 'day' ? n : m[2] === 'week' ? n * 7 : n * 30
    return { from: addDays(today, -days), to: null, label: `last ${n} ${m[2]}${n > 1 ? 's' : ''}` }
  }
  if (/\b(this|current)\s+week\b/.test(t)) {
    const dow = (today.getDay() + 6) % 7
    return { from: addDays(today, -dow), to: null, label: 'this week' }
  }
  if (/\blast\s+week\b/.test(t)) {
    const dow = (today.getDay() + 6) % 7
    const thisMon = addDays(today, -dow)
    // "last week" is read generously: from the start of the previous calendar week until now
    return { from: addDays(thisMon, -7), to: null, label: 'last week' }
  }
  if (/\b(this|current)\s+month\b/.test(t)) return { from: new Date(today.getFullYear(), today.getMonth(), 1), to: null, label: 'this month' }
  if (/\blast\s+month\b/.test(t)) {
    return { from: new Date(today.getFullYear(), today.getMonth() - 1, 1), to: new Date(today.getFullYear(), today.getMonth(), 1), label: 'last month' }
  }
  if (/\b(recent|recently|lately|latest)\b/.test(t)) return { from: addDays(today, -14), to: null, label: 'recent (14 days)' }
  for (let i = 0; i < 12; i++) {
    if (new RegExp(`\\b(?:in|from|during)\\s+${MONTHS[i]}\\b`).test(t)) {
      const year = i > now.getMonth() ? now.getFullYear() - 1 : now.getFullYear()
      return { from: new Date(year, i, 1), to: new Date(year, i + 1, 1), label: `in ${MONTHS[i][0].toUpperCase()}${MONTHS[i].slice(1)}` }
    }
  }
  return null
}

function matchCourses(text, courses) {
  const t = ' ' + tokenize(text).join(' ') + ' '
  const raw = text.toLowerCase().replace(/[\s_-]/g, '')
  const hits = []
  for (const c of courses || []) {
    const code = (c.code || '').toLowerCase().replace(/[\s_-]/g, '')
    const names = [c.name, ...(c.keywords || [])].filter(Boolean).map(s => tokenize(s).join(' '))
    const byCode = code && raw.includes(code)
    const byName = names.some(n => n && t.includes(' ' + n + ' '))
    if (byCode || byName) hits.push(c)
  }
  return hits
}

function courseTerms(c) {
  const out = new Set()
  if (c.code) { out.add(c.code.toLowerCase().replace(/[\s_-]/g, '')) }
  for (const k of c.keywords || []) out.add(k.toLowerCase())
  // a one-word course name ("Genetics") is itself a good file-name term; multi-word names are too ambiguous
  const nameToks = tokenize(c.name || '')
  if (nameToks.length === 1 && nameToks[0].length > 3) out.add(nameToks[0])
  return Array.from(out)
}

/**
 * @returns {{intent:'find'|'organize', groups:string[][], extensions:string[], typeLabel:string|null,
 *            dateFrom:number|null, dateTo:number|null, dateLabel:string|null, courses:object[], summary:string, source:'local'|'ai'}}
 */
function planQuery(text, { courses = [], now = new Date() } = {}) {
  const original = String(text || '').trim()
  let t = original.toLowerCase()

  const intent = /\b(organi[sz]e|sort|group|gather|collect|bundle|tidy|clean up|put together)\b/.test(t) ? 'organize' : 'find'

  const dates = parseDates(t, now)
  let extensions = []
  let typeLabel = null
  for (const tf of TYPE_FILTERS) {
    if (tf.re.test(t)) {
      // "slides"/"presentations" are soft (handled via synonyms); others are hard filters
      if (tf.label === 'Presentations') continue
      extensions = Array.from(new Set([...extensions, ...tf.exts]))
      typeLabel = typeLabel ? `${typeLabel} / ${tf.label}` : tf.label
    }
  }
  const explicitExt = t.match(/\.([a-z0-9]{2,5})\b/g)
  if (explicitExt) {
    extensions = Array.from(new Set([...extensions, ...explicitExt.map(e => e.slice(1))]))
    typeLabel = typeLabel || explicitExt.join(', ')
  }

  const matchedCourses = matchCourses(original, courses)

  // keyword groups
  const typeWords = new Set(['pdf', 'pdfs', 'word', 'docx', 'excel', 'spreadsheet', 'spreadsheets', 'csv', 'xlsx', 'image', 'images',
    'photo', 'photos', 'picture', 'pictures', 'screenshot', 'screenshots', 'video', 'videos', 'recording', 'recordings', 'audio',
    'music', 'zip', 'archive', 'archives', 'doc', 'docs', 'document', 'documents', 'jpg', 'jpeg', 'png', 'mp4', 'mp3', 'powerpoint',
    'ppt', 'pptx', 'presentation', 'presentations'])
  const courseTokens = new Set()
  for (const c of matchedCourses) {
    tokenize(c.name).forEach(x => courseTokens.add(x))
    ;(c.keywords || []).forEach(k => tokenize(k).forEach(x => courseTokens.add(x)))
    tokenize(c.code).forEach(x => courseTokens.add(x))
  }

  const groups = []
  const seen = new Set()
  for (const c of matchedCourses) {
    const terms = courseTerms(c)
    if (terms.length) groups.push(terms)
  }
  for (const tok of tokenize(original)) {
    if (STOP_WORDS.has(tok) || typeWords.has(tok) || courseTokens.has(tok) || seen.has(tok)) continue
    if (/^\d+$/.test(tok) && tok.length < 2) continue
    if (MONTHS.includes(tok)) continue
    seen.add(tok)
    groups.push(SYNONYMS[tok] ? Array.from(new Set([tok, ...SYNONYMS[tok]])) : [tok])
  }
  // week N / lecture N → keep number tied to nothing; it will simply be another group
  const summaryParts = []
  if (matchedCourses.length) summaryParts.push(`course ${matchedCourses.map(c => c.code || c.name).join(', ')}`)
  const kw = groups.slice(matchedCourses.length).map(g => g[0])
  if (kw.length) summaryParts.push(`keywords ${kw.join(', ')}`)
  if (typeLabel) summaryParts.push(`type ${typeLabel}`)
  if (dates) summaryParts.push(`modified ${dates.label}`)

  return {
    intent,
    groups,
    extensions,
    typeLabel,
    dateFrom: dates?.from ? dates.from.getTime() : null,
    dateTo: dates?.to ? dates.to.getTime() : null,
    dateLabel: dates?.label || null,
    courses: matchedCourses.map(c => ({ code: c.code, name: c.name })),
    summary: summaryParts.join(' · ') || 'all files',
    source: 'local'
  }
}

/** Merge an AI-produced plan (already validated) over the local one. */
function mergeAiPlan(local, ai) {
  if (!ai || typeof ai !== 'object') return local
  const groups = Array.isArray(ai.keywords)
    ? ai.keywords.map(g => (Array.isArray(g) ? g : [g])).map(g => g.map(s => String(s).toLowerCase().trim()).filter(Boolean)).filter(g => g.length).slice(0, 8)
    : null
  const exts = Array.isArray(ai.extensions) ? ai.extensions.map(e => String(e).toLowerCase().replace(/^\./, '')).filter(Boolean).slice(0, 20) : null
  const out = { ...local, source: 'ai' }
  if (groups && groups.length) {
    // keep course groups from the local plan (they carry user-defined aliases) and add AI groups not already covered
    const have = new Set(local.groups.flat())
    out.groups = [...local.groups.slice(0, local.courses.length), ...groups.filter(g => !g.every(s => have.has(s)) || local.courses.length === 0)]
    if (local.courses.length === 0) out.groups = groups
  }
  if (exts && exts.length && !local.extensions.length) out.extensions = exts
  const parse = v => { const n = Date.parse(v); return Number.isFinite(n) ? n : null }
  if (ai.modifiedAfter && !local.dateFrom) out.dateFrom = parse(ai.modifiedAfter)
  if (ai.modifiedBefore && !local.dateTo) out.dateTo = parse(ai.modifiedBefore)
  if (ai.intent === 'organize' || ai.intent === 'find') out.intent = ai.intent
  if (typeof ai.summary === 'string' && ai.summary.trim()) out.summary = ai.summary.trim().slice(0, 160)
  return out
}

module.exports = { planQuery, mergeAiPlan, parseDates, matchCourses }
