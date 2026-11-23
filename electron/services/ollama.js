'use strict'
/**
 * Minimal client for a local Ollama server (default http://127.0.0.1:11434). Everything runs on
 * this computer; nothing is sent to the internet. Qwen3 is run with "thinking" disabled for speed,
 * and answers are requested as JSON matching a schema so the Study Buddy can rely on their shape.
 */
const DEFAULT_URL = 'http://127.0.0.1:11434'
const DEFAULT_MODEL = 'qwen3:8b'

class OllamaError extends Error {
  constructor(code, message) { super(message); this.code = code }
}

const stripThink = s => String(s || '').replace(/<think>[\s\S]*?<\/think>/gi, '').trim()

/** Best-effort JSON extraction (models sometimes wrap JSON in fences or prose). */
function parseJson(text) {
  const t = stripThink(text).replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/i, '').trim()
  try { return JSON.parse(t) } catch { /* try to find an object */ }
  const a = t.indexOf('{'), b = t.lastIndexOf('}')
  if (a >= 0 && b > a) { try { return JSON.parse(t.slice(a, b + 1)) } catch { /* fallthrough */ } }
  throw new OllamaError('BAD_JSON', 'The model returned an answer KoolMate could not read. Try again.')
}

function createOllama({ getConfig, fetchImpl = globalThis.fetch }) {
  const cfg = () => {
    const c = getConfig() || {}
    return { url: String(c.url || DEFAULT_URL).replace(/\/+$/, ''), model: c.model || DEFAULT_MODEL }
  }

  async function request(path, { method = 'GET', body, timeoutMs = 600000, signal } = {}) {
    const ctl = new AbortController()
    const timer = setTimeout(() => ctl.abort(), timeoutMs)
    if (signal) signal.addEventListener('abort', () => ctl.abort(), { once: true })
    try {
      const res = await fetchImpl(cfg().url + path, {
        method, signal: ctl.signal,
        headers: body ? { 'Content-Type': 'application/json' } : undefined,
        body: body ? JSON.stringify(body) : undefined
      })
      if (!res.ok) {
        let msg = ''
        try { msg = (await res.json()).error || '' } catch { /* ignore */ }
        if (res.status === 404 && /not found/i.test(msg)) throw new OllamaError('MODEL_MISSING', `The model “${cfg().model}” is not installed. Run: ollama pull ${cfg().model}`)
        throw new OllamaError('HTTP', msg || `Ollama answered with an error (${res.status}).`)
      }
      return res
    } catch (e) {
      if (e instanceof OllamaError) throw e
      if (e.name === 'AbortError') throw new OllamaError('TIMEOUT', 'The local model took too long to answer.')
      throw new OllamaError('DOWN', 'Ollama is not running. Start the Ollama app, then try again.')
    } finally { clearTimeout(timer) }
  }

  /** @returns {{running:boolean, url:string, model:string, hasModel:boolean, models:string[], pullCommand:string}} */
  async function status() {
    const { url, model } = cfg()
    const base = { running: false, url, model, hasModel: false, models: [], pullCommand: `ollama pull ${model}` }
    try {
      const res = await request('/api/tags', { timeoutMs: 4000 })
      const data = await res.json()
      const models = (data.models || []).map(m => m.name || m.model).filter(Boolean)
      const want = model.includes(':') ? model : model + ':latest'
      return { ...base, running: true, models, hasModel: models.some(n => n === model || n === want) }
    } catch { return base }
  }

  /**
   * Chat completion. `schema` (JSON schema) turns on structured output and the result is parsed.
   * `numCtx` raises Ollama's small default context window so whole sections fit.
   */
  async function chat({ system, messages, schema, numCtx = 8192, temperature = 0.3, maxTokens = 1800, signal, onStream }) {
    const { model } = cfg()
    const body = {
      model, stream: !!onStream, think: false,
      // `think:false` needs Ollama 0.9+; Qwen3 also honours a trailing /no_think, which covers older versions.
      messages: [...(system ? [{ role: 'system', content: system }] : []), ...messages.map((m, i) => (/qwen3/i.test(model) && i === messages.length - 1 && m.role === 'user' ? { ...m, content: m.content + ' /no_think' } : m))],
      options: { num_ctx: numCtx, temperature, num_predict: maxTokens }
    }
    if (schema) body.format = schema
    const res = await request('/api/chat', { method: 'POST', body, signal })
    let raw
    if (onStream && res.body) {
      // NDJSON: one JSON object per line, each carrying a piece of the answer
      raw = ''
      onStream({ phase: 'thinking', text: '' })
      const reader = res.body.getReader(); const dec = new TextDecoder(); let buf = ''
      for (;;) {
        const { done, value } = await reader.read()
        const last = done
        if (last) buf += '\n'
        else buf += dec.decode(value, { stream: true })
        let i
        while ((i = buf.indexOf('\n')) >= 0) {
          const line = buf.slice(0, i).trim(); buf = buf.slice(i + 1)
          if (!line) continue
          let j; try { j = JSON.parse(line) } catch { continue }
          if (j.error) throw new OllamaError('HTTP', j.error)
          if (j.message?.content) { raw += j.message.content; onStream({ phase: 'writing', text: stripThink(raw) }) }
        }
        if (last) break
      }
    } else raw = (await res.json())?.message?.content
    const text = stripThink(raw)
    if (!text) throw new OllamaError('EMPTY', 'The model returned an empty answer. Try again.')
    return schema ? parseJson(text) : text
  }

  return { status, chat, config: cfg }
}

module.exports = { createOllama, OllamaError, parseJson, stripThink, DEFAULT_URL, DEFAULT_MODEL }
