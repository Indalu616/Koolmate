import React, { useEffect } from 'react'
import { X, Loader2, FileText, FileSpreadsheet, FileImage, FileVideo, FileAudio, FileArchive, Presentation, File as FileIcon, FolderOpen, ChevronRight } from 'lucide-react'
import { fileKind, splitPath } from '../lib/format'

const cx = (...a) => a.filter(Boolean).join(' ')

const BTN = {
  primary: 'bg-accent text-accent-ink hover:brightness-110 shadow-sm',
  secondary: 'bg-surface text-ink border border-line hover:bg-surface2 shadow-sm',
  ghost: 'text-muted hover:text-ink hover:bg-surface2',
  danger: 'bg-surface text-bad border border-line hover:bg-bad-soft'
}
const BTN_SIZE = { sm: 'h-8 px-3 text-[13px] gap-1.5', md: 'h-9 px-3.5 text-sm gap-2', lg: 'h-10 px-4 text-sm gap-2' }

export function Button({ variant = 'secondary', size = 'md', loading, icon: Icon, children, className, disabled, ...rest }) {
  return (
    <button
      {...rest}
      disabled={disabled || loading}
      className={cx('inline-flex shrink-0 items-center justify-center rounded-lg font-medium transition active:scale-[.98] disabled:cursor-not-allowed disabled:opacity-50', BTN[variant], BTN_SIZE[size], className)}
    >
      {loading ? <Loader2 size={15} className="animate-spin" /> : Icon ? <Icon size={15} strokeWidth={2} /> : null}
      {children}
    </button>
  )
}

export function IconButton({ icon: Icon, label, className, ...rest }) {
  return (
    <button {...rest} aria-label={label} title={label} className={cx('inline-flex h-8 w-8 items-center justify-center rounded-lg text-muted transition hover:bg-surface2 hover:text-ink', className)}>
      <Icon size={16} />
    </button>
  )
}

const TONES = {
  neutral: 'bg-surface2 text-muted',
  accent: 'bg-accent-soft text-accent',
  ok: 'bg-ok-soft text-ok',
  warn: 'bg-warn-soft text-warn',
  bad: 'bg-bad-soft text-bad',
  muted: 'bg-surface2 text-muted'
}
export function Badge({ tone = 'neutral', icon: Icon, children, className }) {
  return (
    <span className={cx('inline-flex items-center gap-1 whitespace-nowrap rounded-md px-2 py-0.5 text-xs font-medium', TONES[tone], className)}>
      {Icon && <Icon size={12} />}
      {children}
    </span>
  )
}

export function Card({ className, children, ...rest }) {
  return <section {...rest} className={cx('rounded-xl border border-line bg-surface shadow-card', className)}>{children}</section>
}

export function CardHeader({ title, description, action }) {
  return (
    <div className="flex items-start justify-between gap-4 border-b border-line px-5 py-4">
      <div className="min-w-0">
        <h2 className="text-[15px] font-semibold text-ink">{title}</h2>
        {description && <p className="mt-0.5 text-[13px] text-muted">{description}</p>}
      </div>
      {action}
    </div>
  )
}

export function PageHeader({ title, description, actions }) {
  return (
    <header className="flex flex-wrap items-end justify-between gap-x-6 gap-y-3 pb-6">
      <div className="min-w-[320px] flex-1">
        <h1 className="text-[22px] font-semibold tracking-tight text-ink">{title}</h1>
        {description && <p className="mt-1 max-w-xl text-sm text-muted">{description}</p>}
      </div>
      {actions && <div className="flex shrink-0 items-center gap-2">{actions}</div>}
    </header>
  )
}

export function Toggle({ checked, onChange, label, description, disabled }) {
  return (
    <label className={cx('flex items-start justify-between gap-6 py-3', disabled ? 'opacity-50' : 'cursor-pointer')}>
      <span className="min-w-0">
        <span className="block text-sm font-medium text-ink">{label}</span>
        {description && <span className="mt-0.5 block text-[13px] text-muted">{description}</span>}
      </span>
      <button
        type="button" role="switch" aria-checked={checked} disabled={disabled}
        onClick={() => onChange(!checked)}
        className={cx('relative mt-0.5 h-5 w-9 shrink-0 rounded-full transition', checked ? 'bg-accent' : 'bg-line')}
      >
        <span className={cx('absolute top-0.5 h-4 w-4 rounded-full bg-white shadow transition-all', checked ? 'left-[18px]' : 'left-0.5')} />
      </button>
    </label>
  )
}

export function Segmented({ value, onChange, options }) {
  return (
    <div className="inline-flex rounded-lg border border-line bg-surface2 p-0.5">
      {options.map(o => (
        <button key={o.value} type="button" onClick={() => onChange(o.value)}
          className={cx('rounded-md px-3 py-1 text-[13px] font-medium transition', value === o.value ? 'bg-accent text-accent-ink shadow-sm' : 'text-muted hover:text-ink')}>
          {o.label}
        </button>
      ))}
    </div>
  )
}

