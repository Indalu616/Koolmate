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
  assert.match(c.primary.folder, /GEN201_Genetics[\\/]Lectures$/)

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

function makeCore(extraSettings = {}) {
  const docs = tmp()
  const store = createStore(tmp())
  const events = { suggestions: [], newSug: [], index: 0, flows: [], autoMoved: [] }
  const core = createCore({
    store, documentsDir: docs,
    hooks: {
      onNewSuggestion: s => events.newSug.push(s), onSuggestions: l => events.suggestions.push(l), onIndex: () => events.index++,
      onTask: e => (events.tasks = events.tasks || []).push(e), onFlow: f => events.flows.push(f), onAutoMoved: e => events.autoMoved.push(e)
    }
  })
  core.updateSettings({ searchRoots: [docs], watchedFolders: [], destinationRoots: [docs], geminiApiKey: '', ...extraSettings })
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
  assert.match(preview.folderName, /^GEN201_Genetics$/)
  assert.match(preview.base, /University[\\/]GEN201_Genetics$/)
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
  const { core, events } = makeCore({ autoFileCourses: false })
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
  assert.equal(rel(st), `${sem}/SoftwareTesting/LectureMaterials`)
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
  const { core } = makeCore({ autoFileCourses: false })
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
  assert.equal(rel(r), 'Fall 2026/Distributed Systems/LectureMaterials'); assert.equal(r.primary.isNewFolder, true)
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

// ---------------------------------------------------------------- ADU catalog + automatic filing

const aduCatalog = require('../electron/services/aduCatalog')
const SWE = 'Bachelor of Science in Software Engineering'

function writeDownload(dir, name, title, lines = []) {
  fs.mkdirSync(dir, { recursive: true })
  const p = path.join(dir, name)
  fs.writeFileSync(p, demo.makePdf(title, lines))
  const st = fs.statSync(p)
  return { path: p, name, size: st.size, mtime: st.mtimeMs }
}
const stepsOf = flow => Object.fromEntries(flow.steps.map(s => [s.key, s]))

test('ADU catalog: majors, official titles, and name matching limited to the student\'s major', () => {
  const majors = aduCatalog.majors()
  assert.ok(majors.length >= 30)
  assert.ok(majors.some(m => m.name === SWE))
  assert.equal(aduCatalog.courseTitle('CSC 408'), 'Distributed Information Systems')
  assert.equal(aduCatalog.courseTitle('csc408'), 'Distributed Information Systems')
  const subj = aduCatalog.subjectsFor(SWE)
  const by = code => subj.find(s => s.code === code)
  assert.equal(by('CSC 301').codeOnly, false, 'own major course is matched by name')
  assert.equal(by('ACC 200').codeOnly, true, 'other majors are matched by code only')
  assert.equal(by('SWE 399A').codeOnly, true, 'generic titles like internships are code only')
  assert.ok(aduCatalog.subjectsFor('').every(s => s.codeOnly), 'no major chosen: code only')
})

test('core: a recognised course download creates the course folder and subfolder and reports each real step', async () => {
  const { core, docs, events } = makeCore({ major: SWE })
  const dl = tmp()
  const info = writeDownload(dl, 'CSC301_Lecture03_Trees.pdf', 'Lecture 3: Trees')
  const sug = await core.handleNewFile({ ...info, sourceUrl: 'https://adu.blackboard.com/ultra/courses/_123_1/outline' })

  const course = path.join(docs, 'CSC301_DataStructuresAndAlgorithms')
  const target = path.join(course, 'LectureMaterials', info.name)
  assert.equal(sug.status, 'moved')
  assert.ok(fs.existsSync(target), 'file is inside the new course/subfolder')
  assert.ok(!fs.existsSync(info.path))
  assert.equal(core.activity()[0].source, 'auto')
  assert.equal(events.autoMoved.length, 1)

  const last = events.flows[events.flows.length - 1]
  assert.equal(last.status, 'done')
  assert.deepEqual(last.steps.map(s => s.key), ['detect', 'read', 'course', 'type', 'courseFolder', 'subFolder', 'move'])
  assert.ok(last.steps.every(s => s.status === 'done'))
  const st = stepsOf(last)
  assert.match(st.detect.detail, /from Blackboard/)
  assert.match(st.course.detail, /CSC 301 Data Structures and Algorithms/)
  assert.match(st.courseFolder.detail, /^Created/)
  assert.match(st.subFolder.detail, /^Created “.*LectureMaterials”/)
  // steps arrive one at a time, in order (each emitted after it really happened)
  const firstMove = events.flows.findIndex(f => f.steps.some(s => s.key === 'move'))
  assert.ok(firstMove > events.flows.findIndex(f => f.steps.some(s => s.key === 'subFolder' && s.status === 'done')))

  // second download of the same course: the course folder is found, a new subfolder is created
  const lab = writeDownload(dl, 'Data Structures and Algorithms Lab 2.pdf', 'Lab 2')
  const sug2 = await core.handleNewFile(lab)
  assert.equal(sug2.status, 'moved')
  assert.ok(fs.existsSync(path.join(course, 'Labs', lab.name)))
  const st2 = stepsOf(events.flows[events.flows.length - 1])
  assert.match(st2.courseFolder.detail, /^Found/)
  assert.match(st2.subFolder.detail, /^Created/)
  core.close()
})

test('core: an unrecognised download is not moved; the flow stops and waits for the student', async () => {
  const { core, events } = makeCore({ major: SWE })
  const info = writeDownload(tmp(), 'Signal.pdf', 'Signal')
  const sug = await core.handleNewFile(info)
  assert.equal(sug.status, 'pending')
  assert.ok(fs.existsSync(info.path))
  const last = events.flows[events.flows.length - 1]
  assert.equal(last.status, 'waiting')
  assert.equal(last.suggestionId, sug.id)
  assert.equal(stepsOf(last).course.status, 'failed')

  // accepting from the pop-up completes the same flow
  const entry = await core.acceptSuggestion(sug.id)
  const done = events.flows[events.flows.length - 1]
  assert.equal(done.status, 'done')
  assert.equal(done.entry.id, entry.id)
  core.close()
})

// ---------------------------------------------------------------- Blackboard browser extension

const http = require('http')
const { createBridgeServer } = require('../electron/services/bridgeServer')

function postJson(port, route, body, origin = 'chrome-extension://abcdefghijklmnop') {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(body)
    const req = http.request({ host: '127.0.0.1', port, path: route, method: 'POST', headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data), Origin: origin } }, res => {
      let out = ''; res.on('data', c => (out += c)); res.on('end', () => resolve({ status: res.statusCode, body: out ? JSON.parse(out) : null }))
    })
    req.on('error', reject); req.end(data)
  })
}

