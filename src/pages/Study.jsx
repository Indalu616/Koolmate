import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useNavigate, useSearchParams } from 'react-router-dom'
import { GraduationCap, FolderOpen, Check, Circle, CheckCircle2, ChevronRight, Lightbulb, MessageCircleQuestion, RefreshCw, Copy, ExternalLink, FileText, Sparkles, Target, Eye, EyeOff, Send, Wand2, ArrowRight, Server } from 'lucide-react'
import { api } from '../lib/bridge'
import { useApp } from '../state/AppContext'
import { timeAgo } from '../lib/format'
import { fields, peek } from '../lib/partialJson'
import { Badge, Button, Card, CardHeader, EmptyState, FileTile, IconButton, PageHeader, Spinner, cx } from '../components/ui'

const IMPORTANCE = { high: ['bad', 'Key'], medium: ['warn', 'Important'], low: ['neutral', 'Good to know'] }

const BUILD_STEPS = [['read', 'Opening file'], ['sections', 'Reading sections'], ['objectives', 'Writing objectives'], ['concepts', 'Finding key concepts'], ['plan', 'Building plan']]

/** "Thinking…" until the first word arrives, then "Writing…" with a blinking cursor. */
function Status({ live, idle = 'Thinking' }) {
  const writing = live?.phase === 'writing'
  return (
    <span className="inline-flex items-center gap-2 text-xs font-medium text-accent">
      <span className="relative flex h-2 w-2"><span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-accent opacity-60" /><span className="relative inline-flex h-2 w-2 rounded-full bg-accent" /></span>
      {writing ? 'Writing…' : `${idle}…`}
    </span>
  )
}
const Cursor = () => <span className="ml-0.5 inline-block h-[1em] w-[2px] translate-y-[2px] animate-pulse bg-accent" />

function BuildPanel({ live, name }) {
  const idx = Math.max(0, BUILD_STEPS.findIndex(([k]) => k === live.step))
  const items = peek(live.step === 'objectives' || live.step === 'concepts' ? live.text : '').filter(it => it.key !== 'title')
  return (
    <Card>
      <CardHeader title="Building your study plan" description={name} action={<Status live={live} idle={live.step === 'sections' || live.step === 'read' ? 'Reading' : 'Thinking'} />} />
      <div className="space-y-5 px-5 py-5">
        <div className="flex items-center gap-2.5">
          <div className="h-1.5 flex-1 overflow-hidden rounded-full bg-surface2"><div className="h-full rounded-full bg-accent transition-all duration-500" style={{ width: `${Math.max(4, Math.min(100, live.pct || 0))}%` }} /></div>
          <span className="w-9 text-right text-xs tabular-nums text-muted">{Math.round(live.pct || 0)}%</span>
        </div>
        <ol className="grid gap-2 sm:grid-cols-5">
          {BUILD_STEPS.map(([k, label], i) => (
            <li key={k} className={cx('flex items-center gap-2 rounded-lg px-2.5 py-2 text-xs', i < idx ? 'text-ink' : i === idx ? 'bg-accent-soft font-medium text-accent' : 'text-subtle')}>
              {i < idx ? <Check size={13} className="text-ok" /> : <span className={cx('h-1.5 w-1.5 rounded-full', i === idx ? 'bg-accent' : 'bg-line')} />}{label}
            </li>
          ))}
        </ol>
        {live.detail && <p className="text-sm text-muted">{live.detail}</p>}
        <div className="min-h-[120px] rounded-lg border border-line bg-bg px-4 py-3.5">
          {items.length === 0
            ? <p className="text-sm text-subtle">{live.step === 'objectives' || live.step === 'concepts' ? 'Waiting for the first words…' : 'The model will start writing once it has read your file.'}</p>
            : <ul className="space-y-1.5 text-sm text-ink">{items.map((it, i) => <li key={i} className="flex gap-2"><Target size={14} className="mt-1 shrink-0 text-accent" /><span>{it.value}{it.partial && <Cursor />}</span></li>)}</ul>}
        </div>
      </div>
    </Card>
  )
}