export function Modal({ open, onClose, title, description, children, footer, width = 'max-w-3xl' }) {
  useEffect(() => {
    if (!open) return
    const onKey = e => { if (e.key === 'Escape') onClose() }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [open, onClose])
  if (!open) return null
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-6" role="dialog" aria-modal="true" aria-label={title}>
      <div className="absolute inset-0 bg-ink/40 backdrop-blur-[2px]" onClick={onClose} />
      <div className={cx('relative flex max-h-[86vh] w-full animate-fade-up flex-col overflow-hidden rounded-2xl border border-line bg-surface shadow-pop', width)}>
        <div className="flex items-start justify-between gap-4 border-b border-line px-6 py-4">
          <div>
            <h2 className="text-base font-semibold text-ink">{title}</h2>
            {description && <p className="mt-0.5 text-[13px] text-muted">{description}</p>}
          </div>
          <IconButton icon={X} label="Close" onClick={onClose} />
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto px-6 py-5">{children}</div>
        {footer && <div className="flex items-center justify-end gap-2 border-t border-line bg-surface2/50 px-6 py-3.5">{footer}</div>}
      </div>
    </div>
  )
}

export function EmptyState({ icon: Icon, title, description, children }) {
  return (
    <div className="flex flex-col items-center px-6 py-14 text-center">
      <div className="mb-4 flex h-14 w-14 items-center justify-center rounded-full bg-accent-soft text-accent">
        <Icon size={22} />
      </div>
      <h3 className="text-[15px] font-semibold text-ink">{title}</h3>
      {description && <p className="mt-1 max-w-md text-sm text-muted">{description}</p>}
      {children && <div className="mt-5">{children}</div>}
    </div>
  )
}

export function Spinner({ size = 16 }) { return <Loader2 size={size} className="animate-spin text-muted" /> }

export function Kbd({ children }) {
  return <kbd className="rounded border border-line bg-surface2 px-1.5 py-0.5 font-mono text-[11px] text-muted">{children}</kbd>
}

const KIND_ICON = { PDF: FileText, Word: FileText, Text: FileText, Slides: Presentation, Sheet: FileSpreadsheet, Image: FileImage, Video: FileVideo, Audio: FileAudio, Archive: FileArchive }
const KIND_TONE = { bad: 'bg-bad-soft text-bad', accent: 'bg-accent-soft text-accent', warn: 'bg-warn-soft text-warn', ok: 'bg-ok-soft text-ok', muted: 'bg-surface2 text-muted' }

export function FileTile({ ext, size = 'md' }) {
  const k = fileKind(ext)
  const Icon = KIND_ICON[k.label] || FileIcon
  return (
    <div className={cx('flex shrink-0 items-center justify-center rounded-lg', KIND_TONE[k.tone], size === 'lg' ? 'h-11 w-11' : 'h-9 w-9')}>
      <Icon size={size === 'lg' ? 20 : 17} />
    </div>
  )
}

/** Folder path rendered as breadcrumb, showing the trailing segments. */
export function PathCrumbs({ path, keep = 3, className, highlight = true }) {
  const parts = splitPath(path)
  const shown = parts.slice(-keep)
  const truncated = parts.length > keep
  return (
    <div className={cx('flex min-w-0 flex-wrap items-center gap-x-1 text-[13px]', className)} title={path}>
      <FolderOpen size={14} className="mr-1 shrink-0 text-subtle" />
      {truncated && <span className="text-subtle">…<ChevronRight size={12} className="mx-0.5 inline text-subtle" /></span>}
      {shown.map((p, i) => (
        <React.Fragment key={i}>
          {i > 0 && <ChevronRight size={12} className="shrink-0 text-subtle" />}
          <span className={cx('truncate', highlight && i === shown.length - 1 ? 'font-semibold text-ink' : 'text-muted')}>{p}</span>
        </React.Fragment>
      ))}
    </div>
  )
}

export function ConfidenceMeter({ value, needsReview }) {
  const pct = Math.round((value ?? 0) * 100)
  const level = needsReview || pct < 55 ? 'low' : pct < 80 ? 'medium' : 'high'
  const tone = { low: 'bg-warn', medium: 'bg-accent', high: 'bg-ok' }[level]
  const label = { low: 'Low', medium: 'Medium', high: 'High' }[level]
  const text = { low: 'text-warn', medium: 'text-accent', high: 'text-ok' }[level]
  return (
    <div className="flex items-center gap-2.5" title={`${pct}% match`}>
      <div className="h-1.5 w-20 overflow-hidden rounded-full bg-line"><div className={cx('h-full rounded-full', tone)} style={{ width: `${Math.max(6, pct)}%` }} /></div>
      <span className={cx('text-xs font-medium', text)}>{label} · {pct}%</span>
    </div>
  )
}

export function Toasts({ toasts, dismiss }) {
  return (
    <div className="pointer-events-none fixed bottom-5 right-5 z-[60] flex w-[380px] flex-col gap-2">
      {toasts.map(t => (
        <div key={t.id} role="status" className="pointer-events-auto flex animate-fade-up items-start gap-3 rounded-xl border border-line bg-surface p-3.5 shadow-pop">
          <div className={cx('mt-0.5 h-2 w-2 shrink-0 rounded-full', t.type === 'error' ? 'bg-bad' : t.type === 'success' ? 'bg-ok' : 'bg-accent')} />
          <p className="min-w-0 flex-1 text-[13px] leading-snug text-ink">{t.message}</p>
          {t.action && (
            <button className="shrink-0 text-[13px] font-semibold text-accent hover:underline" onClick={() => { t.action.onClick(); dismiss(t.id) }}>{t.action.label}</button>
          )}
          <button aria-label="Dismiss" className="shrink-0 text-subtle hover:text-ink" onClick={() => dismiss(t.id)}><X size={14} /></button>
        </div>
      ))}
    </div>
  )
}

export { cx }