test('bridge server: accepts the extension, refuses web pages', async () => {
  const got = []
  const bridge = createBridgeServer({ onDownload: h => { got.push(h); return { code: 'X' } }, version: '1.0.0' })
  const port = await bridge.listen(0)
  assert.ok(port)
  const ok = await postJson(port, '/download', { fileName: 'a.pdf', courseId: '_1_1', courseTitle: 'T', evil: 'x' })
  assert.equal(ok.status, 200)
  assert.equal(got.length, 1)
  assert.deepEqual(Object.keys(got[0]).sort(), ['courseCode', 'courseId', 'courseTitle', 'fileName', 'path', 'referrer', 'state', 'url'])
  const bad = await postJson(port, '/download', { fileName: 'b.pdf' }, 'https://evil.example')
  assert.equal(bad.status, 403)
  assert.equal(got.length, 1, 'a web page cannot send hints')
  await bridge.close()
})

test('extension: a file with no course in its name is filed under the Blackboard course it came from, and the course is remembered', async () => {
  const { core, docs, events } = makeCore() // no major chosen
  const bridge = createBridgeServer({ onDownload: h => core.addDownloadHint(h), onCourse: h => core.addCourseHint(h) })
  const port = await bridge.listen(0)
  const dl = tmp()

  // what the extension sends when the student downloads from the HCI course page
  const r = await postJson(port, '/download', { fileName: '[f] Week 11 - Design.pptx', path: path.join(dl, '[f] Week 11 - Design.pptx'), courseId: '_90411_1', courseTitle: 'Human Computer Interaction (Fall 2026)' })
  assert.deepEqual(r.body.course, { code: 'ITE 409', name: 'Human Computer Interaction' })

  const info = writeDownload(dl, '[f] Week 11 - Design.pptx', 'Week 11 Design')
  const sug = await core.handleNewFile(info)
  assert.equal(sug.status, 'moved')
  const course = path.join(docs, 'ITE409_HumanComputerInteraction')
  assert.ok(fs.existsSync(path.join(course, 'LectureMaterials', info.name)), 'slides from the course go to LectureMaterials')
  const st = stepsOf(events.flows[events.flows.length - 1])
  assert.match(st.course.detail, /ITE 409 Human Computer Interaction · from Blackboard course page/)

  // later, without the extension: the browser's saved source page is enough, because the course id is remembered
  const next = writeDownload(dl, 'Week 12.pptx', 'Week 12')
  const sug2 = await core.handleNewFile({ ...next, sourceUrl: 'https://blackboard.adu.ac.ae/ultra/courses/_90411_1/outline' })
  assert.equal(sug2.status, 'moved')
  assert.ok(fs.existsSync(path.join(course, 'LectureMaterials', next.name)))
  assert.equal(core.extensionStatus().courses, 1)
  await bridge.close(); core.close()
})

