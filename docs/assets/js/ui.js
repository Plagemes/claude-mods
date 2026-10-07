// Small UI utilities: theme, clipboard, toast, reveals, pointer spotlight.

export const reducedMotion = () =>
  document.documentElement.classList.contains('reduced-motion') ||
  window.matchMedia('(prefers-reduced-motion: reduce)').matches

/* ---------- Theme ---------- */
const THEME_KEY = 'claude-mods:theme'
const systemLight = window.matchMedia('(prefers-color-scheme: light)')

function effectiveTheme() {
  const forced = document.documentElement.dataset.theme
  if (forced === 'light' || forced === 'dark') return forced
  return systemLight.matches ? 'light' : 'dark'
}

function syncTheme() {
  const theme = effectiveTheme()
  document.documentElement.dataset.effectiveTheme = theme
  const button = document.querySelector('[data-theme-toggle]')
  if (button) button.setAttribute('aria-label', theme === 'dark' ? 'Switch to light theme' : 'Switch to dark theme')
}

export function initTheme() {
  syncTheme()
  systemLight.addEventListener?.('change', syncTheme)
  document.querySelector('[data-theme-toggle]')?.addEventListener('click', () => {
    const next = effectiveTheme() === 'dark' ? 'light' : 'dark'
    const apply = () => {
      document.documentElement.dataset.theme = next
      syncTheme()
    }
    if (document.startViewTransition && !reducedMotion()) document.startViewTransition(apply)
    else apply()
    try { localStorage.setItem(THEME_KEY, next) } catch { /* storage unavailable: theme still applies for this visit */ }
  })
}

/* ---------- Toast ---------- */
let toastTimer = 0
export function toast(message) {
  const el = document.querySelector('[data-toast]')
  if (!el) return
  el.textContent = message
  el.classList.add('is-shown')
  clearTimeout(toastTimer)
  toastTimer = setTimeout(() => el.classList.remove('is-shown'), 2600)
}

/* ---------- Clipboard ---------- */
export async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text)
    return true
  } catch {
    const area = document.createElement('textarea')
    area.value = text
    area.setAttribute('readonly', '')
    area.style.cssText = 'position:fixed;top:-1000px;opacity:0'
    document.body.append(area)
    area.select()
    let ok = false
    try { ok = document.execCommand('copy') } catch { ok = false }
    area.remove()
    return ok
  }
}

export function flashCopied(button) {
  button.classList.add('is-copied')
  clearTimeout(button._copiedTimer)
  button._copiedTimer = setTimeout(() => button.classList.remove('is-copied'), 1800)
}

export function initCopyButtons(root = document) {
  root.addEventListener('click', async event => {
    const button = event.target.closest('[data-copy]')
    if (!button) return
    const text = button.dataset.copy
    const ok = await copyText(text)
    if (ok) {
      flashCopied(button)
      toast(text === '/mods' ? 'Copied /mods' : 'Copied. Paste it into Claude Code.')
    } else {
      toast('Copy failed. Select the command and copy it manually.')
    }
  })
}

/* ---------- Reveal on scroll ---------- */
export function initReveal() {
  const items = [...document.querySelectorAll('.reveal, .feat, [data-flow]')]
  if (!('IntersectionObserver' in window) || reducedMotion()) {
    items.forEach(el => el.classList.add('is-in'))
    return
  }
  // Stagger siblings that enter together.
  document.querySelectorAll('.bento, .steps, .section-head').forEach(group => {
    ;[...group.querySelectorAll('.reveal')].forEach((el, i) => el.style.setProperty('--stagger', String(i)))
  })
  const io = new IntersectionObserver(entries => {
    for (const entry of entries) {
      if (!entry.isIntersecting) continue
      entry.target.classList.add('is-in')
      io.unobserve(entry.target)
    }
  }, { rootMargin: '0px 0px -8% 0px', threshold: 0.08 })
  items.forEach(el => io.observe(el))
}

/* ---------- Pointer spotlight on cards ---------- */
export function initSpotlight() {
  if (window.matchMedia('(hover: none)').matches) return
  document.addEventListener('pointermove', event => {
    const card = event.target.closest?.('.feat, .card')
    if (!card) return
    const rect = card.getBoundingClientRect()
    card.style.setProperty('--mx', `${event.clientX - rect.left}px`)
    card.style.setProperty('--my', `${event.clientY - rect.top}px`)
  }, { passive: true })
}

/* ---------- Header state ---------- */
export function initHeader() {
  const header = document.querySelector('.site-header')
  if (!header) return
  const update = () => header.classList.toggle('is-scrolled', window.scrollY > 8)
  update()
  window.addEventListener('scroll', update, { passive: true })
}
