'use strict'
/**
 * Application core: wires the indexer, watcher, suggestion engine, mover and (optional) Gemini
 * together. It has no Electron dependency, so it can be unit-tested; Electron-specific behaviour
 * (popup, native notifications) is injected through `hooks`.
 */
const fs = require('fs')
const path = require('path')
const { Indexer } = require('./indexer')
const { planQuery, mergeAiPlan } = require('./queryPlanner')
const { searchFiles } = require('./search')
const { suggest, buildCatalog, courseFolderName, extractSignals, parseSource } = require('./classifier')
const { DownloadWatcher, readDownloadSource } = require('./watcher')
const { executeMove, undoMove, assertSafeDestination } = require('./mover')
const { planOrganize } = require('./organizer')
const gemini = require('./gemini')
const smart = require('./smartSort')
const { readExcerpt, IMAGE_EXT } = require('./contentReader')
const demo = require('./demo')
const { createOllama } = require('./ollama')
const { createStudy } = require('./study')
const { readSections } = require('./contentReader')
const aduCatalog = require('./aduCatalog')
const { uid, extOf, isInside, isTempName, SKIP_DIR_NAMES, tokenizeWithCodes } = require('./common')

function createCore({ store, hooks = {}, documentsDir }) {
  const noop = () => {}
  const h = { onSuggestions: noop, onNewSuggestion: noop, onAutoMoved: noop, onFlow: noop, onIndex: noop, onTask: noop, onStudyStream: noop, onActivity: noop, onWatchError: noop, ...hooks }

  const settings = () => store.getSettings()
  const codeKey = c => String(c || '').toLowerCase().replace(/[\s_-]/g, '')
  /** The student's own courses first, then the bundled university catalog (unless turned off). */
  const allCourses = () => {
    const s = settings()
    if (s.university !== 'adu') return s.courses
    const own = new Set(s.courses.map(c => codeKey(c.code)).filter(Boolean))
    return [...s.courses, ...aduCatalog.subjectsFor(s.major).filter(c => !own.has(codeKey(c.code)))]
  }
  /** Courses that may be recognised by name (search, organize): own courses + the student's major. */
  const nameableCourses = () => allCourses().filter(c => !c.codeOnly)
  const indexer = new Indexer({ getRoots: () => settings().searchRoots, getExcluded: () => settings().excludedFolders })
  const task = (kind, step, pct, detail) => h.onTask({ kind, step, pct, detail })
  indexer.onProgress = s => { h.onIndex(s); if (s.state === 'indexing') task('index', 'scan', null, `${(s.count || 0).toLocaleString()} files`) }
  const watcher = new DownloadWatcher()
  const suggestions = new Map() // id -> suggestion
  let catalogCache = { at: 0, folders: [] }
  const invalidateCatalog = () => { catalogCache.at = 0 }

  async function getCatalog() {
    if (Date.now() - catalogCache.at < 45000) return catalogCache.folders
    const s = settings()
    const roots = [...s.destinationRoots].filter(r => { try { return fs.statSync(r).isDirectory() } catch { return false } })
    const folders = await buildCatalog(roots, s.excludedFolders)
    catalogCache = { at: Date.now(), folders }
    return folders
  }

  const listSuggestions = () => Array.from(suggestions.values()).filter(s => s.status === 'pending').sort((a, b) => b.ts - a.ts)
  const emitSuggestions = () => h.onSuggestions(listSuggestions())

  // ------------------------------------------------------------- downloads

  // ------------------------------------------------------------- understanding files

  async function context({ fresh = false, roots } = {}) {
    const s = settings()
    let catalog
    if (roots && roots.length) catalog = await buildCatalog(roots.filter(r => { try { return fs.statSync(r).isDirectory() } catch { return false } }), s.excludedFolders)
    else { if (fresh) catalogCache.at = 0; catalog = await getCatalog() }
    const rootList = (roots && roots.length ? roots : s.destinationRoots).map(r => path.resolve(r))
    return { catalog, subjects: smart.subjectsFromCatalog(catalog, allCourses()), roots: rootList, learning: store.getLearning() }
  }

  const needsReading = (file, ctx, sourceUrl) => {
    const sig = extractSignals(file.name, { sourceUrl, courses: ctx.subjects })
    return !smart.isSelfDescriptive(file.name, sig) || !sig.course || (!sig.course.known && /^(scan|img|image|dsc|doc|file|photo|page|inv|bill|ref)\d/i.test(sig.course.code))
  }

  /** Local, offline understanding + destination. Always available. */
  function localPlan(file, content, ctx, sourceUrl, courseHint = null) {
    return smart.plan({ file, content, subjects: ctx.subjects, catalog: ctx.catalog, roots: ctx.roots, learning: ctx.learning, sourceUrl, courseHint })
  }

  // ------------------------------------------------------------- Blackboard course hints (browser extension)

  const hints = []          // { key, course, courseId, ts } — "this file name came from this course"
  let extensionSeenAt = 0
  const HINT_TTL = 30 * 60 * 1000
  const fileKey = n => String(n || '').toLowerCase().replace(/ \(\d+\)(?=\.[^.]+$)/, '')
  const bbCourseIdOf = url => { const m = String(url || '').match(/\/courses\/(_\d+_\d+)/) || String(url || '').match(/[?&]course_id=(_\d+_\d+)/); return m ? m[1] : null }
  const cleanTitle = t => smart.cleanSegment(String(t || '')
    .replace(/\((fall|spring|summer|winter)[^)]*\)/ig, '').replace(/\b(fall|spring|summer|winter)\s*(20)?\d{2}\b/ig, '')
    .replace(/[([]?\b[A-Za-z]{3,4}[\s_-]?\d{3}[A-Za-z]?\b[)\]]?/g, '').replace(/\b(section|sec|crn)\s*\w+/ig, '')
    .replace(/^[\s\-–:|]+|[\s\-–:|]+$/g, ''))

  /** Turn what Blackboard calls a course into the official course (code + name) and remember it. */
  function resolveBlackboardCourse({ courseId, courseTitle, courseCode }) {
    const mem = courseId ? store.getLearning().bbCourses[courseId] : null
    if (!courseTitle && !courseCode) return mem || null
    const subjects = allCourses()
    const text = `${courseCode || ''} ${courseTitle || ''}`
    const m = text.match(/(?<![A-Za-z])([A-Za-z]{3,4})[\s_-]?(\d{3}[A-Za-z]?)(?![\dA-Za-z])/)
    let hit = m ? subjects.find(s => codeKey(s.code) === codeKey(m[1] + m[2])) : null
    if (!hit && courseTitle) hit = smart.detectSubject(courseTitle, subjects.map(s => ({ ...s, codeOnly: false })))?.subject
    const name = cleanTitle(courseTitle)
    const course = hit ? { code: hit.code, name: hit.name } : { code: m ? `${m[1].toUpperCase()} ${m[2].toUpperCase()}` : '', name }
    if (!course.code && !course.name) return mem || null
    // With no course code and no known course, the "title" is often the page's heading (an assignment
    // like "Term Project - Report Submission"), not the course: never let it replace a known course,
    // and don't treat it as the course at all; the file itself decides instead.
    if (!hit && !course.code) return mem?.code ? mem : null
    if (mem?.code && !course.code) return mem
    if (courseId && (!mem || mem.code !== course.code || mem.name !== course.name)) store.learnBlackboardCourse(courseId, course)
    return course
  }

  // What the extension sends, kept in a small local log (extension.log) to check "why wasn't the
  // course used?". Only file names and course titles; nothing leaves the computer.
  function logBridge(kind, h, course) {
    try {
      const file = path.join(store.dir || '', 'extension.log')
      if (!store.dir) return
      try { if (fs.statSync(file).size > 256 * 1024) fs.renameSync(file, file + '.old') } catch { /* no log yet */ }
      fs.appendFileSync(file, JSON.stringify({ t: new Date().toISOString(), kind, file: h.fileName || undefined, state: h.state || undefined, courseId: h.courseId, title: h.courseTitle, code: h.courseCode, course: course ? `${course.code} ${course.name}`.trim() : null }) + '\n')
    } catch { /* logging must never break filing */ }
  }

  // The Blackboard course the student has open (from the extension), as a fallback when a download's
  // own message from the extension doesn't arrive.
  let lastViewed = null
  const VIEWED_TTL = 3 * 60 * 60 * 1000
  const noteViewed = course => { if (course?.code) lastViewed = { course, ts: Date.now() } }

  function addCourseHint(h) {
    extensionSeenAt = Date.now()
    const course = resolveBlackboardCourse(h)
    noteViewed(course)
    logBridge('course', h, course)
    return course
  }

  function addDownloadHint(h) {
    extensionSeenAt = Date.now()
    const course = resolveBlackboardCourse(h)
    noteViewed(course)
    logBridge('download', h, course)
    const name = h.fileName || path.basename(h.path || '')
    if (!name || !course) return course
    hints.push({ key: fileKey(name), course, courseId: h.courseId, ts: Date.now() })
    while (hints.length > 200 || (hints[0] && Date.now() - hints[0].ts > HINT_TTL)) hints.shift()
    return course
  }

  const findHint = name => { const k = fileKey(name); for (let i = hints.length - 1; i >= 0; i--) if (hints[i].key === k && Date.now() - hints[i].ts < HINT_TTL) return hints[i]; return null }

  /** The extension usually reports a download before it finishes; if it is running, give it a moment. */
  async function waitForHint(name, ms) {
    const t0 = Date.now()
    let h = findHint(name)
    while (!h && Date.now() - t0 < ms) { await new Promise(r => setTimeout(r, 150)); h = findHint(name) }
    return h
  }
  const extensionActive = () => Date.now() - extensionSeenAt < 15 * 60 * 1000

  const folderListForAi = ctx => {
    const map = new Map()
    for (const f of ctx.catalog) { const rel = f.rel.join('/'); if (!map.has(rel)) map.set(rel, f.path) }
    return map
  }

  /** Optional Gemini step: improves the understanding, then the folder is re-resolved locally. */
  async function aiPlan(file, content, ctx, local, sourceUrl) {
    const s = settings()
    if (!s.geminiApiKey) return null
    const allowText = s.aiReadContent !== false
    let image = null
    if (allowText && IMAGE_EXT.has(extOf(file.name)) && (file.size || 0) < 4_000_000) {
      try {
        const mime = { jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', webp: 'image/webp', gif: 'image/gif', bmp: 'image/bmp', heic: 'image/heic' }[extOf(file.name)]
        if (mime) image = { mime, data: (await fs.promises.readFile(file.path)).toString('base64') }
      } catch { /* ignore */ }
    }
    const folders = folderListForAi(ctx)
    const a = local.analysis
    let ai
    try {
      ai = await gemini.analyzeFileAI({
        apiKey: s.geminiApiKey, model: s.geminiModel, fileName: file.name, mtime: file.mtime,
        excerpt: allowText && content?.ok ? content.text.slice(0, 1500) : '', courses: ctx.subjects.slice(0, 40),
        folders: Array.from(folders.keys()).slice(0, 150),
        local: { course: a.course?.name || a.course?.code || null, type: a.type, semester: a.semester ? `${a.semester.term} ${a.semester.year}` : null, topic: a.topic?.name || null },
        image
      })
    } catch { return null }
    if (!ai || typeof ai !== 'object') return null
    const a2 = smart.applyAi(a, ai, { subjects: ctx.subjects })
    a2.mtime = file.mtime
    const r = smart.resolveDestination(a2, { catalog: ctx.catalog, roots: ctx.roots, learning: ctx.learning, subjects: ctx.subjects })
    const folder = typeof ai.existingFolder === 'string' ? folders.get(ai.existingFolder) : null
    if (folder && !a2.course && r.primary.confidence < 0.8) {
      try { assertSafeDestination(folder) } catch { return { analysis: a2, ...r } }
      r.alternatives.unshift({ folder: r.primary.folder, confidence: r.primary.confidence, reason: r.primary.reason, isNewFolder: r.primary.isNewFolder })
      r.primary = { folder, isNewFolder: false, confidence: Math.max(0.6, Math.min(0.92, (Number(ai.confidence) || 0.6) * 0.95)), reason: `${ai.summary || 'AI reading'} · matches your “${path.basename(folder)}” folder` }
    }
    r.primary.reason = r.primary.reason.replace(/ · folder already exists$/, '')
    return { analysis: a2, ...r }
  }

  function mergeAlternatives(primary, lists) {
    const seen = new Set([primary.folder])
    const out = []
    for (const l of lists) for (const x of l || []) { if (seen.has(x.folder) || out.length >= 6) continue; seen.add(x.folder); out.push({ folder: x.folder, confidence: x.confidence ?? null, reason: x.reason, isNewFolder: !!x.isNewFolder }) }
    return out
  }

  // ------------------------------------------------------------- downloads

  // ------------------------------------------------------------- download flow (live steps)

  /**
   * A flow is the step-by-step record of what KoolMate did with one download. Each step is
   * reported only after it has really happened (file read, folder created, file moved), so the
   * pop-up shows actual progress, not an animation.
   */
  function createFlow(info) {
    const flow = { id: uid(), ts: Date.now(), status: 'running', file: { name: info.name, path: info.path, size: info.size, ext: extOf(info.name) }, steps: [] }
    const emit = () => h.onFlow(JSON.parse(JSON.stringify(flow)))
    const step = (key, label, status, detail = '') => {
      const st = { key, label, status, detail }
      const i = flow.steps.findIndex(x => x.key === key)
      if (i >= 0) flow.steps[i] = st; else flow.steps.push(st)
      emit()
    }
    const finish = (status, extra = {}) => { Object.assign(flow, { status }, extra); emit() }
    return { flow, step, finish }
  }
  const flows = new Map() // suggestion id -> flow controller

  const courseLabel = c => [c.code, c.name].filter(Boolean).join(' ')
  const READABLE = new Set(['pdf', 'doc', 'docx', 'ppt', 'pptx', 'odt', 'odp', 'rtf', 'txt', 'md', 'xlsx', 'ods', 'csv', 'png', 'jpg', 'jpeg', 'bmp', 'tif', 'tiff'])
  const TYPE_WORD = { Lectures: 'Lecture material', Assignments: 'Assignment', Activities: 'Activity', Labs: 'Lab', Exams: 'Exam', Syllabus: 'Syllabus', Projects: 'Project', Notes: 'Notes', Readings: 'Reading' }

  /** Create the course folder and its subfolder (if missing), reporting each, then move the file. */
  /**
   * A course folder the student made themselves ("HumanComputerInteraction") gets the official
   * name ("ITE 409 Human Computer Interaction") so every course looks the same. Only for ADU
   * catalog courses, only when the folder name has no course code yet, never for the root,
   * a semester or a type folder, and never over an existing folder. Recorded so it can be undone.
   */
  /**
   * The same file already sits in one of the student's course folders (downloaded before, filed by
   * hand): that folder's course is this file's course. Only when the folder points at exactly one course.
   */
  async function courseOfSameFile(info) {
    try {
      const catalog = await getCatalog()
      const roots = settings().destinationRoots.map(r => path.resolve(r))
      const here = path.resolve(path.dirname(info.path))
      const isCourseLevel = f => roots.includes(path.dirname(f.path)) || smart.isSemesterName(path.basename(path.dirname(f.path)))
      const byPath = new Map(catalog.map(f => [f.path, f]))
      const subjects = allCourses().map(s => ({ ...s, codeOnly: false }))
      for (const f of catalog) {
        if (f.path === here || !(f.files || []).some(n => smart.sameFileName(n, info.name))) continue
        let cd = f
        while (cd && !isCourseLevel(cd)) cd = byPath.get(path.dirname(cd.path))
        if (!cd || smart.isSemesterName(cd.name) || smart.typeOfName(cd.name)) continue
        const code = cd.name.match(/(?<![A-Za-z])([A-Za-z]{3,4})[\s_-]?(\d{3}[A-Za-z]?)(?![\dA-Za-z])/)
        let hits = code ? subjects.filter(s => codeKey(s.code) === codeKey(code[1] + code[2])) : subjects.filter(s => smart.subjectMatchesFolder(s, cd))
        hits = hits.filter((s, i) => hits.findIndex(x => codeKey(x.code) === codeKey(s.code)) === i)
        if (hits.length === 1) return { code: hits[0].code, name: hits[0].name, evidence: `your “${cd.name}” folder already has this file` }
      }
    } catch { /* fall back to reading the file */ }
    return null
  }

  async function holdsOtherCourses(dir, code, depth = 0) {
    let entries
    try { entries = await fs.promises.readdir(dir, { withFileTypes: true }) } catch { return false }
    for (const e of entries.slice(0, 400)) {
      const m = e.name.match(/(?<![A-Za-z])([A-Za-z]{3,4})[\s_-]?(\d{3})(?!\d)/)
      if (m && codeKey(m[1] + m[2]) !== codeKey(code) && aduCatalog.courseTitle(`${m[1].toUpperCase()} ${m[2]}`)) return true
      if (e.isDirectory() && depth < 2 && await holdsOtherCourses(path.join(dir, e.name), code, depth + 1)) return true
    }
    return false
  }

  async function renameToOfficial(courseDir, course, root) {
    if (!course?.code || !course.name || settings().renameCourseFolders === false || settings().university !== 'adu') return null
    if (aduCatalog.courseTitle(course.code) !== course.name) return null
    const name = path.basename(courseDir)
    const official = smart.cleanSegment(courseFolderName(course))
    if (!root || path.resolve(courseDir) === path.resolve(root) || name === official) return null
    // "ITE442", "ITE 442 Big Data", "CSC301-Data Structure" are the same course in the student's own style:
    // rename them too. A folder carrying a *different* course code is never touched.
    const codeInName = name.match(/(?<![A-Za-z])([A-Za-z]{2,4})[\s_-]?(\d{3}[A-Za-z]?)(?![\dA-Za-z])/)
    if (codeInName && codeKey(codeInName[1] + codeInName[2]) !== codeKey(course.code)) return null
    if (smart.isSemesterName(name) || smart.typeOfName(name)) return null
    // a folder picked because of the files inside it ("Uni stuff") may hold other courses too:
    // rename it only when nothing in it belongs to another course
    if (!smart.subjectMatchesFolder(course, { leafTokens: tokenizeWithCodes(name) }) && await holdsOtherCourses(courseDir, course.code)) return null
    const target = path.join(path.dirname(courseDir), official)
    if (!fs.existsSync(courseDir) || fs.existsSync(target)) return null
    await fs.promises.rename(courseDir, target)
    const entry = {
      id: uid(), ts: Date.now(), type: 'rename', status: 'done', from: courseDir, to: target,
      fileName: name, folder: path.dirname(courseDir), source: 'auto', course: course.code,
      reason: `Renamed your “${name}” folder to the official course name`
    }
    store.addActivity(entry)
    invalidateCatalog()
    h.onActivity(store.listActivity())
    return target
  }

  async function fileWithSteps(from, folder, meta, step, roots, course = null) {
    assertSafeDestination(folder)
    const hasSub = !!smart.typeOfName(path.basename(folder))
    let courseDir = hasSub ? path.dirname(folder) : folder
    const root = roots.find(r => isInside(folder, r))
    const rel = p => (root ? path.relative(root, p) : path.basename(p)) || path.basename(p)
    const ensure = async (dir, key, label) => {
      const existed = fs.existsSync(dir)
      if (!existed) { step(key, label, 'active', `Creating “${path.basename(dir)}”`); await fs.promises.mkdir(dir, { recursive: true }) }
      step(key, label, 'done', existed ? `Found “${rel(dir)}”` : `Created “${rel(dir)}”`)
    }
    const oldName = path.basename(courseDir)
    const renamed = await renameToOfficial(courseDir, course, root)
    if (renamed) {
      courseDir = renamed
      folder = hasSub ? path.join(renamed, path.basename(folder)) : renamed
      step('courseFolder', 'Course folder', 'done', `Renamed “${oldName}” → “${path.basename(renamed)}”`)
    } else await ensure(courseDir, 'courseFolder', 'Course folder')
    if (hasSub) await ensure(folder, 'subFolder', 'Subfolder')
    step('move', 'Moving the file', 'active', path.basename(from))
    const entry = await moveWithJournal(from, folder, meta)
    step('move', 'File moved', 'done', `${entry.fileName} → ${rel(folder)}`)
    return entry
  }

  async function handleNewFile(info) {
    const s = settings()
    if (!fs.existsSync(info.path)) return null
    const sourceUrl = info.sourceUrl ?? await readDownloadSource(info.path)
    const { flow, step, finish } = createFlow(info)
    const hint = info.courseHint ? { course: info.courseHint } : await waitForHint(info.name, extensionActive() ? 3000 : 0)
    const remembered = !hint && bbCourseIdOf(sourceUrl) ? store.getLearning().bbCourses[bbCourseIdOf(sourceUrl)] : null
    // downloaded from Blackboard but the extension's message for this file is missing: use the course
    // the student had open, unless the file name names another course
    const fromBlackboard = /^https?:\/\/([^/]+\.)?(blackboard\.com|blackboard\.adu\.ac\.ae)(\/|$)/i.test(sourceUrl || '')
    const nameCode = info.name.match(/(?<![A-Za-z])([A-Za-z]{3,4})[\s_-]?(\d{3})(?!\d)/)
    const viewed = !hint && !remembered && fromBlackboard && lastViewed && Date.now() - lastViewed.ts < VIEWED_TTL &&
      (!nameCode || codeKey(nameCode[1] + nameCode[2]) === codeKey(lastViewed.course.code)) ? lastViewed.course : null
    let courseHint = hint ? { ...hint.course, evidence: 'Blackboard course page' } : remembered ? { ...remembered, evidence: 'this Blackboard course (remembered)' }
      : viewed ? { ...viewed, evidence: 'the Blackboard course you had open' } : null
    if (!courseHint) courseHint = await courseOfSameFile(info) // re-downloading a file you already filed
    const from = hint ? 'Blackboard' : parseSource(sourceUrl, info.name).label
    step('detect', 'Download finished', 'done', from ? `${info.name} · from ${from}` : info.name)
    task('simulate', 'analyze', 75, info.name)
    const file = { path: info.path, name: info.name, size: info.size, mtime: info.mtime || Date.now() }
    let ctx = null; let content = null; let local = null
    const classic = await (async () => {
      const catalog = await getCatalog()
      return suggest({ fileName: info.name, sourceUrl, courses: allCourses(), catalog, learning: store.getLearning(), destinationRoots: s.destinationRoots })
    })()
    try {
      ctx = await context()
      // Documents are always opened: the name alone can be wrong ("Lecture 5" that is really an activity).
      if (needsReading(file, ctx, sourceUrl) || READABLE.has(extOf(file.name))) {
        step('read', 'Reading the file', 'active', 'Looking inside for the course and type')
        content = await readExcerpt(file.path)
        step('read', 'Read the file', 'done', content?.ok ? (content.ocr ? 'Read the text in its pictures (Windows OCR)' : 'Checked what the file is about') : 'Could not read inside; using the name')
      } else step('read', 'Checked the file name', 'done', 'This kind of file cannot be read inside')
      local = localPlan(file, content, ctx, sourceUrl, courseHint)
    } catch (e) { console.error('Smart analysis failed, using basic suggestion:', e) } // a notification must always be shown
    const a = local?.analysis
    if (a?.course) step('course', 'Course identified', 'done', `${courseLabel(a.course)}${a.courseEvidence ? ` · from ${a.courseEvidence}` : ''}`)
    else step('course', 'Course not identified', 'failed', 'No course code or name found')
    if (a?.type) step('type', 'Material type', 'done', `${TYPE_WORD[a.type] || a.type}${a.typeEvidence ? ` · from ${a.typeEvidence}` : ''}`)
    else step('type', 'Material type unclear', 'failed', 'Not sure if it is a lecture, lab or assignment')
    const primary = local ? local.primary : classic.primary
    const sug = {
      id: uid(), ts: Date.now(), status: 'pending',
      file: { path: info.path, name: info.name, size: info.size, ext: extOf(info.name) },
      sourceUrl, aiAssisted: false,
      signals: { ...classic.signals, semester: local?.analysis.semester ? `${local.analysis.semester.term} ${local.analysis.semester.year}` : null },
      analysis: local ? smart.publicAnalysis(local.analysis, info.name) : { readContent: false },
      primary, alternatives: local ? mergeAlternatives(primary, [local.alternatives, classic.alternatives]) : classic.alternatives,
      needsReview: primary.confidence < 0.55,
      candidatePaths: classic.candidatePaths
    }
    if (local) {
      sug.signals.course = local.analysis.course ? { code: local.analysis.course.code, name: local.analysis.course.name, known: !!local.analysis.course.known } : null
      sug.signals.type = local.analysis.type || sug.signals.type
    }
    indexer.noteAdded({ path: info.path, name: info.name, dir: path.dirname(info.path), ext: sug.file.ext, size: info.size, mtime: info.mtime || Date.now() })

    // A recognised course + material type is filed straight away (creating folders if needed);
    // anything less certain waits for the student.
    const roots = ctx?.roots || s.destinationRoots.map(r => path.resolve(r))
    const courseKnown = !!(a?.course && a.course.known && !a.course.inferred && (a.courseStrength ?? 1) >= 0.5)
    const autoFile = s.autoFileCourses !== false && courseKnown && !!a.type && s_isUnderRoots(sug.primary.folder, roots)
    const autoMove = s.autoMove && !sug.needsReview && sug.primary.confidence >= s.autoMoveThreshold
    if (autoFile || autoMove) {
      try {
        const entry = await fileWithSteps(info.path, sug.primary.folder, { source: 'auto', course: sug.signals.course?.code || null, reason: sug.primary.reason, confidence: sug.primary.confidence }, step, roots, a?.course)
        sug.status = 'moved'; sug.result = entry
        suggestions.set(sug.id, sug)
        store.learn({ course: sug.signals.course?.code, ext: sug.file.ext, folder: entry.folder })
        const tidy = await planTidy(entry, a?.course, step).catch(() => null)
        finish('done', { entry, tidy })
        h.onAutoMoved(entry, sug)
        return sug
      } catch (e) { step('move', 'Could not move the file', 'failed', e.message) } // fall through to a manual suggestion
    }

    sug.flowId = flow.id
    flows.set(sug.id, { step, finish })
    step('decide', 'Waiting for you', 'active', sug.needsReview ? 'Please choose where it goes' : 'Confirm the suggested folder')
    finish('waiting', { suggestionId: sug.id })
    suggestions.set(sug.id, sug)
    h.onNewSuggestion(sug)
    emitSuggestions()
    if (s.geminiApiKey && local) refineWithAi(sug, file, content, ctx, local, sourceUrl).catch(() => {})
    return sug
  }

  async function refineWithAi(sug, file, content, ctx, local, sourceUrl) {
    const r = await aiPlan(file, content, ctx, local, sourceUrl)
    if (!r || sug.status !== 'pending') return
    try { assertSafeDestination(r.primary.folder) } catch { return }
    if (!s_isUnderRoots(r.primary.folder, ctx.roots)) return // never trust a path outside the user's chosen roots
    sug.alternatives = mergeAlternatives(r.primary, [[{ folder: sug.primary.folder, confidence: sug.primary.confidence, reason: sug.primary.reason, isNewFolder: sug.primary.isNewFolder }], r.alternatives, sug.alternatives])
    sug.primary = r.primary
    sug.analysis = smart.publicAnalysis(r.analysis, file.name, { source: 'ai' })
    if (r.analysis.course) sug.signals.course = { code: r.analysis.course.code, name: r.analysis.course.name, known: !!r.analysis.course.known }
    if (r.analysis.type) sug.signals.type = r.analysis.type
    sug.signals.semester = r.analysis.semester ? `${r.analysis.semester.term} ${r.analysis.semester.year}` : sug.signals.semester
    sug.aiAssisted = true
    sug.needsReview = sug.primary.confidence < 0.55
    emitSuggestions()
  }
  const s_isUnderRoots = (folder, roots) => roots.some(r => isInside(folder, r))

  async function moveWithJournal(from, folder, meta) {
    const entry = await executeMove(from, folder, meta)
    store.addActivity(entry)
    indexer.noteMoved(from, entry.to)
    invalidateCatalog()
    h.onActivity(store.listActivity())
    return entry
  }

  // ------------------------------------------------------------- tidy a course folder (asks first)

  const tidyOffers = new Map() // offer id -> { courseDir, course, items }
  const TIDY_MAX = 150

  /**
   * After a file is filed into a course folder, look at the loose files the student already had at the
   * top of that folder ("AI\Week 1.pptx") and work out which subfolder each belongs in, the same way a
   * download is judged (name + content). Nothing moves here: it becomes a question in the pop-up.
   * Asked once per course; files already in subfolders, and files whose type is unclear, are left alone.
   */
  async function planTidy(entry, course, step = null) {
    if (!entry || !course?.code || settings().tidyCourseFolders === false) return null
    const key = codeKey(course.code)
    if (store.tidyAsked(key)) return null
    const courseDir = smart.typeOfName(path.basename(entry.folder)) ? path.dirname(entry.folder) : entry.folder
    let entries
    try { entries = await fs.promises.readdir(courseDir, { withFileTypes: true }) } catch { return null }
    const loose = entries.filter(e => e.isFile() && !e.name.startsWith('.') && !isTempName(e.name) && !/^desktop\.ini$/i.test(e.name)).slice(0, TIDY_MAX)
    if (!loose.length) return null
    if (step) step('tidy', 'Other files in the folder', 'active', `Looking at ${loose.length} file${loose.length > 1 ? 's' : ''} already in “${path.basename(courseDir)}”`)
    const typeDirs = entries.filter(e => e.isDirectory()).map(e => e.name)
    const items = []; const unclear = []
    for (const [i, e] of loose.entries()) {
      const p = path.join(courseDir, e.name)
      let st; try { st = await fs.promises.stat(p) } catch { continue }
      const content = i < 60 && READABLE.has(extOf(e.name)) ? await readExcerpt(p, { ocr: false }).catch(() => null) : null
      const a = smart.understand({ file: { name: e.name, size: st.size, mtime: st.mtimeMs }, content, subjects: [], courseHint: course })
      if (!a.type) { unclear.push(e.name); continue }
      const folderName = typeDirs.find(n => smart.typeOfName(n) === a.type) || smart.TYPE_DEFAULT_NAME[a.type] || a.type
      items.push({ from: p, name: e.name, type: a.type, folder: folderName })
    }
    if (!items.length) {
      if (step) step('tidy', 'Other files in the folder', 'done', `${unclear.length} file${unclear.length > 1 ? 's' : ''} left as they are (type unclear)`)
      return null
    }
    const counts = {}
    for (const it of items) counts[it.folder] = (counts[it.folder] || 0) + 1
    const offer = { id: uid(), courseDir, course, items, unclear }
    tidyOffers.set(offer.id, offer)
    if (step) step('tidy', 'Other files in the folder', 'done', `${items.length} can be sorted into subfolders`)
    return { id: offer.id, folder: path.basename(courseDir), path: courseDir, count: items.length, counts, unclear: unclear.length,
      items: items.map(it => ({ name: it.name, folder: it.folder })) }
  }

  async function applyTidy(id) {
    const offer = tidyOffers.get(id)
    if (!offer) throw new Error('This offer is no longer available.')
    tidyOffers.delete(id)
    store.markTidyAsked(codeKey(offer.course.code), 'sorted')
    const batchId = uid()
    let moved = 0; const failed = []
    for (const it of offer.items) {
      try {
        if (!fs.existsSync(it.from)) continue
        const target = path.join(offer.courseDir, it.folder)
        assertSafeDestination(target)
        await fs.promises.mkdir(target, { recursive: true })
        await moveWithJournal(it.from, target, { source: 'tidy', batchId, course: offer.course.code, reason: `Sorted inside “${path.basename(offer.courseDir)}”: ${(TYPE_WORD[it.type] || it.type).toLowerCase()}` })
        moved++
      } catch (e) { failed.push({ fileName: it.name, error: e.message }) }
    }
    return { batchId, moved, failed }
  }

  function dismissTidy(id) {
    const offer = tidyOffers.get(id)
    if (offer) store.markTidyAsked(codeKey(offer.course.code), 'declined')
    tidyOffers.delete(id)
  }

  async function acceptSuggestion(id, folder) {
    const sug = suggestions.get(id)
    if (!sug || sug.status !== 'pending') throw new Error('This suggestion is no longer available.')
    const target = folder || sug.primary.folder
    task('accept', 'move', 30, sug.file.name)
    const chosenDifferent = path.resolve(target) !== path.resolve(sug.primary.folder)
    const entry = await moveWithJournal(sug.file.path, target, {
      source: chosenDifferent ? 'download-manual' : 'download', course: sug.signals.course?.code || null,
      reason: chosenDifferent ? 'Destination chosen by you' : sug.primary.reason, confidence: chosenDifferent ? null : sug.primary.confidence
    })
    task('accept', 'save', 80, null)
    sug.status = 'moved'; sug.result = entry
    const fc = flows.get(id)
    if (fc) {
      fc.step('decide', chosenDifferent ? 'You chose a folder' : 'You confirmed', 'done', path.basename(target))
      fc.step('move', 'File moved', 'done', `${entry.fileName} → ${path.basename(target)}`)
      const tidy = !chosenDifferent ? await planTidy(entry, sug.signals.course, fc.step).catch(() => null) : null
      fc.finish('done', { entry, tidy }); flows.delete(id)
    }
    store.learn({ course: sug.signals.course?.code, ext: sug.file.ext, folder: path.dirname(entry.to) })
    // confirming a file from a Blackboard course teaches KoolMate which course that is
    const bbId = bbCourseIdOf(sug.sourceUrl)
    if (bbId && !chosenDifferent && sug.signals.course && (sug.signals.course.code || sug.signals.course.name)) store.learnBlackboardCourse(bbId, sug.signals.course)
    emitSuggestions()
    return entry
  }

  function dismissSuggestion(id) {
    const sug = suggestions.get(id)
    if (sug) { sug.status = 'dismissed'; emitSuggestions() }
    const fc = flows.get(id)
    if (fc) { fc.step('decide', 'Left in Downloads', 'done', 'You can file it later from Downloads'); fc.finish('dismissed'); flows.delete(id) }
  }

  // ------------------------------------------------------------- search + organize

  async function search(text) {
    const t0 = Date.now()
    const s = settings()
    task('search', 'understand', 8, text.slice(0, 60))
    let plan = planQuery(text, { courses: nameableCourses() })
    let aiError = null
    if (s.geminiApiKey && text.trim()) {
      try {
        const ai = await gemini.planQueryAI({ apiKey: s.geminiApiKey, model: s.geminiModel, text, courses: nameableCourses().slice(0, 80), today: new Date().toISOString().slice(0, 10) })
        plan = mergeAiPlan(plan, ai)
      } catch (e) { aiError = e.message }
    }
    task('search', 'scan', 45, null)
    await indexer.ensureFresh()
    task('search', 'rank', 80, `${indexer.status.count.toLocaleString()} files`)
    const { total, results } = searchFiles(indexer.files, plan)
    return { plan, total, results, indexed: indexer.status.count, tookMs: Date.now() - t0, aiError }
  }

  function suggestedFolderName(plan, text) {
    if (plan.courses?.length) return courseFolderName(plan.courses[0])
    const kw = (plan.groups || []).map(g => g[0]).filter(Boolean).slice(0, 3)
    const base = kw.length ? kw.join(' ') : text.trim().slice(0, 40)
    return base.replace(/[\\/:*?"<>|]/g, '').replace(/\b\w/g, c => c.toUpperCase()).trim() || 'Organized Files'
  }

  function organizePreview({ paths, text, destinationRoot, folderName: nameOverride }) {
    const s = settings()
    const root = destinationRoot || s.destinationRoots[0]
    if (!root) throw new Error('Choose a destination folder first.')
    assertSafeDestination(root)
    const plan = planQuery(text || '', { courses: nameableCourses() })
    const cleaned = String(nameOverride || '').replace(/[\\/:*?"<>|]/g, '').trim()
    const folderName = cleaned || suggestedFolderName(plan, text || '')
    const files = paths.map(p => {
      const f = indexer.files.find(x => x.path === p)
      return f || { path: p, name: path.basename(p), size: 0 }
    })
    const { base, items } = planOrganize(files, { destinationRoot: root, folderName, courses: nameableCourses() })
    return { destinationRoot: root, folderName, base, items }
  }

  async function organizeExecute({ items, label }) {
    const batchId = uid()
    const done = []; const failed = []
    task('organize', 'prepare', 4, `${items.length} files`)
    for (const [i, it] of items.entries()) {
      task('organize', 'move', 8 + Math.round((i / Math.max(items.length, 1)) * 84), `${it.fileName} (${i + 1}/${items.length})`)
      try {
        const entry = await moveWithJournal(it.from, path.dirname(it.to), { source: 'assistant', batchId, reason: label || 'Organized from search results' })
        done.push(entry)
      } catch (e) { failed.push({ fileName: it.fileName, error: e.message }) }
    }
    task('organize', 'save', 96, null)
    return { batchId, moved: done.length, failed }
  }

  // ------------------------------------------------------------- sort a whole folder

  async function listFolderFiles(folder, recursive, cap = 400) {
    const out = []
    const walk = async (dir, depth) => {
      let entries
      try { entries = await fs.promises.readdir(dir, { withFileTypes: true }) } catch { return }
      for (const e of entries) {
        if (out.length >= cap) return
        const full = path.join(dir, e.name)
        if (e.isFile()) {
          if (isTempName(e.name)) continue
          try { const st = await fs.promises.stat(full); out.push({ path: full, name: e.name, size: st.size, mtime: st.mtimeMs }) } catch { /* vanished */ }
        } else if (recursive && e.isDirectory() && !e.isSymbolicLink() && depth < 3 && !e.name.startsWith('.') && !SKIP_DIR_NAMES.has(e.name.toLowerCase())) await walk(full, depth + 1)
      }
    }
    await walk(folder, 0)
    return out
  }

  async function pool(list, size, fn) {
    let next = 0
    await Promise.all(Array.from({ length: Math.min(size, list.length) }, async () => {
      while (next < list.length) { const i = next++; await fn(list[i], i) }
    }))
  }

  /**
   * Looks at every file in `folder`, works out what each one is (opening it when the name says
   * nothing) and proposes an existing folder or a new one. Nothing is moved.
   */
  async function sortScan({ folder, recursive = false, destinationRoot } = {}) {
    if (!folder || !path.isAbsolute(folder) || !fs.existsSync(folder)) throw new Error('Choose a folder to sort.')
    assertSafeDestination(folder)
    const s = settings()
    const roots = destinationRoot ? [destinationRoot] : s.destinationRoots
    if (!roots.length) throw new Error('Add a destination folder in Settings first.')
    task('sort', 'scan', 4, path.basename(folder))
    const files = await listFolderFiles(folder, recursive)
    if (!files.length) return { folder, recursive, destinationRoot: roots[0], items: [], stats: { total: 0, ready: 0, review: 0, newFolders: 0, read: 0, inPlace: 0 } }
    const ctx = await context({ fresh: true, roots })
    task('sort', 'scan', 14, `${files.length} files · ${ctx.catalog.length} folders`)

    // 1) open the files whose names don't explain themselves
    const contents = new Array(files.length).fill(null)
    let done = 0
    await pool(files, 6, async (f, i) => {
      if (needsReading(f, ctx, '')) contents[i] = await readExcerpt(f.path)
      done++
      task('sort', 'read', 16 + Math.round((done / files.length) * 26), `${f.name} (${done}/${files.length})`)
    })

    // 2) understand + pick a folder (AI refines when a key is configured)
    const results = new Array(files.length)
    let aiBudget = 80; done = 0
    await pool(files, 3, async (f, i) => {
      let plan = localPlan(f, contents[i], ctx, '')
      let aiUsed = false
      const worthAi = s.geminiApiKey && aiBudget > 0 && (contents[i]?.ok || IMAGE_EXT.has(extOf(f.name)) || plan.primary.confidence < 0.85)
      if (worthAi) {
        aiBudget--
        const r = await aiPlan(f, contents[i], ctx, plan, '')
        if (r && s_isUnderRoots(r.primary.folder, ctx.roots)) { r.alternatives = mergeAlternatives(r.primary, [[{ folder: plan.primary.folder, confidence: plan.primary.confidence, reason: plan.primary.reason, isNewFolder: plan.primary.isNewFolder }], r.alternatives, plan.alternatives]); plan = r; aiUsed = true }
      }
      results[i] = { f, plan, aiUsed, content: contents[i] }
      done++
      task('sort', 'understand', 44 + Math.round((done / files.length) * 40), `${f.name} (${done}/${files.length})`)
    })

    // 3) assemble the review list
    task('sort', 'plan', 90, null)
    const items = results.map(({ f, plan, aiUsed, content }) => {
      const inPlace = path.resolve(path.dirname(f.path)) === path.resolve(plan.primary.folder)
      return {
        id: uid(), from: f.path, fileName: f.name, size: f.size, mtime: f.mtime, ext: extOf(f.name),
        analysis: smart.publicAnalysis(plan.analysis, f.name, { source: aiUsed ? 'ai' : 'local' }),
        unreadable: content && !content.ok ? (content.reason || 'unreadable') : null,
        primary: plan.primary, alternatives: plan.alternatives.slice(0, 5),
        needsReview: plan.primary.confidence < 0.55, inPlace
      }
    }).sort((a, b) => (b.primary.confidence - a.primary.confidence))
    const stats = {
      total: items.length, inPlace: items.filter(i => i.inPlace).length, read: items.filter(i => i.analysis.readContent).length,
      review: items.filter(i => i.needsReview && !i.inPlace).length, ready: items.filter(i => !i.needsReview && !i.inPlace).length,
      newFolders: new Set(items.filter(i => i.primary.isNewFolder && !i.inPlace).map(i => i.primary.folder)).size
    }
    return { folder, recursive, destinationRoot: roots[0], items, stats }
  }

  async function sortExecute({ items, label }) {
    const batchId = uid()
    const done = []; const failed = []
    task('organize', 'prepare', 4, `${items.length} files`)
    for (const [i, it] of items.entries()) {
      task('organize', 'move', 8 + Math.round((i / Math.max(items.length, 1)) * 84), `${path.basename(it.from)} (${i + 1}/${items.length})`)
      try {
        const entry = await moveWithJournal(it.from, it.folder, { source: 'sort', batchId, course: it.course || null, reason: label || 'Sorted by content', confidence: it.confidence ?? null })
        done.push(entry)
        if (it.course) store.learn({ course: it.course, ext: extOf(path.basename(it.from)), folder: path.dirname(entry.to) })
      } catch (e) { failed.push({ fileName: path.basename(it.from), error: e.message }) }
    }
    task('organize', 'save', 96, null)
    return { batchId, moved: done.length, failed }
  }

  async function undo(id, quiet) {
    const entry = store.getActivity(id)
    if (!entry) throw new Error('Activity entry not found.')
    if (!quiet) task('undo', 'restore', 40, entry.fileName)
    if (entry.type === 'rename') {
      if (entry.status !== 'done') throw new Error('This rename was already undone.')
      if (!fs.existsSync(entry.to)) throw new Error('The renamed folder can no longer be found.')
      if (fs.existsSync(entry.from)) throw new Error(`A folder called “${path.basename(entry.from)}” already exists.`)
      await fs.promises.rename(entry.to, entry.from)
      store.updateActivity(id, { status: 'undone', undoneAt: Date.now() })
      invalidateCatalog(); indexer.build().catch(() => {})
      h.onActivity(store.listActivity())
      return { restoredTo: entry.from }
    }
    const r = await undoMove(entry)
    store.updateActivity(id, { status: 'undone', undoneAt: Date.now() })
    indexer.noteMoved(entry.to, r.restoredTo)
    invalidateCatalog()
    h.onActivity(store.listActivity())
    return r
  }

  async function undoBatch(batchId) {
    const entries = store.listActivity().filter(e => e.batchId === batchId && e.status === 'done')
    let ok = 0; const errors = []
    for (const [i, e] of entries.entries()) {
      task('undo', 'restore', Math.round((i / Math.max(entries.length, 1)) * 90) + 5, `${e.fileName} (${i + 1}/${entries.length})`)
      try { await undo(e.id, true); ok++ } catch (err) { errors.push(err.message) } }
    return { restored: ok, errors }
  }

  // ------------------------------------------------------------- lifecycle

  function syncWatcher() {
    const s = settings()
    const existing = s.watchedFolders.filter(f => { try { return fs.statSync(f).isDirectory() } catch { return false } })
    watcher.setPaused(s.paused)
    return watcher.sync(existing)
  }

  watcher.on('file', info => handleNewFile(info).catch(e => console.error('handleNewFile failed', e)))
  watcher.on('error', e => h.onWatchError(e))

  function start() {
    syncWatcher()
    setTimeout(() => indexer.build().catch(() => {}), 1500)
  }

  function updateSettings(patch) {
    const next = store.updateSettings(patch)
    if ('watchedFolders' in patch || 'paused' in patch) syncWatcher()
    if ('destinationRoots' in patch || 'excludedFolders' in patch) invalidateCatalog()
    if ('searchRoots' in patch || 'excludedFolders' in patch) indexer.build().catch(() => {})
    return next
  }

  function loadDemo() {
    task('demo', 'files', 15, 'Sample course files')
    const d = demo.createDemoWorkspace(documentsDir)
    task('demo', 'settings', 60, null)
    const s = settings()
    const merge = (list, add) => Array.from(new Set([...list, add]))
    const codes = new Set(s.courses.map(c => c.code))
    updateSettings({
      courses: [...s.courses, ...d.courses.filter(c => !codes.has(c.code))],
      destinationRoots: [...d.destinations, ...s.destinationRoots.filter(r => !d.destinations.includes(r))],
      watchedFolders: merge(s.watchedFolders, d.downloads),
      searchRoots: merge(s.searchRoots, d.root),
      demoLoaded: true, demoRoot: d.root
    })
    invalidateCatalog()
    task('demo', 'index', 85, null)
    indexer.build().catch(() => {})
    return d
  }

  function simulateDownload() {
    const s = settings()
    if (!s.demoLoaded) throw new Error('Load the demo workspace first.')
    task('simulate', 'create', 20, null)
    const r = demo.simulateDownload(path.join(s.demoRoot, 'Downloads'))
    task('simulate', 'detect', 60, null)
    return r
  }

  // ------------------------------------------------------------- study buddy (local Ollama)
  const ollama = createOllama({ getConfig: () => ({ url: settings().ollamaUrl, model: settings().ollamaModel }), fetchImpl: hooks.fetch || globalThis.fetch })
  // Study Buddy uses Gemini when a key is set (fast, parallel), otherwise the local Ollama model.
  const useGemini = () => { const p = settings().studyProvider; return p === 'gemini' ? !!settings().geminiApiKey : p === 'ollama' ? false : !!settings().geminiApiKey }
  const studyAi = {
    concurrency: () => (useGemini() ? 4 : 1),
    config: () => (useGemini() ? { model: settings().geminiModel, provider: 'gemini' } : { ...ollama.config(), provider: 'ollama' }),
    chat: opts => useGemini()
      ? gemini.chatJson({ apiKey: settings().geminiApiKey, model: settings().geminiModel, system: opts.system, prompt: opts.messages.map(m => m.content).join('\n\n'), schema: opts.schema, maxTokens: 8192 })
      : ollama.chat(opts)
  }
  const study = createStudy({ ollama: studyAi, readSections, dir: store.dir, task, stream: e => h.onStudyStream(e) })

  return {
    studyStatus: async () => {
      if (useGemini()) return { ready: true, provider: 'gemini', model: settings().geminiModel, running: true, hasModel: true, models: [], url: '', pullCommand: '' }
      const st = await ollama.status()
      return { ...st, provider: 'ollama', ready: st.running && st.hasModel }
    },
    studyOpen: ({ path: file, force } = {}) => study.build(file, { force }),
    studyLesson: ({ planId, conceptId, mode, force }) => study.lesson(planId, conceptId, mode, { force }),
    studyDone: ({ planId, conceptId, done }) => study.setDone(planId, conceptId, done),
    studyAsk: ({ planId, question }) => study.ask(planId, question),
    studyRecent: () => study.recent(),
    studyLoad: id => study.load(id),
    studyRemove: id => study.remove(id),
    start, close: () => watcher.close(),
    settings, updateSettings,
    search, organizePreview, organizeExecute, sortScan, sortExecute,
    listSuggestions, acceptSuggestion, dismissSuggestion, handleNewFile, applyTidy, dismissTidy,
    undo, undoBatch, activity: () => store.listActivity(),
    majors: () => aduCatalog.majors(),
    addDownloadHint, addCourseHint,
    noteExtension: () => { extensionSeenAt = Date.now() },
    extensionStatus: () => ({ connected: extensionActive(), lastSeen: extensionSeenAt || null, courses: Object.keys(store.getLearning().bbCourses).length }),
    rebuildIndex: () => indexer.build(), indexStatus: () => indexer.status,
    watching: () => watcher.active, syncWatcher,
    loadDemo, simulateDownload,
    testGemini: async (apiKey, model) => { task('ai', 'connect', 30, model || settings().geminiModel); return gemini.testKey({ apiKey, model: model || settings().geminiModel }) },
    _internals: { indexer, watcher, getCatalog }
  }
}

module.exports = { createCore }
