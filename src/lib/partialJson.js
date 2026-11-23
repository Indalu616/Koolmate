/**
 * Reads the string values out of a JSON document that is still being written, so the UI can show
 * the answer as it streams: '{"explanation":"Hel' -> [{ key: 'explanation', value: 'Hel' }].
 * Keys are strings followed by a colon; every other string is a value of the most recent key.
 */
const UNESCAPE = { n: '\n', t: '\t', r: '', '"': '"', '\\': '\\', '/': '/' }
const unescape = s => s.replace(/\\(u[0-9a-fA-F]{4}|.)/g, (_, c) => (c[0] === 'u' && c.length === 5 ? String.fromCharCode(parseInt(c.slice(1), 16)) : UNESCAPE[c] ?? c))

export function peek(text) {
  const out = []
  const re = /"((?:[^"\\]|\\.)*)("?)(\s*:)?/g
  let m, key = ''
  while ((m = re.exec(text || ''))) {
    const closed = m[2] === '"'
    if (closed && m[3]) { key = unescape(m[1]); continue } // a key
    if (!closed && /^\s*$/.test((text || '').slice(m.index + m[0].length))) { out.push({ key, value: unescape(m[1].replace(/\\$/, '')), partial: true }); break }
    out.push({ key, value: unescape(m[1]) })
  }
  return out
}

export const fields = text => {
  const f = {}
  for (const { key, value } of peek(text)) f[key] = f[key] ? `${f[key]}\n${value}` : value
  return f
}
