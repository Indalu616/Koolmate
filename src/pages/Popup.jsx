import React, { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import { Check, ChevronDown, FolderOpen, X, Undo2, Wand2, FolderPlus, AlertTriangle, Eye, Loader2, Circle } from 'lucide-react'
import { api } from '../lib/bridge'
import { useTheme } from '../state/AppContext'
import { formatBytes, cleanError } from '../lib/format'
import { Badge, Button, ConfidenceMeter, FileTile, PathCrumbs, cx } from '../components/ui'

/** The real steps KoolMate has taken with a download; each line appears once that step has happened. */
function FlowSteps({ flow }) {
  return (
    <ol className="space-y-1.5">
      {flow.steps.map(st => (
        <li key={st.key} className="flex items-start gap-2.5">
          <span className="mt-0.5 shrink-0">
            {st.status === 'done' && <Check size={14} className="text-ok" />}
            {st.status === 'active' && <Loader2 size={14} className="animate-spin text-accent" />}
            {st.status === 'failed' && <AlertTriangle size={14} className="text-warn" />}
            {st.status === 'pending' && <Circle size={14} className="text-subtle" />}
          </span>
          <span className="min-w-0 flex-1">
            <span className={cx('block text-[13px] font-medium', st.status === 'failed' ? 'text-muted' : 'text-ink')}>{st.label}</span>
            {st.detail && <span className="block truncate text-[11.5px] text-subtle" title={st.detail}>{st.detail}</span>}
          </span>
        </li>
      ))}
    </ol>
  )
}

/** "Sort the other files in this course folder?" — asked once per course, after a download is filed. */
function TidyOffer({ offer, onBusy }) {
  const [state, setState] = useState('ask') // ask | busy | done | declined
  const [result, setResult] = useState(null)
  const [err, setErr] = useState('')
  const [showList, setShowList] = useState(false)
  const summary = Object.entries(offer.counts).map(([f, n]) => `${n} → ${f}`).join(' · ')
  const run = async () => {
    setState('busy'); setErr(''); onBusy?.(true)
    try { setResult(await api.tidy.apply(offer.id)); setState('done') } catch (e) { setErr(cleanError(e)); setState('ask') } finally { onBusy?.(false) }
  }
  const undoAll = async () => { try { await api.activity.undoBatch(result.batchId); setState('declined'); setResult(null) } catch (e) { setErr(cleanError(e)) } }
  if (state === 'declined' && !result) return null
  return (
    <div className="mt-3 rounded-xl border border-accent/30 bg-accent-soft/40 p-3">
      {state === 'done' ? (
        <>
          <div className="flex items-center gap-2 text-[13px] font-semibold text-ok"><Check size={14} />Sorted {result.moved} file{result.moved === 1 ? '' : 's'} in “{offer.folder}”</div>
          {result.failed?.length > 0 && <p className="mt-1 text-[11.5px] text-warn">{result.failed.length} could not be moved</p>}
          <div className="mt-2 flex gap-2">
            <Button size="sm" icon={FolderOpen} onClick={() => api.files.reveal(offer.path)}>Show</Button>
            <Button size="sm" icon={Undo2} onClick={undoAll}>Undo all</Button>
          </div>
        </>
      ) : (
        <>
          <div className="text-[13px] font-semibold text-ink">Sort the other files in “{offer.folder}”?</div>
          <div className="mt-1 text-[11.5px] text-muted">{offer.count} file{offer.count === 1 ? '' : 's'} can go into subfolders: {summary}</div>
          {offer.unclear > 0 && <div className="text-[11.5px] text-subtle">{offer.unclear} unclear file{offer.unclear === 1 ? '' : 's'} stay where {offer.unclear === 1 ? 'it is' : 'they are'}</div>}
          <button onClick={() => setShowList(v => !v)} className="mt-1 text-[11.5px] font-medium text-accent hover:underline">{showList ? 'Hide files' : 'See which files'}</button>
          {showList && (
            <ul className="mt-1.5 max-h-28 space-y-0.5 overflow-y-auto text-[11.5px]">
              {offer.items.map(it => <li key={it.name} className="truncate text-muted" title={it.name}><span className="text-ink">{it.name}</span> → {it.folder}</li>)}
            </ul>
          )}
          {err && <p className="mt-1 text-xs text-bad">{err}</p>}
          <div className="mt-2.5 flex gap-2">
            <Button size="sm" variant="primary" icon={Check} loading={state === 'busy'} onClick={run}>Sort them</Button>
            <Button size="sm" variant="ghost" disabled={state === 'busy'} onClick={() => { api.tidy.dismiss(offer.id); setState('declined') }}>Not now</Button>
          </div>
        </>
      )}
    </div>
  )
}

/** Compact always-on-top window shown when a download finishes. */
export default function Popup() {
  const [settings, setSettings] = useState(null)
  const [list, setList] = useState([])
  const [flow, setFlow] = useState(null) // live record of what happened to the latest download
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
      api.on('popup:show', p => {
        setOpen(false); setError('')
        setNotice(p.kind === 'moved' ? { kind: 'moved', entry: p.entry } : null)
        if (p.kind === 'flow') setFlow(p.flow); else if (p.kind !== 'moved') setFlow(null)
        api.suggestions.list().then(setList); armTimer()
      }),
      api.on('flow:update', f => {
        // follow the newest download, but don't jump away from one that is still being processed
        setFlow(cur => (!cur || cur.id === f.id || cur.status !== 'running' ? f : cur))
        armTimer(f.status === 'done' ? (f.tidy ? 60000 : 15000) : 45000)
      })
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

  const waitingOn = flow?.status === 'waiting' ? list.find(x => x.id === flow.suggestionId) : null
  const s = waitingOn || list[0]
  const more = list.length - 1

  const accept = async folder => {
    setBusy(true); setError('')
    try {
      const entry = await api.suggestions.accept(s.id, folder)
      setOpen(false)
      // with a live flow, its "done" update (which may carry the offer to sort the folder) takes over
      if (waitingOn && flow) { setNotice(null); armTimer(15000) } else { setNotice({ kind: 'done', entry }); setFlow(null); armTimer(7000) }
    } catch (e) { setError(cleanError(e)) } finally { setBusy(false) }
  }
  const browse = async () => { const f = await api.dialog.pickFolder(`Where should “${s.file.name}” go?`); if (f) accept(f) }
  const undo = async () => { try { await api.activity.undo(notice.entry.id); setNotice(null); api.popup.close() } catch (e) { setError(cleanError(e)) } }
  const undoFlow = async () => { try { await api.activity.undo(flow.entry.id); setFlow(null); api.popup.close() } catch (e) { setError(cleanError(e)) } }

  const flowHeader = flow && (
    <div className="mb-3 flex items-start gap-3">
      <FileTile ext={flow.file.ext} />
      <div className="min-w-0 flex-1">
        <div className="truncate text-sm font-semibold text-ink" title={flow.file.name}>{flow.file.name}</div>
        <div className="mt-0.5 text-xs text-muted">{formatBytes(flow.file.size)}</div>
      </div>
    </div>
  )

  let body
  if (!notice && flow && flow.status !== 'waiting') {
    body = (
      <div className="p-4">
        {flowHeader}
        <div className="rounded-xl border border-line bg-bg p-3"><FlowSteps flow={flow} /></div>
        {error && <p className="mt-2 text-xs text-bad">{error}</p>}
        {flow.status === 'done' && flow.entry && (
          <div className="mt-3 space-y-2.5">
            <PathCrumbs path={flow.entry.folder} keep={3} />
            <div className="flex gap-2">
              <Button size="sm" icon={FolderOpen} onClick={() => api.files.reveal(flow.entry.to)}>Show</Button>
              <Button size="sm" icon={Undo2} onClick={undoFlow}>Undo</Button>
              <Button size="sm" variant="ghost" className="ml-auto" onClick={() => api.popup.close()}>Done</Button>
            </div>
            {flow.tidy && <TidyOffer key={flow.tidy.id} offer={flow.tidy} onBusy={b => b && armTimer(60000)} />}
          </div>
        )}
        {flow.status === 'dismissed' && <div className="mt-3 flex justify-end"><Button size="sm" variant="ghost" onClick={() => api.popup.close()}>Close</Button></div>}
      </div>
    )
  } else if (notice) {
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

        {waitingOn && <div className="mt-3 rounded-xl border border-line bg-bg p-3"><FlowSteps flow={flow} /></div>}

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