test('existing course folder without a code is found, renamed to the official name, used, and the rename can be undone', async () => {
  const { core, docs, events } = makeCore()
  // the student's own folder, like OneDrive\Documents\HumanComputerInteraction
  const mine = path.join(docs, 'HumanComputerInteraction')
  fs.mkdirSync(path.join(mine, 'Assignment'), { recursive: true })
  fs.writeFileSync(path.join(mine, '5.Chapter 3 - Personas & Scenarios.pptx'), 'x')
  const own = path.join(docs, 'CSC408 My Distributed Notes') // a different course's code: never renamed
  fs.mkdirSync(own)

  core.addDownloadHint({ fileName: '[f] Week 11 - Design.pptx', courseId: '_90411_1', courseTitle: 'Human Computer Interaction' })
  const info = writeDownload(tmp(), '[f] Week 11 - Design.pptx', 'Week 11 Design')
  const sug = await core.handleNewFile(info)

  const official = path.join(docs, 'ITE409_HumanComputerInteraction')
  assert.equal(sug.status, 'moved')
  assert.ok(!fs.existsSync(mine), 'old folder name is gone')
  assert.ok(fs.existsSync(path.join(official, 'Assignment')), 'existing contents kept')
  assert.ok(fs.existsSync(path.join(official, '5.Chapter 3 - Personas & Scenarios.pptx')))
  assert.ok(fs.existsSync(path.join(official, 'LectureMaterials', info.name)), 'file filed inside the renamed folder')
  assert.ok(fs.existsSync(own))
  const st = stepsOf(events.flows[events.flows.length - 1])
  assert.equal(st.courseFolder.detail, 'Renamed “HumanComputerInteraction” → “ITE409_HumanComputerInteraction”')

  const rename = core.activity().find(e => e.type === 'rename')
  assert.ok(rename)
  await core.undo(rename.id)
  assert.ok(fs.existsSync(path.join(mine, 'LectureMaterials', info.name)), 'undo restores the original folder name')
  core.close()
})

test('a two-letter acronym folder ("AI") is recognised as the course, renamed and used', async () => {
  const { core, docs } = makeCore()
  const mine = path.join(docs, 'AI')
  fs.mkdirSync(mine); fs.writeFileSync(path.join(mine, 'Week 1 - Introduction and History.pptx'), 'x')
  fs.mkdirSync(path.join(docs, 'ICT_AI')) // a different thing that only contains "AI": left alone
  core.addDownloadHint({ fileName: 'Week 4 Supervised learning.pptx', courseId: '_88012_1', courseTitle: 'CSC 406 Artificial Intelligence' })
  const info = writeDownload(tmp(), 'Week 4 Supervised learning.pptx', 'Supervised learning')
  const sug = await core.handleNewFile(info)
  const official = path.join(docs, 'CSC406_ArtificialIntelligence')
  assert.equal(sug.status, 'moved')
  assert.ok(!fs.existsSync(mine), 'AI was renamed, not duplicated')
  assert.ok(fs.existsSync(path.join(official, 'Week 1 - Introduction and History.pptx')), 'existing files kept')
  assert.ok(fs.existsSync(path.join(official, 'LectureMaterials', info.name)))
  assert.ok(fs.existsSync(path.join(docs, 'ICT_AI')))
  core.close()
})

