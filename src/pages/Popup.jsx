import React, { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import { Check, ChevronDown, FolderOpen, X, Undo2, Wand2, FolderPlus, AlertTriangle, Eye } from 'lucide-react'
import { api } from '../lib/bridge'
import { useTheme } from '../state/AppContext'
import { formatBytes, cleanError } from '../lib/format'
import { Badge, Button, ConfidenceMeter, FileTile, PathCrumbs, cx } from '../components/ui'

/** Compact always-on-top window shown when a download finishes. */
export default function Popup() {
  const [settings, setSettings] = useState(null)
  const [list, setList] = useState([])
  const [notice, setNotice] = useState(null) // {kind:'moved', entry} | {kind:'done', entry}
  const [open, setOpen] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const root = useRef(null)
  const hover = useRef(false)
  const timer = useRef(null)

  useTheme(settings?.theme)

  const armTimer = useCallback((ms = 45000) => {
    clearTimeout(timer.current)
    timer.current = setTimeout(() => { if (hover.current) armTimer(10000); else api.popup.close() }, ms)
  }, [])

  useEffect(() => {
    api.settings.get().then(setSettings).catch(() => {})
    api.suggestions.list().then(setList).catch(() => {})
    const offs = [
      api.on('suggestions:changed', l => { setList(l); setNotice(n => (n?.kind === 'suggestion-gone' ? null : n)) }),
      api.on('settings:changed', setSettings),
      api.on('popup:show', p => { setOpen(false); setError(''); setNotice(p.kind === 'moved' ? { kind: 'moved', entry: p.entry } : null); api.suggestions.list().then(setList); armTimer() })
    ]
    armTimer()
    return () => { offs.forEach(o => o()); clearTimeout(timer.current) }
  }, [armTimer])

  useLayoutEffect(() => {
    const el = root.current
    if (!el) return
    const report = () => api.popup.resize(Math.ceil(el.getBoundingClientRect().height) + 2)
    report()
    const ro = new ResizeObserver(report)
    ro.observe(el)
    return () => ro.disconnect()
  }, [])

  const s = list[0]
  const more = list.length - 1

  const accept = async folder => {
    setBusy(true); setError('')
    try {
      const entry = await api.suggestions.accept(s.id, folder)
      setNotice({ kind: 'done', entry }); setOpen(false); armTimer(7000)
    } catch (e) { setError(cleanError(e)) } finally { setBusy(false) }
  }
  const browse = async () => { const f = await api.dialog.pickFolder(`Where should “${s.file.name}” go?`); if (f) accept(f) }
  const undo = async () => { try { await api.activity.undo(notice.entry.id); setNotice(null); api.popup.close() } catch (e) { setError(cleanError(e)) } }

  let body
  if (notice) {
    const moved = notice.kind === 'moved'
    body = (
      <div className="space-y-3 p-4">
        <div className="flex items-center gap-2 text-sm font-semibold text-ok"><Check size={16} />{moved ? 'Organized automatically' : 'File moved'}</div>
        <div className="text-[13px] text-ink"><span className="font-medium">{notice.entry.fileName}</span></div>
        <PathCrumbs path={notice.entry.folder} keep={3} />
        {error && <p className="text-xs text-bad">{error}</p>}
        <div className="flex gap-2"><Button size="sm" icon={Undo2} onClick={undo}>Undo</Button><Button size="sm" variant="ghost" onClick={() => (more > 0 && !moved ? setNotice(null) : api.popup.close())}>{more > 0 && !moved ? 'Next file' : 'Done'}</Button></div>
      </div>
    )
  } else if (!s) {
    body = <div className="p-4 text-sm text-muted">No downloads waiting. <button className="font-medium text-accent" onClick={() => api.popup.close()}>Close</button></div>
  } else {
    body = (
      <div className="p-4">
        <div className="flex items-start gap-3">
          <FileTile ext={s.file.ext} />
          <div className="min-w-0 flex-1">
            <div className="truncate text-sm font-semibold text-ink" title={s.file.name}>{s.file.name}</div>
            <div className="mt-0.5 flex flex-wrap items-center gap-1.5 text-xs text-muted">
              <span>{formatBytes(s.file.size)}</span>
              {s.signals?.source && <Badge>{s.signals.source}</Badge>}
              {s.signals?.course && <Badge tone="accent">{s.signals.course.code || s.signals.course.name}</Badge>}
              {s.analysis?.readContent && <Badge tone="ok" icon={Eye}>Read inside</Badge>}
              {s.needsReview && <Badge tone="warn" icon={AlertTriangle}>Review</Badge>}
            </div>
          </div>
        </div>

        <div className="mt-3 rounded-xl border border-line bg-bg p-3">
          <div className="mb-1.5 flex items-center justify-between text-[11px] font-semibold uppercase tracking-wider text-subtle">
            <span>Suggested folder</span>
            <span className="flex items-center gap-1.5 normal-case tracking-normal">
              {s.aiAssisted && <Badge tone="ok" icon={Wand2}>AI</Badge>}
              {s.primary.isNewFolder && <Badge tone="accent" icon={FolderPlus}>New</Badge>}
            </span>
          </div>
          <PathCrumbs path={s.primary.folder} keep={2} />
          <div className="mt-2"><ConfidenceMeter value={s.primary.confidence} needsReview={s.needsReview} /></div>
        </div>

        {open && (
          <div className="mt-2 max-h-40 divide-y divide-line overflow-y-auto rounded-lg border border-line bg-surface">
            {s.alternatives.slice(0, 4).map(a => (
              <button key={a.folder} disabled={busy} onClick={() => accept(a.folder)} className="block w-full px-3 py-2 text-left hover:bg-accent-soft/50">
                <PathCrumbs path={a.folder} keep={2} /><div className="mt-0.5 pl-5 text-[11px] text-subtle">{a.reason}</div>
              </button>
            ))}
            <button onClick={browse} className="flex w-full items-center gap-2 px-3 py-2 text-left text-[13px] font-medium text-accent hover:bg-accent-soft/50"><FolderOpen size={14} />Browse</button>
          </div>
        )}
        {error && <p className="mt-2 text-xs text-bad">{error}</p>}

        <div className="mt-3 flex items-center gap-2">
          <Button size="sm" variant="primary" icon={Check} loading={busy} onClick={() => accept()}>Move here</Button>
          <Button size="sm" icon={ChevronDown} onClick={() => setOpen(o => !o)}>Change</Button>
          <Button size="sm" variant="ghost" onClick={() => api.popup.close()} className="ml-auto">Later</Button>
        </div>
        {more > 0 && <button onClick={() => api.popup.openMain('/downloads')} className="mt-2.5 text-xs font-medium text-accent hover:underline">+{more} more</button>}
      </div>
    )
  }

  return (
    <div ref={root} onMouseEnter={() => (hover.current = true)} onMouseLeave={() => (hover.current = false)} className="overflow-hidden border border-line bg-surface">
      <div className="flex items-center gap-2 border-b border-line bg-nav px-3.5 py-2 text-nav-ink" style={{ WebkitAppRegion: 'drag' }}>
        <img src="./logo-mark.png" alt="" className="h-4 w-4 rounded" />
        <span className="flex-1 text-xs font-semibold">KoolMate · New download</span>
        <button aria-label="Close" onClick={() => api.popup.close()} className="rounded p-1 text-nav-muted hover:bg-accent-soft hover:text-accent" style={{ WebkitAppRegion: 'no-drag' }}><X size={14} /></button>
      </div>
      {body}
    </div>
  )
}
