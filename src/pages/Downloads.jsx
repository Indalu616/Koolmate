import React, { useState } from 'react'
import { DownloadCloud, Check, FolderOpen, FolderPlus, ChevronDown, ChevronUp, X, PauseCircle, PlayCircle, Wand2, BookOpen, Link2, FlaskConical, AlertTriangle, FileSearch, Eye } from 'lucide-react'
import { api } from '../lib/bridge'
import { useApp } from '../state/AppContext'
import { useProcess } from '../state/Process'
import { formatBytes, timeAgo, shortPath } from '../lib/format'
import { Badge, Button, Card, ConfidenceMeter, EmptyState, FileTile, PageHeader, PathCrumbs, cx } from '../components/ui'

function SuggestionCard({ s }) {
  const { toast, fail, setSuggestions } = useApp()
  const { run } = useProcess()
  const [open, setOpen] = useState(false)
  const [busy, setBusy] = useState(false)
  const sig = s.signals || {}

  const move = async folder => {
    setBusy(true)
    try {
      const entry = await run('accept', () => api.suggestions.accept(s.id, folder), { detail: s.file.name })
      setSuggestions(list => list.filter(x => x.id !== s.id))
      toast(`Moved to ${shortPath(entry.folder, 2)}`, {
        type: 'success', action: { label: 'Undo', onClick: () => run('undo', () => api.activity.undo(entry.id), { detail: s.file.name }).then(() => toast('Restored.', { type: 'success' })).catch(fail) }
      })
    } catch (e) { fail(e) } finally { setBusy(false) }
  }
  const browse = async () => { const f = await api.dialog.pickFolder(`Where should “${s.file.name}” go?`); if (f) move(f) }
  const dismiss = async () => { await api.suggestions.dismiss(s.id); setSuggestions(list => list.filter(x => x.id !== s.id)) }

  return (
    <Card className={cx('animate-fade-up overflow-hidden', s.needsReview && 'border-l-4 border-l-warn')}>
      <div className="flex items-start gap-4 p-5">
        <FileTile ext={s.file.ext} size="lg" />
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
            <h3 className="truncate text-[15px] font-semibold text-ink" title={s.file.name}>{s.file.name}</h3>
            {s.needsReview && <Badge tone="warn" icon={AlertTriangle}>Needs review</Badge>}
          </div>
          <div className="mt-1 flex flex-wrap items-center gap-x-2.5 gap-y-1.5 text-xs text-muted">
            <span>{formatBytes(s.file.size)}</span><span aria-hidden>·</span><span>{timeAgo(s.ts)}</span>
            {sig.source && <Badge icon={Link2}>{sig.source}</Badge>}
            {sig.course && <Badge tone="accent" icon={BookOpen}>{sig.course.name || sig.course.code}</Badge>}
            {sig.type && <Badge>{sig.type.replace(/s$/, '')}</Badge>}
            {sig.week != null && <Badge>Week {sig.week}</Badge>}
            {sig.semester && <Badge>{sig.semester}</Badge>}
            {s.analysis?.readContent && <Badge tone="ok" icon={Eye}>Read inside</Badge>}
          </div>

          <div className="mt-4 rounded-xl border border-line bg-bg p-3.5">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <span className="text-[11px] font-semibold uppercase tracking-wider text-subtle">Suggested folder</span>
              <div className="flex items-center gap-2">
                {s.aiAssisted && <Badge tone="ok" icon={Wand2}>AI</Badge>}
                {s.primary.isNewFolder && <Badge tone="accent" icon={FolderPlus}>New folder</Badge>}
              </div>
            </div>
            <PathCrumbs path={s.primary.folder} keep={4} className="mt-2 text-sm" />
            <div className="mt-2.5 flex flex-wrap items-center justify-between gap-2">
              <ConfidenceMeter value={s.primary.confidence} needsReview={s.needsReview} />
            </div>
            <p className="mt-2 text-[13px] text-muted">{s.primary.reason}</p>
          </div>

          <div className="mt-4 flex flex-wrap items-center gap-2">
            <Button variant="primary" icon={Check} loading={busy} onClick={() => move()}>Move here</Button>
            <Button icon={open ? ChevronUp : ChevronDown} onClick={() => setOpen(o => !o)}>Other folder</Button>
            <Button variant="ghost" icon={X} onClick={dismiss}>Dismiss</Button>
            <Button variant="ghost" icon={FileSearch} className="ml-auto" onClick={() => api.files.reveal(s.file.path).catch(fail)}>Show</Button>
          </div>
        </div>
      </div>

      {open && (
        <div className="border-t border-line bg-surface2/50 px-5 py-4">
          <div className="mb-2 text-xs font-semibold uppercase tracking-wide text-subtle">Other folders</div>
          <div className="divide-y divide-line overflow-hidden rounded-lg border border-line bg-surface">
            {s.alternatives.length === 0 && <div className="px-4 py-3 text-[13px] text-muted">None.</div>}
            {s.alternatives.map(a => (
              <button key={a.folder} disabled={busy} onClick={() => move(a.folder)} className="flex w-full items-center gap-3 px-4 py-2.5 text-left transition hover:bg-accent-soft/50">
                <PathCrumbs path={a.folder} keep={3} className="flex-1" />
                <span className="shrink-0 text-xs text-muted">{a.reason}{a.confidence != null ? ` · ${Math.round(a.confidence * 100)}%` : ''}</span>
              </button>
            ))}
            <button onClick={browse} className="flex w-full items-center gap-3 px-4 py-2.5 text-left text-[13px] font-medium text-accent transition hover:bg-accent-soft/50"><FolderOpen size={15} /> Browse…</button>
          </div>
        </div>
      )}
    </Card>
  )
}

