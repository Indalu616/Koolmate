import React, { useCallback, useMemo, useState } from 'react'
import { FolderSearch, ScanSearch, FolderPlus, ChevronDown, ChevronUp, FolderOpen, Check, BookOpen, Wand2, Eye, CalendarDays, AlertTriangle, FlaskConical, FolderTree, Download } from 'lucide-react'
import { api } from '../lib/bridge'
import { useApp } from '../state/AppContext'
import { useProcess } from '../state/Process'
import { formatBytes, shortPath } from '../lib/format'
import { Badge, Button, Card, ConfidenceMeter, EmptyState, FileTile, PageHeader, PathCrumbs, Segmented, cx } from '../components/ui'

const TYPE_LABEL = { Lectures: 'Lecture', Assignments: 'Assignment', Labs: 'Lab', Exams: 'Exam', Syllabus: 'Syllabus', Projects: 'Project', Notes: 'Notes', Readings: 'Reading' }

export function Understanding({ a, compact }) {
  if (!a) return null
  return (
    <div className="flex flex-wrap items-center gap-1.5">
      {a.course && <Badge tone="accent" icon={BookOpen}>{a.course.name || a.course.code}</Badge>}
      {!a.course && a.topic && <Badge tone="accent">{a.topic}</Badge>}
      {a.type && <Badge>{TYPE_LABEL[a.type] || a.type}</Badge>}
      {a.semester && <Badge icon={CalendarDays}>{a.semester}</Badge>}
      {!compact && a.readContent && <Badge tone="ok" icon={Eye}>Read inside</Badge>}
      {!compact && a.source === 'ai' && <Badge tone="ok" icon={Wand2}>AI</Badge>}
      {!a.course && !a.topic && !a.type && a.keywords?.length > 0 && <Badge>{a.keywords.slice(0, 2).join(', ')}</Badge>}
    </div>
  )
}

function Row({ it, selected, onToggle, choice, onChoose }) {
  const { fail } = useApp()
  const [open, setOpen] = useState(false)
  const dest = choice || it.primary
  const browse = async () => { const f = await api.dialog.pickFolder(`Where should “${it.fileName}” go?`); if (f) { onChoose({ folder: f, isNewFolder: false, confidence: null, reason: 'Chosen by you' }); setOpen(false) } }
  return (
    <div className={cx('border-b border-line last:border-0', selected && 'bg-accent-soft/30')}>
      <div className="flex items-start gap-3 px-4 py-3.5">
        <input type="checkbox" aria-label={`Select ${it.fileName}`} checked={selected} disabled={it.inPlace} onChange={onToggle} className="mt-3 h-4 w-4 accent-[rgb(var(--accent))]" />
        <FileTile ext={it.ext} />
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
            <button onClick={() => api.files.open(it.from).catch(fail)} className="max-w-full truncate text-left text-sm font-medium text-ink hover:text-accent hover:underline" title={it.from}>{it.fileName}</button>
            <span className="text-xs text-subtle">{formatBytes(it.size)}</span>
          </div>
          <div className="mt-1.5"><Understanding a={it.analysis} /></div>
          {it.unreadable && <div className="mt-1 text-xs text-subtle">Couldn’t read inside ({it.unreadable})</div>}
        </div>
        <div className="w-[44%] min-w-0 shrink-0">
          {it.inPlace ? <Badge tone="ok" icon={Check}>Already in place</Badge> : (
            <>
              <div className="flex items-center justify-between gap-2">
                <PathCrumbs path={dest.folder} keep={3} className="min-w-0 flex-1" />
                {dest.isNewFolder && <Badge tone="accent" icon={FolderPlus}>New</Badge>}
              </div>
              <div className="mt-1.5 flex items-center justify-between gap-2">
                {dest.confidence != null ? <ConfidenceMeter value={dest.confidence} needsReview={it.needsReview && !choice} /> : <span className="text-xs text-muted">Chosen by you</span>}
                <button onClick={() => setOpen(o => !o)} className="flex items-center gap-1 text-xs font-medium text-accent hover:underline">{open ? <ChevronUp size={13} /> : <ChevronDown size={13} />}Change</button>
              </div>
              {!choice && <p className="mt-1 line-clamp-2 text-xs text-muted" title={it.primary.reason}>{it.primary.reason}</p>}
            </>
          )}
        </div>
      </div>
      {open && (
        <div className="mx-4 mb-3 divide-y divide-line overflow-hidden rounded-lg border border-line bg-surface">
          {[it.primary, ...it.alternatives].filter(a => a.folder !== dest.folder).map(a => (
            <button key={a.folder} onClick={() => { onChoose(a === it.primary ? null : a); setOpen(false) }} className="flex w-full items-center gap-3 px-4 py-2 text-left transition hover:bg-accent-soft/50">
              <PathCrumbs path={a.folder} keep={3} className="flex-1" />
              {a.isNewFolder && <Badge tone="accent">New</Badge>}
              <span className="shrink-0 text-xs text-muted">{a.confidence != null ? `${Math.round(a.confidence * 100)}%` : ''}</span>
            </button>
          ))}
          <button onClick={browse} className="flex w-full items-center gap-2 px-4 py-2 text-left text-[13px] font-medium text-accent transition hover:bg-accent-soft/50"><FolderOpen size={14} />Browse</button>
        </div>
      )}
    </div>
  )
}

