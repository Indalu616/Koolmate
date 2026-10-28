import React from 'react'
import { HashRouter, Route, Routes } from 'react-router-dom'
import { AppProvider } from './state/AppContext'
import { ProcessProvider } from './state/Process'
import Layout from './components/Layout'
import Assistant from './pages/Assistant'
import Downloads from './pages/Downloads'
import Activity from './pages/Activity'
import Sort from './pages/Sort'
import Settings from './pages/Settings'
import Popup from './pages/Popup'

export default function App() {
  return (
    <HashRouter>
      <Routes>
        <Route path="/popup" element={<Popup />} />
        <Route element={<AppProvider><ProcessProvider><Layout /></ProcessProvider></AppProvider>}>
          <Route index element={<Assistant />} />
          <Route path="sort" element={<Sort />} />
          <Route path="downloads" element={<Downloads />} />
          <Route path="activity" element={<Activity />} />
          <Route path="settings" element={<Settings />} />
          <Route path="*" element={<Assistant />} />
        </Route>
      </Routes>
    </HashRouter>
  )
}
