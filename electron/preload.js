'use strict'
const { contextBridge, ipcRenderer } = require('electron')

const EVENTS = new Set(['suggestions:changed', 'index:progress', 'activity:changed', 'popup:show', 'navigate', 'settings:changed', 'task:progress', 'study:stream', 'flow:update'])

async function call(channel, ...args) {
  const res = await ipcRenderer.invoke(channel, ...args)
  if (res && res.ok === false) throw new Error(res.error || 'Unexpected error')
  return res ? res.data : undefined
}

contextBridge.exposeInMainWorld('koolmate', {
  isDesktop: true,
  platform: process.platform,
  app: { info: () => call('app:info') },
  settings: { get: () => call('settings:get'), update: patch => call('settings:update', patch) },
  search: text => call('search:run', text),
  index: { status: () => call('index:status'), rebuild: () => call('index:rebuild') },
  files: { open: p => call('file:open', p), reveal: p => call('file:reveal', p) },
  dialog: { pickFolder: title => call('dialog:pick-folder', title), pickFile: title => call('dialog:pick-file', title) },
  study: {
    status: () => call('study:status'), open: req => call('study:open', req), lesson: req => call('study:lesson', req),
    done: req => call('study:done', req), ask: req => call('study:ask', req), recent: () => call('study:recent'),
    load: id => call('study:load', id), remove: id => call('study:remove', id)
  },
  suggestions: {
    list: () => call('suggestions:list'),
    accept: (id, folder) => call('suggestions:accept', id, folder),
    dismiss: id => call('suggestions:dismiss', id)
  },
  organize: { preview: req => call('organize:preview', req), execute: req => call('organize:execute', req) },
  sort: { scan: req => call('sort:scan', req), execute: req => call('sort:execute', req) },
  tidy: { apply: id => call('tidy:apply', id), dismiss: id => call('tidy:dismiss', id) },
  activity: { list: () => call('activity:list'), undo: id => call('activity:undo', id), undoBatch: id => call('activity:undo-batch', id) },
  catalog: { majors: () => call('catalog:majors') },
  extension: { status: () => call('extension:status'), reveal: () => call('extension:reveal'), openStore: which => call('extension:open-store', which) },
  demo: { load: () => call('demo:load'), simulate: () => call('demo:simulate') },
  ai: { test: (key, model) => call('ai:test', key, model) },
  popup: { close: () => call('popup:close'), resize: h => call('popup:resize', h), openMain: route => call('popup:open-main', route) },
  on(event, cb) {
    if (!EVENTS.has(event)) throw new Error(`Unknown event ${event}`)
    const handler = (_e, payload) => cb(payload)
    ipcRenderer.on(event, handler)
    return () => ipcRenderer.removeListener(event, handler)
  }
})