test('a folder whose name says nothing is found by the course files already inside it', async () => {
  const { core, docs } = makeCore()
  const mine = path.join(docs, 'Uni Stuff')
  fs.mkdirSync(mine)
  fs.writeFileSync(path.join(mine, 'Week 2 Data Quality and Preprocessing.pptx'), 'x')
  core.addDownloadHint({ fileName: 'Week 2 Data Quality and Preprocessing (1).pptx', courseId: '_88012_1', courseTitle: 'CSC 406 Artificial Intelligence' })
  const info = writeDownload(tmp(), 'Week 2 Data Quality and Preprocessing (1).pptx', 'Data quality')
  const sug = await core.handleNewFile(info)
  assert.equal(sug.status, 'moved')
  const official = path.join(docs, 'CSC406_ArtificialIntelligence')
  assert.ok(fs.existsSync(path.join(official, 'LectureMaterials', info.name)), 'filed in the folder that already had the course\'s file (renamed)')
  assert.ok(fs.existsSync(path.join(official, 'Week 2 Data Quality and Preprocessing.pptx')))
  assert.match(sug.primary.reason, /already has this file/)

  // a folder holding several courses is used by code evidence but never renamed
  const { core: core2, docs: docs2 } = makeCore()
  const mixed = path.join(docs2, 'Semester Files')
  fs.mkdirSync(mixed)
  for (const n of ['CSC406 quiz 1.pdf', 'CSC406 notes.pdf', 'ITE409 report.docx']) fs.writeFileSync(path.join(mixed, n), 'x')
  core2.addDownloadHint({ fileName: 'Week 9 Search.pptx', courseId: '_88012_1', courseTitle: 'CSC 406 Artificial Intelligence' })
  const info2 = writeDownload(tmp(), 'Week 9 Search.pptx', 'Search')
  const sug2 = await core2.handleNewFile(info2)
  assert.equal(sug2.status, 'moved')
  assert.ok(fs.existsSync(path.join(mixed, 'LectureMaterials', info2.name)))
  core.close(); core2.close()
})

test('no message from the extension for a download: the Blackboard course you had open is used', async () => {
  const { core, docs } = makeCore()
  fs.mkdirSync(path.join(docs, 'AI'))
  core.addCourseHint({ courseId: '_88012_1', courseTitle: 'Artificial Intelligence_102_AD_2025-2026 SPR' }) // the course page is open
  const info = writeDownload(tmp(), '3. Intelligent Agents.pptx', 'Intelligent agents')
  const sug = await core.handleNewFile({ ...info, sourceUrl: 'https://blackboard.adu.ac.ae/' })
  assert.equal(sug.status, 'moved')
  assert.ok(fs.existsSync(path.join(docs, 'CSC406_ArtificialIntelligence', 'LectureMaterials', info.name)))
  // ...but not for a file from somewhere else, nor one naming another course
  const other = writeDownload(tmp(), 'ITE409 Week 2.pptx', 'Personas')
  const sug2 = await core.handleNewFile({ ...other, sourceUrl: 'https://blackboard.adu.ac.ae/' })
  assert.equal(sug2.signals.course.code, 'ITE 409')
  core.close()
})

test('re-downloading a file you already have: its folder ("AI") tells the course', async () => {
  const { core, docs } = makeCore()
  fs.mkdirSync(path.join(docs, 'AI'))
  fs.writeFileSync(path.join(docs, 'AI', '2. Week3 Chapter 2 - Intelligent Agents - students copy.pptx'), 'old')
  const info = writeDownload(tmp(), '2. Week3 Chapter 2 - Intelligent Agents - students copy.pptx', 'Intelligent agents')
  const sug = await core.handleNewFile(info)
  assert.equal(sug.status, 'moved')
  assert.equal(sug.signals.course.code, 'CSC 406')
  assert.ok(fs.existsSync(path.join(docs, 'CSC406_ArtificialIntelligence', 'LectureMaterials', info.name)))
  core.close()
})

