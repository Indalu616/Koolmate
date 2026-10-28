'use strict'
const { app, BrowserWindow, Tray, Menu, Notification, dialog, ipcMain, nativeImage, safeStorage, screen, shell } = require('electron')
const path = require('path')
const fs = require('fs')
const { createStore } = require('./services/store')
const { createCore } = require('./services/core')

const isDev = !!process.env.KOOLMATE_DEV
const ICON = path.join(__dirname, 'assets', 'icon.png')
const TRAY_ICON = path.join(__dirname, 'assets', 'tray.png')

app.setName('KoolMate')
if (process.platform === 'win32') app.setAppUserModelId('com.koolmate.app')

if (!app.requestSingleInstanceLock()) { app.quit(); process.exit(0) }

let mainWindow = null
let popupWindow = null
let popupReady = false
let popupQueue = []
let popupTimer = null
let tray = null
let quitting = false
let core = null

// ---------------------------------------------------------------------------- windows

function rendererUrl(hash = '') {
  return isDev ? `http://localhost:5173/#${hash}` : null
}
function loadRenderer(win, hash = '/') {
  if (isDev) return win.loadURL(rendererUrl(hash))
  return win.loadFile(path.join(__dirname, '..', 'dist', 'index.html'), { hash })
}

const secure = win => {
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
  win.webContents.on('will-navigate', (e, url) => { if (!url.startsWith('file://') && !url.startsWith('http://localhost:5173')) e.preventDefault() })
}

function send(win, channel, payload) {
  if (win && !win.isDestroyed() && win.webContents && !win.webContents.isDestroyed()) win.webContents.send(channel, payload)
}
const broadcast = (channel, payload) => { send(mainWindow, channel, payload); send(popupWindow, channel, payload) }

function createMainWindow() {
  mainWindow = new BrowserWindow({
    width: 1280, height: 820, minWidth: 1000, minHeight: 660,
    show: false, autoHideMenuBar: true, title: 'KoolMate', icon: ICON,
    backgroundColor: '#0b1220',
    webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true, nodeIntegration: false, sandbox: true }
  })
  secure(mainWindow)
  mainWindow.once('ready-to-show', () => mainWindow.show())
  mainWindow.on('close', e => {
    if (!quitting && core?.settings().runInBackground) {
      e.preventDefault()
      mainWindow.hide()
    }
  })
  loadRenderer(mainWindow, '/')
}

function showMain(route) {
  if (!mainWindow || mainWindow.isDestroyed()) createMainWindow()
  if (mainWindow.isMinimized()) mainWindow.restore()
  mainWindow.show(); mainWindow.focus()
  if (route) send(mainWindow, 'navigate', route)
}

function createPopupWindow() {
  popupReady = false
  popupWindow = new BrowserWindow({
    width: 420, height: 260, show: false, frame: false, resizable: false, movable: true, skipTaskbar: true,
    alwaysOnTop: true, fullscreenable: false, minimizable: false, maximizable: false, title: 'KoolMate',
    backgroundColor: '#0b1220', icon: ICON,
    webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true, nodeIntegration: false, sandbox: true }
  })
  secure(popupWindow)
  popupWindow.setAlwaysOnTop(true, 'floating')
  popupWindow.webContents.once('did-finish-load', () => {
    popupReady = true
    for (const p of popupQueue) send(popupWindow, 'popup:show', p)
    popupQueue = []
  })
  popupWindow.on('closed', () => { popupWindow = null; popupReady = false })
  loadRenderer(popupWindow, '/popup')
}

function positionPopup(height) {
  if (!popupWindow || popupWindow.isDestroyed()) return
  const { workArea } = screen.getPrimaryDisplay()
  const w = 420
  const h = Math.max(150, Math.min(Math.round(height || 260), workArea.height - 40))
  popupWindow.setBounds({ x: workArea.x + workArea.width - w - 16, y: workArea.y + workArea.height - h - 16, width: w, height: h })
}

function showPopup(payload) {
  if (!core.settings().showPopup) return
  if (!popupWindow || popupWindow.isDestroyed()) createPopupWindow()
  if (popupReady) send(popupWindow, 'popup:show', payload); else popupQueue.push(payload)
  positionPopup(260)
  popupWindow.showInactive()
  clearTimeout(popupTimer)
}

function hidePopup() { if (popupWindow && !popupWindow.isDestroyed()) popupWindow.hide() }

function nativeNotify(title, body, route) {
  if (!core.settings().nativeNotifications || !Notification.isSupported()) return
  const n = new Notification({ title, body, icon: ICON, silent: false })
  n.on('click', () => showMain(route))
  n.show()
}

// ---------------------------------------------------------------------------- tray

function buildTray() {
  tray = new Tray(nativeImage.createFromPath(TRAY_ICON))
  tray.setToolTip('KoolMate — watching your downloads')
  const refresh = () => {
    const paused = core.settings().paused
    tray.setContextMenu(Menu.buildFromTemplate([
      { label: 'Open KoolMate', click: () => showMain('/') },
      { label: `Pending downloads: ${core.listSuggestions().length}`, click: () => showMain('/downloads') },
      { type: 'separator' },
      { label: paused ? 'Resume download watching' : 'Pause download watching', click: () => { const s = core.updateSettings({ paused: !paused }); broadcast('settings:changed', publicSettings(s)); refresh() } },
      { type: 'separator' },
      { label: 'Quit KoolMate', click: () => { quitting = true; app.quit() } }
    ]))
  }
  tray.on('click', () => showMain('/'))
  refresh()
  return refresh
}