function SetupCard({ status, checking, onCheck, model }) {
  const { toast } = useApp()
  const navigate = useNavigate()
  const cmd = status?.pullCommand || `ollama pull ${model}`
  const copy = async () => { try { await navigator.clipboard.writeText(cmd); toast('Command copied.', { type: 'success' }) } catch { /* ignore */ } }
  const running = !!status?.running
  const Step = ({ n, done, title, children }) => (
    <li className="flex gap-3.5">
      <span className={cx('mt-0.5 flex h-6 w-6 shrink-0 items-center justify-center rounded-full text-xs font-semibold', done ? 'bg-ok-soft text-ok' : 'bg-accent-soft text-accent')}>{done ? <Check size={13} /> : n}</span>
      <div className="min-w-0 flex-1"><div className="text-sm font-medium text-ink">{title}</div><div className="mt-1 text-[13px] text-muted">{children}</div></div>
    </li>
  )
  return (
    <Card>
      <CardHeader title="Choose how Study Buddy thinks" description="The quickest way is Gemini. Or run a model privately on this computer with Ollama."
        action={<Badge tone={running ? 'warn' : 'neutral'} icon={Server}>{running ? 'Model missing' : 'Not set up'}</Badge>} />
      <div className="flex items-center justify-between gap-4 border-b border-line px-5 py-4">
        <div><div className="text-sm font-medium text-ink">Use Gemini (recommended)</div><div className="mt-0.5 text-[13px] text-muted">Fast. Uses the key from Settings. The text of the file you study is sent to Google.</div></div>
        <Button variant="primary" onClick={() => navigate('/settings')}>Add key</Button>
      </div>
      <ol className="space-y-5 px-5 py-5">
        <Step n={1} done={running} title="Install and start Ollama">
          Download it from <span className="font-medium text-ink">ollama.com</span> and open the app. It runs quietly in the background.
        </Step>
        <Step n={2} done={status?.hasModel} title={`Download the ${model} model`}>
          Run this once in a terminal (about 5 GB). Use <span className="font-mono text-ink">qwen3:4b</span> on computers with 8 GB of memory or less.
          <div className="mt-2 flex items-center gap-2 rounded-lg border border-line bg-bg px-3 py-2">
            <code className="flex-1 truncate font-mono text-[13px] text-ink">{cmd}</code>
            <IconButton icon={Copy} label="Copy command" onClick={copy} />
          </div>
          {running && status.models.length > 0 && <p className="mt-2">Installed models: {status.models.join(', ')}. You can pick one in Settings.</p>}
        </Step>
      </ol>
      <div className="flex items-center justify-between border-t border-line px-5 py-3.5">
        <p className="text-[13px] text-muted">The rest of KoolMate works without this.</p>
        <Button variant="primary" icon={RefreshCw} loading={checking} onClick={onCheck}>Check again</Button>
      </div>
    </Card>
  )
}

function Picker({ onOpen, recent }) {
  const pick = async () => { const p = await api.dialog.pickFile('Choose a file to study'); if (p) onOpen(p) }
  return (
    <div className="space-y-5">
      <Card className="p-8 text-center">
        <div className="mx-auto flex h-12 w-12 items-center justify-center rounded-2xl bg-accent-soft text-accent"><GraduationCap size={24} /></div>
        <h2 className="mt-4 text-lg font-semibold text-ink">What are we studying?</h2>
        <p className="mx-auto mt-1 max-w-md text-sm text-muted">Pick a lecture, slides or notes. Study Buddy reads it, lists what you should learn, and teaches it concept by concept.</p>
        <div className="mt-5 flex flex-wrap items-center justify-center gap-2">
          <Button variant="primary" size="lg" icon={FolderOpen} onClick={pick}>Choose a file</Button>
        </div>
        <p className="mt-3 text-xs text-subtle">PDF, PowerPoint, Word, text. You can also ask the Assistant: “open OS lecture 6 and help me study”.</p>
      </Card>
      {recent.length > 0 && (
        <Card>
          <CardHeader title="Recent" />
          <ul className="divide-y divide-line">
            {recent.map(r => (
              <li key={r.id}>
                <button disabled={!r.exists} onClick={() => onOpen(r.file.path)} className="flex w-full items-center gap-3 px-5 py-3 text-left transition hover:bg-surface2 disabled:opacity-50">
                  <FileTile ext={r.file.name.split('.').pop()} />
                  <div className="min-w-0 flex-1">
                    <div className="truncate text-sm font-medium text-ink">{r.title}</div>
                    <div className="truncate text-xs text-muted">{r.file.name} · {timeAgo(r.lastOpened)}</div>
                  </div>
                  <Badge tone={r.progress.done === r.progress.total && r.progress.total ? 'ok' : 'neutral'}>{r.progress.done}/{r.progress.total}</Badge>
                  <ChevronRight size={16} className="text-subtle" />
                </button>
              </li>
            ))}
          </ul>
        </Card>
      )}
    </div>
  )
}

