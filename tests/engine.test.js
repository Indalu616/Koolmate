'use strict'
const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('fs')
const os = require('os')
const path = require('path')

const { planQuery } = require('../electron/services/queryPlanner')
const { searchFiles } = require('../electron/services/search')
const { suggest, buildCatalog, extractSignals } = require('../electron/services/classifier')
const { planMove, executeMove, undoMove, assertSafeDestination } = require('../electron/services/mover')
const { createStore } = require('../electron/services/store')
const { createCore } = require('../electron/services/core')
const demo = require('../electron/services/demo')

const NOW = new Date('2026-10-07T12:00:00')
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'koolmate-'))
const sleep = ms => new Promise(r => setTimeout(r, ms))

test('planQuery understands course, type, dates and intent', () => {
  const p = planQuery('Find all my distributed systems PDF lecture slides from last week', { courses: demo.COURSES, now: NOW })
  assert.equal(p.courses[0].code, 'CSC408')
  assert.deepEqual(p.extensions, ['pdf'])
  assert.equal(p.dateLabel, 'last week')
  assert.ok(p.dateFrom < NOW.getTime() && p.dateTo === null)
  assert.equal(p.intent, 'find')
  assert.ok(p.groups.some(g => g.includes('csc408')))
  assert.ok(p.groups.some(g => g.includes('lecture') && g.includes('slides')))
  assert.equal(planQuery('Find all my Genetics course materials and organize them').intent, 'organize')
})

test('planQuery handles relative ranges and image requests', () => {
  const p = planQuery('screenshots from the last 3 days', { now: NOW })
  assert.ok(p.extensions.includes('png'))
  assert.equal(p.dateLabel, 'last 3 days')
  assert.equal(p.groups.length, 0)
})

test('search ranks name matches above folder matches and honours filters', () => {
  const files = [
    { path: '/u/a/CSC408_Lecture05.pdf', name: 'CSC408_Lecture05.pdf', dir: '/u/a', ext: 'pdf', size: 1, mtime: NOW.getTime() },
    { path: '/u/CSC408/misc.pdf', name: 'misc.pdf', dir: '/u/CSC408', ext: 'pdf', size: 1, mtime: NOW.getTime() },
    { path: '/u/a/CSC408_Lecture05.docx', name: 'CSC408_Lecture05.docx', dir: '/u/a', ext: 'docx', size: 1, mtime: NOW.getTime() },
    { path: '/u/a/holiday.pdf', name: 'holiday.pdf', dir: '/u/a', ext: 'pdf', size: 1, mtime: NOW.getTime() }
  ]
  const plan = planQuery('csc408 pdf', { courses: demo.COURSES, now: NOW })
  const { results } = searchFiles(files, plan, { now: NOW.getTime() })
  assert.equal(results.length, 2)
  assert.equal(results[0].name, 'CSC408_Lecture05.pdf')
  assert.ok(results.every(r => r.ext === 'pdf'))
})

test('classifier files a download into the matching course/type folder and proposes new folders', async () => {
  const docs = tmp()
  const d = demo.createDemoWorkspace(docs)
  const catalog = await buildCatalog([d.destination])
  const base = { courses: demo.COURSES, catalog, destinationRoots: [d.destination] }

  const a = suggest({ fileName: 'CSC408_Lecture07_Replication_and_Consistency.pdf', ...base })
  assert.match(a.primary.folder, /Distributed Systems[\\/]Lecture Materials$/)
  assert.ok(a.primary.confidence >= 0.75, `confidence ${a.primary.confidence}`)
  assert.equal(a.needsReview, false)

  const b = suggest({ fileName: 'CSC302_Assignment3_Query_Optimization.pdf', ...base })
  assert.match(b.primary.folder, /Database Management[\\/]Assignments$/)

  const c = suggest({ fileName: 'GEN201_Lecture02_Mendelian_Genetics.pdf', ...base })
  assert.equal(c.primary.isNewFolder, true)
  assert.match(c.primary.folder, /GEN201 Genetics[\\/]Lectures$/)

  const e = suggest({ fileName: 'Signal.pdf', ...base })
  assert.equal(e.needsReview, true)
  assert.ok(e.primary.confidence < 0.55)

  const w = extractSignals('SWE473_Week3_Refactoring.pdf', { courses: demo.COURSES })
  assert.equal(w.week, 3)
  assert.equal(w.course.code, 'SWE473')
})