// ---------------------------------------------------------------------------- ipc

function handle(channel, fn) {
  ipcMain.handle(channel, async (_e, ...args) => {
    try { return { ok: true, data: await fn(...args) } }
    catch (err) { return { ok: false, error: err?.message || String(err) } }
  })
}

const absoluteExisting = p => {
  if (typeof p !== 'string' || !path.isAbsolute(p) || !fs.existsSync(p)) throw new Error('That file or folder no longer exists.')
  return p
}

// The renderer never receives the real API key, only a mask that says "a key is stored".
const KEY_MASK = '••••••••••••'
const publicSettings = s => ({ ...s, geminiApiKey: s.geminiApiKey ? KEY_MASK : '', geminiApiKeyEnc: undefined })

function registerIpc(refreshTray) {
  handle('app:info', () => ({ name: app.getName(), version: app.getVersion(), platform: process.platform, dataDir: path.join(app.getPath('userData'), 'data') }))
  handle('settings:get', () => publicSettings(core.settings()))
  handle('settings:update', patch => {
    const next = { ...(patch || {}) }
    if (next.geminiApiKey === KEY_MASK) delete next.geminiApiKey
    const s = core.updateSettings(next); refreshTray(); return publicSettings(s)
  })
  handle('search:run', text => core.search(String(text || '').slice(0, 500)))
  handle('index:status', () => core.indexStatus())
  handle('index:rebuild', async () => { await core.rebuildIndex(); return core.indexStatus() })
  handle('file:open', async p => { const err = await shell.openPath(absoluteExisting(p)); if (err) throw new Error(err) })
  handle('file:reveal', p => { shell.showItemInFolder(absoluteExisting(p)) })
  handle('dialog:pick-folder', async title => {
    const parent = mainWindow && mainWindow.isVisible() ? mainWindow : undefined
    const r = await dialog.showOpenDialog(parent, { title: title || 'Select a folder', properties: ['openDirectory', 'createDirectory'] })
    return r.canceled ? null : r.filePaths[0]
  })
  handle('suggestions:list', () => core.listSuggestions())
  handle('suggestions:accept', async (id, folder) => { const e = await core.acceptSuggestion(id, folder); refreshTray(); return e })
  handle('suggestions:dismiss', id => { core.dismissSuggestion(id); refreshTray() })
  handle('organize:preview', req => core.organizePreview(req))
  handle('organize:execute', req => core.organizeExecute(req))
  handle('sort:scan', req => core.sortScan(req || {}))
  handle('sort:execute', req => core.sortExecute(req))
  handle('activity:list', () => core.activity())
  handle('activity:undo', id => core.undo(id))
  handle('activity:undo-batch', id => core.undoBatch(id))
  handle('demo:load', () => { const d = core.loadDemo(); broadcast('settings:changed', publicSettings(core.settings())); return { root: d.root, sortFolder: d.sortFolder } })
  handle('demo:simulate', () => core.simulateDownload())
  handle('ai:test', async (key, model) => {
    const k = !key || key === KEY_MASK ? core.settings().geminiApiKey : String(key)
    return { ok: await core.testGemini(k, model) }
  })
  handle('popup:close', () => hidePopup())
  handle('popup:resize', h => positionPopup(Number(h)))
  handle('popup:open-main', route => { hidePopup(); showMain(route || '/downloads') })
}

// ---------------------------------------------------------------------------- lifecycle

app.on('second-instance', () => showMain('/'))
app.on('before-quit', () => { quitting = true })
app.on('activate', () => showMain('/')) // macOS: clicking the Dock icon reopens the window
app.on('window-all-closed', () => { /* keep running in the tray */ })
app.on('will-quit', () => core?.close())

app.whenReady().then(() => {
  // Windows/Linux: no menu bar. macOS needs a minimal menu or Cmd+C/V/Q stop working.
  if (process.platform === 'darwin') {
    Menu.setApplicationMenu(Menu.buildFromTemplate([
      { role: 'appMenu' }, { role: 'editMenu' }, { role: 'windowMenu' }
    ]))
  } else Menu.setApplicationMenu(null)
  const cipher = safeStorage.isEncryptionAvailable()
    ? { encrypt: v => safeStorage.encryptString(v).toString('base64'), decrypt: v => safeStorage.decryptString(Buffer.from(v, 'base64')) }
    : null
  const store = createStore(path.join(app.getPath('userData'), 'data'), cipher)
  let refreshTray = () => {}
  core = createCore({
    store, documentsDir: app.getPath('documents'),
    hooks: {
      onSuggestions: list => { broadcast('suggestions:changed', list); refreshTray() },
      onNewSuggestion: sug => {
        showPopup({ kind: 'suggestion', id: sug.id })
        const dest = path.basename(sug.primary.folder)
        nativeNotify('New download detected', `${sug.file.name} → ${dest}`, '/downloads')
      },
      onAutoMoved: (entry) => {
        showPopup({ kind: 'moved', entry })
        nativeNotify('File organized automatically', `${entry.fileName} → ${path.basename(entry.folder)}`, '/activity')
      },
      onIndex: s => send(mainWindow, 'index:progress', s),
      onTask: e => send(mainWindow, 'task:progress', e),
      onActivity: list => broadcast('activity:changed', list),
      onWatchError: e => console.error('Watcher error:', e.folder, e.error?.message)
    }
  })
  registerIpc(() => refreshTray())
  refreshTray = buildTray()
  createMainWindow()
  core.start()
})
