'use strict'
/** Creates a self-contained sample workspace so the product can be demonstrated on any machine. */
const fs = require('fs')
const path = require('path')

function makePdf(title, lines = []) {
  const esc = s => String(s).replace(/[\\()]/g, m => '\\' + m)
  const content = ['BT', '/F1 22 Tf', '72 740 Td', `(${esc(title)}) Tj`, '/F1 12 Tf', ...lines.flatMap(l => ['0 -26 Td', `(${esc(l)}) Tj`]), 'ET'].join('\n')
  const objs = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 5 0 R /Resources << /Font << /F1 4 0 R >> >> >>',
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
    `<< /Length ${Buffer.byteLength(content)} >>\nstream\n${content}\nendstream`
  ]
  let out = '%PDF-1.4\n'
  const offsets = []
  objs.forEach((o, i) => { offsets.push(Buffer.byteLength(out)); out += `${i + 1} 0 obj\n${o}\nendobj\n` })
  const xref = Buffer.byteLength(out)
  out += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n` + offsets.map(o => String(o).padStart(10, '0') + ' 00000 n \n').join('')
  out += `trailer\n<< /Size ${objs.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF`
  return Buffer.from(out, 'latin1')
}

const daysAgo = n => Date.now() - n * 86400000

const COURSES = [
  { code: 'CSC308', name: 'Operating Systems', keywords: ['os', 'operating systems'] },
  { code: 'CSC408', name: 'Distributed Systems', keywords: ['ds', 'distributed'] },
  { code: 'CSC302', name: 'Database Management', keywords: ['db', 'dbms', 'database'] },
  { code: 'SWE473', name: 'Software Maintenance and Evolution', keywords: ['maintenance', 'evolution'] },
  { code: 'GEN201', name: 'Genetics', keywords: [] }
]

const semName = (term, year) => `${term} ${year}`
function currentSemesters(now = new Date()) {
  const m = now.getMonth() + 1, y = now.getFullYear()
  const term = m >= 8 ? 'Fall' : m >= 6 ? 'Summer' : 'Spring'
  const prev = term === 'Fall' ? ['Spring', y] : term === 'Spring' ? ['Fall', y - 1] : ['Spring', y]
  return { current: semName(term, y), previous: semName(prev[0], prev[1]) }
}

// [relative path inside "University/<semester>", age in days]. Course folders carry no codes on purpose:
// the engine has to recognise "CSC308" / "OS" / "operating systems" as the same course.
const COURSE_FILES = [
  ['Operating Systems/Lecture Materials/CSC308_Lecture03_Process_Scheduling.pdf', 41],
  ['Operating Systems/Lecture Materials/CSC308_Lecture04_Synchronization.pdf', 33],
  ['Operating Systems/Assignments/CSC308_Assignment1_Threads.pdf', 30],
  ['Operating Systems/Labs/CSC308_Lab02_File_Systems.pdf', 24],
  ['Operating Systems/Exams/CSC308_Midterm_Past_Paper.pdf', 60],
  ['Distributed Systems/Lecture Materials/CSC408_Lecture05_Consensus_Paxos.pdf', 9],
  ['Distributed Systems/Lecture Materials/CSC408_Lecture06_Replication.pdf', 3],
  ['Distributed Systems/Labs/CSC408_Lab02_PubSub_Broker.pdf', 12],
  ['Distributed Systems/Assignments/CSC408_Assignment1_Clocks.pdf', 20],
  ['Database Management/Lecture Materials/CSC302_Lecture02_ER_Modeling.pdf', 45],
  ['Database Management/Lecture Materials/CSC302_Lecture05_Normalization.pdf', 6],
  ['Database Management/Assignments/CSC302_Assignment2_SQL_Queries.pdf', 15],
  ['Software Maintenance and Evolution/Lecture Materials/SWE473_Week2_Legacy_Code.pdf', 14],
  ['Software Maintenance and Evolution/Projects/SWE473_Project_Proposal.pdf', 8]
]
const PREVIOUS_FILES = [
  ['Data Structures/Lecture Materials/Trees_and_Heaps.pdf', 200],
  ['Data Structures/Assignments/Assignment2_Graphs.pdf', 190],
  ['Computer Networks/Lecture Materials/Routing_Protocols.pdf', 210]
]

const PLAIN_FILES = [
  ['Personal/Invoices/electricity_bill_september.pdf', 35],
  ['Personal/Travel/Flight_Itinerary_Doha.pdf', 80],
  // scattered files for the "organize" demo
  ['Scattered/genetics_lecture1_mendel.pdf', 52],
  ['Scattered/Genetics_Lab_Report_Drosophila.pdf', 40],
  ['Scattered/GEN201_Assignment3_Pedigrees.pdf', 18],
  ['Scattered/notes_genetics_midterm_review.pdf', 10],
  ['Scattered/holiday_packing_list.pdf', 70]
]

// Files whose names say nothing; the text inside tells KoolMate what they are.
const MYSTERY_FILES = [
  { rel: 'Sort Me/scan_0042.pdf', age: 2, title: 'Operating Systems', lines: ['Lecture 6: Deadlocks and Recovery', 'Learning outcomes: resource allocation graphs, banker algorithm', 'Fall semester slides'] },
  { rel: 'Sort Me/Document1.pdf', age: 1, title: 'CSC408 Distributed Systems', lines: ['Lab 3: Implementing a publish/subscribe broker', 'Experiment procedure and lab objectives'] },
  { rel: 'Sort Me/untitled.txt', age: 4, title: 'Database Management', lines: ['Midterm exam question paper', 'Time allowed: 90 minutes', 'Question 1: normalise the relation to 3NF. Marks: 10'] },
  { rel: 'Sort Me/Signal_0831.pdf', age: 6, title: 'DEWA electricity bill', lines: ['Invoice for the month of September', 'Amount due: 412 AED. Payment due by the 15th', 'Account balance statement'] },
  { rel: 'Sort Me/WhatsApp Document 2026-10-03.pdf', age: 3, title: 'GEN201 Genetics', lines: ['Assignment 3: Pedigree analysis', 'Submit by Friday. Deadline: end of week'] },
  { rel: 'Sort Me/Software Testing Lecture 1.pdf', age: 5, title: 'Software Testing', lines: ['Lecture 1: Introduction to unit testing'] }
]

const DOWNLOAD_SAMPLES = [
  'CSC408_Lecture07_Replication_and_Consistency.pdf',
  'scan_0108.pdf',
  'CSC302_Assignment3_Query_Optimization.pdf',
  'CSC308_Lab04_Memory_Management.pdf',
  'Document2.pdf',
  'SWE473_Week3_Refactoring_Patterns.pdf',
  'GEN201_Lecture02_Mendelian_Genetics.pdf',
  'Signal.pdf'
]
// Hidden content for generic-named download samples
const DOWNLOAD_CONTENT = {
  'scan_0108.pdf': { title: 'Operating Systems', lines: ['Lecture 7: Memory Management and Paging', 'Learning outcomes and agenda'] },
  'Document2.pdf': { title: 'Database Management', lines: ['Assignment 3: Query optimization', 'Submit by Sunday. Due date: next week'] }
}

function writeSample(file, age, title, lines) {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  if (!fs.existsSync(file)) {
    if (file.endsWith('.txt')) fs.writeFileSync(file, [title, ...lines].join('\n'))
    else fs.writeFileSync(file, makePdf(title, lines))
  }
  const t = new Date(daysAgo(age)); fs.utimesSync(file, t, t)
}

function createDemoWorkspace(documentsDir) {
  const root = path.join(documentsDir, 'KoolMate Demo')
  const sem = currentSemesters()
  const uni = path.join(root, 'University')
  const plain = f => path.basename(f, path.extname(f)).replace(/_/g, ' ')
  for (const [rel, age] of COURSE_FILES) { const f = path.join(uni, sem.current, rel); writeSample(f, age, plain(f), ['KoolMate demo document', 'Generated sample content.']) }
  for (const [rel, age] of PREVIOUS_FILES) { const f = path.join(uni, sem.previous, rel); writeSample(f, age, plain(f), ['KoolMate demo document', 'Generated sample content.']) }
  for (const [rel, age] of PLAIN_FILES) { const f = path.join(root, rel); writeSample(f, age, plain(f), ['KoolMate demo document', 'Generated sample content.']) }
  for (const m of MYSTERY_FILES) writeSample(path.join(root, m.rel), m.age, m.title, m.lines)
  fs.mkdirSync(path.join(root, 'Downloads'), { recursive: true })
  return {
    root, destination: uni, destinations: [uni, path.join(root, 'Personal')], downloads: path.join(root, 'Downloads'),
    sortFolder: path.join(root, 'Sort Me'), courses: COURSES, semester: sem.current
  }
}

let sampleIndex = 0
function simulateDownload(downloadsDir, name) {
  const fileName = name || DOWNLOAD_SAMPLES[sampleIndex++ % DOWNLOAD_SAMPLES.length]
  fs.mkdirSync(downloadsDir, { recursive: true })
  let target = path.join(downloadsDir, fileName)
  if (fs.existsSync(target)) {
    const ext = path.extname(fileName)
    target = path.join(downloadsDir, `${path.basename(fileName, ext)} (${Date.now() % 1000})${ext}`)
  }
  const hidden = DOWNLOAD_CONTENT[fileName]
  const title = hidden ? hidden.title : path.basename(fileName, '.pdf').replace(/_/g, ' ')
  // write in two steps so the watcher's "wait until the download finishes" logic is exercised for real
  const buf = makePdf(title, hidden ? hidden.lines : ['Simulated download', 'Created by KoolMate demo tools.'])
  fs.writeFileSync(target, buf.subarray(0, 200))
  setTimeout(() => { try { fs.appendFileSync(target, buf.subarray(200)) } catch { /* ignore */ } }, 400)
  return target
}

module.exports = { createDemoWorkspace, simulateDownload, makePdf, COURSES, DOWNLOAD_SAMPLES }