export default function Downloads() {
  const { suggestions, settings, updateSettings, fail } = useApp()
  const { run } = useProcess()
  const paused = settings?.paused

  const simulate = async () => {
    try {
      await run('simulate', async () => {
        await new Promise((resolve, reject) => {
          const offs = []
          const done = () => { offs.forEach(o => o()); clearTimeout(t); resolve() }
          const t = setTimeout(done, 7000)
          offs.push(api.on('suggestions:changed', done), api.on('activity:changed', done))
          api.demo.simulate().catch(e => { offs.forEach(o => o()); clearTimeout(t); reject(e) })
        })
      }, { hold: 450 })
    } catch (e) { fail(e) }
  }

  return (
    <div>
      <PageHeader
        title="Downloads"
        actions={<>
          {settings?.demoLoaded && <Button icon={FlaskConical} onClick={simulate}>Simulate download</Button>}
          <Button icon={paused ? PlayCircle : PauseCircle} onClick={() => updateSettings({ paused: !paused })}>{paused ? 'Resume' : 'Pause'}</Button>
        </>}
      />

      <div className="mb-5 flex flex-wrap items-center gap-3">
        <Badge tone={paused ? 'warn' : 'ok'}>{paused ? 'Paused' : 'Watching'}</Badge>
        <div className="flex flex-wrap items-center gap-2 text-[13px] text-muted">
          {settings?.watchedFolders?.map(f => <span key={f} className="rounded-md border border-line bg-surface px-2 py-1" title={f}>{shortPath(f, 2)}</span>)}
        </div>
      </div>

      {suggestions.length === 0 ? (
        <Card>
          <EmptyState icon={DownloadCloud} title={paused ? 'Paused' : 'All caught up'} description={paused ? 'Resume to get suggestions.' : 'New downloads appear here.'} />
        </Card>
      ) : (
        <div className="space-y-4">
          <div className="text-[13px] font-medium text-muted">{suggestions.length} waiting</div>
          {suggestions.map(s => <SuggestionCard key={s.id} s={s} />)}
        </div>
      )}
    </div>
  )
}