function Lesson({ plan, concept, onLesson, onToggle, onNext, hasNext, live }) {
  const [mode, setMode] = useState('normal')
  const [reveal, setReveal] = useState(false)
  useEffect(() => { setMode('normal'); setReveal(false) }, [concept.id])
  const streaming = live?.scope === 'lesson' && live.key === concept.id
  const lesson = streaming ? null : concept.lessons?.[mode]
  const part = streaming ? fields(live.text) : null
  const [tone, label] = IMPORTANCE[concept.importance] || IMPORTANCE.medium
  const go = (m, force) => { setMode(m); setReveal(false); if (!concept.lessons?.[m] || force) onLesson(concept, m, force) }
  useEffect(() => { if (!concept.lessons?.normal) onLesson(concept, 'normal') }, [concept.id]) // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <Card>
      <div className="flex flex-wrap items-start justify-between gap-3 border-b border-line px-5 py-4">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2"><h2 className="text-lg font-semibold text-ink">{concept.title}</h2><Badge tone={tone}>{label}</Badge></div>
          <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted">
            {concept.source && <span className="inline-flex items-center gap-1"><FileText size={12} />From your file · {concept.source}</span>}
            {concept.prerequisites.length > 0 && <span>Needs: {concept.prerequisites.map(p => p.title).join(', ')}</span>}
          </div>
        </div>
        <Button variant={concept.done ? 'secondary' : 'primary'} icon={concept.done ? CheckCircle2 : Check} onClick={() => onToggle(concept)}>{concept.done ? 'Understood' : 'Mark understood'}</Button>
      </div>

      {!lesson ? (
        <div className="space-y-5 px-5 py-5">
          <div className="flex items-center justify-between"><Status live={live} /><span className="text-xs text-subtle">{streaming ? 'Generated live' : ''}</span></div>
          {!part || !part.explanation
            ? <div className="space-y-2"><div className="h-3 w-4/5 animate-pulse rounded bg-surface2" /><div className="h-3 w-3/5 animate-pulse rounded bg-surface2" /><div className="h-3 w-2/3 animate-pulse rounded bg-surface2" /></div>
            : (
              <>
                <section><h3 className="mb-1.5 text-xs font-semibold uppercase tracking-wide text-subtle">Explanation</h3><p className="whitespace-pre-line text-[15px] leading-relaxed text-ink">{part.explanation}{!part.example && <Cursor />}</p></section>
                {part.example && <section className="rounded-lg border border-line bg-bg px-4 py-3.5"><h3 className="mb-1.5 flex items-center gap-2 text-xs font-semibold uppercase tracking-wide text-subtle"><Lightbulb size={13} className="text-accent" />Example <Badge tone="accent" icon={Wand2}>AI-written</Badge></h3><p className="whitespace-pre-line text-sm leading-relaxed text-ink">{part.example}{!part.checkQuestion && <Cursor />}</p></section>}
                {part.checkQuestion && <section className="rounded-lg bg-accent-soft px-4 py-3.5"><h3 className="mb-1.5 flex items-center gap-2 text-xs font-semibold uppercase tracking-wide text-accent"><MessageCircleQuestion size={13} />Check yourself</h3><p className="text-sm font-medium text-ink">{part.checkQuestion}{!part.checkAnswer && <Cursor />}</p></section>}
              </>
            )}
        </div>
      ) : (
        <div className="space-y-5 px-5 py-5">
          <section>
            <h3 className="mb-1.5 text-xs font-semibold uppercase tracking-wide text-subtle">Explanation</h3>
            <p className="whitespace-pre-line text-[15px] leading-relaxed text-ink">{lesson.explanation}</p>
          </section>
          <section className="rounded-lg border border-line bg-bg px-4 py-3.5">
            <h3 className="mb-1.5 flex items-center gap-2 text-xs font-semibold uppercase tracking-wide text-subtle"><Lightbulb size={13} className="text-accent" />Example <Badge tone="accent" icon={Wand2}>AI-written</Badge></h3>
            <p className="whitespace-pre-line text-sm leading-relaxed text-ink">{lesson.example}</p>
          </section>
          <section className="rounded-lg bg-accent-soft px-4 py-3.5">
            <h3 className="mb-1.5 flex items-center gap-2 text-xs font-semibold uppercase tracking-wide text-accent"><MessageCircleQuestion size={13} />Check yourself</h3>
            <p className="text-sm font-medium text-ink">{lesson.checkQuestion}</p>
            {reveal
              ? <p className="mt-2 border-t border-accent/20 pt-2 text-sm text-ink">{lesson.checkAnswer}</p>
              : <Button size="sm" className="mt-2.5" icon={Eye} onClick={() => setReveal(true)}>Show answer</Button>}
            {reveal && <Button size="sm" variant="ghost" className="mt-1" icon={EyeOff} onClick={() => setReveal(false)}>Hide</Button>}
          </section>
        </div>
      )}

      <div className="flex flex-wrap items-center justify-between gap-2 border-t border-line px-5 py-3.5">
        <div className="flex flex-wrap gap-2">
          <Button size="sm" disabled={streaming} variant={mode === 'simpler' ? 'primary' : 'secondary'} onClick={() => go('simpler')}>Simpler</Button>
          <Button size="sm" disabled={streaming} variant={mode === 'deeper' ? 'primary' : 'secondary'} onClick={() => go('deeper')}>Go deeper</Button>
          {mode !== 'normal' && <Button size="sm" variant="ghost" onClick={() => go('normal')}>Original</Button>}
          <Button size="sm" variant="ghost" icon={RefreshCw} onClick={() => go(mode, true)}>Regenerate</Button>
        </div>
        {hasNext && <Button size="sm" icon={ArrowRight} onClick={onNext}>Next concept</Button>}
      </div>
    </Card>
  )
}

