import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Sparkles, Search, ExternalLink, FolderSearch, FolderTree, ArrowRight, CalendarClock, FileType2, BookOpen, Tag, Cpu, Wand2, X } from 'lucide-react'
import { api } from '../lib/bridge'
import { useApp } from '../state/AppContext'
import { useProcess } from '../state/Process'
import { formatBytes, formatDate, shortPath, folderLabel, splitPath } from '../lib/format'
import { Badge, Button, Card, EmptyState, FileTile, IconButton, Kbd, Modal, PageHeader, PathCrumbs, Spinner, cx } from '../components/ui'

const EXAMPLES = [
  'Genetics course materials, organize them',
  'Distributed systems slides from last week',
  'Operating systems assignments'
]

function PlanChips({ plan }) {
  const chips = []
  if (plan.intent === 'organize') chips.push({ icon: FolderTree, text: 'Organize request', tone: 'accent' })
  plan.courses?.forEach(c => chips.push({ icon: BookOpen, text: `${c.code}${c.name ? ` · ${c.name}` : ''}`, tone: 'accent' }))
  const skip = plan.courses?.length || 0
  plan.groups?.slice(skip).forEach(g => chips.push({ icon: Tag, text: g[0], tone: 'neutral' }))
  if (plan.typeLabel) chips.push({ icon: FileType2, text: plan.typeLabel, tone: 'neutral' })
  if (plan.dateLabel) chips.push({ icon: CalendarClock, text: `Modified ${plan.dateLabel}`, tone: 'neutral' })
  return (
    <div className="flex flex-wrap items-center gap-1.5">
      {chips.length === 0 && <Badge>all files</Badge>}
      {chips.map((c, i) => <Badge key={i} tone={c.tone} icon={c.icon}>{c.text}</Badge>)}
      {plan.source === 'ai' && <Badge tone="ok" icon={Wand2} className="ml-1">Gemini</Badge>}
    </div>
  )
}

function OrganizeModal({ open, onClose, selectedPaths, query, onDone }) {
  const { settings, toast, fail } = useApp()
  const { run } = useProcess()
  const [root, setRoot] = useState('')
  const [name, setName] = useState('')
  const [preview, setPreview] = useState(null)
  const [busy, setBusy] = useState(false)
  const [loading, setLoading] = useState(false)

  const load = useCallback(async (r, n) => {
    setLoading(true)
    try {
      const p = await run('preview', () => api.organize.preview({ paths: selectedPaths, text: query, destinationRoot: r || undefined, folderName: n || undefined }))
      setPreview(p); setRoot(p.destinationRoot); setName(p.folderName)
    } catch (e) { fail(e); setPreview(null) } finally { setLoading(false) }
  }, [selectedPaths, query, fail, run])

  useEffect(() => { if (open) { setPreview(null); setRoot(''); setName(''); load('', '') } }, [open]) // eslint-disable-line

  const browse = async () => { const f = await api.dialog.pickFolder('Choose where the organized folder should be created'); if (f) load(f, name) }

  const grouped = useMemo(() => {
    const g = {}
    preview?.items.forEach(i => { (g[i.sub] = g[i.sub] || []).push(i) })
    return Object.entries(g)
  }, [preview])

  const confirm = async () => {
    setBusy(true)
    try {
      const r = await run('organize', () => api.organize.execute({ items: preview.items, label: query }), { detail: `${preview.items.length} files`, doneText: x => `${x.moved} moved` })
      if (r.failed.length) toast(`${r.moved} moved, ${r.failed.length} failed: ${r.failed[0].error}`, { type: 'error' })
      else toast(`Organized ${r.moved} file${r.moved === 1 ? '' : 's'} into “${preview.folderName}”.`, {
        type: 'success', action: { label: 'Undo', onClick: () => run('undo', () => api.activity.undoBatch(r.batchId)).then(() => { toast('Restored.', { type: 'success' }); onDone?.(true) }).catch(fail) }
      })
      onClose(); onDone?.(true)
    } catch (e) { fail(e) } finally { setBusy(false) }
  }

  return (
    <Modal open={open} onClose={onClose} width="max-w-3xl" title="Organize files"
      footer={<>
        <Button onClick={onClose}>Cancel</Button>
        <Button variant="primary" loading={busy} disabled={!preview || !preview.items.length || loading} onClick={confirm} icon={FolderTree}>
          Move {preview?.items.length ?? 0} file{preview?.items.length === 1 ? '' : 's'}
        </Button>
      </>}>
      <div className="grid gap-4 sm:grid-cols-[1fr_1fr]">
        <div>
          <label className="mb-1.5 block text-xs font-semibold uppercase tracking-wide text-subtle">Location</label>
          <div className="flex gap-2">
            <input readOnly value={root} title={root} className="field truncate" placeholder={settings?.destinationRoots?.[0]} />
            <Button onClick={browse}>Browse</Button>
          </div>
        </div>
        <div>
          <label className="mb-1.5 block text-xs font-semibold uppercase tracking-wide text-subtle">Folder name</label>
          <input value={name} onChange={e => setName(e.target.value)} onBlur={() => name && preview && name !== preview.folderName && load(root, name)} onKeyDown={e => e.key === 'Enter' && e.currentTarget.blur()} className="field" />
        </div>
      </div>

      <div className="mt-5">
        {loading || !preview ? <div className="flex items-center gap-2 py-10 text-sm text-muted"><Spinner /> Preview…</div> : (
          <>
            <div className="mb-3 flex items-center gap-2 text-[13px] text-muted">
              <FolderTree size={15} /> <span className="truncate font-medium text-ink" title={preview.base}>{shortPath(preview.base, 3)}</span>
            </div>
            {preview.items.length === 0 ? <p className="py-6 text-sm text-muted">Already organized.</p> : (
              <div className="divide-y divide-line overflow-hidden rounded-xl border border-line">
                {grouped.map(([sub, items]) => (
                  <div key={sub}>
                    <div className="flex items-center justify-between bg-surface2 px-4 py-2 text-xs font-semibold text-muted">
                      <span>{sub}</span><span>{items.length} file{items.length === 1 ? '' : 's'}</span>
                    </div>
                    {items.map(i => (
                      <div key={i.to} className="flex items-center gap-3 px-4 py-2.5 text-[13px]">
                        <span className="min-w-0 flex-1 truncate font-medium text-ink" title={i.fileName}>{i.fileName}</span>
                        <span className="hidden max-w-[40%] truncate text-subtle sm:block" title={i.from}>{folderLabel(splitPath(i.from).slice(0, -1).join('/'))}</span>
                        <ArrowRight size={13} className="shrink-0 text-subtle" />
                        <span className="shrink-0 font-medium text-accent">{sub}</span>
                      </div>
                    ))}
                  </div>
                ))}
              </div>
            )}
          </>
        )}
      </div>
    </Modal>
  )
}