test('after filing, KoolMate offers to sort the loose files in the course folder; nothing moves until you say yes', async () => {
  const { core, docs, events } = makeCore()
  const mine = path.join(docs, 'OperatingSystem')
  fs.mkdirSync(path.join(mine, 'Assignment'), { recursive: true })
  const put = (n, ...lines) => fs.writeFileSync(path.join(mine, n), lines.join('\n') || 'x')
  put('Week 1 - Introduction to OS.pptx'); put('Chapter 3 Processes.pptx')
  put('Assignment 2 - Scheduling.docx'); put('Lab 4 Threads.pdf'); put('random thoughts.txt', 'hello')
  fs.mkdirSync(path.join(mine, 'Old')); fs.writeFileSync(path.join(mine, 'Old', 'Lecture 9.pptx'), 'x') // already in a subfolder: left alone

  core.addDownloadHint({ fileName: 'Chapter 5 Memory.pptx', courseId: '_7_1', courseTitle: 'CSC 308 Operating Systems' })
  const info = writeDownload(tmp(), 'Chapter 5 Memory.pptx', 'Memory management')
  const sug = await core.handleNewFile(info)
  assert.equal(sug.status, 'moved')
  const course = path.join(docs, 'CSC308_OperatingSystems')
  const flow = events.flows[events.flows.length - 1]
  const offer = flow.tidy
  assert.ok(offer, 'the pop-up asks about the other files')
  assert.equal(offer.count, 4)
  assert.equal(offer.counts.LectureMaterials, 2)
  assert.equal(offer.counts.Assignment, 1, 'reuses the student\'s own "Assignment" folder')
  assert.equal(offer.counts.Labs, 1)
  assert.equal(offer.unclear, 1)
  assert.ok(fs.existsSync(path.join(course, 'Chapter 3 Processes.pptx')), 'nothing moved before saying yes')

  const r = await core.applyTidy(offer.id)
  assert.equal(r.moved, 4)
  assert.ok(fs.existsSync(path.join(course, 'LectureMaterials', 'Chapter 3 Processes.pptx')))
  assert.ok(fs.existsSync(path.join(course, 'Assignment', 'Assignment 2 - Scheduling.docx')))
  assert.ok(fs.existsSync(path.join(course, 'Labs', 'Lab 4 Threads.pdf')))
  assert.ok(fs.existsSync(path.join(course, 'random thoughts.txt')), 'unclear files stay')
  assert.ok(fs.existsSync(path.join(course, 'Old', 'Lecture 9.pptx')))

  await core.undoBatch(r.batchId)
  assert.ok(fs.existsSync(path.join(course, 'Chapter 3 Processes.pptx')), 'Undo all puts them back')

  // asked once per course
  core.addDownloadHint({ fileName: 'Chapter 6.pptx', courseId: '_7_1', courseTitle: 'CSC 308 Operating Systems' })
  await core.handleNewFile(writeDownload(tmp(), 'Chapter 6.pptx', 'Deadlocks'))
  assert.equal(events.flows[events.flows.length - 1].tidy, null)
  core.close()
})

test('a Blackboard page heading is never mistaken for the course, nor replaces a known one', async () => {
  const { core } = makeCore()
  assert.deepEqual(core.addCourseHint({ courseId: '_91170_1', courseTitle: 'ITE 442 Data Science and Big Data Analytics' }), { code: 'ITE 442', name: 'Data Science and Big Data Analytics' })
  // an assignment page whose only heading is the assignment title
  assert.deepEqual(core.addCourseHint({ courseId: '_91170_1', courseTitle: 'Term Project - Report Submission' }), { code: 'ITE 442', name: 'Data Science and Big Data Analytics' })
  assert.equal(core.addCourseHint({ courseId: '_5_1', courseTitle: 'Term Project - Report Submission' }), null)
  core.close()
})

