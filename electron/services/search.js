'use strict'
const path = require('path')
const { tokenizeWithCodes, categoryOfExt } = require('./common')

function hasTerm(tokens, tokenSet, term) {
  if (tokenSet.has(term)) return true
  // allow prefix matches for longer terms ("assign" ~ "assignment", "lect" ~ "lecture")
  if (term.length >= 4) {
    for (const t of tokens) if (t.startsWith(term) || (t.length >= 4 && term.startsWith(t))) return true
  }
  return false
}

/**
 * Score every indexed file against the plan. Returns the best `limit` matches.
 */
function searchFiles(files, plan, { limit = 200, now = Date.now() } = {}) {
  const groups = plan.groups || []
  const need = groups.length <= 2 ? groups.length : groups.length - 1
  const exts = plan.extensions?.length ? new Set(plan.extensions) : null
  const results = []

  for (const f of files) {
    if (exts && !exts.has(f.ext)) continue
    if (plan.dateFrom && f.mtime < plan.dateFrom) continue
    if (plan.dateTo && f.mtime >= plan.dateTo) continue

    let score = 0
    let matched = 0
    const reasons = []

    if (groups.length) {
      const nameTokens = tokenizeWithCodes(f.name.replace(/\.[^.]+$/, ''))
      const nameSet = new Set(nameTokens)
      const dirParts = f.dir.split(/[\\/]/).slice(-6)
      const dirTokens = tokenizeWithCodes(dirParts.join(' '))
      const dirSet = new Set(dirTokens)
      for (const g of groups) {
        let best = 0
        let where = ''
        for (let i = 0; i < g.length; i++) {
          const term = g[i]
          const primary = i === 0 ? 1 : 0.8
          if (hasTerm(nameTokens, nameSet, term)) { if (3 * primary > best) { best = 3 * primary; where = `name matches "${term}"` } }
          else if (hasTerm(dirTokens, dirSet, term)) { if (1.6 * primary > best) { best = 1.6 * primary; where = `in folder matching "${term}"` } }
        }
        if (best > 0) { matched++; score += best; reasons.push(where) }
      }
      if (matched < need || matched === 0) continue
    } else if (!exts && !plan.dateFrom && !plan.dateTo) {
      continue // nothing to search for
    }

    if (exts) reasons.push(`${f.ext.toUpperCase()} file`)
    if (plan.dateLabel) reasons.push(`modified ${plan.dateLabel}`)

    const ageDays = Math.max(0, (now - f.mtime) / 86400000)
    score += Math.max(0, 1 - ageDays / 180) * 0.8 // gentle recency tiebreak

    results.push({ ...f, category: categoryOfExt(f.ext), score: Math.round(score * 100) / 100, reasons: Array.from(new Set(reasons)).slice(0, 4) })
  }

  results.sort((a, b) => b.score - a.score || b.mtime - a.mtime)
  return { total: results.length, results: results.slice(0, limit) }
}

module.exports = { searchFiles }
