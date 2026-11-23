/* In-memory stand-in for the Electron bridge. Only used when running outside the desktop app. */
const DAY = 86400000
const now = Date.now()
const H = '/Users/demo/Documents/KoolMate Demo/University'

const file = (rel, ageDays, size, ext = 'pdf') => {
  const full = `${H}/${rel}`
  const i = full.lastIndexOf('/')
  return { path: full, name: full.slice(i + 1), dir: full.slice(0, i), ext, size, mtime: now - ageDays * DAY }
}

const FILES = [
  file('CSC408 Distributed Systems/Lectures/CSC408_Lecture05_Consensus_Paxos.pdf', 9, 2_340_000),
  file('CSC408 Distributed Systems/Lectures/CSC408_Lecture06_Replication.pdf', 3, 1_890_000),
  file('CSC408 Distributed Systems/Labs/CSC408_Lab02_PubSub_Broker.pdf', 12, 640_000),
  file('CSC408 Distributed Systems/Assignments/CSC408_Assignment1_Clocks.pdf', 20, 410_000),
  file('CSC308 Operating Systems/Lectures/CSC308_Lecture03_Process_Scheduling.pdf', 41, 3_100_000),
  file('CSC308 Operating Systems/Lectures/CSC308_Lecture04_Synchronization.pdf', 33, 2_700_000),
  file('CSC308 Operating Systems/Assignments/CSC308_Assignment1_Threads.pdf', 30, 380_000),
  file('CSC308 Operating Systems/Exams/CSC308_Midterm_Past_Paper.pdf', 60, 520_000),
  file('CSC302 Database Management/Lectures/CSC302_Lecture05_Normalization.pdf', 6, 1_450_000),
  file('CSC302 Database Management/Assignments/CSC302_Assignment2_SQL_Queries.pdf', 15, 300_000),
  file('SWE473 Software Maintenance and Evolution/Projects/SWE473_Project_Proposal.pdf', 8, 880_000),
  { path: '/Users/demo/Documents/KoolMate Demo/Scattered/genetics_lecture1_mendel.pdf', name: 'genetics_lecture1_mendel.pdf', dir: '/Users/demo/Documents/KoolMate Demo/Scattered', ext: 'pdf', size: 1_220_000, mtime: now - 52 * DAY },
  { path: '/Users/demo/Documents/KoolMate Demo/Scattered/Genetics_Lab_Report_Drosophila.pdf', name: 'Genetics_Lab_Report_Drosophila.pdf', dir: '/Users/demo/Documents/KoolMate Demo/Scattered', ext: 'pdf', size: 960_000, mtime: now - 40 * DAY },
  { path: '/Users/demo/Documents/KoolMate Demo/Scattered/GEN201_Assignment3_Pedigrees.pdf', name: 'GEN201_Assignment3_Pedigrees.pdf', dir: '/Users/demo/Documents/KoolMate Demo/Scattered', ext: 'pdf', size: 310_000, mtime: now - 18 * DAY },
  { path: '/Users/demo/Documents/KoolMate Demo/Scattered/notes_genetics_midterm_review.pdf', name: 'notes_genetics_midterm_review.pdf', dir: '/Users/demo/Documents/KoolMate Demo/Scattered', ext: 'pdf', size: 150_000, mtime: now - 10 * DAY }
]

const BASE_SETTINGS = {
  watchedFolders: ['/Users/demo/Downloads', '/Users/demo/Documents/KoolMate Demo/Downloads'],
  searchRoots: ['/Users/demo'],
  excludedFolders: ['/Users/demo/Documents/Personal'],
  destinationRoots: ['/Users/demo/Documents/KoolMate Demo/University'],
  courses: [
    { code: 'CSC308', name: 'Operating Systems', keywords: ['os'] },
    { code: 'CSC408', name: 'Distributed Systems', keywords: ['ds'] },
    { code: 'CSC302', name: 'Database Management', keywords: ['db', 'dbms'] }
  ],
  geminiApiKey: '', geminiModel: 'gemini-3-flash-preview', autoMove: false, autoMoveThreshold: 0.9,
  showPopup: true, nativeNotifications: true, runInBackground: true, paused: false, theme: 'system', demoLoaded: true, demoRoot: '/Users/demo/Documents/KoolMate Demo'
}

