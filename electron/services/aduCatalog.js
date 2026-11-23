'use strict'
/**
 * Abu Dhabi University course catalog (Undergraduate Catalog 2026-2027), bundled with the app.
 *
 * Every catalog course can be recognised by its code ("CSC 408", "CSC408", "csc-408").
 * Recognising a course by its *name* is riskier, since "Internship" or "Deep Learning" can
 * appear in any file, so names are only matched for courses in the student's own major
 * (plus General Education), and never for generic titles shared by many courses.
 */
const data = require('../data/adu-courses.json')

const GENERIC_TITLE = /^(internship|capstone|graduation project|special topics?|selected topics?|undergraduate research|open elective|professional elective|.*\bplacement\b|.*\binternship\b)/i

const GENERAL_EDUCATION = data.programs.find(p => p.college === 'General Education')

function majors() {
  return data.programs
    .filter(p => p !== GENERAL_EDUCATION)
    .map(p => ({ name: p.name, college: p.college, courses: p.courses.length }))
}

const cache = new Map()

/**
 * Courses in the shape the filing engine uses ({code, name, keywords}).
 * Courses of `major` come first and may be matched by name; all others are `codeOnly`.
 */
function subjectsFor(major) {
  const key = major || ''
  if (cache.has(key)) return cache.get(key)
  const program = data.programs.find(p => p.name === major && p !== GENERAL_EDUCATION)
  const mine = program ? [...program.courses, ...GENERAL_EDUCATION.courses] : []
  const mineSet = new Set(mine)
  const namedOnce = new Set()
  const toSubject = code => {
    const name = data.courses[code]
    const lower = name.toLowerCase()
    const byName = mineSet.has(code) && !GENERIC_TITLE.test(name) && !namedOnce.has(lower)
    if (byName) namedOnce.add(lower)
    return { code, name, keywords: [], catalog: true, codeOnly: !byName }
  }
  const ordered = [...new Set([...mine, ...Object.keys(data.courses)])].filter(c => data.courses[c])
  const list = ordered.map(toSubject)
  cache.set(key, list)
  return list
}

const courseTitle = code => data.courses[code] || data.courses[String(code || '').replace(/^([A-Za-z]+)\s*(\d)/, '$1 $2').toUpperCase()] || null

module.exports = { majors, subjectsFor, courseTitle, catalogName: data.catalog }