test('classifier uses learned preferences', async () => {
  const docs = tmp()
  const d = demo.createDemoWorkspace(docs)
  const catalog = await buildCatalog([d.destination])
  const target = path.join(d.destination, d.semester, 'Database Management', 'Assignments')
  const learning = { courseFolders: { csc302: target }, extFolders: {}, recent: [target] }
  const r = suggest({ fileName: 'CSC302_Notes_Indexes.pdf', courses: demo.COURSES, catalog, learning, destinationRoots: [d.destination] })
  assert.ok(r.alternatives.some(a => a.folder === target) || r.primary.folder === target)
})

test('mover never renames, avoids overwrites, blocks system folders, and undoes', async () => {
  const dir = tmp()
  const src = path.join(dir, 'in', 'report.pdf'); fs.mkdirSync(path.dirname(src), { recursive: true }); fs.writeFileSync(src, 'x')
  const dest = path.join(dir, 'out', 'Reports'); fs.mkdirSync(dest, { recursive: true }); fs.writeFileSync(path.join(dest, 'report.pdf'), 'existing')

  const plan = await planMove(src, dest)
  assert.equal(plan.conflictRenamed, true)
  assert.equal(path.basename(plan.to), 'report (1).pdf')

  const entry = await executeMove(src, dest, { source: 'test' })
  assert.ok(fs.existsSync(entry.to)); assert.ok(!fs.existsSync(src))
  assert.equal(fs.readFileSync(path.join(dest, 'report.pdf'), 'utf8'), 'existing')

  await undoMove(entry)
  assert.ok(fs.existsSync(src)); assert.ok(!fs.existsSync(entry.to))

  assert.throws(() => assertSafeDestination('relative/path'))
  assert.throws(() => assertSafeDestination(path.parse(dir).root))
  if (process.platform !== 'win32') assert.throws(() => assertSafeDestination('/etc/secret'))
})

function makeCore() {
  const docs = tmp()
  const store = createStore(tmp())
  const events = { suggestions: [], newSug: [], index: 0 }
  const core = createCore({
    store, documentsDir: docs,
    hooks: { onNewSuggestion: s => events.newSug.push(s), onSuggestions: l => events.suggestions.push(l), onIndex: () => events.index++, onTask: e => (events.tasks = events.tasks || []).push(e) }
  })
  core.updateSettings({ searchRoots: [docs], watchedFolders: [], destinationRoots: [docs], geminiApiKey: '' })
  return { core, docs, store, events }
}

test('core: demo workspace -> natural-language search finds the right files', async () => {
  const { core } = makeCore()
  core.loadDemo()
  await core.rebuildIndex()

  const r1 = await core.search('find my operating systems assignments')
  assert.ok(r1.results.length >= 1)
  assert.ok(r1.results.every(f => /CSC308/i.test(f.path)))
  assert.ok(r1.results[0].name.includes('Assignment'))

  const r2 = await core.search('PDFs from the last week')
  assert.ok(r2.results.length >= 1)
  assert.ok(r2.results.every(f => f.ext === 'pdf' && Date.now() - f.mtime < 15 * 86400000))

  const r3 = await core.search('Find all my Genetics course materials and organize them')
  assert.equal(r3.plan.intent, 'organize')
  const names = r3.results.map(f => f.name)
  assert.ok(names.includes('genetics_lecture1_mendel.pdf'))
  assert.ok(names.includes('Genetics_Lab_Report_Drosophila.pdf'))
  assert.ok(names.includes('GEN201_Assignment3_Pedigrees.pdf'), 'course code alias should match too')
  assert.ok(!names.includes('holiday_packing_list.pdf'))
  core.close()
})

