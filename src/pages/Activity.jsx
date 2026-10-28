import React, { useMemo, useState } from 'react'
import { History, Undo2, ArrowRight } from 'lucide-react'
import { api } from '../lib/bridge'
import { useApp } from '../state/AppContext'
import { useProcess } from '../state/Process'
import { timeAgo, shortPath } from '../lib/format'
import { Badge, Button, Card, EmptyState, FileTile, PageHeader, Segmented } from '../components/ui'

const SOURCE = {
  download: { label: 'Suggested', tone: 'accent' },
  'download-manual': { label: 'Manual', tone: 'neutral' },
  auto: { label: 'Automatic', tone: 'ok' },
  assistant: { label: 'From Assistant', tone: 'accent' },
  sort: { label: 'Sorted', tone: 'accent' }
}

export default function Activity() {
  const { activity, toast, fail } = useApp()
  const { run } = useProcess()
  const [filter, setFilter] = useState('all')
  const [busy, setBusy] = useState(null)

  const groups = useMemo(() => {
    const list = activity.filter(a => filter === 'all' || a.status === filter)
    const out = []; const seen = new Map()
    for (const a of list) {
      if (a.batchId) {
        if (!seen.has(a.batchId)) { const g = { key: a.batchId, batchId: a.batchId, entries: [], ts: a.ts }; seen.set(a.batchId, g); out.push(g) }
        seen.get(a.batchId).entries.push(a)
      } else out.push({ key: a.id, entries: [a], ts: a.ts })
    }
    return out
  }, [activity, filter])

  const undo = async a => {
    setBusy(a.id)
    try { await run('undo', () => api.activity.undo(a.id), { detail: a.fileName }); toast('Restored.', { type: 'success' }) } catch (e) { fail(e) } finally { setBusy(null) }
  }
  const undoBatch = async g => {
    setBusy(g.key)
    try { const r = await run('undo', () => api.activity.undoBatch(g.batchId), { detail: `${g.entries.length} files` }); toast(`Restored ${r.restored}.`, { type: r.errors.length ? 'error' : 'success' }) } catch (e) { fail(e) } finally { setBusy(null) }
  }

  const Row = ({ a, nested }) => {
    const src = SOURCE[a.source] || { label: 'Moved', tone: 'neutral' }
    return (
      <div className={`flex items-center gap-4 px-5 py-3.5 ${nested ? 'pl-12' : ''}`}>
        <FileTile ext={a.fileName.split('.').pop()} />
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <span className="truncate text-sm font-medium text-ink" title={a.fileName}>{a.fileName}</span>
            <Badge tone={src.tone}>{src.label}</Badge>
            {a.status === 'undone' && <Badge tone="warn">Undone</Badge>}
            {a.createdFolder && <Badge>New folder</Badge>}
            {a.renamedOnConflict && <Badge tone="warn">Renamed copy</Badge>}
          </div>
          <div className="mt-1 flex min-w-0 items-center gap-2 text-xs text-subtle">
            <span className="truncate" title={a.from}>{shortPath(a.from.replace(/[\\/][^\\/]*$/, ''), 2)}</span>
            <ArrowRight size={12} className="shrink-0" />
            <span className="truncate font-medium text-muted" title={a.folder}>{shortPath(a.folder, 3)}</span>
          </div>
        </div>
        <span className="hidden shrink-0 text-xs text-muted sm:block">{timeAgo(a.ts)}</span>
        {a.status === 'done' ? <Button size="sm" icon={Undo2} loading={busy === a.id} onClick={() => undo(a)}>Undo</Button> : <span className="w-[68px]" />}
      </div>
    )
  }

  return (
    <div>
      <PageHeader title="Activity" actions={
        <Segmented value={filter} onChange={setFilter} options={[{ value: 'all', label: 'All' }, { value: 'done', label: 'Moved' }, { value: 'undone', label: 'Undone' }]} />
      } />
      <Card className="overflow-hidden">
        {groups.length === 0 ? (
          <EmptyState icon={History} title="No activity yet" />
        ) : (
          <div className="divide-y divide-line">
            {groups.map(g => g.entries.length > 1 || g.batchId ? (
              <div key={g.key}>
                <div className="flex items-center justify-between gap-3 bg-surface2/70 px-5 py-2.5">
                  <div className="text-[13px]"><span className="font-semibold text-ink">Organized {g.entries.length} file{g.entries.length === 1 ? '' : 's'}</span><span className="ml-2 text-muted">{timeAgo(g.ts)}</span></div>
                  {g.entries.some(e => e.status === 'done') && <Button size="sm" icon={Undo2} loading={busy === g.key} onClick={() => undoBatch(g)}>Undo all</Button>}
                </div>
                {g.entries.map(a => <Row key={a.id} a={a} nested />)}
              </div>
            ) : <Row key={g.key} a={g.entries[0]} />)}
          </div>
        )}
      </Card>
    </div>
  )
}