function AskBox({ plan, live, begin, end }) {
  const { fail } = useApp()
  const [q, setQ] = useState('')
  const [log, setLog] = useState([])
  const [pending, setPending] = useState('')
  const asking = live?.scope === 'ask'
  const submit = async e => {
    e.preventDefault()
    const question = q.trim()
    if (!question) return
    setQ('')
    try {
      begin('ask', 'ask')
      setPending(question)
      const r = await api.study.ask({ planId: plan.id, question })
      setLog(l => [{ question, ...r }, ...l])
    } catch (err) { fail(err); setQ(question) } finally { end(); setPending('') }
  }
  return (
    <Card>
      <CardHeader title="Ask about this file" description="Answers come only from the file, with where to look." />
      <div className="space-y-3 px-5 py-4">
        <form onSubmit={submit} className="flex gap-2">
          <input className="field flex-1" value={q} onChange={e => setQ(e.target.value)} placeholder="e.g. Why does a deadlock happen?" />
          <Button variant="primary" icon={Send} type="submit" disabled={!q.trim() || asking}>Ask</Button>
        </form>
        {asking && (
          <div className="rounded-lg border border-line bg-bg px-4 py-3">
            <div className="flex items-center justify-between"><div className="text-xs font-semibold text-muted">{pending}</div><Status live={live} /></div>
            {fields(live.text).answer ? <p className="mt-1 whitespace-pre-line text-sm leading-relaxed text-ink">{fields(live.text).answer}<Cursor /></p> : <div className="mt-2 h-3 w-3/5 animate-pulse rounded bg-surface2" />}
          </div>
        )}
        {log.map((m, i) => (
          <div key={i} className="rounded-lg border border-line bg-bg px-4 py-3">
            <div className="text-xs font-semibold text-muted">{m.question}</div>
            <p className="mt-1 whitespace-pre-line text-sm leading-relaxed text-ink">{m.answer}</p>
            {m.sources?.length > 0 && <div className="mt-2 flex flex-wrap gap-1.5">{m.sources.map(s => <Badge key={s} icon={FileText}>{s}</Badge>)}</div>}
            {!m.found && <div className="mt-2"><Badge tone="warn">Not found in this file</Badge></div>}
          </div>
        ))}
      </div>
    </Card>
  )
}

