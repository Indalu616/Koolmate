import React, { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react'
import { Check, ScanSearch, Search, RefreshCw, FolderTree, Sparkles, DownloadCloud, Undo2, FlaskConical, FolderInput } from 'lucide-react'
import { api } from '../lib/bridge'
import { cx } from '../components/ui'

/**
 * Real-time processing overlay. Any long-ish operation is wrapped in `run(kind, fn)`:
 * the main process streams `task:progress` events ({kind, step, pct, detail}) and the overlay
 * shows them as they arrive. A short minimum display time keeps fast operations from flickering.
 */
const KINDS = {
  search:   { title: 'Searching', icon: Search, steps: [['understand', 'Understanding request'], ['scan', 'Checking index'], ['rank', 'Ranking matches']] },
  index:    { title: 'Indexing files', icon: RefreshCw, steps: [['scan', 'Scanning folders'], ['finish', 'Building index']] },
  sort:     { title: 'Analyzing files', icon: ScanSearch, steps: [['scan', 'Scanning folders'], ['read', 'Opening files'], ['understand', 'Understanding content'], ['plan', 'Choosing folders']] },
  preview:  { title: 'Planning', icon: FolderTree, steps: [['plan', 'Grouping files'], ['check', 'Checking destinations']], quick: true },
  organize: { title: 'Organizing files', icon: FolderTree, steps: [['prepare', 'Preparing'], ['move', 'Moving files'], ['save', 'Saving history']] },
  accept:   { title: 'Moving file', icon: FolderInput, steps: [['move', 'Moving'], ['save', 'Updating history']] },
  undo:     { title: 'Restoring files', icon: Undo2, steps: [['restore', 'Moving back'], ['save', 'Updating history']] },
  ai:       { title: 'Testing AI', icon: Sparkles, steps: [['connect', 'Connecting'], ['verify', 'Verifying key']] },
  simulate: { title: 'Simulating download', icon: DownloadCloud, steps: [['create', 'Downloading file'], ['detect', 'Detecting file'], ['analyze', 'Finding a folder']] },
  demo:     { title: 'Loading demo', icon: FlaskConical, steps: [['files', 'Creating sample files'], ['settings', 'Applying settings'], ['index', 'Indexing']] }
}

const Ctx = createContext(null)
export const useProcess = () => useContext(Ctx)

const MIN_MS = 900

export function ProcessProvider({ children }) {
  const [t, setT] = useState(null) // { kind, stepIdx, pct, detail, state: 'run' | 'done' }
  const active = useRef(null)
  const sleep = ms => new Promise(r => setTimeout(r, ms))

  useEffect(() => api.on('task:progress', e => {
    const cur = active.current
    if (!cur || e.kind !== cur) return
    setT(prev => {
      if (!prev || prev.kind !== e.kind || prev.state !== 'run') return prev
      const idx = KINDS[e.kind].steps.findIndex(([k]) => k === e.step)
      return {
        ...prev,
        stepIdx: idx < 0 ? prev.stepIdx : Math.max(prev.stepIdx, idx),
        pct: e.pct == null ? prev.pct : Math.max(prev.pct, e.pct),
        detail: e.detail === undefined ? prev.detail : e.detail
      }
    })
  }), [])

  // Slow creep so the bar never looks frozen while a step is working.
  useEffect(() => {
    if (!t || t.state !== 'run') return
    const id = setInterval(() => setT(p => (p && p.state === 'run' && p.pct < 92 ? { ...p, pct: p.pct + (92 - p.pct) * 0.04 } : p)), 160)
    return () => clearInterval(id)
  }, [t?.kind, t?.state])

  const run = useCallback(async (kind, fn, opts = {}) => {
    const def = KINDS[kind]
    if (!def || active.current) return fn() // never stack overlays
    active.current = kind
    const started = Date.now()
    setT({ kind, stepIdx: 0, pct: 3, detail: opts.detail ?? null, state: 'run', title: opts.title })
    try {
      const result = await fn()
      const min = def.quick ? 500 : MIN_MS
      const left = min - (Date.now() - started)
      if (left > 0) {
        // fast job: walk through the steps so it still reads as progress
        const n = def.steps.length
        for (let i = 0; i < n; i++) { setT(p => p && { ...p, stepIdx: Math.max(p.stepIdx, i), pct: Math.max(p.pct, ((i + 1) / (n + 1)) * 100) }); await sleep(left / n) }
      }
      setT(p => p && { ...p, stepIdx: def.steps.length, pct: 100, state: 'done', detail: opts.doneText ? (typeof opts.doneText === 'function' ? opts.doneText(result) : opts.doneText) : null })
      await sleep(opts.hold ?? 650)
      return result
    } finally {
      active.current = null
      setT(null)
    }
  }, [])

  const value = useMemo(() => ({ run }), [run])
  return <Ctx.Provider value={value}>{children}<ProcessModal t={t} /></Ctx.Provider>
}

function ProcessModal({ t }) {
  if (!t) return null
  const def = KINDS[t.kind]
  const Icon = def.icon
  const done = t.state === 'done'
  const pct = Math.round(Math.min(100, t.pct))
  const R = 44, C = 2 * Math.PI * R
  return (
    <div className="fixed inset-0 z-[60] flex items-center justify-center bg-ink/35 backdrop-blur-[3px] animate-fade-in" role="alertdialog" aria-live="polite" aria-label={def.title}>
      <div className="relative w-[380px] overflow-hidden rounded-3xl border border-line bg-surface p-7 shadow-pop animate-pop-in">
        <div className="pointer-events-none absolute -top-24 left-1/2 h-48 w-48 -translate-x-1/2 rounded-full bg-accent/20 blur-3xl" />
        <div className="relative mx-auto mb-5 grid h-28 w-28 place-items-center">
          <svg viewBox="0 0 100 100" className="absolute inset-0 -rotate-90">
            <circle cx="50" cy="50" r={R} fill="none" strokeWidth="5" className="stroke-accent-soft" />
            <circle cx="50" cy="50" r={R} fill="none" strokeWidth="5" strokeLinecap="round" className="stroke-accent transition-[stroke-dashoffset] duration-300 ease-out"
              strokeDasharray={C} strokeDashoffset={C * (1 - pct / 100)} />
          </svg>
          {!done && <span className="absolute inset-3 rounded-full bg-accent/10 animate-ping-slow" />}
          <div className={cx('relative grid h-16 w-16 place-items-center rounded-full transition-colors duration-300', done ? 'bg-ok text-white' : 'bg-accent-soft text-accent')}>
            {done ? <Check size={30} strokeWidth={2.6} className="animate-pop-in" /> : <Icon size={26} strokeWidth={1.9} className={t.kind === 'index' ? 'animate-spin' : ''} />}
          </div>
        </div>

        <div className="text-center">
          <div className="text-[17px] font-semibold tracking-tight text-ink">{done ? 'Done' : t.title || def.title}</div>
          <div className="mt-1 h-5 truncate text-[13px] text-muted">{t.detail || ' '}</div>
        </div>

        <div className="mt-4 h-1.5 overflow-hidden rounded-full bg-accent-soft">
          <div className="relative h-full rounded-full bg-accent transition-[width] duration-300 ease-out" style={{ width: `${pct}%` }}>
            {!done && <span className="absolute inset-0 animate-shimmer bg-gradient-to-r from-transparent via-white/45 to-transparent" />}
          </div>
        </div>
        <div className="mt-1.5 text-right text-[11px] font-medium tabular-nums text-subtle">{pct}%</div>

        <ol className="mt-3 space-y-2">
          {def.steps.map(([k, label], i) => {
            const state = done || i < t.stepIdx ? 'done' : i === t.stepIdx ? 'active' : 'todo'
            return (
              <li key={k} className={cx('flex items-center gap-3 text-[13px] transition-colors', state === 'todo' ? 'text-subtle' : 'text-ink')}>
                <span className={cx('grid h-5 w-5 shrink-0 place-items-center rounded-full text-[10px] font-semibold transition',
                  state === 'done' ? 'bg-accent text-accent-ink' : state === 'active' ? 'border-2 border-accent text-accent' : 'border border-line text-subtle')}>
                  {state === 'done' ? <Check size={12} strokeWidth={3} /> : state === 'active' ? <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-accent" /> : i + 1}
                </span>
                <span className={state === 'active' ? 'font-medium' : ''}>{label}</span>
              </li>
            )
          })}
        </ol>
      </div>
    </div>
  )
}
