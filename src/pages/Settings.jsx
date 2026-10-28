import React, { useEffect, useState } from 'react'
import { FolderPlus, Trash2, Plus, Eye, EyeOff, Wand2, CheckCircle2, ShieldCheck, FlaskConical, Folder } from 'lucide-react'
import { api } from '../lib/bridge'
import { useApp } from '../state/AppContext'
import { useProcess } from '../state/Process'
import { Badge, Button, Card, CardHeader, IconButton, PageHeader, Segmented, Toggle } from '../components/ui'

function FolderList({ title, description, folders, onChange, pickTitle }) {
  const add = async () => { const f = await api.dialog.pickFolder(pickTitle); if (f && !folders.includes(f)) onChange([...folders, f]) }
  return (
    <div className="py-4 first:pt-0 last:pb-0">
      <div className="flex items-start justify-between gap-4">
        <div><div className="text-sm font-medium text-ink">{title}</div><p className="mt-0.5 text-[13px] text-muted">{description}</p></div>
        <Button size="sm" icon={FolderPlus} onClick={add}>Add</Button>
      </div>
      <div className="mt-3 space-y-1.5">
        {folders.length === 0 && <div className="rounded-lg border border-dashed border-line px-3 py-2.5 text-[13px] text-subtle">None added</div>}
        {folders.map(f => (
          <div key={f} className="flex items-center gap-2.5 rounded-lg border border-line bg-bg px-3 py-2">
            <Folder size={15} className="shrink-0 text-subtle" />
            <span className="min-w-0 flex-1 truncate font-mono text-xs text-ink" title={f}>{f}</span>
            <IconButton icon={Trash2} label="Remove" className="!h-7 !w-7" onClick={() => onChange(folders.filter(x => x !== f))} />
          </div>
        ))}
      </div>
    </div>
  )
}

function CoursesEditor({ courses, onSave }) {
  const [draft, setDraft] = useState(courses)
  useEffect(() => setDraft(courses), [courses])
  const dirty = JSON.stringify(draft) !== JSON.stringify(courses)
  const set = (i, patch) => setDraft(d => d.map((c, j) => (j === i ? { ...c, ...patch } : c)))
  const cleaned = () => draft.filter(c => c.code.trim() || c.name.trim()).map(c => ({ code: c.code.trim().toUpperCase(), name: c.name.trim(), keywords: c.keywords.map(k => k.trim()).filter(Boolean) }))
  return (
    <div>
      <div className="overflow-hidden rounded-lg border border-line">
        <div className="grid grid-cols-[110px_1fr_1fr_40px] gap-2 bg-surface2 px-3 py-2 text-[11px] font-semibold uppercase tracking-wider text-subtle"><span>Code</span><span>Name</span><span>Aliases</span><span /></div>
        {draft.length === 0 && <div className="px-3 py-4 text-[13px] text-subtle">No courses yet.</div>}
        {draft.map((c, i) => (
          <div key={i} className="grid grid-cols-[110px_1fr_1fr_40px] items-center gap-2 border-t border-line px-3 py-2">
            <input className="field !py-1.5 font-mono uppercase" value={c.code} placeholder="CSC408" onChange={e => set(i, { code: e.target.value })} />
            <input className="field !py-1.5" value={c.name} placeholder="Distributed Systems" onChange={e => set(i, { name: e.target.value })} />
            <input className="field !py-1.5" value={c.keywords.join(', ')} placeholder="ds, distributed" onChange={e => set(i, { keywords: e.target.value.split(',') })} />
            <IconButton icon={Trash2} label="Remove course" onClick={() => setDraft(d => d.filter((_, j) => j !== i))} />
          </div>
        ))}
      </div>
      <div className="mt-3 flex items-center justify-between">
        <Button size="sm" icon={Plus} onClick={() => setDraft(d => [...d, { code: '', name: '', keywords: [] }])}>Add course</Button>
        <div className="flex gap-2">
          <Button size="sm" variant="ghost" disabled={!dirty} onClick={() => setDraft(courses)}>Discard</Button>
          <Button size="sm" variant="primary" disabled={!dirty} onClick={() => onSave(cleaned())}>Save courses</Button>
        </div>
      </div>
    </div>
  )
}