test('the file content decides the type when the name is wrong (named Lecture, actually an activity)', async () => {
  const { core, docs } = makeCore({ major: SWE })
  const info = writeDownload(tmp(), 'CSC301_Lecture05.pdf', 'In-Class Activity 3: Build a Heap', ['Work in groups of three', 'Time: 20 minutes', 'Discuss with your group and submit one answer'])
  const sug = await core.handleNewFile(info)
  assert.equal(sug.status, 'moved')
  assert.ok(fs.existsSync(path.join(docs, 'CSC301_DataStructuresAndAlgorithms', 'Activities', info.name)))
  assert.match(sug.analysis.summary + ' ' + JSON.stringify(sug.signals), /Activities/)
  core.close()
})

test('a folder with the student\'s own short name ("Big Data") is recognised as the course, renamed and used', async () => {
  const { core, docs, events } = makeCore()
  const mine = path.join(docs, 'Big Data')
  fs.mkdirSync(mine); fs.writeFileSync(path.join(mine, 'hadoop notes.txt'), 'x')
  fs.mkdirSync(path.join(docs, 'HCI'))
  core.addDownloadHint({ fileName: 'Week 3.pdf', courseId: '_2_1', courseTitle: 'Data Science and Big Data Analytics' })
  const info = writeDownload(tmp(), 'Week 3.pdf', 'Lecture 3: Hadoop and MapReduce', ['Learning outcomes', 'Slides'])
  const sug = await core.handleNewFile(info)
  const official = path.join(docs, 'ITE442_DataScienceAndBigDataAnalytics')
  assert.equal(sug.status, 'moved')
  assert.ok(!fs.existsSync(mine))
  assert.ok(fs.existsSync(path.join(official, 'hadoop notes.txt')), 'existing contents kept')
  assert.ok(fs.existsSync(path.join(official, 'LectureMaterials', info.name)))
  assert.equal(stepsOf(events.flows[events.flows.length - 1]).courseFolder.detail, 'Renamed “Big Data” → “ITE442_DataScienceAndBigDataAnalytics”')

  // initials work too: "HCI" -> ITE 409 Human Computer Interaction
  core.addDownloadHint({ fileName: 'Week 12.pptx', courseId: '_90411_1', courseTitle: 'Human Computer Interaction' })
  const hci = writeDownload(tmp(), 'Week 12.pptx', 'Week 12')
  await core.handleNewFile(hci)
  assert.ok(fs.existsSync(path.join(docs, 'ITE409_HumanComputerInteraction', 'LectureMaterials', hci.name)))
  assert.ok(!fs.existsSync(path.join(docs, 'HCI')))
  core.close()
})

test('a task sheet named "Lecture 0" (rules + questions) is filed as an activity; real lecture slides stay lectures', async () => {
  const { core, docs } = makeCore({ major: SWE })
  const sheet = writeDownload(tmp(), 'CSC301 - Lecture 0.pdf', 'CSC301 - Lecture 0 - Independent Learning', [
    'Part 1:', 'Rules:', 'When the question asks you to Google, include a screenshot of the search',
    'List the concepts you already took in another course', 'Search the definition of each block using any AI tool',
    'Google the difference between batch and real-time processing', 'What are the benefits of the visualization step?',
    'Why do you think the visualization step comes last in the flow?', 'Part 2:', 'Use any AI tool to compare the database types'
  ])
  const s1 = await core.handleNewFile(sheet)
  assert.equal(s1.status, 'moved')
  assert.ok(fs.existsSync(path.join(docs, 'CSC301_DataStructuresAndAlgorithms', 'Activities', sheet.name)), 'task sheet -> Activities')

  const slides = writeDownload(tmp(), 'CSC301 - Lecture 4.pdf', 'Lecture 4: Binary Search Trees', ['Learning outcomes', 'What is a binary search tree?', 'Insertion', 'Deletion', 'Traversal orders', 'Summary'])
  const s2 = await core.handleNewFile(slides)
  assert.ok(fs.existsSync(path.join(docs, 'CSC301_DataStructuresAndAlgorithms', 'LectureMaterials', slides.name)), 'slides -> LectureMaterials')
  core.close()
})