export default function Assistant() {
  const { index, settings, fail } = useApp()
  const { run: runTask } = useProcess()
  const [query, setQuery] = useState('')
  const [lastQuery, setLastQuery] = useState('')
  const [loading, setLoading] = useState(false)
  const [res, setRes] = useState(null)
  const [selected, setSelected] = useState(new Set())
  const [organizeOpen, setOrganizeOpen] = useState(false)
  const inputRef = useRef(null)

  useEffect(() => {
    const onKey = e => { if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k') { e.preventDefault(); inputRef.current?.focus(); inputRef.current?.select() } }
    window.addEventListener('keydown', onKey)
    inputRef.current?.focus()
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  const run = useCallback(async (text, quiet) => {
    const q = (text ?? query).trim()
    if (!q) return
    setQuery(q); setLoading(true); setLastQuery(q)
    try {
      const r = quiet === true ? await api.search(q) : await runTask('search', () => api.search(q), { detail: q, hold: 350, doneText: x => `${x.total} found` })
      setRes(r)
      setSelected(r.plan.intent === 'organize' ? new Set(r.results.map(f => f.path)) : new Set())
    } catch (e) { fail(e) } finally { setLoading(false) }
  }, [query, fail, runTask])

  const toggle = p => setSelected(s => { const n = new Set(s); n.has(p) ? n.delete(p) : n.add(p); return n })
  const allSelected = res && res.results.length > 0 && selected.size === res.results.length
  const toggleAll = () => setSelected(allSelected ? new Set() : new Set(res.results.map(f => f.path)))
  const selectedPaths = useMemo(() => Array.from(selected), [selected])

  const scopeText = index.state === 'indexing'
    ? `Indexing · ${index.count.toLocaleString()}`
    : `${index.count.toLocaleString()} files indexed`

  return (
    <div>
      <PageHeader title="Assistant" />

      <Card className="p-4">
        <form onSubmit={e => { e.preventDefault(); run() }} className="flex items-center gap-3">
          <div className="relative flex-1">
            <Sparkles size={18} className="pointer-events-none absolute left-3.5 top-1/2 -translate-y-1/2 text-accent" />
            <input ref={inputRef} value={query} onChange={e => setQuery(e.target.value)}
              placeholder="Describe the files you need"
              className="h-12 w-full rounded-xl border border-line bg-bg pl-11 pr-24 text-[15px] text-ink placeholder:text-subtle transition focus:border-accent focus:bg-surface focus:outline-none focus:ring-2 focus:ring-accent/25" />
            {query ? <IconButton icon={X} label="Clear" type="button" className="absolute right-3 top-1/2 -translate-y-1/2" onClick={() => { setQuery(''); inputRef.current?.focus() }} />
              : <span className="absolute right-3.5 top-1/2 hidden -translate-y-1/2 gap-1 sm:flex"><Kbd>Ctrl</Kbd><Kbd>K</Kbd></span>}
          </div>
          <Button type="submit" variant="primary" size="lg" loading={loading} icon={Search} className="h-12 px-5">Search</Button>
        </form>
        <div className="mt-3 flex flex-wrap items-center gap-2">
          {EXAMPLES.map(e => (
            <button key={e} onClick={() => run(e)} className="rounded-full border border-line bg-surface px-3 py-1 text-xs text-muted transition hover:border-accent/50 hover:bg-accent-soft hover:text-accent">{e}</button>
          ))}
        </div>
        <div className="mt-3 flex items-center gap-2 border-t border-line pt-3 text-xs text-subtle">
          {index.state === 'indexing' ? <Spinner size={12} /> : <FolderSearch size={13} />}{scopeText}
        </div>
      </Card>

      <div className="mt-6">
        {!res && !loading && (
          <Card><EmptyState icon={FolderSearch} title="Ask for any file" description="Course, topic, type or date." /></Card>
        )}

        {res && (
          <div className={cx('space-y-4 transition', loading && 'opacity-60')}>
            <div className="flex flex-wrap items-center justify-between gap-3">
              <PlanChips plan={res.plan} />
              <span className="text-[13px] text-muted">{res.total.toLocaleString()} result{res.total === 1 ? '' : 's'}{res.total > res.results.length ? ` (showing ${res.results.length})` : ''} · {res.tookMs} ms</span>
            </div>
            {res.aiError && <div className="rounded-lg border border-line bg-warn-soft px-3.5 py-2 text-[13px] text-warn">AI unavailable, used local search.</div>}

            {res.plan.intent === 'organize' && res.results.length > 0 && (
              <div className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-accent/30 bg-accent-soft px-4 py-3">
                <div className="flex items-center gap-3 text-sm text-ink"><FolderTree size={18} className="text-accent" /><span><b>Organize these files?</b></span></div>
                <Button variant="primary" icon={FolderTree} disabled={!selected.size} onClick={() => setOrganizeOpen(true)}>Preview ({selected.size})</Button>
              </div>
            )}

            <Card className="overflow-hidden">
              {res.results.length === 0 ? (
                <EmptyState icon={Search} title="No matches" description="Try other words." />
              ) : (
                <>
                  <table className="w-full table-fixed text-left">
                    <thead className="border-b border-line bg-surface2/60">
                      <tr>
                        <th className="th w-10 !pr-0"><input type="checkbox" aria-label="Select all" checked={!!allSelected} onChange={toggleAll} className="h-4 w-4 accent-[rgb(var(--accent))]" /></th>
                        <th className="th">File</th>
                        <th className="th w-28">Modified</th>
                        <th className="th w-24">Size</th>
                        <th className="th w-20 text-right"> </th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-line">
                      {res.results.map(f => (
                        <tr key={f.path} className={cx('group transition hover:bg-surface2/60', selected.has(f.path) && 'bg-accent-soft/40')}>
                          <td className="w-10 py-3 pl-4"><input type="checkbox" aria-label={`Select ${f.name}`} checked={selected.has(f.path)} onChange={() => toggle(f.path)} className="h-4 w-4 accent-[rgb(var(--accent))]" /></td>
                          <td className="px-4 py-3">
                            <div className="flex items-center gap-3">
                              <FileTile ext={f.ext} />
                              <div className="min-w-0">
                                <button onClick={() => api.files.open(f.path).catch(fail)} className="block max-w-full truncate text-left text-sm font-medium text-ink hover:text-accent hover:underline" title={f.name}>{f.name}</button>
                                <div className="truncate text-xs text-subtle" title={f.dir}>{shortPath(f.dir, 4)}</div>
                                {f.reasons?.length > 0 && <div className="mt-1 flex flex-wrap gap-1">{f.reasons.slice(0, 3).map(r => <span key={r} className="rounded bg-surface2 px-1.5 py-0.5 text-[11px] text-muted">{r}</span>)}</div>}
                              </div>
                            </div>
                          </td>
                          <td className="px-4 py-3 text-[13px] text-muted">{formatDate(f.mtime)}</td>
                          <td className="px-4 py-3 text-[13px] text-muted">{formatBytes(f.size)}</td>
                          <td className="px-3 py-3">
                            <div className="flex justify-end gap-0.5 opacity-0 transition group-hover:opacity-100 focus-within:opacity-100">
                              <IconButton icon={ExternalLink} label="Open file" onClick={() => api.files.open(f.path).catch(fail)} />
                              <IconButton icon={FolderSearch} label="Show in folder" onClick={() => api.files.reveal(f.path).catch(fail)} />
                            </div>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </>
              )}
            </Card>

            {selected.size > 0 && res.plan.intent !== 'organize' && (
              <div className="sticky bottom-4 flex items-center justify-between rounded-xl border border-line bg-surface px-4 py-3 shadow-pop">
                <span className="text-sm text-ink"><b>{selected.size}</b> selected</span>
                <div className="flex gap-2"><Button onClick={() => setSelected(new Set())}>Clear</Button><Button variant="primary" icon={FolderTree} onClick={() => setOrganizeOpen(true)}>Organize</Button></div>
              </div>
            )}
          </div>
        )}
      </div>

      <OrganizeModal open={organizeOpen} onClose={() => setOrganizeOpen(false)} selectedPaths={selectedPaths} query={lastQuery} onDone={() => run(lastQuery, true)} />
    </div>
  )
}