test('core: organize preview -> execute -> undo batch', async () => {
  const { core } = makeCore()
  core.loadDemo()
  await core.rebuildIndex()
  const q = 'Find all my Genetics course materials and organize them'
  const r = await core.search(q)
  const preview = core.organizePreview({ paths: r.results.map(f => f.path), text: q })
  assert.match(preview.folderName, /^GEN201 Genetics$/)
  assert.match(preview.base, /University[\\/]GEN201 Genetics$/)
  assert.ok(preview.items.length >= 4)
  assert.ok(preview.items.some(i => i.sub === 'Lectures'))
  assert.ok(preview.items.some(i => i.sub === 'Labs'))
  for (const i of preview.items) assert.ok(fs.existsSync(i.from))

  const res = await core.organizeExecute({ items: preview.items, label: q })
  assert.equal(res.failed.length, 0)
  for (const i of preview.items) { assert.ok(fs.existsSync(i.to)); assert.ok(!fs.existsSync(i.from)) }

  const undone = await core.undoBatch(res.batchId)
  assert.equal(undone.restored, preview.items.length)
  for (const i of preview.items) assert.ok(fs.existsSync(i.from))
  core.close()
})

test('core: a finished download is detected, suggested, accepted, learned and can be undone', async () => {
  const { core, events } = makeCore()
  core.loadDemo()
  await core.rebuildIndex()
  const file = core.simulateDownload() // CSC408 lecture, written in two stages like a real download

  const t0 = Date.now()
  while (!events.newSug.length && Date.now() - t0 < 8000) await sleep(100)
  assert.equal(events.newSug.length, 1, 'watcher should announce the finished download once')
  const sug = events.newSug[0]
  assert.equal(sug.file.path, file)
  assert.match(sug.primary.folder, /Distributed Systems[\\/]Lecture Materials$/)
  assert.equal(core.listSuggestions().length, 1)
  assert.ok(fs.statSync(file).size > 200, 'file was fully written before it was announced')

  const entry = await core.acceptSuggestion(sug.id)
  assert.ok(fs.existsSync(entry.to)); assert.ok(!fs.existsSync(file))
  assert.equal(core.listSuggestions().length, 0)
  assert.equal(core.activity().length, 1)

  await core.undo(entry.id)
  assert.ok(fs.existsSync(file))
  assert.equal(core.activity()[0].status, 'undone')
  core.close()
})

test('core: auto-move only fires for high-confidence matches when enabled', async () => {
  const { core, events } = makeCore()
  core.loadDemo()
  core.updateSettings({ autoMove: true, autoMoveThreshold: 0.7 })
  await core.rebuildIndex()
  const moved = []
  const core2 = core // hooks captured at creation; check via activity
  const lecture = demo.simulateDownload(path.join(core.settings().demoRoot, 'Downloads'), 'CSC408_Lecture08_Transactions.pdf')
  const t0 = Date.now()
  while (!core2.activity().length && Date.now() - t0 < 8000) await sleep(100)
  assert.equal(core2.activity().length, 1)
  assert.equal(core2.activity()[0].source, 'auto')
  assert.ok(!fs.existsSync(lecture))

  const unknown = demo.simulateDownload(path.join(core.settings().demoRoot, 'Downloads'), 'Signal.pdf')
  await sleep(3500)
  assert.ok(fs.existsSync(unknown), 'low-confidence file must NOT be auto-moved')
  assert.equal(core.listSuggestions().length, 1)
  assert.equal(moved.length, 0); assert.equal(events.newSug.length, 1)
  core.close()
})

test('core: long operations stream task progress events', async () => {
  const { core, events } = makeCore()
  core.loadDemo()
  await core.rebuildIndex()
  await core.search('genetics lab')
  const search = events.tasks.filter(e => e.kind === 'search').map(e => e.step)
  assert.deepEqual(search, ['understand', 'scan', 'rank'])
  assert.ok(events.tasks.some(e => e.kind === 'demo' && e.step === 'files'))
  const prev = core.organizePreview({ paths: (await core.search('genetics')).results.map(f => f.path), text: 'genetics' })
  events.tasks.length = 0
  await core.organizeExecute({ items: prev.items, label: 'x' })
  const org = events.tasks.filter(e => e.kind === 'organize')
  assert.equal(org[0].step, 'prepare')
  assert.equal(org.filter(e => e.step === 'move').length, prev.items.length)
  assert.equal(org[org.length - 1].step, 'save')
  core.close()
})