export default function Study() {
  const { fail, toast } = useApp()
  const navigate = useNavigate()
  const [params, setParams] = useSearchParams()
  const [status, setStatus] = useState(null)
  const [checking, setChecking] = useState(false)
  const [plan, setPlan] = useState(null)
  const [activeId, setActiveId] = useState(null)
  const [recent, setRecent] = useState([])
  const opened = useRef(null)
  const [live, setLive] = useState(null) // { scope: 'build'|'lesson'|'ask', key, phase, text, step, pct, detail }
  const liveRef = useRef(null)
  const begin = useCallback((scope, key, extra = {}) => { const v = { scope, key, phase: 'thinking', text: '', step: scope === 'build' ? 'read' : null, pct: 3, detail: null, ...extra }; liveRef.current = v; setLive(v) }, [])
  const end = useCallback(() => { liveRef.current = null; setLive(null) }, [])
  useEffect(() => {
    const off1 = api.on('study:stream', e => {
      const cur = liveRef.current
      if (!cur || cur.scope !== e.scope || (e.scope === 'lesson' && e.conceptId !== cur.key)) return
      const next = { ...cur, phase: e.phase, text: e.text, step: e.step || cur.step }
      liveRef.current = next; setLive(next)
    })
    const off2 = api.on('task:progress', e => {
      const cur = liveRef.current
      if (!cur || cur.scope !== 'build' || e.kind !== 'study') return
      const next = { ...cur, step: e.step || cur.step, pct: e.pct == null ? cur.pct : Math.max(cur.pct, e.pct), detail: e.detail === undefined ? cur.detail : e.detail, text: e.step && e.step !== cur.step ? '' : cur.text, phase: e.step && e.step !== cur.step ? 'thinking' : cur.phase }
      liveRef.current = next; setLive(next)
    })
    return () => { off1(); off2() }
  }, [])

  const check = useCallback(async () => {
    setChecking(true)
    try { const s = await api.study.status(); setStatus(s); return s } catch (e) { fail(e) } finally { setChecking(false) }
  }, [fail])
  const loadRecent = useCallback(() => api.study.recent().then(setRecent).catch(() => {}), [])
  useEffect(() => { check(); loadRecent() }, [check, loadRecent])

  const ready = !!(status && status.ready)

  const open = useCallback(async (path, force) => {
    try {
      const name = path.split(/[\\/]/).pop()
      begin('build', path, { name })
      const r = await api.study.open({ path, force })
      setPlan(r.plan)
      setActiveId((r.plan.concepts.find(c => !c.done) || r.plan.concepts[0])?.id)
      loadRecent()
    } catch (e) { fail(e) } finally { end() }
  }, [begin, end, fail, loadRecent])

  // ?path=... comes from the Assistant or a file row
  useEffect(() => {
    const p = params.get('path')
    if (p && ready && opened.current !== p) { opened.current = p; open(p); setParams({}, { replace: true }) }
  }, [params, ready, open, setParams])

  const patchConcept = (id, fn) => setPlan(p => p && { ...p, concepts: p.concepts.map(c => (c.id === id ? fn(c) : c)) })

  const onLesson = useCallback(async (concept, mode, force) => {
    try {
      begin('lesson', concept.id)
      const l = await api.study.lesson({ planId: plan.id, conceptId: concept.id, mode, force })
      patchConcept(concept.id, c => ({ ...c, lessons: { ...c.lessons, [mode]: l } }))
    } catch (e) { fail(e) } finally { end() }
  }, [plan, begin, end, fail])

  const onToggle = async concept => {
    try {
      const progress = await api.study.done({ planId: plan.id, conceptId: concept.id, done: !concept.done })
      patchConcept(concept.id, c => ({ ...c, done: !c.done }))
      setPlan(p => ({ ...p, progress }))
      if (!concept.done && progress.done === progress.total) toast('You have covered every concept.', { type: 'success' })
    } catch (e) { fail(e) }
  }

  const active = useMemo(() => plan?.concepts.find(c => c.id === activeId), [plan, activeId])
  const idx = plan ? plan.concepts.findIndex(c => c.id === activeId) : -1
  const pct = plan && plan.progress.total ? Math.round((plan.progress.done / plan.progress.total) * 100) : 0

  return (
    <div>
      <PageHeader title="Study Buddy"
        description={plan ? undefined : 'Understand a lesson, one concept at a time.'}
        actions={plan && <div className="flex gap-2">
          <Button icon={ExternalLink} onClick={() => api.files.open(plan.file.path).catch(fail)}>Open file</Button>
          <Button icon={FolderOpen} onClick={() => { setPlan(null); opened.current = null }}>Change file</Button>
        </div>} />

      {!status ? (
        <div className="flex items-center gap-2 py-16 text-sm text-muted"><Spinner /> Checking local AI…</div>
      ) : !ready ? (
        <SetupCard status={status} checking={checking} onCheck={check} model={status.model} />
      ) : live?.scope === 'build' ? (
        <BuildPanel live={live} name={live.name || ''} />
      ) : !plan ? (
        <Picker onOpen={p => open(p)} recent={recent} />
      ) : (
        <div className="grid gap-5 lg:grid-cols-[330px_minmax(0,1fr)]">
          <div className="space-y-5">
            <Card>
              <div className="px-5 py-4">
                <div className="text-xs font-semibold uppercase tracking-wide text-subtle">Studying</div>
                <h2 className="mt-1 text-base font-semibold leading-snug text-ink">{plan.title}</h2>
                <p className="mt-0.5 truncate text-xs text-muted" title={plan.file.path}>{plan.file.name} · {plan.sections} section{plan.sections === 1 ? '' : 's'}</p>
                {plan.truncated && <p className="mt-2 text-xs text-warn">This file is long: only the first part was analysed.</p>}
                <div className="mt-3 flex items-center gap-2.5">
                  <div className="h-1.5 flex-1 overflow-hidden rounded-full bg-surface2"><div className="h-full rounded-full bg-accent transition-all" style={{ width: `${pct}%` }} /></div>
                  <span className="text-xs font-medium tabular-nums text-muted">{plan.progress.done}/{plan.progress.total}</span>
                </div>
              </div>
            </Card>

            <Card>
              <CardHeader title="After this you can…" action={<Badge tone="accent" icon={Wand2}>AI summary</Badge>} />
              <ul className="space-y-2.5 px-5 py-4">
                {plan.objectives.map((o, i) => <li key={i} className="flex gap-2.5 text-sm text-ink"><Target size={15} className="mt-0.5 shrink-0 text-accent" /><span>{o}</span></li>)}
              </ul>
            </Card>

            <Card>
              <CardHeader title="Concepts" />
              <ul className="p-2">
                {plan.concepts.map((c, i) => (
                  <li key={c.id}>
                    <button onClick={() => setActiveId(c.id)} className={cx('flex w-full items-start gap-2.5 rounded-lg px-3 py-2.5 text-left transition', c.id === activeId ? 'bg-accent-soft' : 'hover:bg-surface2')}>
                      {c.done ? <CheckCircle2 size={17} className="mt-0.5 shrink-0 text-ok" /> : <Circle size={17} className="mt-0.5 shrink-0 text-subtle" />}
                      <span className="min-w-0 flex-1">
                        <span className={cx('block text-sm font-medium', c.done ? 'text-muted line-through decoration-line' : 'text-ink')}>{i + 1}. {c.title}</span>
                        <span className="mt-0.5 flex items-center gap-2 text-xs text-muted">
                          <span className={cx('h-1.5 w-1.5 rounded-full', c.importance === 'high' ? 'bg-bad' : c.importance === 'medium' ? 'bg-warn' : 'bg-subtle')} />
                          {IMPORTANCE[c.importance]?.[1]}{c.source ? ` · ${c.source}` : ''}
                        </span>
                      </span>
                    </button>
                  </li>
                ))}
              </ul>
            </Card>
          </div>

          <div className="space-y-5">
            {active && <Lesson live={live} plan={plan} concept={active} onLesson={onLesson} onToggle={onToggle} hasNext={idx < plan.concepts.length - 1} onNext={() => setActiveId(plan.concepts[idx + 1].id)} />}
            <AskBox plan={plan} live={live} begin={begin} end={end} />
            <div className="flex items-center justify-between text-xs text-subtle">
              <span className="inline-flex items-center gap-1.5"><Sparkles size={12} />Generated by {plan.model}{status?.provider === 'ollama' ? ' on this computer' : ''}. Check important facts against your material.</span>
              <button className="underline hover:text-ink" onClick={() => open(plan.file.path, true)}>Rebuild plan</button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
