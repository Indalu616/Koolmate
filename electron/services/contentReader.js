'use strict'
/**
 * Reads a short text excerpt from a file so KoolMate can work out what it is about when the
 * file name says nothing ("scan_0042.pdf"). Reading happens locally; nothing is modified.
 * Supported: plain text/code/markdown/csv/json/html/rtf, PDF, Word (docx), PowerPoint (pptx),
 * Excel (xlsx) and OpenDocument files. Images/audio/video are reported as unreadable (the caller
 * may hand images to the optional AI vision step).
 */
const fs = require('fs')
const zlib = require('zlib')
const { extOf } = require('./common')

const TEXT_EXT = new Set(['txt', 'md', 'markdown', 'csv', 'tsv', 'json', 'log', 'tex', 'html', 'htm', 'xml', 'yml', 'yaml', 'ini', 'rtf',
  'js', 'ts', 'py', 'java', 'c', 'cpp', 'h', 'cs', 'go', 'rs', 'sql', 'sh', 'ipynb', 'css'])
const ZIP_XML = {
  docx: ['word/document.xml'], pptx: null, xlsx: ['xl/sharedStrings.xml'],
  odt: ['content.xml'], odp: ['content.xml'], ods: ['content.xml']
}
const IMAGE_EXT = new Set(['png', 'jpg', 'jpeg', 'webp', 'gif', 'bmp', 'heic'])
const MAX_READ_BYTES = 80 * 1024 * 1024

const decodeEntities = s => s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&#(\d+);/g, (_, n) => String.fromCharCode(+n)).replace(/&amp;/g, '&')
const squash = s => s.replace(/\u0000/g, ' ').replace(/[ \t\r\f\v]+/g, ' ').replace(/\n\s*\n+/g, '\n').trim()
const xmlText = xml => decodeEntities(xml.replace(/<\/(w:p|a:p|text:p|si|row)>/g, '\n').replace(/<[^>]+>/g, ' '))

function unescapePdf(s) {
  return s.replace(/\\([nrtbf()\\])/g, (_, c) => ({ n: '\n', r: '', t: ' ', b: '', f: '' }[c] ?? c)).replace(/\\(\d{3})/g, (_, o) => String.fromCharCode(parseInt(o, 8)))
}

/** Minimal text extraction for simple/uncompressed or Flate-compressed PDFs (fallback when pdf-parse fails). */
function rawPdfText(buf, maxChars) {
  const s = buf.toString('latin1')
  const out = []
  const re = /stream\r?\n([\s\S]*?)\r?\nendstream/g
  let m
  while ((m = re.exec(s)) && out.join(' ').length < maxChars * 2) {
    let body = m[1]
    const head = s.slice(Math.max(0, m.index - 300), m.index)
    if (/FlateDecode/.test(head)) { try { body = zlib.inflateSync(Buffer.from(body, 'latin1')).toString('latin1') } catch { continue } }
    if (!/\b(Tj|TJ)\b/.test(body)) continue
    for (const t of body.matchAll(/\(((?:\\.|[^\\)])*)\)\s*Tj|\[((?:\\.|[^\]])*)\]\s*TJ/g)) {
      if (t[1] != null) out.push(unescapePdf(t[1]))
      else out.push(Array.from(t[2].matchAll(/\(((?:\\.|[^\\)])*)\)/g)).map(x => unescapePdf(x[1])).join(''))
      out.push('\n')
    }
  }
  return out.join(' ')
}

let pdfjsPromise = null
const loadPdfjs = () => (pdfjsPromise ||= import('pdfjs-dist/legacy/build/pdf.mjs'))

async function readPdf(file, maxChars) {
  const buf = await fs.promises.readFile(file)
  let text = ''
  try {
    const pdfjs = await loadPdfjs()
    const task = pdfjs.getDocument({ data: new Uint8Array(buf), verbosity: 0, disableFontFace: true, isEvalSupported: false, useSystemFonts: false })
    const doc = await Promise.race([task.promise, new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), 10000))])
    try {
      for (let i = 1; i <= Math.min(doc.numPages, 4) && text.length < maxChars * 2; i++) {
        const page = await doc.getPage(i)
        const c = await page.getTextContent()
        text += c.items.map(x => (x.str || '') + (x.hasEOL ? '\n' : ' ')).join('') + '\n'
      }
    } finally { doc.destroy().catch(() => {}) }
  } catch { /* fall back below */ }
  if (text.trim().length < 20) text = rawPdfText(buf, maxChars)
  return text
}

async function readZipXml(file, ext, maxChars) {
  const JSZip = require('jszip')
  const zip = await JSZip.loadAsync(await fs.promises.readFile(file))
  let names = ZIP_XML[ext]
  if (!names) { // pptx: slide1..N
    names = Object.keys(zip.files).filter(n => /^ppt\/slides\/slide\d+\.xml$/.test(n)).sort((a, b) => parseInt(a.match(/\d+/)[0]) - parseInt(b.match(/\d+/)[0])).slice(0, 6)
  }
  let text = ''
  for (const n of names) {
    const f = zip.file(n)
    if (f) text += xmlText(await f.async('string')) + '\n'
    if (text.length > maxChars * 2) break
  }
  const core = zip.file('docProps/core.xml')
  if (core) { const t = (await core.async('string')).match(/<dc:title>([^<]*)<\/dc:title>/); if (t?.[1]) text = decodeEntities(t[1]) + '\n' + text }
  return text
}

/**
 * @returns {{ ok: boolean, kind: string, text: string, reason?: string }}
 */
async function readExcerpt(file, { maxChars = 4000 } = {}) {
  const ext = extOf(file)
  try {
    const st = await fs.promises.stat(file)
    if (!st.isFile()) return { ok: false, kind: 'other', text: '', reason: 'not a file' }
    if (IMAGE_EXT.has(ext)) return { ok: false, kind: 'image', text: '', reason: 'image' }
    if (st.size > MAX_READ_BYTES) return { ok: false, kind: 'large', text: '', reason: 'too large to read' }
    let text = ''
    let kind = ext
    if (ext === 'pdf') text = await readPdf(file, maxChars)
    else if (ext in ZIP_XML || ext === 'pptx') text = await readZipXml(file, ext, maxChars)
    else if (TEXT_EXT.has(ext) || (!ext && st.size < 2_000_000)) {
      const fd = await fs.promises.open(file, 'r')
      try { const b = Buffer.alloc(Math.min(st.size, maxChars * 4)); await fd.read(b, 0, b.length, 0); text = b.toString('utf8') } finally { await fd.close() }
      if (/^(html|htm|xml)$/.test(ext)) text = xmlText(text.replace(/<(script|style)[\s\S]*?<\/\1>/gi, ' '))
      if (ext === 'rtf') text = text.replace(/\\par[d]?/g, '\n').replace(/\{\\\*[^}]*\}/g, '').replace(/\\[a-z]+-?\d* ?/gi, '').replace(/[{}]/g, '')
    } else return { ok: false, kind: 'binary', text: '', reason: 'unsupported type' }
    text = squash(text).slice(0, maxChars)
    return text.length >= 12 ? { ok: true, kind, text } : { ok: false, kind, text, reason: 'no readable text (scanned or empty?)' }
  } catch (e) {
    return { ok: false, kind: ext, text: '', reason: e.message }
  }
}

module.exports = { readExcerpt, rawPdfText, IMAGE_EXT }
