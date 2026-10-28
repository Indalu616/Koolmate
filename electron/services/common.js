'use strict'
const os = require('os')
const path = require('path')

const TEMP_EXTENSIONS = new Set(['crdownload', 'part', 'tmp', 'download', 'opdownload', 'partial', 'temp', 'ini', 'lnk'])

const SKIP_DIR_NAMES = new Set([
  'node_modules', '.git', '.svn', '.hg', 'appdata', '$recycle.bin', 'windows', 'program files',
  'program files (x86)', 'programdata', 'system volume information', '.cache', '.npm', '.gradle', '.m2',
  '__pycache__', 'venv', '.venv', '.idea', '.vscode', 'library', '.trash', 'snap', 'proc', 'sys', 'dev',
  'dist', 'build', 'target', 'site-packages', '.next', '.nuxt', 'bower_components', 'koolmate demo backup'
])

const STOP_WORDS = new Set([
  'a', 'an', 'the', 'and', 'or', 'of', 'to', 'in', 'on', 'for', 'from', 'with', 'about', 'regarding', 'related',
  'my', 'me', 'i', 'we', 'our', 'your', 'all', 'any', 'every', 'each', 'some', 'that', 'this', 'those', 'these',
  'is', 'are', 'was', 'were', 'be', 'been', 'have', 'has', 'had', 'do', 'does', 'did', 'can', 'could', 'would',
  'please', 'find', 'show', 'search', 'look', 'locate', 'get', 'list', 'give', 'open', 'where', 'what', 'which',
  'need', 'want', 'needed', 'wanted', 'file', 'files', 'folder', 'folders', 'stuff', 'things', 'thing', 'material',
  'materials', 'course', 'courses', 'it', 'them', 'there', 'here', 'at', 'by', 'as', 'into', 'out', 'up', 'down',
  'containing', 'named', 'called', 'something', 'anything', 'everything', 'one', 'ones', 'than', 'then', 'also',
  'last', 'past', 'recent', 'recently', 'week', 'weeks', 'month', 'months', 'day', 'days', 'today', 'yesterday',
  'ago', 'since', 'earlier', 'modified', 'downloaded', 'created', 'saved', 'organize', 'organise', 'sort', 'group',
  'move', 'gather', 'collect', 'bundle', 'tidy', 'put', 'place', 'together', 'under', 'new', 'how', 'when', 'who',
  'ive', "i've", 'got', 'only', 'just', 'most', 'latest', 'newest', 'oldest', 'older', 'newer', 'type', 'kind'
])

function home() { return os.homedir() }

function normalizeSlashes(p) { return String(p || '').replace(/\\/g, '/') }

function tokenize(text) {
  return String(text || '')
    .replace(/([a-z])([A-Z])/g, '$1 $2')       // camelCase -> camel Case
    .replace(/([A-Za-z])(\d)/g, '$1 $2')        // CSC308 -> CSC 308
    .replace(/(\d)([A-Za-z])/g, '$1 $2')
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean)
}

/** Tokens of a name where letter+digit codes are also kept joined: "CSC408" -> ["csc","408","csc408"] */
function tokenizeWithCodes(text) {
  const base = tokenize(text)
  const codes = (String(text || '').match(/[A-Za-z]{2,5}[\s_-]?\d{3,4}[A-Za-z]?/g) || [])
    .map(c => c.replace(/[\s_-]/g, '').toLowerCase())
  return Array.from(new Set([...base, ...codes]))
}

function extOf(name) {
  const i = name.lastIndexOf('.')
  return i > 0 ? name.slice(i + 1).toLowerCase() : ''
}

function isTempName(name) {
  if (!name || name.startsWith('.') || name.startsWith('~$')) return true
  if (name.toLowerCase() === 'desktop.ini' || name.toLowerCase() === 'thumbs.db') return true
  return TEMP_EXTENSIONS.has(extOf(name))
}

function isInside(child, parent) {
  const rel = path.relative(path.resolve(parent), path.resolve(child))
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel))
}

function formatBytes(n) {
  if (!Number.isFinite(n)) return ''
  const u = ['B', 'KB', 'MB', 'GB', 'TB']
  let i = 0
  while (n >= 1024 && i < u.length - 1) { n /= 1024; i++ }
  return `${n >= 10 || i === 0 ? Math.round(n) : n.toFixed(1)} ${u[i]}`
}

function uid() { return Date.now().toString(36) + Math.random().toString(36).slice(2, 8) }

const EXT_CATEGORY = {
  Documents: ['pdf', 'doc', 'docx', 'txt', 'rtf', 'odt', 'md', 'tex'],
  Presentations: ['ppt', 'pptx', 'key', 'odp'],
  Spreadsheets: ['xls', 'xlsx', 'csv', 'ods', 'tsv'],
  Images: ['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp', 'svg', 'heic', 'tiff'],
  Videos: ['mp4', 'mkv', 'mov', 'avi', 'webm', 'wmv'],
  Audio: ['mp3', 'wav', 'flac', 'aac', 'm4a', 'ogg'],
  Archives: ['zip', 'rar', '7z', 'tar', 'gz', 'tgz'],
  Code: ['java', 'js', 'ts', 'py', 'c', 'cpp', 'h', 'cs', 'go', 'rs', 'html', 'css', 'json', 'sql', 'ipynb', 'sh'],
  Installers: ['exe', 'msi', 'dmg', 'deb', 'pkg', 'apk']
}

function categoryOfExt(ext) {
  for (const [cat, list] of Object.entries(EXT_CATEGORY)) if (list.includes(ext)) return cat
  return 'Other'
}

module.exports = {
  TEMP_EXTENSIONS, SKIP_DIR_NAMES, STOP_WORDS, EXT_CATEGORY,
  home, normalizeSlashes, tokenize, tokenizeWithCodes, extOf, isTempName, isInside, formatBytes, uid, categoryOfExt
}
