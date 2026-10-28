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
const { suggest, buildCatalog, courseFolderName, extractSignals } = require('./classifier')
const { DownloadWatcher, readDownloadSource } = require('./watcher')
const { executeMove, undoMove, assertSafeDestination } = require('./mover')
const { planOrganize } = require('./organizer')
const gemini = require('./gemini')
const smart = require('./smartSort')
const { readExcerpt, IMAGE_EXT } = require('./contentReader')
const demo = require('./demo')
const { uid, extOf, isInside, isTempName, SKIP_DIR_NAMES } = require('./common')

function createCore({ store, hooks = {}, documentsDir }) {
  const noop = () => {}
  const h = { onSuggestions: noop, onNewSuggestion: noop, onAutoMoved: noop, onIndex: noop, onTask: noop, onActivity: noop, onWatchError: noop, ...hooks }

  const settings = () => store.getSettings()
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
    return { catalog, subjects: smart.subjectsFromCatalog(catalog, s.courses), roots: rootList, learning: store.getLearning() }
  }

  const needsReading = (file, ctx, sourceUrl) => {
    const sig = extractSignals(file.name, { sourceUrl, courses: ctx.subjects })
    return !smart.isSelfDescriptive(file.name, sig) || !sig.course || (!sig.course.known && /^(scan|img|image|dsc|doc|file|photo|page|inv|bill|ref)\d/i.test(sig.course.code))
  }

  /** Local, offline understanding + destination. Always available. */
  function localPlan(file, content, ctx, sourceUrl) {
    return smart.plan({ file, content, subjects: ctx.subjects, catalog: ctx.catalog, roots: ctx.roots, learning: ctx.learning, sourceUrl })
  }

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

  async function handleNewFile(info) {
    const s = settings()
    if (!fs.existsSync(info.path)) return null
    const sourceUrl = info.sourceUrl ?? await readDownloadSource(info.path)
    task('simulate', 'analyze', 75, info.name)
    const file = { path: info.path, name: info.name, size: info.size, mtime: info.mtime || Date.now() }
    let ctx = null; let content = null; let local = null
    const classic = await (async () => {
      const catalog = await getCatalog()
      return suggest({ fileName: info.name, sourceUrl, courses: s.courses, catalog, learning: store.getLearning(), destinationRoots: s.destinationRoots })
    })()
    try {
      ctx = await context()
      content = needsReading(file, ctx, sourceUrl) ? await readExcerpt(file.path) : null
      local = localPlan(file, content, ctx, sourceUrl)
    } catch (e) { console.error('Smart analysis failed, using basic suggestion:', e) } // a notification must always be shown
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

    if (s.autoMove && !sug.needsReview && sug.primary.confidence >= s.autoMoveThreshold) {
      try {
        const entry = await moveWithJournal(info.path, sug.primary.folder, { source: 'auto', course: sug.signals.course?.code || null, reason: sug.primary.reason, confidence: sug.primary.confidence })
        sug.status = 'moved'; sug.result = entry
        suggestions.set(sug.id, sug)
        h.onAutoMoved(entry, sug)
        return sug
      } catch { /* fall through to a manual suggestion */ }
    }

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
    store.learn({ course: sug.signals.course?.code, ext: sug.file.ext, folder: path.dirname(entry.to) })
    emitSuggestions()
    return entry
  }

  function dismissSuggestion(id) {
    const sug = suggestions.get(id)
    if (sug) { sug.status = 'dismissed'; emitSuggestions() }
  }

  // ------------------------------------------------------------- search + organize

  async function search(text) {
    const t0 = Date.now()
    const s = settings()
    task('search', 'understand', 8, text.slice(0, 60))
    let plan = planQuery(text, { courses: s.courses })
    let aiError = null
    if (s.geminiApiKey && text.trim()) {
      try {
        const ai = await gemini.planQueryAI({ apiKey: s.geminiApiKey, model: s.geminiModel, text, courses: s.courses, today: new Date().toISOString().slice(0, 10) })
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
    const plan = planQuery(text || '', { courses: s.courses })
    const cleaned = String(nameOverride || '').replace(/[\\/:*?"<>|]/g, '').trim()
    const folderName = cleaned || suggestedFolderName(plan, text || '')
    const files = paths.map(p => {
      const f = indexer.files.find(x => x.path === p)
      return f || { path: p, name: path.basename(p), size: 0 }
    })
    const { base, items } = planOrganize(files, { destinationRoot: root, folderName, courses: s.courses })
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

  return {
    start, close: () => watcher.close(),
    settings, updateSettings,
    search, organizePreview, organizeExecute, sortScan, sortExecute,
    listSuggestions, acceptSuggestion, dismissSuggestion, handleNewFile,
    undo, undoBatch, activity: () => store.listActivity(),
    rebuildIndex: () => indexer.build(), indexStatus: () => indexer.status,
    watching: () => watcher.active, syncWatcher,
    loadDemo, simulateDownload,
    testGemini: async (apiKey, model) => { task('ai', 'connect', 30, model || settings().geminiModel); return gemini.testKey({ apiKey, model: model || settings().geminiModel }) },
    _internals: { indexer, watcher, getCatalog }
  }
}

module.exports = { createCore }
