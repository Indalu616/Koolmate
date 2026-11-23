'use strict'
/**
 * Content-aware filing engine.
 *
 *   understand(file)  ->  { course, type, semester, topic, keywords, title }
 *   resolve(...)      ->  the best *existing* folder, or the exact new folder path to create,
 *                         following the hierarchy the user already uses
 *                         (e.g. <root>/Fall 2026/Operating Systems/Lecture Materials).
 *
 * Everything here is deterministic and offline. The optional Gemini step only improves the
 * "understanding" fields; the folder is always resolved here, against the user's real folders.
 */
const path = require('path')
const { STOP_WORDS, tokenize, tokenizeWithCodes, extOf, categoryOfExt } = require('./common')
const { extractSignals, TYPE_FOLDER_ALIASES, TYPE_RULES, scoreFolder, jaccardMax, toConfidence, courseFolderName, joinedName } = require('./classifier')

// ------------------------------------------------------------------ small helpers

const stem = w => (w.length > 3 && w.endsWith('s') && !w.endsWith('ss') ? w.slice(0, -1) : w)
const stems = text => tokenize(text).filter(t => t.length > 1).map(stem)
const title = s => s.replace(/\b\w/g, c => c.toUpperCase())
const cleanSegment = s => String(s || '').replace(/[\\/:*?"<>|\u0000-\u001f]/g, ' ').replace(/\s+/g, ' ').replace(/^\.+/, '').trim().slice(0, 90)

const TYPE_DEFAULT_NAME = {
  Lectures: 'LectureMaterials', Assignments: 'Assignments', Activities: 'Activities', Labs: 'Labs', Exams: 'Exams',
  Syllabus: 'Syllabus', Projects: 'Projects', Notes: 'Notes', Readings: 'Readings'
}
const TYPE_LABEL = { Lectures: 'lecture', Assignments: 'assignment', Activities: 'activity', Labs: 'lab', Exams: 'exam', Syllabus: 'syllabus', Projects: 'project', Notes: 'notes', Readings: 'reading' }

// ------------------------------------------------------------------ semester

const SEM_WORD = '(fall|autumn|spring|summer|winter)'
const SEM_A = new RegExp(`\\b${SEM_WORD}[\\s_.\\-]*(?:semester|term|sem)?[\\s_.\\-]*((?:20)?\\d{2})(?!\\d)`, 'i')
const SEM_B = new RegExp(`(?<!\\d)((?:20)\\d{2})(?:[\\s_.\\-]*\\d{2,4})?[\\s_.\\-]*(?:semester|term|sem)?[\\s_.\\-]*${SEM_WORD}\\b`, 'i')
const normTerm = t => { t = t.toLowerCase(); return t === 'autumn' ? 'fall' : t }
const fullYear = y => { y = String(y); return y.length === 2 ? 2000 + parseInt(y, 10) : parseInt(y, 10) }

function parseSemester(text) {
  const s = String(text || '')
  let m = s.match(SEM_A)
  let term, year
  if (m) { term = m[1]; year = fullYear(m[2]) } else if ((m = s.match(SEM_B))) { term = m[2]; year = fullYear(m[1]) } else return null
  if (year < 2000 || year > 2100) return null
  const t = normTerm(term)
  return { term: title(t), year, key: `${t}-${year}` }
}

/** A folder is a "semester folder" when its whole name is basically a semester. */
function isSemesterName(name) {
  const sem = parseSemester(name)
  if (!sem) return false
  const rest = name.toLowerCase().replace(SEM_A, ' ').replace(SEM_B, ' ').replace(/semester|term|academic|year|[\d\s_.\-]/g, '')
  return rest.length <= 2
}

function semesterFromTime(ms) {
  const d = new Date(ms || Date.now())
  const m = d.getMonth() + 1
  const term = m >= 8 ? 'Fall' : m >= 6 ? 'Summer' : 'Spring'
  return { term, year: d.getFullYear(), key: `${term.toLowerCase()}-${d.getFullYear()}` }
}

/** Format a new semester folder name in the same style as an existing one (e.g. "2026_FALL"). */
function formatSemester(sem, example) {
  const ex = example || 'Fall 2026'
  const yearFirst = /^\D*(20\d\d)/.test(ex) && ex.search(/20\d\d/) < ex.search(/[A-Za-z]/)
  const sep = (ex.match(/[\s_\-.]+/) || [' '])[0][0]
  let term = sem.term
  if (ex === ex.toUpperCase() && /[A-Z]/.test(ex)) term = term.toUpperCase()
  else if (ex === ex.toLowerCase()) term = term.toLowerCase()
  const parts = yearFirst ? [sem.year, term] : [term, sem.year]
  return parts.join(sep === '.' ? ' ' : sep)
}

// ------------------------------------------------------------------ document type

const TYPE_PATTERNS = [
  ['Syllabus', [/\bsyllabus\b/i, /\bcourse (description|outcomes|objectives)\b/i, /\bgrading (policy|scheme)\b/i, /\boffice hours\b/i, /\bprerequisites?\b/i]],
  ['Exams', [/\b(mid-?term|final) exam/i, /\bexam(ination)?\b/i, /\bquiz\b/i, /\bquestion paper\b/i, /\bmarks?\b.*\bduration\b/i, /\btime allowed\b/i, /\bpast paper\b/i]],
  ['Assignments', [/\bassignment\s*#?\d*/i, /\bhomework\b/i, /\bproblem set\b/i, /\bdue (date|on|by)\b/i, /\bsubmit (by|before|via)\b/i, /\bdeadline\b/i]],
  ['Activities', [/\bactivit(y|ies)\b/i, /\bcase study\b/i, /\breview questions\b/i,
    /\b(aha ?slides|kahoot|mentimeter|menti\.com|quizizz|slido|poll ?everywhere|wooclap|nearpod|padlet)\b/i, /\bleaderboard\b/i, /\b(vote|poll|join) (at|now|code)\b/i, /\b(in[- ]?class|class|group|team|individual|hands[- ]on) (activity|exercise|task)\b/i, /\bwork (in|with) (pairs|groups|your (group|team|partner))\b/i, /\bworksheet\b/i, /\bdiscuss (with|in) (your )?(group|partner|team)\b/i, /\btime(box)?:?\s*\d+\s*(min|minutes)\b/i]],
  ['Labs', [/\blab(oratory)?[\s-]*(report|manual|exercise|session|sheet|\d)/i, /\bexperiment\b/i, /\bprocedure\b.*\bapparatus\b/i, /\blab objectives?\b/i]],
  ['Projects', [/\bproject (proposal|report|plan|charter|description)\b/i, /\bmilestone\b/i, /\bdeliverables?\b/i, /\bcapstone\b/i]],
  ['Lectures', [/\blecture\s*#?\d*/i, /\bslides?\b/i, /\bchapter\s*\d+/i, /\blearning outcomes?\b/i, /\bagenda\b/i, /\btoday'?s (topic|class)\b/i, /\boutline\b/i]],
  ['Readings', [/\babstract\b[\s\S]{0,400}\bintroduction\b/i, /\bet al\.?/i, /\bdoi:/i, /\breferences\b/i, /\barxiv\b/i]],
  ['Notes', [/\bnotes?\b/i, /\bsummary\b/i, /\bcheat ?sheet\b/i, /\brevision\b/i]]
]

// A line that asks the student to do something: "List the concepts…", "Google the difference…", "Why do you think…?"
const TASK_LINE = /^\s*(?:\(?\d+[.)]|\(?[a-z][.)]|[-•*▪●])?\s*(?:list|explain|describe|define|compare|contrast|use|google|search|find|write|draw|answer|discuss|calculate|compute|summari[sz]e|show|identify|give|state|prepare|design|create|analy[sz]e|evaluate|justify|solve|complete|fill|choose|select|match|what|why|how|which|who|when|where|is|are|do|does|can)\b/i

/**
 * Worksheets: mostly instructions and questions for the student, whatever the file is called
 * ("ITE442 - Lecture 0.docx" that is really an independent-learning task sheet).
 */
function taskSheetScore(text) {
  const lines = text.split('\n').map(l => l.trim()).filter(l => l.length >= 12)
  if (lines.length < 4) return 0
  const tasks = lines.filter(l => TASK_LINE.test(l) || /\?\s*$/.test(l)).length
  if (tasks < 4 || tasks / lines.length < 0.3) return 0
  let score = 2 + Math.min(3, (tasks - 4) * 0.25)
  if (/\b(rules|instructions|directions|guidelines)\s*:/i.test(text)) score += 2
  if (/\b(independent|self[- ]?directed|self)[- ]?(learning|study)\b|\breview questions\b|\bcase study\b|\bpractice questions\b/i.test(text)) score += 2
  if (/\bpart\s*(1|2|one|two|a|b)\b/i.test(text)) score += 0.7
  return score
}

/** How strongly the text reads like each kind of course material (the title/first lines count most). */
function scoreDocTypes(text) {
  const head = text.slice(0, 700)
  const scores = {}
  for (const [type, pats] of TYPE_PATTERNS) {
    let score = 0
    for (const p of pats) { if (p.test(head)) score += 2; else if (p.test(text)) score += 0.7 }
    scores[type] = score
  }
  // a task sheet is an assignment when it is graded or has a deadline, otherwise an activity
  const tasks = taskSheetScore(text)
  if (tasks) {
    const graded = /\b(due (date|on|by)?|deadline|submit(ted|ssion)?\b|marks?\b|points?\b|grade[ds]?\b|weight(ing)?\s*:?\s*\d+\s*%)/i.test(text)
    scores[graded ? 'Assignments' : 'Activities'] += tasks
  }
  let best = null
  for (const [type, score] of Object.entries(scores)) if (score > 0 && (!best || score > best.score)) best = { type, score }
  return { best, scores }
}

function detectDocType(text) {
  const { best } = scoreDocTypes(text)
  return best && best.score >= 1.4 ? best.type : null
}

// ------------------------------------------------------------------ topics (non-course documents)

const TOPICS = [
  { name: 'Finance', folder: 'Finance', words: ['invoice', 'receipt', 'bill', 'payment', 'statement', 'bank', 'tax', 'salary', 'payslip', 'vat', 'balance', 'transaction', 'amount due', 'iban'], folders: ['finance', 'invoice', 'bill', 'receipt', 'bank', 'tax', 'payment', 'money', 'budget'] },
  { name: 'Utilities', folder: 'Utilities', words: ['electricity', 'water', 'dewa', 'etisalat', 'du', 'internet', 'utility', 'meter', 'kwh'], folders: ['utilit', 'electric', 'bill', 'home'] },
  { name: 'Career', folder: 'Career', words: ['resume', 'curriculum vitae', 'cv', 'cover letter', 'internship', 'employment', 'job description', 'interview', 'linkedin', 'work experience'], folders: ['career', 'job', 'resume', 'cv', 'work', 'internship'] },
  { name: 'Applications', folder: 'Applications', words: ['statement of purpose', 'personal statement', 'letter of motivation', 'recommendation letter', 'transcript', 'admission', 'scholarship', 'graduate program', 'application'], folders: ['application', 'admission', 'scholarship', 'masters', 'graduate'] },
  { name: 'Travel', folder: 'Travel', words: ['boarding pass', 'itinerary', 'flight', 'hotel', 'booking', 'reservation', 'e-ticket', 'visa', 'check-in'], folders: ['travel', 'trip', 'flight', 'visa'] },
  { name: 'Legal & Identity', folder: 'Legal', words: ['passport', 'emirates id', 'contract', 'agreement', 'lease', 'tenancy', 'certificate', 'power of attorney', 'license', 'registration'], folders: ['legal', 'identity', 'id', 'contract', 'document', 'certificate'] },
  { name: 'Health', folder: 'Health', words: ['prescription', 'medical', 'patient', 'diagnosis', 'vaccination', 'clinic', 'hospital', 'insurance', 'lab result'], folders: ['health', 'medical', 'insurance'] },
  { name: 'Research', folder: 'Research Papers', words: ['abstract', 'keywords', 'methodology', 'references', 'doi', 'ieee', 'conference', 'et al', 'dataset', 'proposed method'], folders: ['research', 'paper', 'publication', 'thesis'] }
]

function detectTopic(text) {
  const hay = ' ' + text.toLowerCase().replace(/[^a-z0-9&\- ]+/g, ' ') + ' '
  const head = hay.slice(0, 500)
  let best = null
  for (const t of TOPICS) {
    let score = 0
    for (const w of t.words) {
      const needle = ' ' + w + ' '
      if (head.includes(needle)) score += 2
      else if (hay.includes(needle)) score += 1
    }
    if (score >= 2 && (!best || score > best.score)) best = { ...t, score }
  }
  return best
}

// "scan_0108", "IMG2001", "INV1234" look like course codes but are not
const NOT_A_COURSE = /^(scan|img|image|dsc|dscn|pxl|doc|docs|file|photo|pic|page|vid|mov|screenshot|screen|whatsapp|wa|ss|fig|chart|table|part|copy|new|ver|version|ref|inv|bill|order|ticket|invoice|receipt|report|test|form|id|pdf|document|download|export|output|untitled)\d/i
const realCourse = c => (c && (c.known || !NOT_A_COURSE.test(String(c.code || '').replace(/[\s_-]/g, '')))) ? c : null
const ACADEMIC = new Set(['Lectures', 'Assignments', 'Activities', 'Labs', 'Exams', 'Syllabus'])
const GENERIC = new Set(['img', 'dsc', 'scan', 'scanned', 'camscanner', 'document', 'doc', 'docs', 'file', 'untitled', 'copy', 'download', 'downloads', 'final', 'new', 'version', 'draft', 'whatsapp', 'image', 'photo', 'screenshot', 'signal', 'pxl', 'adobe', 'pdf', 'docx', 'pptx', 'xlsx', 'page', 'pages', 'unnamed', 'noname', 'scan', 'attachment', 'report', 'data', 'export', 'output', 'sample', 'test', 'temp', 'tmp', 'jpeg', 'jpg', 'png', 'com', 'www', 'v1', 'v2'])

function meaningfulTokens(name) {
  return tokenize(name.replace(/\.[^.]+$/, '')).filter(t => t.length >= 3 && /^[a-z]+$/.test(t) && !GENERIC.has(t) && !STOP_WORDS.has(t))
}

/** True when the file name alone tells us what the file is. */
function isSelfDescriptive(name, sig) {
  sig = { ...sig, course: realCourse(sig.course) }
  const base = name.replace(/\.[^.]+$/, '')
  if (/^(img|dsc|pxl|scan|image|photo|document|doc|file|untitled|scanned|camscanner|screenshot|screen shot|attachment|download)[\s_\-(]*\d*\)?$/i.test(base.trim())) return false
  if (/^[0-9a-f]{16,}$/i.test(base) || /^[0-9a-f]{8}-[0-9a-f]{4}-/.test(base) || /^[\d\s_\-().]+$/.test(base)) return false
  if (sig.course) return true
  const m = meaningfulTokens(name)
  return m.length >= 2 || (m.length === 1 && !!sig.type)
}

// ------------------------------------------------------------------ subjects (courses)

/** Course folders already on disk count as subjects even if the user never configured them. */
function subjectsFromCatalog(catalog, configured = []) {
  const subjects = configured.map(c => ({ ...c, keywords: c.keywords || [] }))
  const codeKey = x => String(x || '').toLowerCase().replace(/[\s_-]/g, '')
  const have = c => subjects.some(s => (s.code && c.code && codeKey(s.code) === codeKey(c.code)) || (!c.code && stems(s.name || '').join(' ') === stems(c.name).join(' ')))
  const dirSet = new Set(catalog.map(f => f.path))
  for (const f of catalog) {
    if (isSemesterName(f.name) || typeOfName(f.name) || f.name.length < 3) continue
    const parent = path.dirname(f.path)
    const hasTypeChild = catalog.some(c => path.dirname(c.path) === f.path && typeOfName(c.name))
    const m = f.name.match(/([A-Za-z]{2,4})[\s_-]?(\d{3,4})(?!\d)/)
    const parentIsSem = dirSet.has(parent) && isSemesterName(path.basename(parent))
    if (!(m || hasTypeChild || parentIsSem)) continue
    const code = m ? (m[1] + m[2]).toUpperCase() : ''
    const name = f.name.replace(m ? m[0] : '', '').replace(/^[\s_\-–:]+|[\s_\-–:]+$/g, '')
    const words = stems(name).filter(w => w.length > 1)
    const acronym = words.length >= 2 ? words.map(w => w[0]).join('') : ''
    const first = words.find(w => w.length >= 6 && !['manage', 'introduction', 'system', 'principle', 'fundamental', 'advanced', 'topic'].includes(w))
    const keywords = [acronym.length >= 2 && acronym.length <= 4 ? acronym : '', first || ''].filter(Boolean)
    const c = { code, name: name || '', keywords, derived: true }
    if (!c.code && !c.name) continue
    if (!have(c)) subjects.push(c)
  }
  return subjects
}

function typeOfName(name) {
  const toks = tokenize(name).map(stem)
  const compact = tokenize(name)
  for (const [type, aliases] of Object.entries(TYPE_FOLDER_ALIASES)) {
    if (aliases.some(a => compact.includes(a) || toks.includes(stem(a)))) return type
  }
  if (/materials?|resources?/i.test(name) && /lecture|course|class/i.test(name)) return 'Lectures'
  return null
}

function subjectMatchesFolder(subject, f) {
  const code = (subject.code || '').toLowerCase().replace(/[\s_-]/g, '')
  if (code && f.leafTokens.includes(code)) return true
  const nameStems = stems(subject.name || '').filter(t => t.length > 1)
  const leafStems = f.leafTokens.map(stem)
  if (nameStems.length && nameStems.every(t => leafStems.includes(t))) return true
  // the student's own short name for the course: "Big Data" for "Data Science and Big Data Analytics"
  const leafWords = Array.from(new Set(f.leafTokens.filter(t => /^[a-z]+$/.test(t) && t.length > 1 && !STOP_WORDS.has(t)).map(stem)))
  if (leafWords.length >= 2 && leafWords.every(t => nameStems.includes(t))) return true
  // ...or its initials: "HCI" for "Human Computer Interaction", "AI" for "Artificial Intelligence"
  const initials = nameStems.filter(t => !STOP_WORDS.has(t)).map(t => t[0]).join('')
  const leafRaw = f.leafTokens.filter(t => /^[a-z]+$/.test(t) && !STOP_WORDS.has(t))
  if (initials.length >= 2 && leafRaw.length === 1 && leafRaw[0] === initials) return true
  // ...or just its first, distinctive word: "Distributed" for "Distributed Systems"
  const firstWord = nameStems.find(t => !STOP_WORDS.has(t))
  if (nameStems.length >= 2 && leafWords.length === 1 && leafWords[0] === firstWord && firstWord.length >= 6 && !VAGUE_FIRST_WORDS.has(firstWord)) return true
  return (subject.keywords || []).some(k => k.length > 3 && f.leafTokens.includes(k.toLowerCase()))
}
const VAGUE_FIRST_WORDS = new Set(['introduct', 'introduction', 'fundamental', 'principl', 'principle', 'advanc', 'advanced', 'special', 'selected', 'select',
  'topic', 'applied', 'appli', 'general', 'computer', 'comput', 'software', 'system', 'business', 'design', 'research', 'project', 'professional', 'profession',
  'engineering', 'engineer', 'modern', 'contemporary', 'english', 'arabic', 'islamic', 'information', 'inform', 'management', 'manag'].map(stem))

const sameFileName = (a, b) => {
  const n = s => s.toLowerCase().replace(/\.[^.]+$/, '').replace(/\s*\(\d+\)/g, '').replace(/[^a-z0-9]+/g, '')
  return n(a).length >= 6 && n(a) === n(b)
}

/**
 * The student's folder may have a name that says nothing about the course ("Uni stuff", "Sem 5") but
 * already hold its files. Scores a folder by what is inside it (and its subfolders): files named with the
 * course code or the full course name, or the very same file as the one being filed.
 */
function folderFileEvidence(subject, f, dirs, fileName = '') {
  const inside = dirs.filter(d => d === f || d.path.startsWith(f.path + path.sep))
  const names = inside.flatMap(d => d.files || [])
  if (!names.length) return { score: 0, why: '' }
  const code = (subject.code || '').toLowerCase().replace(/[\s_-]/g, '')
  const ns = stems(subject.name || '').filter(t => t.length > 1 && !STOP_WORDS.has(t))
  let same = 0, coded = 0, named = 0
  for (const n of names) {
    if (fileName && sameFileName(n, fileName)) same++
    const compact = n.toLowerCase().replace(/[\s_-]/g, '')
    if (code && new RegExp(`(?<![a-z])${code}(?!\\d)`).test(compact)) coded++
    else if (ns.length >= 2) { const st = new Set(stems(n)); if (ns.every(t => st.has(t))) named++ }
  }
  const score = (same ? 4 : 0) + Math.min(coded, 3) * 1.5 + Math.min(named, 2)
  const why = same ? 'already has this file' : coded ? `has ${coded} ${subject.code} file${coded > 1 ? 's' : ''}` : named ? `has ${subject.name} files` : ''
  return { score, why }
}

/** Best existing folder that holds this course's files, when no folder name matches the course. */
function folderByContents(subject, dirs, fileName, roots, filePath = '') {
  const rootSet = new Set(roots.map(r => path.resolve(r)))
  const codeRe = /(?<![A-Za-z])([A-Za-z]{2,4})[\s_-]?(\d{3})(?!\d)/
  const here = filePath ? path.resolve(filePath) : ''
  let best = null
  for (const f of dirs) {
    if (isSemesterName(f.name) || typeOfName(f.name)) continue
    if (here && here.startsWith(f.path + path.sep)) continue // the folder the file is in right now (being sorted) proves nothing
    const parent = parentOf(f.path)
    // a course folder sits directly in a destination root or in a semester folder
    if (!(rootSet.has(parent) || rootSet.has(f.root) && f.depth === 1 || isSemesterName(path.basename(parent)))) continue
    const other = f.name.match(codeRe) // "CSC301-Data Structure" belongs to CSC301, whatever is inside
    if (other && (other[1] + other[2]).toLowerCase() !== (subject.code || '').toLowerCase().replace(/[\s_-]/g, '')) continue
    const ev = folderFileEvidence(subject, f, dirs, fileName)
    if (ev.score >= 3 && (!best || ev.score > best.score)) best = { folder: f, ...ev }
  }
  return best
}

/** Which subject does this text talk about? `weight` makes content matches stricter than file names. */
function detectSubject(text, subjects, { content = false } = {}) {
  const lower = text.toLowerCase()
  const compact = lower.replace(/[\s_\-]/g, '')
  const stemSet = new Set(stems(text))
  const head = new Set(stems(text.slice(0, 300)))
  let best = null
  for (const s of subjects) {
    let score = 0
    const code = (s.code || '').toLowerCase().replace(/[\s_-]/g, '')
    if (code) { const hits = compact.split(code).length - 1; if (hits) score += 3 + Math.min(hits - 1, 3) * 0.5 }
    if (s.codeOnly) { if (score > 0 && (!best || score > best.score)) best = { subject: s, score }; continue }
    const ns = stems(s.name || '').filter(t => t.length > 1)
    if (ns.length && ns.every(t => stemSet.has(t))) score += (ns.every(t => head.has(t)) ? 3 : 1.5) * (ns.length === 1 && ns[0].length < 6 ? 0.7 : 1)
    if (!content) for (const k of s.keywords || []) { if (k.length >= 2 && tokenize(text).includes(k.toLowerCase())) score += 2.5 }
    else for (const k of s.keywords || []) { if (k.length > 3 && tokenize(text).includes(k.toLowerCase())) score += 1 }
    if (score > 0 && (!best || score > best.score)) best = { subject: s, score }
  }
  const need = content ? 2.4 : 2
  return best && best.score >= need ? best : null
}

// ------------------------------------------------------------------ keywords

function topKeywords(text, extra = '', n = 6) {
  const freq = new Map()
  const add = (t, w) => { const s = stem(t); freq.set(s, (freq.get(s) || 0) + w) }
  for (const t of tokenize(text)) if (t.length >= 4 && /^[a-z]+$/.test(t) && !STOP_WORDS.has(t) && !GENERIC.has(t)) add(t, 1)
  for (const t of tokenize(extra)) if (t.length >= 4 && /^[a-z]+$/.test(t) && !STOP_WORDS.has(t) && !GENERIC.has(t)) add(t, 3)
  return Array.from(freq.entries()).filter(([, c]) => c >= 2).sort((a, b) => b[1] - a[1]).slice(0, n).map(([w]) => w)
}

function firstLine(text) {
  const l = text.split('\n').map(x => x.trim()).find(x => x.length >= 4)
  return l ? l.slice(0, 90) : ''
}

// ------------------------------------------------------------------ understanding

/**
 * @param {object} p { file:{name,mtime,size}, content:{ok,text}|null, subjects, sourceUrl }
 */
function understand({ file, content, subjects, sourceUrl = '', courseHint = null }) {
  const sig = extractSignals(file.name, { sourceUrl, courses: subjects })
  sig.course = realCourse(sig.course)
  const text = content?.ok ? content.text : ''
  const nameSubject = detectSubject(file.name.replace(/\.[^.]+$/, ''), subjects)
  const textSubject = text ? detectSubject(text, subjects, { content: true }) : null
  // the Blackboard course the file was downloaded from beats anything guessed from the file
  let course = courseHint ? { code: courseHint.code || '', name: courseHint.name || '', keywords: [], known: true } : (sig.course?.known ? sig.course : null)
  let courseEvidence = courseHint ? (courseHint.evidence || 'Blackboard course page') : course ? 'file name' : null
  let courseStrength = course ? 1 : 0
  if (!course && nameSubject) { course = { code: nameSubject.subject.code, name: nameSubject.subject.name, known: true }; courseEvidence = 'file name'; courseStrength = Math.min(1, nameSubject.score / 3) }
  if (!course && textSubject) { course = { code: textSubject.subject.code, name: textSubject.subject.name, known: true }; courseEvidence = 'file content'; courseStrength = Math.min(1, textSubject.score / 4) }
  if (!course && sig.course) { course = sig.course; courseEvidence = 'file name'; courseStrength = 0.6 }
  if (!course && sig.type && ACADEMIC.has(sig.type)) { // "Software Testing Lecture 1.pdf": probably a course we don't have a folder for yet
    const typeWords = new Set(TYPE_RULES.flatMap(r => r.words))
    const words = meaningfulTokens(file.name).filter(w => !typeWords.has(w) && w.length > 2)
    if (words.length) { course = { code: '', name: title(words.slice(0, 4).join(' ')), known: false, inferred: true }; courseEvidence = 'file name'; courseStrength = 0.4 }
  }
  if (!course && text) { // an unknown but explicit course code inside the document
    const m = text.slice(0, 600).match(/(?<![A-Za-z])([A-Z]{2,4})[\s-]?(\d{3,4})(?!\d)/)
    if (m && !/^(19|20)\d\d$/.test(m[2])) { course = { code: m[1] + m[2], name: '', known: false }; courseEvidence = 'file content'; courseStrength = 0.55 }
  }
  const docScores = text ? scoreDocTypes(text) : null
  const contentType = docScores?.best && docScores.best.score >= 1.4 ? docScores.best.type : null
  // slides from a known course are lecture material unless the name or content says otherwise
  const slidesType = !sig.type && !contentType && course && sig.category === 'Presentations' ? 'Lectures' : null
  // The name is a hint; what the file actually says wins when it clearly disagrees
  // ("Lecture 5.pptx" whose first slide is "In-class activity" goes to Activities).
  // Lab/Assignment/Exam/Project in a name is deliberate; "Lecture"/"Notes" often just means "week N material".
  const contentWins = !!(sig.type && ['Lectures', 'Notes', 'Readings', 'Syllabus'].includes(sig.type) && contentType && contentType !== sig.type &&
    docScores.best.score >= 2 && docScores.best.score >= (docScores.scores[sig.type] || 0) + 1.3)
  const type = contentWins ? contentType : (sig.type || contentType || slidesType)
  const typeEvidence = contentWins ? `file content (the name said ${TYPE_LABEL[sig.type] || sig.type})`
    : sig.type ? (contentType === sig.type ? 'file name and content' : 'file name')
      : contentType ? 'file content' : slidesType ? 'file type (slides)' : null
  const semester = parseSemester(file.name) || (text ? parseSemester(text.slice(0, 1500)) : null)
  const semesterFrom = semester ? (parseSemester(file.name) ? 'file name' : 'file content') : null
  const topic = !course && text ? detectTopic(text) : (!course ? detectTopic(file.name.replace(/[_\-.]+/g, ' ')) : null)
  const ttl = text ? firstLine(text) : ''
  const keywords = topKeywords(text, `${file.name.replace(/\.[^.]+$/, '')} ${ttl}`)
  return {
    sig, course, courseEvidence, courseStrength, type, week: sig.week, typeEvidence,
    semester, semesterFrom, topic, keywords, title: ttl, readContent: !!text, ext: sig.ext, category: sig.category,
    tokens: Array.from(new Set([...sig.tokens, ...keywords]))
  }
}

// ------------------------------------------------------------------ resolving a destination

const parentOf = p => path.dirname(p)

function semesterKeyOfPath(f) {
  for (const seg of f.rel) { const s = isSemesterName(seg) ? parseSemester(seg) : null; if (s) return s.key }
  return null
}

function resolveDestination(a, { catalog, roots, learning = {}, subjects = [] }) {
  const dirs = catalog
  const semDirs = dirs.filter(f => isSemesterName(f.name))
  const conv = semDirs.length > 0
  const root0 = roots[0] || dirs[0]?.root || ''
  const alts = []
  const addAlt = (folder, conf, reason, isNew = false) => { if (folder) alts.push({ folder, confidence: conf, reason, isNewFolder: isNew }) }
  const sem = a.semester || semesterFromTime(a.mtime)
  const semLabel = `${sem.term} ${sem.year}`
  const conventionName = (type, hintDirs = []) => {
    // reuse the student's own subfolder name only within the same course; otherwise the standard
    // style (LectureMaterials, Labs, Activities…), so one course's "Slides" doesn't spread to others
    for (const cd of hintDirs) { const c = dirs.find(x => parentOf(x.path) === cd.path && typeOfName(x.name) === type); if (c) return c.name }
    return TYPE_DEFAULT_NAME[type] || title(type)
  }
  const usesTypeFolders = courseDir => dirs.some(c => parentOf(c.path) === courseDir.path && typeOfName(c.name)) ||
    dirs.some(c => typeOfName(c.name) && subjects.some(s => dirs.some(cd => cd.path === parentOf(c.path) && subjectMatchesFolder(s, cd))))

  if (a.course) {
    const subject = { code: a.course.code, name: a.course.name, keywords: a.course.keywords || [] }
    const courseDirs = dirs.filter(f => !isSemesterName(f.name) && !typeOfName(f.name) && subjectMatchesFolder(subject, f))
    // no folder named after the course: maybe one of the student's folders already holds its files
    let foundByFiles = null
    if (!courseDirs.length) {
      foundByFiles = folderByContents(subject, dirs, a.fileName || '', roots.length ? roots : [root0], a.filePath || '')
      if (foundByFiles) courseDirs.push(foundByFiles.folder)
    }
    const learned = learning.courseFolders?.[(a.course.code || '').toLowerCase()]
    const rank = f => {
      const k = semesterKeyOfPath(f)
      return (k === sem.key ? 10 : k ? 0 : conv ? 1 : 6) + (learned && f.path === learned ? 2 : 0) - f.depth * 0.1
    }
    courseDirs.sort((x, y) => rank(y) - rank(x))
    const inTarget = courseDirs.find(f => { const k = semesterKeyOfPath(f); return k === sem.key || (!conv && !k) })
    const strength = 0.6 + 0.4 * (a.courseStrength ?? 1)
    const strong = Math.min(1, strength)
    const courseLabel = a.course.name || a.course.code
    const typeLabel = a.type ? TYPE_LABEL[a.type] : null
    const describe = [courseLabel, typeLabel, conv ? semLabel : null].filter(Boolean).join(' · ') +
      (foundByFiles ? ` · your “${foundByFiles.folder.name}” folder ${foundByFiles.why}` : '')

    // other existing folders (alternatives)
    const typedChild = (cd, type) => type && dirs.find(c => parentOf(c.path) === cd.path && typeOfName(c.name) === type)
    for (const cd of courseDirs) {
      if (cd === inTarget) continue
      const tc = typedChild(cd, a.type)
      const k = semesterKeyOfPath(cd)
      addAlt(tc ? tc.path : cd.path, 0.5, `${courseLabel} folder${k ? ` from ${title(k.replace('-', ' '))}` : ''}`)
    }

    let primary
    if (inTarget) {
      const tc = typedChild(inTarget, a.type)
      if (tc) primary = { folder: tc.path, isNewFolder: false, confidence: 0.94 * strong + 0.04, reason: `${describe} · folder already exists` }
      else if (!a.type) primary = { folder: inTarget.path, isNewFolder: false, confidence: 0.8 * strong + 0.1, reason: `${describe} · course folder exists` }
      else {
        // every course gets type subfolders (LectureMaterials, Labs, ...), also in a folder that has none yet
        const nm = conventionName(a.type, courseDirs)
        primary = { folder: path.join(inTarget.path, nm), isNewFolder: true, confidence: 0.82 * strong, reason: `${describe} · create “${nm}” in your existing course folder` }
        addAlt(inTarget.path, 0.55, 'course folder')
      }
    } else {
      // course folder (and maybe semester folder) must be created
      const sample = courseDirs.length ? courseDirs[0] : null
      const nameOnly = dirs.filter(f => subjects.some(s => subjectMatchesFolder(s, f)) && semesterKeyOfPath(f)).every(f => !/[A-Za-z]{2,4}[\s_-]?\d{3,4}/.test(f.name)) &&
        dirs.some(f => subjects.some(s => subjectMatchesFolder(s, f)) && semesterKeyOfPath(f))
      // same course in another semester: keep the student's own name for it
      const courseName = sample && conv ? sample.name
        : cleanSegment(nameOnly && a.course.name ? joinedName(a.course.name) : courseFolderName(a.course) || a.course.name || a.course.code)
      const typeName = a.type ? conventionName(a.type, courseDirs) : null
      let base, why
      if (conv) {
        const semDir = semDirs.find(f => parseSemester(f.name)?.key === sem.key)
        if (semDir) { base = semDir.path; why = `create “${courseName}” in ${semDir.name}` }
        else {
          const ex = semDirs[0]
          base = path.join(ex.root === ex.path ? ex.root : parentOf(ex.path), formatSemester(sem, ex.name)); why = `new ${semLabel} folder → “${courseName}”`
        }
      } else { base = (sample && sample.root) || root0; why = `no folder for ${courseLabel} yet — will create “${courseName}”` }
      const folder = typeName ? path.join(base, courseName, typeName) : path.join(base, courseName)
      const conf = (conv ? (semDirs.some(f => parseSemester(f.name)?.key === sem.key) ? 0.72 : 0.62) : (a.course.known ? 0.72 : 0.55)) * (0.8 + 0.2 * strong)
      primary = { folder, isNewFolder: true, confidence: conf, reason: `${describe} · ${why}` }
    }
    return finish(primary, alts)
  }

  // ---- no course: topic / similarity route
  const topicWords = new Set([...(a.keywords || []).map(stem)])
  let best = null
  for (const f of dirs) {
    if (isSemesterName(f.name)) continue
    const sc = scoreFolder(f, { course: null, type: null, week: null, tokens: a.tokens || [], ext: a.ext }, learning)
    let score = sc.score
    const reasons = sc.reasons.slice()
    const leaf = f.leafTokens.map(stem)
    if (a.topic && a.topic.folders.some(w => leaf.some(l => l.startsWith(w)))) { score += 3.2; reasons.unshift(`${a.topic.name.toLowerCase()} folder`) }
    const kwHit = leaf.filter(l => l.length > 3 && topicWords.has(l))
    if (kwHit.length) { score += 2.6 + kwHit.length * 0.4; reasons.unshift(`folder matches “${kwHit[0]}”`) }
    if (a.topic && !a.course) { const sim = jaccardMax(a.tokens || [], f.samples); if (sim > 0.25) score += sim * 2 }
    if (score >= 2.2 && (!best || score > best.score)) { if (best) addAlt(best.f.path, toConfidence(best.score), best.reasons.slice(0, 2).join(' · ')); best = { f, score, reasons } }
    else if (score >= 1.6) addAlt(f.path, toConfidence(score), reasons.slice(0, 2).join(' · ') || 'possible match')
  }
  const what = a.topic ? a.topic.name : a.keywords?.[0] ? title(a.keywords[0]) : null
  const sumReason = [what, a.type ? TYPE_LABEL[a.type] : null].filter(Boolean).join(' · ')
  let primary
  if (best && best.score >= 3) {
    primary = { folder: best.f.path, isNewFolder: false, confidence: Math.max(toConfidence(best.score) * (a.readContent ? 1 : 0.95), best.reasons.some(x => /folder$|matches/.test(x)) ? 0.62 : 0), reason: `${sumReason ? sumReason + ' · ' : ''}${best.reasons.slice(0, 2).join(' · ')}` }
  } else if (a.topic) {
    primary = { folder: path.join(root0, a.topic.folder), isNewFolder: true, confidence: Math.min(0.7, 0.42 + a.topic.score * 0.05), reason: `${a.topic.name} document · no matching folder, will create “${a.topic.folder}”` }
  } else if (a.keywords?.length >= 1 && a.readContent) {
    const nm = cleanSegment(title(a.keywords.slice(0, 2).join(' ')))
    primary = { folder: path.join(root0, nm), isNewFolder: true, confidence: 0.4, reason: `About “${a.keywords.slice(0, 3).join(', ')}” · no matching folder, will create “${nm}”` }
  } else {
    primary = { folder: path.join(root0, 'To Review', a.category === 'Other' ? 'Misc' : a.category), isNewFolder: true, confidence: 0.15, reason: 'Could not tell what this is — please choose a folder' }
  }
  return finish(primary, alts)

  function finish(primary, alternatives) {
    const seen = new Set([primary.folder])
    const out = []
    for (const x of alternatives.sort((p, q) => (q.confidence ?? 0) - (p.confidence ?? 0))) { if (seen.has(x.folder)) continue; seen.add(x.folder); out.push(x); if (out.length >= 5) break }
    primary.confidence = Math.max(0.05, Math.min(0.97, primary.confidence))
    return { primary, alternatives: out }
  }
}

// ------------------------------------------------------------------ one-call API

function describeAnalysis(a, fileName) {
  const parts = []
  if (a.course) parts.push(a.course.name || a.course.code)
  else if (a.topic) parts.push(a.topic.name)
  else if (a.keywords?.length) parts.push(title(a.keywords.slice(0, 2).join(' ')))
  if (a.type) parts.push(TYPE_LABEL[a.type])
  const core = parts.join(' ')
  return core ? title(core.charAt(0)) + core.slice(1) : fileName
}

/** Understand + resolve in one step (used for downloads and folder sorting). */
function plan({ file, content, subjects, catalog, roots, learning, sourceUrl, courseHint = null }) {
  const a = understand({ file, content, subjects, sourceUrl, courseHint })
  a.mtime = file.mtime
  a.fileName = file.name
  a.filePath = file.path || ''
  const r = resolveDestination(a, { catalog, roots, learning, subjects })
  return { analysis: a, ...r }
}

/** Plain, serialisable view of an analysis for the UI. */
function publicAnalysis(a, fileName, extra = {}) {
  return {
    summary: extra.summary || a.aiSummary || describeAnalysis(a, fileName),
    title: a.title || '',
    course: a.course ? { code: a.course.code, name: a.course.name, known: !!a.course.known } : null,
    courseEvidence: a.courseEvidence || null,
    type: a.type || null,
    semester: a.semester ? `${a.semester.term} ${a.semester.year}` : null,
    topic: a.topic ? a.topic.name : (extra.topic || null),
    keywords: (a.keywords || []).slice(0, 5),
    readContent: !!a.readContent,
    source: extra.source || (a.aiSummary ? 'ai' : 'local')
  }
}

/** Fold Gemini's understanding into a local analysis (the folder is still resolved locally). */
function applyAi(a, ai, { subjects = [] } = {}) {
  const out = { ...a }
  const conf = Math.max(0, Math.min(1, Number(ai?.confidence) || 0.6))
  if (ai?.course && (ai.course.code || ai.course.name)) {
    const label = `${ai.course.code || ''} ${ai.course.name || ''}`
    const hit = detectSubject(label, subjects, { content: false })
    const code = String(ai.course.code || '').replace(/\s+/g, '').toUpperCase()
    out.course = hit ? { code: hit.subject.code, name: hit.subject.name, keywords: hit.subject.keywords || [], known: true }
      : { code, name: cleanSegment(ai.course.name || ''), known: false }
    out.courseEvidence = 'AI reading'
    out.courseStrength = Math.max(0.5, Math.min(1, conf + (hit ? 0.1 : 0)))
  }
  if (ai?.docType && TYPE_LABEL[ai.docType]) { out.type = ai.docType; out.typeEvidence = 'AI reading' }
  if (ai?.semester?.term && ai.semester.year) {
    const t = normTerm(String(ai.semester.term)); const y = fullYear(ai.semester.year)
    if (['fall', 'spring', 'summer', 'winter'].includes(t) && y > 1999 && y < 2101) { out.semester = { term: title(t), year: y, key: `${t}-${y}` }; out.semesterFrom = 'AI reading' }
  }
  if (!out.course && ai?.topic) {
    const nm = String(ai.topic).trim()
    const known = TOPICS.find(t => t.name.toLowerCase() === nm.toLowerCase() || t.folder.toLowerCase() === nm.toLowerCase())
    out.topic = known ? { ...known, score: 4 } : { name: cleanSegment(title(nm)), folder: cleanSegment(title(nm)), words: [], folders: [nm.toLowerCase()], score: 4 }
  }
  out.aiSummary = ai?.summary ? String(ai.summary).slice(0, 80) : ''
  out.readContent = out.readContent || !!ai
  return out
}

module.exports = {
  applyAi, understand, resolveDestination, plan, publicAnalysis, isSelfDescriptive, subjectsFromCatalog, detectDocType, detectTopic, detectSubject,
  subjectMatchesFolder, folderByContents, sameFileName,
  parseSemester, semesterFromTime, formatSemester, isSemesterName, typeOfName, cleanSegment, TYPE_LABEL, TYPE_DEFAULT_NAME
}
