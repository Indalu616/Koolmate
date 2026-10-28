export function formatBytes(n) {
  if (!Number.isFinite(n) || n <= 0) return '—'
  const u = ['B', 'KB', 'MB', 'GB', 'TB']
  let i = 0
  while (n >= 1024 && i < u.length - 1) { n /= 1024; i++ }
  return `${n >= 10 || i === 0 ? Math.round(n) : n.toFixed(1)} ${u[i]}`
}

export function timeAgo(ts) {
  const s = Math.max(0, Math.round((Date.now() - ts) / 1000))
  if (s < 45) return 'just now'
  const m = Math.round(s / 60)
  if (m < 60) return `${m} min ago`
  const h = Math.round(m / 60)
  if (h < 24) return `${h} h ago`
  const d = Math.round(h / 24)
  if (d < 30) return `${d} d ago`
  return new Date(ts).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' })
}

export function formatDate(ts) {
  const d = new Date(ts)
  const sameYear = d.getFullYear() === new Date().getFullYear()
  return d.toLocaleDateString(undefined, { day: 'numeric', month: 'short', ...(sameYear ? {} : { year: 'numeric' }) })
}

export function splitPath(p = '') {
  return p.split(/[\\/]+/).filter(Boolean)
}

export function folderLabel(p = '') {
  const parts = splitPath(p)
  return parts[parts.length - 1] || p
}

/** "C:\Users\me\Documents\University\CSC408\Lectures" -> "… › University › CSC408 › Lectures" */
export function shortPath(p = '', keep = 3) {
  const parts = splitPath(p)
  if (parts.length <= keep) return parts.join(' › ')
  return '… › ' + parts.slice(-keep).join(' › ')
}

const KINDS = {
  pdf: ['PDF', 'bad'], doc: ['Word', 'accent'], docx: ['Word', 'accent'], txt: ['Text', 'muted'], md: ['Text', 'muted'],
  ppt: ['Slides', 'warn'], pptx: ['Slides', 'warn'], key: ['Slides', 'warn'],
  xls: ['Sheet', 'ok'], xlsx: ['Sheet', 'ok'], csv: ['Sheet', 'ok'],
  png: ['Image', 'accent'], jpg: ['Image', 'accent'], jpeg: ['Image', 'accent'], gif: ['Image', 'accent'], webp: ['Image', 'accent'], svg: ['Image', 'accent'],
  mp4: ['Video', 'warn'], mkv: ['Video', 'warn'], mov: ['Video', 'warn'], mp3: ['Audio', 'ok'], wav: ['Audio', 'ok'],
  zip: ['Archive', 'muted'], rar: ['Archive', 'muted'], '7z': ['Archive', 'muted']
}
export function fileKind(ext = '') {
  const k = KINDS[ext.toLowerCase()]
  return k ? { label: k[0], tone: k[1] } : { label: (ext || 'File').toUpperCase().slice(0, 5), tone: 'muted' }
}

export function cleanError(e) {
  return String(e?.message || e || 'Something went wrong').replace(/^Error invoking remote method '[^']+': (Error: )?/, '')
}
