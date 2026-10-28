import React, { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { api } from '../lib/bridge'
import { cleanError } from '../lib/format'
import { Toasts } from '../components/ui'

const Ctx = createContext(null)
export const useApp = () => useContext(Ctx)

/** Applies light/dark theme from settings ("system" follows the OS). */
export function useTheme(theme) {
  useEffect(() => {
    const mq = window.matchMedia('(prefers-color-scheme: dark)')
    const apply = () => { document.documentElement.dataset.theme = theme === 'system' || !theme ? (mq.matches ? 'dark' : 'light') : theme }
    apply()
    mq.addEventListener('change', apply)
    return () => mq.removeEventListener('change', apply)
  }, [theme])
}

export function AppProvider({ children }) {
  const [settings, setSettings] = useState(null)
  const [suggestions, setSuggestions] = useState([])
  const [activity, setActivity] = useState([])
  const [index, setIndex] = useState({ state: 'idle', count: 0 })
  const [info, setInfo] = useState(null)
  const [toasts, setToasts] = useState([])
  const navigate = useNavigate()
  const seq = useRef(0)

  useTheme(settings?.theme)

  const dismissToast = useCallback(id => setToasts(t => t.filter(x => x.id !== id)), [])
  const toast = useCallback((message, opts = {}) => {
    const id = ++seq.current
    setToasts(t => [...t.slice(-3), { id, message, type: opts.type || 'info', action: opts.action }])
    setTimeout(() => dismissToast(id), opts.action ? 12000 : 5500)
  }, [dismissToast])
  const fail = useCallback(e => toast(cleanError(e), { type: 'error' }), [toast])

  useEffect(() => {
    api.settings.get().then(setSettings).catch(fail)
    api.suggestions.list().then(setSuggestions).catch(() => {})
    api.activity.list().then(setActivity).catch(() => {})
    api.index.status().then(setIndex).catch(() => {})
    api.app.info().then(setInfo).catch(() => {})
    const offs = [
      api.on('suggestions:changed', setSuggestions),
      api.on('activity:changed', setActivity),
      api.on('index:progress', setIndex),
      api.on('settings:changed', setSettings),
      api.on('navigate', route => navigate(route))
    ]
    return () => offs.forEach(off => off())
  }, [fail, navigate])

  const updateSettings = useCallback(async patch => {
    try { const s = await api.settings.update(patch); setSettings(s); return s } catch (e) { fail(e); throw e }
  }, [fail])

  const value = useMemo(() => ({ settings, updateSettings, suggestions, setSuggestions, activity, setActivity, index, info, toast, fail }), [settings, updateSettings, suggestions, activity, index, info, toast, fail])

  return (
    <Ctx.Provider value={value}>
      {children}
      <Toasts toasts={toasts} dismiss={dismissToast} />
    </Ctx.Provider>
  )
}