const SUGGESTIONS = () => [
  {
    id: 's1', ts: Date.now() - 40_000, status: 'pending', aiAssisted: false,
    file: { path: '/Users/demo/Downloads/CSC408_Lecture07_Replication_and_Consistency.pdf', name: 'CSC408_Lecture07_Replication_and_Consistency.pdf', size: 2_480_000, ext: 'pdf' },
    sourceUrl: 'https://learn.adu.ac.ae/webapps/blackboard/content/listContent.jsp',
    signals: { course: { code: 'CSC408', name: 'Distributed Systems', known: true }, type: 'Lectures', week: 7, source: 'Blackboard', category: 'Documents', semester: 'Fall 2026' }, analysis: { readContent: false },
    primary: { folder: `${H}/Fall 2026/Distributed Systems/Lecture Materials`, isNewFolder: false, confidence: 0.94, reason: 'Distributed Systems · lecture · Fall 2026 · folder already exists' },
    alternatives: [
      { folder: `${H}/CSC408 Distributed Systems/Labs`, confidence: 0.52, reason: 'folder matches course CSC408' },
      { folder: `${H}/CSC408 Distributed Systems`, confidence: 0.47, reason: 'folder matches course CSC408' },
      { folder: `${H}/CSC302 Database Management/Lectures`, confidence: null, reason: 'Recently used' }
    ], needsReview: false, candidatePaths: []
  },
  {
    id: 's2', ts: Date.now() - 3 * 60_000, status: 'pending', aiAssisted: true,
    file: { path: '/Users/demo/Downloads/GEN201_Lecture02_Mendelian_Genetics.pdf', name: 'GEN201_Lecture02_Mendelian_Genetics.pdf', size: 1_120_000, ext: 'pdf' },
    sourceUrl: '', signals: { course: { code: 'GEN201', name: '', known: false }, type: 'Lectures', week: 2, source: null, category: 'Documents' },
    primary: { folder: `${H}/GEN201/Lectures`, isNewFolder: true, confidence: 0.64, reason: 'Detected course code GEN201 · lectures — no folder exists yet, will create one' },
    alternatives: [{ folder: `${H}/CSC302 Database Management/Lectures`, confidence: 0.43, reason: 'lectures folder' }], needsReview: false, candidatePaths: []
  },
  {
    id: 's3', ts: Date.now() - 9 * 60_000, status: 'pending', aiAssisted: false,
    file: { path: '/Users/demo/Downloads/Signal.pdf', name: 'Signal.pdf', size: 845_000, ext: 'pdf' },
    sourceUrl: '', signals: { course: null, type: null, week: null, source: 'WhatsApp', category: 'Documents' },
    primary: { folder: `${H}/To Review/Documents`, isNewFolder: true, confidence: 0.15, reason: 'No course or matching folder detected — please confirm a destination' },
    alternatives: [{ folder: `${H}/CSC308 Operating Systems/Exams`, confidence: null, reason: 'Recently used' }], needsReview: true, candidatePaths: []
  }
]

