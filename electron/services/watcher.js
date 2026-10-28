'use strict'
const fs = require('fs')
const path = require('path')
const { EventEmitter } = require('events')
const { isTempName } = require('./common')

/**
 * Watches folders (typically Downloads) and emits 'file' once a *new* file has finished downloading.
 * Browsers write to temporary names (.crdownload, .part) and rename when done; we ignore those and
 * additionally wait until the file size stops changing.
 */
class DownloadWatcher extends EventEmitter {
  constructor({ stableMs = 1500, pollMs = 700, maxWaitMs = 10 * 60 * 1000 } = {}) {
    super()
    this.stableMs = stableMs
    this.pollMs = pollMs
    this.maxWaitMs = maxWaitMs
    this.watchers = new Map()   // folder -> FSWatcher
    this.pending = new Map()    // full path -> timer
    this.seen = new Set()       // paths already announced (path|mtime)
    this.paused = false
  }

  sync(folders) {
    const want = new Set(folders.map(f => path.resolve(f)))
    for (const [f, w] of this.watchers) if (!want.has(f)) { w.close(); this.watchers.delete(f) }
    for (const f of want) {
      if (this.watchers.has(f)) continue
      try {
        const w = fs.watch(f, { persistent: true }, (evt, name) => { if (name) this._onEvent(f, name.toString()) })
        w.on('error', err => { this.emit('error', { folder: f, error: err }); this.watchers.delete(f) })
        this.watchers.set(f, w)
      } catch (err) {
        this.emit('error', { folder: f, error: err })
      }
    }
    return Array.from(this.watchers.keys())
  }

  setPaused(p) { this.paused = !!p }
  get active() { return Array.from(this.watchers.keys()) }

  _onEvent(folder, name) {
    if (this.paused || isTempName(name)) return
    const full = path.join(folder, name)
    if (this.pending.has(full)) return
    this._waitUntilStable(full, 0, -1, 0)
  }

  _waitUntilStable(full, waited, lastSize, stableFor) {
    const timer = setTimeout(async () => {
      let st
      try { st = await fs.promises.stat(full) } catch { this.pending.delete(full); return }  // vanished (e.g. temp rename)
      if (!st.isFile()) { this.pending.delete(full); return }
      if (st.size === lastSize) stableFor += this.pollMs; else stableFor = 0
      if (stableFor >= this.stableMs && st.size > 0) {
        this.pending.delete(full)
        const key = `${full}|${Math.floor(st.mtimeMs)}`
        if (this.seen.has(key)) return
        this.seen.add(key)
        if (this.seen.size > 5000) this.seen.clear()
        this.emit('file', { path: full, name: path.basename(full), size: st.size, mtime: st.mtimeMs })
        return
      }
      if (waited > this.maxWaitMs) { this.pending.delete(full); return }
      this._waitUntilStable(full, waited + this.pollMs, st.size, stableFor)
    }, this.pollMs)
    this.pending.set(full, timer)
  }

  /** Mark a path as already handled so it is not announced again (e.g. after we moved it). */
  ignore(full) {
    const t = this.pending.get(full)
    if (t) { clearTimeout(t); this.pending.delete(full) }
  }

  close() {
    for (const w of this.watchers.values()) w.close()
    for (const t of this.pending.values()) clearTimeout(t)
    this.watchers.clear(); this.pending.clear()
  }
}

/** Windows stores where a file was downloaded from in an NTFS stream. Returns '' elsewhere/if absent. */
async function readDownloadSource(filePath) {
  if (process.platform !== 'win32') return ''
  try {
    const txt = await fs.promises.readFile(filePath + ':Zone.Identifier', 'utf8')
    const ref = txt.match(/ReferrerUrl=(.+)/)
    const host = txt.match(/HostUrl=(.+)/)
    return (ref?.[1] || host?.[1] || '').trim()
  } catch { return '' }
}

module.exports = { DownloadWatcher, readDownloadSource }
