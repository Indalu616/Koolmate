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


// ---------------------------------------------------------------- full document, by section (Study Buddy)

const MAX_STUDY_PAGES = 300

/** Splits long plain text into labelled parts on blank lines / headings, aiming for ~`size` chars. */
function splitText(text, label, size = 3500) {
  const paras = text.split(/\n{2,}|\r\n\r\n/).map(x => x.trim()).filter(Boolean)
  const out = []
  let cur = ''
  for (const p of paras) {
    if (cur && cur.length + p.length > size) { out.push(cur); cur = '' }
    cur += (cur ? '\n\n' : '') + p
    while (cur.length > size * 1.6) { out.push(cur.slice(0, size)); cur = cur.slice(size) }
  }
  if (cur) out.push(cur)
  return out.map((t, i) => ({ label: out.length > 1 ? `${label} ${i + 1}` : label, text: t }))
}

async function pdfPages(file) {
  const buf = await fs.promises.readFile(file)
  const pdfjs = await loadPdfjs()
  const task = pdfjs.getDocument({ data: new Uint8Array(buf), verbosity: 0, disableFontFace: true, isEvalSupported: false, useSystemFonts: false })
  const doc = await Promise.race([task.promise, new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), 15000))])
  const pages = []
  try {
    for (let i = 1; i <= Math.min(doc.numPages, MAX_STUDY_PAGES); i++) {
      const page = await doc.getPage(i)
      const c = await page.getTextContent()
      const t = squash(c.items.map(x => (x.str || '') + (x.hasEOL ? '\n' : ' ')).join(''))
      if (t.length > 3) pages.push({ label: `Page ${i}`, text: t })
    }
  } finally { doc.destroy().catch(() => {}) }
  return pages
}

/**
 * Reads a whole document as labelled sections (pages / slides / parts) for studying.
 * @returns {{ ok: boolean, kind: string, sections: {label:string, text:string}[], reason?: string }}
 */
async function readSections(file) {
  const ext = extOf(file)
  try {
    const st = await fs.promises.stat(file)
    if (!st.isFile()) return { ok: false, kind: 'other', sections: [], reason: 'not a file' }
    if (IMAGE_EXT.has(ext)) return { ok: false, kind: 'image', sections: [], reason: 'Images cannot be studied yet.' }
    if (st.size > MAX_READ_BYTES) return { ok: false, kind: 'large', sections: [], reason: 'This file is too large to read.' }
    let sections = []
    if (ext === 'pdf') {
      try { sections = await pdfPages(file) } catch { sections = [] }
      if (!sections.length) sections = splitText(squash(rawPdfText(await fs.promises.readFile(file), 400000)), 'Part')
    } else if (ext === 'pptx') {
      const JSZip = require('jszip')
      const zip = await JSZip.loadAsync(await fs.promises.readFile(file))
      const names = Object.keys(zip.files).filter(n => /^ppt\/slides\/slide\d+\.xml$/.test(n)).sort((a, b) => parseInt(a.match(/\d+/)[0]) - parseInt(b.match(/\d+/)[0]))
      for (const n of names) {
        const t = squash(xmlText(await zip.file(n).async('string')))
        if (t.length > 3) sections.push({ label: `Slide ${parseInt(n.match(/\d+/)[0])}`, text: t })
      }
      const notes = Object.keys(zip.files).filter(n => /^ppt\/notesSlides\/notesSlide\d+\.xml$/.test(n))
      for (const n of notes) {
        const idx = parseInt(n.match(/\d+/)[0]); const t = squash(xmlText(await zip.file(n).async('string')))
        const sec = sections.find(x => x.label === `Slide ${idx}`)
        if (sec && t.length > 12) sec.text += '\nSpeaker notes: ' + t
      }
    } else if (ext === 'docx' || ext === 'odt') {
      const JSZip = require('jszip')
      const zip = await JSZip.loadAsync(await fs.promises.readFile(file))
      const f = zip.file(ext === 'docx' ? 'word/document.xml' : 'content.xml')
      const xml = f ? await f.async('string') : ''
      const text = xmlText(xml).replace(/[ \t]+\n/g, '\n').replace(/\n{1}/g, '\n\n')
      sections = splitText(text.replace(/[ \t]+/g, ' ').trim(), 'Part')
    } else if (ext in ZIP_XML) {
      const t = await readZipXml(file, ext, 400000)
      sections = splitText(squash(t), 'Part')
    } else if (TEXT_EXT.has(ext) || (!ext && st.size < 2_000_000)) {
      let text = await fs.promises.readFile(file, 'utf8')
      if (/^(html|htm|xml)$/.test(ext)) text = xmlText(text.replace(/<(script|style)[\s\S]*?<\/\1>/gi, ' '))
      if (ext === 'rtf') text = text.replace(/\\par[d]?/g, '\n').replace(/\{\\\*[^}]*\}/g, '').replace(/\\[a-z]+-?\d* ?/gi, '').replace(/[{}]/g, '')
      text = text.replace(/\u0000/g, ' ').replace(/\r/g, '').trim()
      if (ext === 'md' || ext === 'markdown') { // split on headings
        const parts = text.split(/\n(?=#{1,3} )/).filter(x => x.trim())
        if (parts.length > 1) sections = parts.map(p => ({ label: (p.match(/^#{1,3} +(.+)/) || [])[1]?.trim().slice(0, 60) || 'Section', text: p.trim() }))
      }
      if (!sections.length) sections = splitText(text, 'Part')
    } else return { ok: false, kind: 'binary', sections: [], reason: 'This file type cannot be studied yet.' }
    const total = sections.reduce((n, s) => n + s.text.length, 0)
    if (total < 80) return { ok: false, kind: ext, sections: [], reason: 'No readable text found (is it a scanned document?).' }
    return { ok: true, kind: ext, sections }
  } catch (e) {
    return { ok: false, kind: ext, sections: [], reason: e.message }
  }
}

module.exports = { readExcerpt, readSections, splitText, rawPdfText, IMAGE_EXT }