export default function Sort() {
  const { settings, toast, fail } = useApp()
  const { run } = useProcess()
  const [folder, setFolder] = useState('')
  const [recursive, setRecursive] = useState(false)
  const [res, setRes] = useState(null)
  const [selected, setSelected] = useState(new Set())
  const [choices, setChoices] = useState({})
  const [filter, setFilter] = useState('all')

  const quick = useMemo(() => {
    const list = []
    if (settings?.demoLoaded && settings.demoRoot) list.push({ label: 'Demo · Sort Me', path: `${settings.demoRoot}${settings.demoRoot.includes('\\') ? '\\' : '/'}Sort Me`, icon: FlaskConical })
    for (const f of settings?.watchedFolders || []) list.push({ label: shortPath(f, 1), path: f, icon: Download })
    return list.slice(0, 4)
  }, [settings])

  const scan = useCallback(async (target, quiet) => {
    const f = target || folder
    if (!f) return
    setFolder(f)
    try {
      const r = quiet ? await api.sort.scan({ folder: f, recursive }) : await run('sort', () => api.sort.scan({ folder: f, recursive }), { detail: shortPath(f, 2), doneText: x => `${x.items.length} analyzed` })
      setRes(r); setChoices({}); setFilter('all')
      setSelected(new Set(r.items.filter(i => !i.needsReview && !i.inPlace).map(i => i.id)))
    } catch (e) { fail(e) }
  }, [folder, recursive, run, fail])

  const pick = async () => { const f = await api.dialog.pickFolder('Choose a folder to sort'); if (f) { setFolder(f); setRes(null) } }

  const items = res?.items || []
  const shown = items.filter(i => filter === 'all' || (filter === 'review' ? i.needsReview && !i.inPlace : !i.needsReview && !i.inPlace))
  const chosen = items.filter(i => selected.has(i.id))
  const newFolders = new Set(chosen.filter(i => (choices[i.id] || i.primary).isNewFolder).map(i => (choices[i.id] || i.primary).folder)).size
  const toggle = id => setSelected(s => { const n = new Set(s); n.has(id) ? n.delete(id) : n.add(id); return n })

  const move = async () => {
    const payload = chosen.map(i => { const d = choices[i.id] || i.primary; return { from: i.from, folder: d.folder, course: i.analysis.course?.code || null, confidence: d.confidence } })
    try {
      const r = await run('organize', () => api.sort.execute({ items: payload, label: `Sorted from ${shortPath(folder, 1)}` }), { detail: `${payload.length} files`, doneText: x => `${x.moved} moved` })
      if (r.failed.length) toast(`${r.moved} moved, ${r.failed.length} failed: ${r.failed[0].error}`, { type: 'error' })
      else toast(`Sorted ${r.moved} file${r.moved === 1 ? '' : 's'}.`, { type: 'success', action: { label: 'Undo', onClick: () => run('undo', () => api.activity.undoBatch(r.batchId)).then(() => { toast('Restored.', { type: 'success' }); scan(folder, true) }).catch(fail) } })
      scan(folder, true)
    } catch (e) { fail(e) }
  }

  const st = res?.stats
  return (
    <div className="pb-24">
      <PageHeader title="Sort files" />
      <Card className="p-4">
        <div className="flex flex-wrap items-center gap-3">
          <div className="flex min-w-[280px] flex-1 items-center gap-2 rounded-xl border border-line bg-bg px-3.5 py-2.5">
            <FolderSearch size={17} className="shrink-0 text-accent" />
            <input value={folder} onChange={e => setFolder(e.target.value)} placeholder="Choose a folder" spellCheck={false} className="min-w-0 flex-1 bg-transparent text-sm text-ink placeholder:text-subtle focus:outline-none" onKeyDown={e => e.key === 'Enter' && scan()} />
          </div>
          <Button size="lg" onClick={pick} icon={FolderOpen}>Browse</Button>
          <Button size="lg" variant="primary" icon={ScanSearch} disabled={!folder} onClick={() => scan()}>Analyze</Button>
        </div>
        <div className="mt-3 flex flex-wrap items-center gap-2">
          {quick.map(q => <button key={q.path} onClick={() => { setFolder(q.path); scan(q.path) }} className="inline-flex items-center gap-1.5 rounded-full border border-line bg-surface px-3 py-1 text-xs text-muted transition hover:border-accent/50 hover:bg-accent-soft hover:text-accent"><q.icon size={12} />{q.label}</button>)}
          <label className="ml-auto flex cursor-pointer items-center gap-2 text-xs text-muted"><input type="checkbox" checked={recursive} onChange={e => setRecursive(e.target.checked)} className="h-3.5 w-3.5 accent-[rgb(var(--accent))]" />Include subfolders</label>
        </div>
      </Card>

      <div className="mt-6">
        {!res && <Card><EmptyState icon={FolderTree} title="Pick a folder to sort" description="Files are read, understood and matched to your folders." /></Card>}
        {res && items.length === 0 && <Card><EmptyState icon={FolderSearch} title="No files found" /></Card>}
        {res && items.length > 0 && (
          <div className="space-y-4">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <div className="flex flex-wrap items-center gap-2">
                <Badge>{st.total} files</Badge>
                <Badge tone="ok" icon={Check}>{st.ready} ready</Badge>
                {st.review > 0 && <Badge tone="warn" icon={AlertTriangle}>{st.review} to review</Badge>}
                <Badge tone="accent" icon={FolderPlus}>{st.newFolders} new folders</Badge>
                <Badge icon={Eye}>{st.read} read inside</Badge>
              </div>
              <div className="flex items-center gap-2">
                <Segmented value={filter} onChange={setFilter} options={[{ value: 'all', label: 'All' }, { value: 'ready', label: 'Ready' }, { value: 'review', label: 'Review' }]} />
                <Button size="sm" onClick={() => setSelected(new Set(items.filter(i => !i.needsReview && !i.inPlace).map(i => i.id)))}>Select ready</Button>
                <Button size="sm" variant="ghost" onClick={() => setSelected(new Set())}>None</Button>
              </div>
            </div>
            <Card className="overflow-hidden">
              {shown.map(it => <Row key={it.id} it={it} selected={selected.has(it.id)} onToggle={() => toggle(it.id)} choice={choices[it.id]} onChoose={c => setChoices(m => { const n = { ...m }; if (c) n[it.id] = c; else delete n[it.id]; return n })} />)}
              {shown.length === 0 && <div className="px-5 py-8 text-center text-sm text-muted">Nothing here.</div>}
            </Card>
          </div>
        )}
      </div>

      {chosen.length > 0 && (
        <div className="fixed bottom-5 left-[240px] right-5 z-30 mx-auto flex max-w-[1000px] items-center justify-between rounded-2xl border border-line bg-surface px-5 py-3 shadow-pop">
          <span className="text-sm text-ink"><b>{chosen.length}</b> selected{newFolders > 0 && <span className="text-muted"> · {newFolders} new folder{newFolders === 1 ? '' : 's'}</span>}</span>
          <Button variant="primary" size="lg" icon={FolderTree} onClick={move}>Move {chosen.length} file{chosen.length === 1 ? '' : 's'}</Button>
        </div>
      )}
    </div>
  )
}