test('folders named with just the code ("ITE442") or code + short name ("CSC301-Data Structure") are reused and renamed, never duplicated', async () => {
  const { core, docs, events } = makeCore({ major: SWE })
  fs.mkdirSync(path.join(docs, 'ITE442')); fs.writeFileSync(path.join(docs, 'ITE442', 'old notes.txt'), 'x')
  fs.mkdirSync(path.join(docs, 'CSC301-Data Structure', 'Slides'), { recursive: true })
  fs.writeFileSync(path.join(docs, 'CSC301-Data Structure', 'Slides', 'ch1.pptx'), 'x')

  core.addDownloadHint({ fileName: 'Week 5.pdf', courseId: '_2_1', courseTitle: 'Data Science and Big Data Analytics' })
  const a = writeDownload(tmp(), 'Week 5.pdf', 'Lecture 5: Spark', ['Learning outcomes', 'Slides'])
  assert.equal((await core.handleNewFile(a)).status, 'moved')
  const big = path.join(docs, 'ITE442_DataScienceAndBigDataAnalytics')
  assert.ok(!fs.existsSync(path.join(docs, 'ITE442')), 'code-only folder renamed, not duplicated')
  assert.ok(fs.existsSync(path.join(big, 'old notes.txt')))
  assert.ok(fs.existsSync(path.join(big, 'LectureMaterials', a.name)))
  assert.equal(stepsOf(events.flows[events.flows.length - 1]).courseFolder.detail, 'Renamed “ITE442” → “ITE442_DataScienceAndBigDataAnalytics”')

  const b = writeDownload(tmp(), 'CSC301_Lecture2.pdf', 'Lecture 2: Linked Lists', ['Learning outcomes'])
  assert.equal((await core.handleNewFile(b)).status, 'moved')
  const dsa = path.join(docs, 'CSC301_DataStructuresAndAlgorithms')
  assert.ok(!fs.existsSync(path.join(docs, 'CSC301-Data Structure')))
  assert.ok(fs.existsSync(path.join(dsa, 'Slides', 'ch1.pptx')), 'existing contents kept')
  assert.ok(fs.existsSync(path.join(dsa, 'Slides', b.name)), 'lecture goes into the student\'s own "Slides" folder')
  const dirs = fs.readdirSync(docs)
  assert.deepEqual(dirs.filter(d => /ITE442|CSC301/.test(d)).sort(), ['CSC301_DataStructuresAndAlgorithms', 'ITE442_DataScienceAndBigDataAnalytics'])
  core.close()
})

test('OCR (Windows): text in a picture is read and used to decide the type', { skip: process.platform !== 'win32' }, async () => {
  const { readExcerpt } = require('../electron/services/contentReader')
  const { execFileSync } = require('child_process')
  const png = path.join(tmp(), 'IMG_0042.png')
  // draw a slide with text, like a photo of the board or an exported AhaSlides page
  const ps = `Add-Type -AssemblyName System.Drawing; $b = New-Object System.Drawing.Bitmap 1200, 500; $g = [System.Drawing.Graphics]::FromImage($b); $g.Clear([System.Drawing.Color]::White); $f = New-Object System.Drawing.Font('Arial', 40); $g.DrawString('In-class activity: Kahoot quiz', $f, [System.Drawing.Brushes]::Black, 40, 80); $g.DrawString('Work in groups of three', $f, [System.Drawing.Brushes]::Black, 40, 220); $b.Save('${png.replace(/'/g, "''")}'); $g.Dispose(); $b.Dispose()`
  execFileSync('powershell.exe', ['-NoProfile', '-Command', ps])
  const r = await readExcerpt(png)
  assert.equal(r.ok, true, 'picture text was read')
  assert.equal(r.ocr, true)
  assert.match(r.text, /activity/i)
  const smart = require('../electron/services/smartSort')
  const a = smart.understand({ file: { name: 'IMG_0042.png' }, content: r, subjects: [{ code: 'ITE 442', name: 'Data Science and Big Data Analytics', keywords: [] }] })
  assert.equal(a.type, 'Activities')
})