test('core: sort a folder — reads unlabeled files, reuses existing folders, proposes new ones', async () => {
  const { core, events } = makeCore()
  const d = core.loadDemo()
  await core.rebuildIndex()
  events.tasks = []
  const r = await core.sortScan({ folder: d.sortFolder })
  const by = Object.fromEntries(r.items.map(i => [i.fileName, i]))
  const rel = i => path.relative(d.destination, i.primary.folder).split(path.sep).join('/')
  const sem = d.semester

  const os = by['scan_0042.pdf']
  assert.equal(rel(os), `${sem}/Operating Systems/Lecture Materials`)
  assert.equal(os.primary.isNewFolder, false)
  assert.equal(os.analysis.readContent, true)
  assert.equal(os.analysis.course.code, 'CSC308')
  assert.equal(os.analysis.type, 'Lectures')

  const lab = by['Document1.pdf']
  assert.equal(rel(lab), `${sem}/Distributed Systems/Labs`)
  assert.equal(lab.primary.isNewFolder, false)

  const exam = by['untitled.txt']
  assert.equal(rel(exam), `${sem}/Database Management/Exams`)
  assert.equal(exam.primary.isNewFolder, true, 'course exists but has no Exams folder yet')

  const bill = by['Signal_0831.pdf']
  assert.match(bill.primary.folder, /Personal[\\/]Invoices$/)
  assert.equal(bill.primary.isNewFolder, false)

  const gen = by['WhatsApp Document 2026-10-03.pdf']
  assert.equal(rel(gen), `${sem}/Genetics/Assignments`)
  assert.equal(gen.primary.isNewFolder, true)

  const st = by['Software Testing Lecture 1.pdf']
  assert.equal(rel(st), `${sem}/Software Testing/Lecture Materials`)
  assert.equal(st.primary.isNewFolder, true)

  assert.ok(events.tasks.some(e => e.kind === 'sort' && e.step === 'read'))
  assert.ok(r.stats.read >= 5 && r.stats.newFolders >= 3)

  const pick = [os, exam].map(i => ({ from: i.from, folder: i.primary.folder, course: i.analysis.course?.code }))
  const done = await core.sortExecute({ items: pick, label: 'test' })
  assert.equal(done.moved, 2)
  assert.ok(fs.existsSync(path.join(d.destination, sem, 'Database Management', 'Exams', 'untitled.txt')))
  assert.equal((await core.undoBatch(done.batchId)).restored, 2)
  assert.ok(fs.existsSync(os.from))
  core.close()
})

test('core: a download with a meaningless name is opened and filed by its content', async () => {
  const { core } = makeCore()
  const d = core.loadDemo()
  await core.rebuildIndex()
  const f = demo.simulateDownload(path.join(d.root, 'Downloads'), 'scan_0108.pdf')
  const t0 = Date.now()
  while (!core.listSuggestions().length && Date.now() - t0 < 8000) await sleep(100)
  const sug = core.listSuggestions()[0]
  assert.ok(sug, 'suggestion created')
  assert.equal(path.relative(d.destination, sug.primary.folder).split(path.sep).join('/'), `${d.semester}/Operating Systems/Lecture Materials`)
  assert.equal(sug.analysis.readContent, true)
  assert.ok(fs.existsSync(f))
  core.close()
})

test('content reader: pdf, docx, pptx, xlsx and text; images are reported unreadable', async () => {
  const JSZip = require('jszip')
  const { readExcerpt } = require('../electron/services/contentReader')
  const dir = tmp()
  const zip = async (name, files) => { const z = new JSZip(); for (const [k, v] of Object.entries(files)) z.file(k, v); fs.writeFileSync(path.join(dir, name), await z.generateAsync({ type: 'nodebuffer' })); return path.join(dir, name) }
  const docx = await zip('a.docx', { 'word/document.xml': '<w:document><w:p><w:r><w:t>Distributed Systems &amp; Consensus</w:t></w:r></w:p><w:p><w:r><w:t>Assignment 2 deadline Friday</w:t></w:r></w:p></w:document>' })
  const pptx = await zip('b.pptx', { 'ppt/slides/slide1.xml': '<p:sld><a:p><a:r><a:t>Lecture 4 Process Scheduling</a:t></a:r></a:p></p:sld>' })
  const xlsx = await zip('c.xlsx', { 'xl/sharedStrings.xml': '<sst><si><t>Invoice number</t></si><si><t>Amount due</t></si></sst>' })
  fs.writeFileSync(path.join(dir, 'd.txt'), 'Plain notes about normalization and third normal form in databases.')
  fs.writeFileSync(path.join(dir, 'e.pdf'), demo.makePdf('Operating Systems', ['Lecture 6: Deadlocks and recovery']))
  fs.writeFileSync(path.join(dir, 'f.png'), Buffer.from([137, 80, 78, 71]))
  assert.match((await readExcerpt(docx)).text, /Distributed Systems & Consensus[\s\S]*Assignment 2/)
  assert.match((await readExcerpt(pptx)).text, /Process Scheduling/)
  assert.match((await readExcerpt(xlsx)).text, /Invoice number/)
  assert.match((await readExcerpt(path.join(dir, 'd.txt'))).text, /third normal form/)
  assert.match((await readExcerpt(path.join(dir, 'e.pdf'))).text, /Deadlocks/)
  assert.equal((await readExcerpt(path.join(dir, 'f.png'))).ok, false)
})

