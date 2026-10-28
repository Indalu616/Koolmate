import { createMockApi } from './mockApi'

/**
 * In the desktop app the preload script exposes the real API on window.koolmate.
 * In a plain browser (npm run dev, screenshots, docs) we fall back to an in-memory mock with sample data.
 */
export const api = typeof window !== 'undefined' && window.koolmate ? window.koolmate : createMockApi()
export const isDesktop = !!(typeof window !== 'undefined' && window.koolmate)
