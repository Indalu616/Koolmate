import React from 'react'
import { NavLink, Outlet } from 'react-router-dom'
import { Sparkles, ScanSearch, DownloadCloud, History, Settings as SettingsIcon, RefreshCw } from 'lucide-react'
import { useApp } from '../state/AppContext'
import { useProcess } from '../state/Process'
import { api } from '../lib/bridge'
import { cx } from './ui'

const NAV = [
  { to: '/', label: 'Assistant', icon: Sparkles, end: true },
  { to: '/sort', label: 'Sort', icon: ScanSearch },
  { to: '/downloads', label: 'Downloads', icon: DownloadCloud, badge: true },
  { to: '/activity', label: 'Activity', icon: History },
  { to: '/settings', label: 'Settings', icon: SettingsIcon }
]

export default function Layout() {
  const { suggestions, index, settings, info, fail } = useApp()
  const { run } = useProcess()
  const pending = suggestions.length
  const watching = settings ? (settings.paused ? 'Paused' : 'Watching downloads') : '…'

  return (
    <div className="flex h-full">
      <aside className="flex w-[220px] shrink-0 flex-col border-r border-nav-line bg-nav text-nav-ink">
        <div className="flex items-center gap-2.5 px-5 pb-5 pt-6">
          <img src="./logo-mark.png" alt="" className="h-8 w-8 rounded-lg" />
          <div className="leading-tight">
            <div className="text-[15px] font-semibold tracking-tight">KoolMate</div>
          </div>
        </div>

        <nav className="flex-1 space-y-0.5 px-3" aria-label="Primary">
          {NAV.map(({ to, label, icon: Icon, end, badge }) => (
            <NavLink key={to} to={to} end={end}
              className={({ isActive }) => cx('group flex items-center gap-3 rounded-lg px-3 py-2 text-[13.5px] font-medium transition',
                isActive ? 'bg-accent-soft text-accent' : 'text-nav-muted hover:bg-accent-soft/60 hover:text-nav-ink')}>
              <Icon size={17} strokeWidth={1.9} />
              <span className="flex-1">{label}</span>
              {badge && pending > 0 && <span className="rounded-full bg-accent px-1.5 text-[11px] font-semibold leading-5 text-accent-ink">{pending}</span>}
            </NavLink>
          ))}
        </nav>

        <div className="space-y-2.5 border-t border-nav-line px-5 py-4 text-[12px] text-nav-muted">
          <div className="flex items-center gap-2">
            <span className={cx('h-2 w-2 rounded-full', settings?.paused ? 'bg-warn' : 'bg-ok')} />
            <span>{watching}</span>
          </div>
          <button onClick={() => run('index', () => api.index.rebuild(), { doneText: x => `${(x?.count || 0).toLocaleString()} files` }).catch(fail)} className="flex w-full items-center gap-2 text-left transition hover:text-nav-ink" title="Rebuild the file index">
            <RefreshCw size={12} className={index.state === 'indexing' ? 'animate-spin' : ''} />
            <span>{index.state === 'indexing' ? `Indexing… ${index.count.toLocaleString()}` : `${(index.count || 0).toLocaleString()} files indexed`}</span>
          </button>
          <div className="pt-1 text-[11px] opacity-60">v{info?.version || '1.0.0'}</div>
        </div>
      </aside>

      <main className="min-w-0 flex-1 overflow-y-auto">
        <div className="mx-auto w-full max-w-[1040px] px-10 py-8"><Outlet /></div>
      </main>
    </div>
  )
}