test('smart sort: semester parsing, naming conventions and hierarchy resolution', async () => {
  const ss = require('../electron/services/smartSort')
  assert.equal(ss.parseSemester('Fall 2026').key, 'fall-2026')
  assert.equal(ss.parseSemester('2026_Spring').key, 'spring-2026')
  assert.equal(ss.parseSemester('Autumn semester 26').key, 'fall-2026')
  assert.equal(ss.formatSemester({ term: 'Spring', year: 2027 }, '2026_FALL'), '2027_SPRING')
  assert.equal(ss.isSemesterName('Fall 2026'), true)
  assert.equal(ss.isSemesterName('Fall of the Roman Empire 2026'), false)

  const root = tmp()
  for (const d of ['Fall 2026/Operating Systems/Lecture Materials', 'Fall 2026/Distributed Systems', 'Spring 2026/Database Management/Lectures']) fs.mkdirSync(path.join(root, d), { recursive: true })
  const catalog = await buildCatalog([root])
  const subjects = ss.subjectsFromCatalog(catalog, [])
  const mt = new Date('2026-10-05').getTime()
  const go = (name, text) => ss.plan({ file: { name, mtime: mt }, content: text ? { ok: true, text } : null, subjects, catalog, roots: [root], learning: {} })
  const rel = r => path.relative(root, r.primary.folder).split(path.sep).join('/')

  let r = go('Operating_System_Lecture_4.pdf')
  assert.equal(rel(r), 'Fall 2026/Operating Systems/Lecture Materials'); assert.equal(r.primary.isNewFolder, false)
  r = go('OS_Assignment_2.pdf') // acronym alias derived from the folder name
  assert.equal(rel(r), 'Fall 2026/Operating Systems/Assignments'); assert.equal(r.primary.isNewFolder, true)
  r = go('Distributed Systems Lecture 3.pdf') // course folder exists but is empty: follow the type-folder convention of the other courses
  assert.equal(rel(r), 'Fall 2026/Distributed Systems/Lecture Materials'); assert.equal(r.primary.isNewFolder, true)
  r = go('Database_Lecture_9.pdf') // only exists in Spring; this is Fall -> create under Fall, keep Spring as alternative
  assert.equal(rel(r), 'Fall 2026/Database Management/Lectures'); assert.equal(r.primary.isNewFolder, true)
  assert.ok(r.alternatives.some(a => /Spring 2026/.test(a.folder)))
  r = go('scan_0042.pdf', 'Operating Systems\nLecture 6: Deadlocks\nFall 2026')
  assert.equal(rel(r), 'Fall 2026/Operating Systems/Lecture Materials')
  r = go('x1.pdf', 'Operating Systems syllabus. Grading policy and office hours. Spring 2027')
  assert.equal(rel(r), 'Spring 2027/Operating Systems/Syllabus') // semester stated in the content creates the new semester folder
  assert.equal(r.primary.isNewFolder, true)
  assert.equal(ss.isSelfDescriptive('scan_0042.pdf', { course: null }), false)
  assert.equal(ss.isSelfDescriptive('Signal.pdf', { course: null }), false)
  assert.equal(ss.isSelfDescriptive('Compiler Design Notes.pdf', { course: null, type: 'Notes' }), true)
})