const ACTIVITY = () => [
  { id: 'a1', ts: Date.now() - 2 * 3600_000, type: 'move', status: 'done', fileName: 'CSC302_Lecture05_Normalization.pdf', from: '/Users/demo/Downloads/CSC302_Lecture05_Normalization.pdf', to: `${H}/CSC302 Database Management/Lectures/CSC302_Lecture05_Normalization.pdf`, folder: `${H}/CSC302 Database Management/Lectures`, source: 'download', reason: 'folder matches course CSC302 · lectures folder', confidence: 0.91 },
  { id: 'a2', ts: Date.now() - 5 * 3600_000, type: 'move', status: 'done', fileName: 'CSC308_Assignment1_Threads.pdf', from: '/Users/demo/Downloads/CSC308_Assignment1_Threads.pdf', to: `${H}/CSC308 Operating Systems/Assignments/CSC308_Assignment1_Threads.pdf`, folder: `${H}/CSC308 Operating Systems/Assignments`, source: 'auto', reason: 'folder matches course CSC308 · assignments folder', confidence: 0.94 },
  ...['genetics_lecture1_mendel.pdf', 'Genetics_Lab_Report_Drosophila.pdf', 'GEN201_Assignment3_Pedigrees.pdf'].map((n, i) => ({
    id: 'b' + i, ts: Date.now() - 26 * 3600_000, type: 'move', status: i === 2 ? 'undone' : 'done', batchId: 'batch1', fileName: n,
    from: `/Users/demo/Documents/KoolMate Demo/Scattered/${n}`, to: `/Users/demo/Documents/Genetics/${i === 1 ? 'Labs' : 'Lectures'}/${n}`, folder: `/Users/demo/Documents/Genetics/${i === 1 ? 'Labs' : 'Lectures'}`, source: 'assistant', reason: 'Find all my Genetics course materials and organize them'
  })),
  { id: 'a6', ts: Date.now() - 2 * DAY, type: 'move', status: 'done', fileName: 'Signal.pdf', from: '/Users/demo/Downloads/Signal.pdf', to: `${H}/CSC308 Operating Systems/Exams/Signal.pdf`, folder: `${H}/CSC308 Operating Systems/Exams`, source: 'download-manual', reason: 'Destination chosen by you' }
]

const STOP = new Set(['find', 'all', 'my', 'the', 'files', 'file', 'for', 'of', 'a', 'and', 'me', 'show', 'course', 'materials', 'organize', 'them', 'from', 'last', 'week'])