function AiSection() {
  const { settings, updateSettings, toast, fail } = useApp()
  const { run } = useProcess()
  const [key, setKey] = useState('')
  const [model, setModel] = useState(settings.geminiModel)
  const [show, setShow] = useState(false)
  const [testing, setTesting] = useState(false)
  const hasKey = !!settings.geminiApiKey
  const dirty = (key && key !== settings.geminiApiKey) || model !== settings.geminiModel

  useEffect(() => { setKey(settings.geminiApiKey); setModel(settings.geminiModel) }, [settings.geminiApiKey, settings.geminiModel])

  const save = async () => { await updateSettings({ geminiApiKey: key, geminiModel: model.trim() || 'gemini-3-flash-preview' }); toast('AI settings saved.', { type: 'success' }) }
  const test = async () => {
    setTesting(true)
    try { const r = await run('ai', () => api.ai.test(key, model), { detail: model }); r.ok ? toast('Connected.', { type: 'success' }) : toast('Unexpected response.', { type: 'error' }) } catch (e) { fail(e) } finally { setTesting(false) }
  }
  return (
    <Card>
      <CardHeader title="AI (optional)"
        action={<Badge tone={hasKey ? 'ok' : 'neutral'} icon={hasKey ? CheckCircle2 : undefined}>{hasKey ? 'Active' : 'Off'}</Badge>} />
      <div className="space-y-4 px-5 py-4">
        <div className="grid gap-4 sm:grid-cols-[1fr_220px]">
          <div>
            <label className="mb-1.5 block text-xs font-semibold uppercase tracking-wide text-subtle">Gemini API key</label>
            <div className="relative">
              <input type={show ? 'text' : 'password'} className="field pr-10 font-mono" placeholder="Paste your key" value={key} onChange={e => setKey(e.target.value)} onFocus={e => key === settings.geminiApiKey && e.target.select()} autoComplete="off" spellCheck={false} />
              <button type="button" aria-label={show ? 'Hide key' : 'Show key'} onClick={() => setShow(s => !s)} className="absolute right-2 top-1/2 -translate-y-1/2 text-subtle hover:text-ink">{show ? <EyeOff size={16} /> : <Eye size={16} />}</button>
            </div>
          </div>
          <div>
            <label className="mb-1.5 block text-xs font-semibold uppercase tracking-wide text-subtle">Model</label>
            <input className="field font-mono" value={model} onChange={e => setModel(e.target.value)} spellCheck={false} />
          </div>
        </div>
        <div className="flex items-center gap-2.5 rounded-lg bg-accent-soft px-3.5 py-2.5 text-[13px] text-ink"><ShieldCheck size={16} className="shrink-0 text-accent" /><span>Reading files happens on this computer. AI sees names and, if allowed, short excerpts.</span></div>
        <Toggle label="AI may read short excerpts" description="Sends the first lines of a file, only when its name is unclear" checked={settings.aiReadContent !== false} onChange={v => updateSettings({ aiReadContent: v })} />
        <div className="flex justify-end gap-2">
          <Button icon={Wand2} loading={testing} disabled={!key} onClick={test}>Test</Button>
          <Button variant="primary" disabled={!dirty} onClick={save}>Save</Button>
        </div>
      </div>
    </Card>
  )
}

export default function Settings() {
  const { settings, updateSettings, info, toast, fail } = useApp()
  const { run } = useProcess()
  if (!settings) return null
  const set = patch => updateSettings(patch)

  const loadDemo = async () => {
    try { await run('demo', () => api.demo.load()); toast('Demo ready.', { type: 'success' }) } catch (e) { fail(e) }
  }

  return (
    <div className="space-y-6 pb-8">
      <PageHeader title="Settings" />

      <Card>
        <CardHeader title="Locations" />
        <div className="divide-y divide-line px-5 py-4">
          <FolderList title="Downloads" description="Watched for new files" folders={settings.watchedFolders} onChange={v => set({ watchedFolders: v })} pickTitle="Select a download folder to watch" />
          <FolderList title="Destinations" description="Where files get organized" folders={settings.destinationRoots} onChange={v => set({ destinationRoots: v })} pickTitle="Select a folder that contains your course folders" />
          <FolderList title="Search" description="Folders the Assistant can search" folders={settings.searchRoots} onChange={v => set({ searchRoots: v })} pickTitle="Select a folder to search" />
          <FolderList title="Excluded" description="Never indexed or suggested" folders={settings.excludedFolders} onChange={v => set({ excludedFolders: v })} pickTitle="Select a folder to exclude" />
        </div>
      </Card>

      <Card>
        <CardHeader title="Courses" />
        <div className="px-5 py-4"><CoursesEditor courses={settings.courses} onSave={c => set({ courses: c }).then(() => toast('Courses saved.', { type: 'success' }))} /></div>
      </Card>

      <Card>
        <CardHeader title="Behaviour" />
        <div className="divide-y divide-line px-5">
          <Toggle label="Pop-up for new downloads" checked={settings.showPopup} onChange={v => set({ showPopup: v })} />
          <Toggle label="Desktop notifications" checked={settings.nativeNotifications} onChange={v => set({ nativeNotifications: v })} />
          <Toggle label="Run in the background" checked={settings.runInBackground} onChange={v => set({ runInBackground: v })} />
          <div>
            <Toggle label="Auto-move confident matches" checked={settings.autoMove} onChange={v => set({ autoMove: v })} />
            {settings.autoMove && (
              <div className="pb-4">
                <div className="mb-1.5 flex items-center justify-between text-[13px]"><span className="text-muted">Minimum confidence</span><span className="font-semibold text-ink">{Math.round(settings.autoMoveThreshold * 100)}%</span></div>
                <input type="range" min="70" max="99" value={Math.round(settings.autoMoveThreshold * 100)} onChange={e => set({ autoMoveThreshold: +e.target.value / 100 })} className="w-full accent-[rgb(var(--accent))]" />
              </div>
            )}
          </div>
        </div>
      </Card>

      <AiSection />

      <Card>
        <CardHeader title="Appearance" />
        <div className="flex items-center justify-between px-5 py-4"><div><div className="text-sm font-medium text-ink">Theme</div></div>
          <Segmented value={settings.theme} onChange={v => set({ theme: v })} options={[{ value: 'system', label: 'System' }, { value: 'light', label: 'Light' }, { value: 'dark', label: 'Dark' }]} /></div>
      </Card>

      <Card>
        <CardHeader title="Demo" />
        <div className="flex items-center justify-between gap-4 px-5 py-4">
          <p className="min-w-0 truncate text-[13px] text-muted">{settings.demoLoaded ? <span className="font-mono text-xs text-ink" title={settings.demoRoot}>{settings.demoRoot}</span> : 'Sample courses and files'}</p>
          <Button icon={FlaskConical} onClick={loadDemo}>{settings.demoLoaded ? 'Recreate' : 'Load demo'}</Button>
        </div>
      </Card>

      <p className="text-center text-xs text-subtle">KoolMate {info?.version} · Stored locally</p>
    </div>
  )
}
