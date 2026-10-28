'use strict'
/**
 * Optional Gemini integration. KoolMate only ever sends short text prompts that contain
 * file names, folder names and the user's own request. By default only names and short excerpts are sent, and excerpts only when 'AI may read excerpts' is on.
 * Every caller has a local fallback, so a missing key or a network error never breaks a feature.
 */
const ENDPOINT = 'https://generativelanguage.googleapis.com/v1beta/models'

async function generateJson({ apiKey, model, prompt, timeoutMs = 12000, image = null }) {
  if (!apiKey) throw new Error('No Gemini API key configured.')
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), timeoutMs)
  try {
    const res = await fetch(`${ENDPOINT}/${encodeURIComponent(model)}:generateContent`, {
      method: 'POST',
      signal: ctrl.signal,
      headers: { 'Content-Type': 'application/json', 'x-goog-api-key': apiKey },
      body: JSON.stringify({
        contents: [{ parts: image ? [{ text: prompt }, { inline_data: { mime_type: image.mime, data: image.data } }] : [{ text: prompt }] }],
        generationConfig: { temperature: 0.1, responseMimeType: 'application/json' }
      })
    })
    if (!res.ok) {
      let detail = ''
      try { detail = (await res.json())?.error?.message || '' } catch { /* ignore */ }
      throw new Error(`Gemini returned ${res.status}${detail ? `: ${detail}` : ''}`)
    }
    const body = await res.json()
    const text = body?.candidates?.[0]?.content?.parts?.map(p => p.text || '').join('') || ''
    return parseJsonLoose(text)
  } finally {
    clearTimeout(timer)
  }
}

function parseJsonLoose(text) {
  const cleaned = String(text).replace(/```json|```/gi, '').trim()
  try { return JSON.parse(cleaned) } catch { /* try to find the first JSON object */ }
  const m = cleaned.match(/\{[\s\S]*\}/)
  if (m) return JSON.parse(m[0])
  throw new Error('Gemini returned an unreadable response.')
}

function queryPrompt({ text, courses, today }) {
  const courseList = (courses || []).map(c => `${c.code} = ${c.name}${c.keywords?.length ? ` (aliases: ${c.keywords.join(', ')})` : ''}`).join('\n') || '(none)'
  return `You convert a person's request about finding computer files into a search plan. Today is ${today}.
Known university courses:
${courseList}

Request: "${text}"

Return ONLY JSON with this shape:
{
  "intent": "find" | "organize",
  "keywords": [["main term","synonym","abbreviation"], ["second concept","synonym"]],
  "extensions": ["pdf"],
  "modifiedAfter": "YYYY-MM-DD" or null,
  "modifiedBefore": "YYYY-MM-DD" or null,
  "summary": "short plain-English description of what is being searched"
}
Rules:
- Each inner array is ONE concept with alternative spellings that could appear in a file name (lowercase). Include course codes and common abbreviations (e.g. "operating systems" -> ["operating","os","csc308"]).
- Use "organize" only if the person asks to organize, sort, group, gather or move files.
- Leave "extensions" empty unless a file format is clearly requested.
- Do not include filler words like "find", "files", "my", "all".`
}

function folderPrompt({ fileName, signals, candidates, destinationRoot, sourceUrl }) {
  return `You help a university student file a newly downloaded document into the right folder.
File name: ${fileName}
Download source: ${sourceUrl || 'unknown'}
Detected signals: ${JSON.stringify(signals)}
Existing candidate folders (choose one if suitable):
${candidates.map((c, i) => `${i + 1}. ${c}`).join('\n') || '(none)'}
Folders may also be created under: ${destinationRoot}

Return ONLY JSON: {"folder": "<exact candidate path, or a new absolute path under the folder above>", "confidence": 0.0-1.0, "reason": "one short sentence"}
Never rename the file. Prefer an existing candidate. Use confidence below 0.5 when you are guessing.`
}

async function planQueryAI({ apiKey, model, text, courses, today }) {
  return generateJson({ apiKey, model, prompt: queryPrompt({ text, courses, today }) })
}

async function pickFolderAI({ apiKey, model, fileName, signals, candidates, destinationRoot, sourceUrl }) {
  return generateJson({ apiKey, model, prompt: folderPrompt({ fileName, signals, candidates, destinationRoot, sourceUrl }) })
}

function fileAnalysisPrompt({ fileName, excerpt, mtime, courses, folders, local }) {
  const courseList = (courses || []).map(c => `${c.code || '-'} = ${c.name}`).join('\n') || '(none)'
  const body = excerpt ? `Text excerpt from the file (first part):\n"""\n${excerpt}\n"""` : '(no readable text; judge from the name or the attached image)'
  return `You are the filing brain of a file organizer used by a university student. Work out what this file is.
File name: ${fileName}
Last modified: ${mtime ? new Date(mtime).toISOString().slice(0, 10) : 'unknown'}
${body}
Known courses:
${courseList}
Existing folders (relative paths):
${(folders || []).map(f => '- ' + f).join('\n') || '(none)'}
Local guess: ${JSON.stringify(local || {})}

Return ONLY JSON:
{
  "summary": "max 8 words: what this document is",
  "course": {"code": "e.g. CSC308 or empty", "name": "course name or empty"} or null,
  "docType": "Lectures" | "Assignments" | "Labs" | "Exams" | "Syllabus" | "Projects" | "Notes" | "Readings" | null,
  "semester": {"term": "Fall" | "Spring" | "Summer", "year": 2026} or null,
  "topic": "short topic or category for non-course files (e.g. Finance, Travel, Career) or null",
  "existingFolder": "one path copied EXACTLY from the folder list, or null",
  "confidence": 0.0-1.0
}
Rules: prefer a known course when the content clearly belongs to it; only state a semester if the text says so; never invent facts.`
}

async function analyzeFileAI({ apiKey, model, fileName, excerpt, mtime, courses, folders, local, image }) {
  return generateJson({ apiKey, model, prompt: fileAnalysisPrompt({ fileName, excerpt, mtime, courses, folders, local }), image, timeoutMs: 20000 })
}

async function testKey({ apiKey, model }) {
  const r = await generateJson({ apiKey, model, prompt: 'Return ONLY this JSON: {"ok": true}', timeoutMs: 10000 })
  return r && r.ok === true
}

module.exports = { planQueryAI, pickFolderAI, analyzeFileAI, testKey, parseJsonLoose, queryPrompt, folderPrompt }
