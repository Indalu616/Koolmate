'use strict'
const fs = require('fs')
const path = require('path')
const { SKIP_DIR_NAMES, extOf, isInside } = require('./common')

const MAX_FILES = 400000

/** Remove roots nested inside other roots so nothing is walked twice. */
function dedupeRoots(roots) {
  const abs = Array.from(new Set(roots.filter(Boolean).map(r => path.resolve(r))))
  return abs.filter(r => !abs.some(o => o !== r && isInside(r, o)))
}

class Indexer {
  constructor({ getRoots, getExcluded }) {
    this.getRoots = getRoots
    this.getExcluded = getExcluded
    this.files = []
    this.status = { state: 'idle', count: 0, startedAt: 0, finishedAt: 0, roots: [] }
    this._running = null
    this.onProgress = () => {}
  }

  isStale(maxAgeMs = 5 * 60 * 1000) {
    return this.status.state !== 'ready' || Date.now() - this.status.finishedAt > maxAgeMs
  }

  async ensureFresh() {
    if (this._running) return this._running
    if (this.isStale()) return this.build()
  }

  /**
   * Starts an index run. If one is already running (possibly with a stale view of the disk),
   * schedule exactly one more run afterwards and resolve when that last run has finished.
   */
  build() {
    if (this._running) {
      this._rerun = true
      return this._running
    }
    const run = async () => {
      let status
      do {
        this._rerun = false
        status = await this._walk()
      } while (this._rerun)
      return status
    }
    this._running = run().finally(() => { this._running = null })
    return this._running
  }

  async _walk() {
    const roots = dedupeRoots(this.getRoots())
    const excluded = this.getExcluded().map(e => path.resolve(e))
    const files = []
    this.status = { state: 'indexing', count: 0, startedAt: Date.now(), finishedAt: 0, roots }
    this.onProgress(this.status)
    let tick = 0

    const stack = [...roots]
    while (stack.length && files.length < MAX_FILES) {
      const dir = stack.pop()
      let entries
      try { entries = await fs.promises.readdir(dir, { withFileTypes: true }) } catch { continue }
      for (const ent of entries) {
        const name = ent.name
        if (ent.isSymbolicLink()) continue
        const full = path.join(dir, name)
        if (ent.isDirectory()) {
          if (SKIP_DIR_NAMES.has(name.toLowerCase()) || (name.startsWith('.') && name.length > 1)) continue
          if (excluded.some(ex => isInside(full, ex))) continue
          stack.push(full)
        } else if (ent.isFile()) {
          if (name.startsWith('.') || name.startsWith('~$')) continue
          let st
          try { st = await fs.promises.stat(full) } catch { continue }
          files.push({
            path: full, name, dir, ext: extOf(name), size: st.size, mtime: st.mtimeMs
          })
          if (files.length >= MAX_FILES) break
        }
        if (++tick % 800 === 0) {
          this.status = { ...this.status, count: files.length }
          this.onProgress(this.status)
          await new Promise(r => setImmediate(r))
        }
      }
    }
    this.files = files
    this.status = { state: 'ready', count: files.length, startedAt: this.status.startedAt, finishedAt: Date.now(), roots }
    this.onProgress(this.status)
    return this.status
  }

  /** Cheap incremental update used after we move files ourselves. */
  noteMoved(from, to) {
    const i = this.files.findIndex(f => f.path === from)
    if (i === -1) return
    const f = this.files[i]
    this.files[i] = { ...f, path: to, name: path.basename(to), dir: path.dirname(to) }
  }
  noteAdded(entry) {
    if (!this.files.some(f => f.path === entry.path)) this.files.push(entry)
  }
}

module.exports = { Indexer, dedupeRoots }
