/** @type {import('tailwindcss').Config} */
const c = name => `rgb(var(--${name}) / <alpha-value>)`
export default {
  content: ['./index.html', './src/**/*.{js,jsx}'],
  darkMode: ['selector', '[data-theme="dark"]'],
  theme: {
    extend: {
      fontFamily: { sans: ['"Inter Variable"', 'Inter', '"Segoe UI"', 'system-ui', 'sans-serif'], mono: ['ui-monospace', 'SFMono-Regular', 'Consolas', 'monospace'] },
      colors: {
        bg: c('bg'), surface: c('surface'), surface2: c('surface-2'), line: c('line'),
        ink: c('ink'), muted: c('muted'), subtle: c('subtle'),
        accent: c('accent'), 'accent-soft': c('accent-soft'), 'accent-ink': c('accent-ink'),
        ok: c('ok'), 'ok-soft': c('ok-soft'), warn: c('warn'), 'warn-soft': c('warn-soft'),
        bad: c('bad'), 'bad-soft': c('bad-soft'),
        nav: c('nav'), 'nav-line': c('nav-line'), 'nav-ink': c('nav-ink'), 'nav-muted': c('nav-muted')
      },
      boxShadow: {
        card: '0 1px 2px rgb(90 60 10 / 0.05), 0 1px 1px rgb(90 60 10 / 0.03)',
        pop: '0 16px 40px rgb(90 60 10 / 0.22), 0 2px 6px rgb(90 60 10 / 0.08)'
      },
      keyframes: {
        fadeUp: { from: { opacity: 0, transform: 'translateY(6px)' }, to: { opacity: 1, transform: 'none' } },
        spin: { to: { transform: 'rotate(360deg)' } },
        fadeIn: { from: { opacity: 0 }, to: { opacity: 1 } },
        popIn: { from: { opacity: 0, transform: 'scale(.94) translateY(8px)' }, to: { opacity: 1, transform: 'none' } },
        shimmer: { from: { transform: 'translateX(-100%)' }, to: { transform: 'translateX(100%)' } },
        pingSlow: { '0%': { transform: 'scale(.8)', opacity: .7 }, '100%': { transform: 'scale(1.25)', opacity: 0 } }
      },
      animation: { 'fade-up': 'fadeUp .18s ease-out both', 'fade-in': 'fadeIn .2s ease-out both', 'pop-in': 'popIn .28s cubic-bezier(.2,.9,.3,1.2) both', shimmer: 'shimmer 1.4s linear infinite', 'ping-slow': 'pingSlow 1.8s ease-out infinite' }
    }
  },
  plugins: []
}
