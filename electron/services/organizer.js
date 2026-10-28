'use strict'
const path = require('path')
const { extractSignals } = require('./classifier')

/**
 * Builds a preview for "organize these search results": every file keeps its name and is placed in
 * <destinationRoot>/<folderName>/<Type>/. Nothing is moved until the user confirms.
 */
function planOrganize(files, { destinationRoot, folderName, courses = [] }) {
  const base = path.join(destinationRoot, folderName)
  const taken = new Set()
  const items = []
  for (const f of files) {
    const sig = extractSignals(f.name, { courses })
    const sub = sig.type || (sig.category === 'Documents' || sig.category === 'Presentations' ? 'Other materials' : sig.category)
    const dir = path.join(base, sub)
    let to = path.join(dir, f.name)
    let n = 1
    const ext = path.extname(f.name)
    const stem = path.basename(f.name, ext)
    while (taken.has(to.toLowerCase())) to = path.join(dir, `${stem} (${n++})${ext}`)
    taken.add(to.toLowerCase())
    if (path.resolve(f.path) === path.resolve(to)) continue // already there
    items.push({ from: f.path, to, fileName: f.name, sub, size: f.size })
  }
  return { base, items }
}

module.exports = { planOrganize }