export function createMockApi() {
  let settings = structuredClone(BASE_SETTINGS)
  let suggestions = SUGGESTIONS()
  let activity = ACTIVITY()
  const listeners = {}
  const emit = (ev, p) => (listeners[ev] || []).forEach(cb => cb(p))
  const wait = ms => new Promise(r => setTimeout(r, ms))
  const task = async (kind, steps, ms = 420) => {
    for (let i = 0; i < steps.length; i++) { emit('task:progress', { kind, step: steps[i][0], pct: Math.round(((i + 1) / (steps.length + 1)) * 100), detail: steps[i][1] }); await wait(ms) }
  }

  return {
    isDesktop: false, platform: 'web',
    app: { info: async () => ({ name: 'KoolMate', version: '1.0.0', platform: 'preview', dataDir: '~/.koolmate' }) },
    settings: { get: async () => settings, update: async patch => { settings = { ...settings, ...patch }; emit('settings:changed', settings); return settings } },
    search: async text => {
      await task('search', [['understand', text.slice(0, 50)], ['scan', null], ['rank', '18,432 files']], 380)
      const words = text.toLowerCase().split(/[^a-z0-9]+/).filter(w => w && !STOP.has(w))
      const results = FILES.filter(f => words.every(w => `${f.dir}/${f.name}`.toLowerCase().includes(w) || (w === 'pdf' && f.ext === 'pdf') || (w === 'os' && /csc308/i.test(f.name)) || (w === 'operating' && /csc308/i.test(f.name)) || (w === 'systems' && /csc308|csc408/i.test(f.name))))
        .map(f => ({ ...f, category: 'Documents', score: 4.2, reasons: words.slice(0, 2).map(w => `name matches “${w}”`).concat(['PDF file']) }))
      const organize = /organi[sz]e/i.test(text)
      return {
        plan: { intent: organize ? 'organize' : 'find', groups: words.map(w => [w]), extensions: /pdf/i.test(text) ? ['pdf'] : [], typeLabel: /pdf/i.test(text) ? 'PDF' : null, dateLabel: /last week/i.test(text) ? 'last week' : null, courses: /distributed|408/i.test(text) ? [{ code: 'CSC408', name: 'Distributed Systems' }] : [], summary: words.join(', '), source: 'local' },
        total: results.length, results, indexed: 18432, tookMs: 41, aiError: null
      }
    },
    index: { status: async () => ({ state: 'ready', count: 18432, roots: ['/Users/demo'] }), rebuild: async () => { await task('index', [['scan', '6,120 files'], ['scan', '12,904 files'], ['scan', '18,432 files']], 450); return { state: 'ready', count: 18432 } } },
    files: { open: async () => {}, reveal: async () => {} },
    dialog: { pickFolder: async () => '/Users/demo/Documents/Chosen Folder', pickFile: async () => `${H}/CSC308 Operating Systems/Lectures/CSC308_Lecture03_Process_Scheduling.pdf` },
    study: (() => {
      let plan = null
      const lessonFor = (t, mode) => ({
        explanation: mode === 'simpler'
          ? `Think of ${t} like a queue at a coffee shop: everyone gets served in turn, and nobody can be forgotten.`
          : mode === 'deeper'
            ? `${t} matters because the operating system must share one CPU between many programs. Under the hood it relies on timer interrupts and a ready queue, and the trade-off is responsiveness against context-switch overhead.`
            : `${t} is how the operating system decides which process runs next and for how long. A good policy keeps the CPU busy while keeping every program responsive.`,
        example: 'Three processes arrive: P1 needs 5 ms, P2 needs 3 ms, P3 needs 8 ms. With a 4 ms time slice, P1 runs 4 ms, P2 finishes in 3 ms, P3 runs 4 ms, and then P1 finishes its last 1 ms.',
        checkQuestion: `What problem does ${t} solve, and what does it cost?`,
        checkAnswer: 'It shares the CPU fairly between processes; the cost is extra context switches and some waiting for long jobs.'
      })
      const mk = () => ({
        id: 'p1', file: { path: `${H}/CSC308 Operating Systems/Lectures/CSC308_Lecture03_Process_Scheduling.pdf`, name: 'CSC308_Lecture03_Process_Scheduling.pdf', size: 3_100_000, mtime: now }, title: 'Process Scheduling', model: 'qwen3:8b', createdAt: now, sections: 7, truncated: false,
        objectives: ['Explain why an operating system needs a CPU scheduler', 'Compare FCFS, shortest job first and round robin', 'Calculate waiting and turnaround time for a set of processes', 'Choose a time slice and justify the trade-off'],
        progress: { done: 0, total: 5 },
        concepts: [
          ['CPU scheduling', 'high', [], 'Slides 2–5'], ['Process states', 'medium', [], 'Slides 6–8'], ['FCFS and SJF', 'high', ['CPU scheduling'], 'Slides 9–14'], ['Round robin', 'high', ['CPU scheduling'], 'Slides 15–19'], ['Context switching', 'low', ['Process states'], 'Slides 20–22']
        ].map(([title, importance, pre, source], i) => ({ id: 'c' + (i + 1), title, importance, source, done: false, lessons: {}, prerequisites: pre.map(t => ({ id: 'x', title: t })) }))
      })
      const typeJson = async (scope, extra, obj, step = 18) => {
        emit('study:stream', { scope, ...extra, phase: 'thinking', text: '' })
        await wait(900)
        const full = JSON.stringify(obj)
        for (let i = 12; i <= full.length + 12; i += 12) { emit('study:stream', { scope, ...extra, phase: 'writing', text: full.slice(0, i) }); await wait(step) }
      }
      return {
        status: async () => ({ ready: true, provider: 'gemini', running: true, url: 'http://127.0.0.1:11434', model: 'qwen3:8b', hasModel: true, models: ['qwen3:8b'], pullCommand: 'ollama pull qwen3:8b' }),
        open: async () => {
          plan = plan || mk()
          await task('study', [['read', 'CSC308_Lecture03_Process_Scheduling.pdf'], ['sections', 'Read 1 of 4 sections'], ['sections', 'Read 3 of 4 sections']], 500)
          emit('task:progress', { kind: 'study', step: 'objectives', pct: 66, detail: null })
          await typeJson('build', { step: 'objectives' }, { title: plan.title, objectives: plan.objectives })
          emit('task:progress', { kind: 'study', step: 'concepts', pct: 80, detail: null })
          await typeJson('build', { step: 'concepts' }, { concepts: plan.concepts.map(c => ({ title: c.title })) }, 25)
          emit('task:progress', { kind: 'study', step: 'plan', pct: 94, detail: null }); await wait(400)
          return { plan, cached: false }
        },
        lesson: async ({ conceptId, mode }) => { const c = plan.concepts.find(x => x.id === conceptId); const l = lessonFor(c.title, mode); await typeJson('lesson', { conceptId, mode }, l, 22); c.lessons = { ...c.lessons, [mode]: l }; return l },
        done: async ({ conceptId, done }) => { plan.concepts.find(x => x.id === conceptId).done = done; plan.progress = { done: plan.concepts.filter(c => c.done).length, total: plan.concepts.length }; return plan.progress },
        ask: async ({ question }) => { const a = { answer: `According to the slides, this happens because of how the scheduler orders the ready queue. (Mock answer to “${question}”.)`, found: true }; await typeJson('ask', {}, a, 25); return { answer: `According to the slides, this happens because of how the scheduler orders the ready queue. (Mock answer to “${question}”.)`, found: true, sources: ['Slides 9–14', 'Slides 15–19'] } },
        recent: async () => (plan ? [{ id: 'p1', title: plan.title, file: plan.file, progress: plan.progress, lastOpened: now, exists: true }] : []),
        load: async () => plan, remove: async () => {}
      }
    })(),
    suggestions: {
      list: async () => suggestions.filter(s => s.status === 'pending'),
      accept: async (id, folder) => {
        await task('accept', [['move', null], ['save', null]], 380)
        const s = suggestions.find(x => x.id === id); s.status = 'moved'
        const entry = { id: 'n' + Date.now(), ts: Date.now(), type: 'move', status: 'done', fileName: s.file.name, from: s.file.path, to: `${folder || s.primary.folder}/${s.file.name}`, folder: folder || s.primary.folder, source: 'download', reason: s.primary.reason }
        activity = [entry, ...activity]; emit('suggestions:changed', suggestions.filter(x => x.status === 'pending')); return entry
      },
      dismiss: async id => { const s = suggestions.find(x => x.id === id); if (s) s.status = 'dismissed'; emit('suggestions:changed', suggestions.filter(x => x.status === 'pending')) }
    },
    organize: {
      preview: async ({ paths, folderName }) => ({
        destinationRoot: settings.destinationRoots[0], folderName: folderName || 'Genetics', base: `${settings.destinationRoots[0]}/${folderName || 'Genetics'}`,
        items: paths.map((p, i) => ({ from: p, to: `${settings.destinationRoots[0]}/${folderName || 'Genetics'}/${i % 2 ? 'Labs' : 'Lectures'}/${p.split('/').pop()}`, fileName: p.split('/').pop(), sub: i % 2 ? 'Labs' : 'Lectures', size: 100000 }))
      }),
      execute: async ({ items }) => { await task('organize', [['prepare', `${items.length} files`], ...items.map((i, n) => ['move', `${i.fileName} (${n + 1}/${items.length})`]), ['save', null]], 450); return { batchId: 'bx', moved: items.length, failed: [] } }
    },
    sort: {
      scan: async ({ folder }) => {
        await task('sort', [['scan', '6 files · 14 folders'], ['read', 'scan_0042.pdf (1/6)'], ['read', 'untitled.txt (4/6)'], ['understand', 'Document1.pdf (3/6)'], ['understand', 'WhatsApp Document (6/6)'], ['plan', null]], 480)
        const F = 'Fall 2026', U = '/Users/demo/Documents/KoolMate Demo/University'
        const mk = (n, size, ext, an, primary, alts = [], extra = {}) => ({ id: n, from: `${folder}/${n}`, fileName: n, size, mtime: Date.now() - 2 * DAY, ext, analysis: { summary: '', title: '', keywords: [], source: 'local', ...an }, primary, alternatives: alts, needsReview: primary.confidence < 0.55, inPlace: false, ...extra })
        const items = [
          mk('scan_0042.pdf', 310_000, 'pdf', { course: { code: 'CSC308', name: 'Operating Systems', known: true }, type: 'Lectures', semester: F, readContent: true }, { folder: `${U}/${F}/Operating Systems/Lecture Materials`, isNewFolder: false, confidence: 0.96, reason: 'Operating Systems · lecture · Fall 2026 · folder already exists' }),
          mk('Document1.pdf', 280_000, 'pdf', { course: { code: 'CSC408', name: 'Distributed Systems', known: true }, type: 'Labs', semester: F, readContent: true }, { folder: `${U}/${F}/Distributed Systems/Labs`, isNewFolder: false, confidence: 0.91, reason: 'Distributed Systems · lab · Fall 2026 · folder already exists' }),
          mk('Signal_0831.pdf', 120_000, 'pdf', { topic: 'Finance', readContent: true }, { folder: '/Users/demo/Documents/KoolMate Demo/Personal/Invoices', isNewFolder: false, confidence: 0.74, reason: 'Finance · invoices folder' }),
          mk('untitled.txt', 2_000, 'txt', { course: { code: 'CSC302', name: 'Database Management', known: true }, type: 'Exams', semester: F, readContent: true }, { folder: `${U}/${F}/Database Management/Exams`, isNewFolder: true, confidence: 0.82, reason: 'Database Management · exam · Fall 2026 · create “Exams” in your existing course folder' }, [{ folder: `${U}/${F}/Database Management/Assignments`, confidence: 0.4, reason: 'course folder', isNewFolder: false }]),
          mk('WhatsApp Document 2026-10-03.pdf', 95_000, 'pdf', { course: { code: 'GEN201', name: 'Genetics', known: true }, type: 'Assignments', semester: F, readContent: true }, { folder: `${U}/${F}/Genetics/Assignments`, isNewFolder: true, confidence: 0.72, reason: 'Genetics · assignment · Fall 2026 · create “Genetics” in Fall 2026' }),
          mk('IMG_2001.png', 1_800_000, 'png', { readContent: false }, { folder: `${U}/To Review/Images`, isNewFolder: true, confidence: 0.15, reason: 'Could not tell what this is — please choose a folder' }, [], { unreadable: 'image' })
        ]
        return { folder, recursive: false, destinationRoot: U, items, stats: { total: 6, ready: 5, review: 1, newFolders: 3, read: 5, inPlace: 0 } }
      },
      execute: async ({ items }) => { await task('organize', [['prepare', `${items.length} files`], ...items.map((i, n) => ['move', `${i.from.split('/').pop()} (${n + 1}/${items.length})`]), ['save', null]], 450); return { batchId: 'bs', moved: items.length, failed: [] } }
    },
    activity: {
      list: async () => activity,
      undo: async id => { await task('undo', [['restore', null]], 500); activity = activity.map(a => a.id === id ? { ...a, status: 'undone' } : a); emit('activity:changed', activity); return {} },
      undoBatch: async bid => { await task('undo', [['restore', '1/2'], ['restore', '2/2']], 450); activity = activity.map(a => a.batchId === bid && a.status === 'done' ? { ...a, status: 'undone' } : a); emit('activity:changed', activity); return { restored: 2, errors: [] } }
    },
    demo: { load: async () => { await task('demo', [['files', 'Sample course files'], ['settings', null], ['index', null]], 600); return { root: settings.demoRoot } }, simulate: async () => { await task('simulate', [['create', null], ['detect', null], ['analyze', 'CSC408_Lecture07.pdf']], 600); suggestions = [...SUGGESTIONS().slice(0, 1).map(s => ({ ...s, id: 'sim' + Date.now(), ts: Date.now() })), ...suggestions]; emit('suggestions:changed', suggestions.filter(s => s.status === 'pending')); return 'sim' } },
    ai: { test: async () => { await task('ai', [['connect', 'gemini-3-flash-preview'], ['verify', null]], 600); return { ok: true } } },
    popup: { close: async () => {}, resize: async () => {}, openMain: async () => {} },
    on(event, cb) { (listeners[event] = listeners[event] || []).push(cb); return () => { listeners[event] = listeners[event].filter(x => x !== cb) } }
  }
}
