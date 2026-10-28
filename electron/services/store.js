'use strict'
/**
 * Tiny JSON-file persistence. KoolMate deliberately has no database: everything
 * (settings, activity history, learned folder preferences) is a small JSON file
 * in the app's user-data directory, and never leaves the machine.
 */
const fs = require('fs')
const path = require('path')
const os = require('os')

const DEFAULT_SETTINGS = () => {
  const home = os.homedir()
  return {
    watchedFolders: [path.join(home, 'Downloads')],
    searchRoots: [home],
    excludedFolders: [],
    destinationRoots: [path.join(home, 'Documents')],
    courses: [],
    geminiApiKey: '',
    geminiModel: 'gemini-3-flash-preview',
    aiReadContent: true,
    autoMove: false,
    autoMoveThreshold: 0.9,
    showPopup: true,
    nativeNotifications: true,
    runInBackground: true,
    paused: false,
    theme: 'system',
    demoLoaded: false,
    demoRoot: ''
  }
}

class JsonFile {
  constructor(file, fallback) {
    this.file = file
    this.fallback = fallback
    this.data = this._load()
  }
  _load() {
    try {
      const raw = fs.readFileSync(this.file, 'utf8')
      const parsed = JSON.parse(raw)
      return typeof this.fallback === 'function' ? this._merge(this.fallback(), parsed) : parsed
    } catch {
      return typeof this.fallback === 'function' ? this.fallback() : structuredClone(this.fallback)
    }
  }
  _merge(base, over) {
    if (Array.isArray(base) || typeof base !== 'object' || base === null) return over ?? base
    const out = { ...base }
    for (const k of Object.keys(over || {})) out[k] = over[k]
    return out
  }
  save() {
    fs.mkdirSync(path.dirname(this.file), { recursive: true })
    const tmp = this.file + '.tmp'
    fs.writeFileSync(tmp, JSON.stringify(this.data, null, 2), 'utf8')
    fs.renameSync(tmp, this.file)
  }
}

/**
 * @param {string} dir
 * @param {{encrypt:(s:string)=>string, decrypt:(s:string)=>string}|null} cipher  optional OS-level secret protection
 *   (Electron safeStorage / Windows DPAPI) for the Gemini API key.
 */
function createStore(dir, cipher = null) {
  fs.mkdirSync(dir, { recursive: true })
  const settingsFile = new JsonFile(path.join(dir, 'settings.json'), DEFAULT_SETTINGS)
  if (cipher && settingsFile.data.geminiApiKeyEnc) {
    try { settingsFile.data.geminiApiKey = cipher.decrypt(settingsFile.data.geminiApiKeyEnc) } catch { settingsFile.data.geminiApiKey = '' }
  }
  const saveSettings = () => {
    if (!cipher) return settingsFile.save()
    const plain = settingsFile.data
    settingsFile.data = { ...plain, geminiApiKey: '', geminiApiKeyEnc: plain.geminiApiKey ? cipher.encrypt(plain.geminiApiKey) : '' }
    try { settingsFile.save() } finally { settingsFile.data = plain }
  }
  const activityFile = new JsonFile(path.join(dir, 'activity.json'), { entries: [] })
  const learningFile = new JsonFile(path.join(dir, 'learning.json'), { courseFolders: {}, extFolders: {}, recent: [] })

  return {
    dir,
    getSettings: () => ({ ...settingsFile.data }),
    updateSettings(patch) {
      settingsFile.data = { ...settingsFile.data, ...patch }
      saveSettings()
      return { ...settingsFile.data }
    },

    // ---- activity (undo journal) ----
    listActivity: () => [...activityFile.data.entries].sort((a, b) => b.ts - a.ts),
    addActivity(entry) {
      activityFile.data.entries.push(entry)
      if (activityFile.data.entries.length > 1000) activityFile.data.entries.splice(0, activityFile.data.entries.length - 1000)
      activityFile.save()
      return entry
    },
    getActivity: id => activityFile.data.entries.find(e => e.id === id),
    updateActivity(id, patch) {
      const e = activityFile.data.entries.find(x => x.id === id)
      if (e) { Object.assign(e, patch); activityFile.save() }
      return e
    },

    // ---- learned preferences (stays on this machine) ----
    getLearning: () => learningFile.data,
    learn({ course, ext, folder }) {
      const L = learningFile.data
      if (course) L.courseFolders[course.toLowerCase()] = folder
      if (ext) {
        L.extFolders[ext] = L.extFolders[ext] || {}
        L.extFolders[ext][folder] = (L.extFolders[ext][folder] || 0) + 1
      }
      L.recent = [folder, ...L.recent.filter(f => f !== folder)].slice(0, 8)
      learningFile.save()
    }
  }
}

module.exports = { createStore, DEFAULT_SETTINGS }
