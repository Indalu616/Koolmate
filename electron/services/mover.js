'use strict'
const fs = require('fs')
const path = require('path')
const { uid } = require('./common')

const WIN_BLOCK = ['c:\\windows', 'c:\\program files', 'c:\\program files (x86)', 'c:\\programdata', 'c:\\system volume information', 'c:\\$recycle.bin']
const POSIX_BLOCK = ['/etc', '/usr', '/bin', '/sbin', '/boot', '/sys', '/proc', '/dev', '/lib', '/var']

function assertSafeDestination(dir) {
  if (!dir || typeof dir !== 'string') throw new Error('No destination folder was provided.')
  if (!path.isAbsolute(dir)) throw new Error('Destination must be an absolute path.')
  const norm = path.resolve(dir)
  const lower = norm.toLowerCase()
  if (path.parse(norm).root === norm) throw new Error('Refusing to move files into a drive root.')
  if (process.platform === 'win32' || /^[a-z]:\\/i.test(norm)) {
    if (WIN_BLOCK.some(b => lower === b || lower.startsWith(b + '\\'))) throw new Error('That destination is a protected system folder.')
  } else if (POSIX_BLOCK.some(b => norm === b || norm.startsWith(b + '/'))) {
    throw new Error('That destination is a protected system folder.')
  }
  return norm
}

async function exists(p) { try { await fs.promises.access(p); return true } catch { return false } }

/** "report.pdf" -> "report (1).pdf" -> "report (2).pdf"; the original name is never changed otherwise. */
async function uniqueTarget(dir, fileName) {
  let target = path.join(dir, fileName)
  if (!(await exists(target))) return { target, renamed: false }
  const ext = path.extname(fileName)
  const base = path.basename(fileName, ext)
  for (let i = 1; i < 1000; i++) {
    target = path.join(dir, `${base} (${i})${ext}`)
    if (!(await exists(target))) return { target, renamed: true }
  }
  throw new Error('Could not find a free file name in the destination.')
}

async function planMove(source, destFolder) {
  const dest = assertSafeDestination(destFolder)
  const name = path.basename(source)
  const { target, renamed } = await uniqueTarget(dest, name)
  return { from: source, to: target, fileName: name, folder: dest, newFolder: !(await exists(dest)), conflictRenamed: renamed }
}

async function moveFileSafe(from, to) {
  try {
    await fs.promises.rename(from, to)
  } catch (e) {
    if (e.code !== 'EXDEV') throw e
    await fs.promises.copyFile(from, to, fs.constants.COPYFILE_EXCL)
    await fs.promises.unlink(from)
  }
}

/**
 * Moves a file and returns a journal entry that can be undone.
 */
async function executeMove(source, destFolder, meta = {}) {
  if (!(await exists(source))) throw new Error(`File no longer exists: ${path.basename(source)}`)
  const plan = await planMove(source, destFolder)
  await fs.promises.mkdir(plan.folder, { recursive: true })
  await moveFileSafe(plan.from, plan.to)
  return {
    id: uid(), ts: Date.now(), type: 'move', status: 'done',
    from: plan.from, to: plan.to, fileName: plan.fileName, folder: plan.folder,
    createdFolder: plan.newFolder, renamedOnConflict: plan.conflictRenamed,
    ...meta
  }
}

async function undoMove(entry) {
  if (entry.status !== 'done') throw new Error('This move was already undone.')
  if (!(await exists(entry.to))) throw new Error('The moved file can no longer be found (it may have been moved or deleted).')
  const dir = path.dirname(entry.from)
  await fs.promises.mkdir(dir, { recursive: true })
  const { target } = await uniqueTarget(dir, path.basename(entry.from))
  await moveFileSafe(entry.to, target)
  // remove the folder we created for this move if it is now empty
  if (entry.createdFolder) { try { await fs.promises.rmdir(entry.folder) } catch { /* not empty */ } }
  return { restoredTo: target }
}

module.exports = { assertSafeDestination, planMove, executeMove, undoMove, uniqueTarget }
