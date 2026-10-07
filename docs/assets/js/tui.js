// The /mods preview in the install section: a small scripted loop of browsing and installing.
import { reducedMotion } from './ui.js'

export function initTui(root, getCatalog) {
  if (!root) return
  const rows = [...root.querySelectorAll('[data-tui-list] li')]
  const nameEl = root.querySelector('[data-tui-name]')
  const descEl = root.querySelector('[data-tui-desc]')
  const button = root.querySelector('[data-tui-btn]')
  const toastEl = root.querySelector('[data-tui-toast]')
  const initial = rows.map(r => ({ cls: r.querySelector('.tui__state').className, text: r.querySelector('.tui__state').textContent }))

  let sel = 1
  let visible = false
  let step = 0
  let timer = 0

  function describe(i) {
    const row = rows[i]
    const name = row.querySelector('.tui__name').textContent
    const state = row.querySelector('.tui__state')
    const mod = getCatalog()?.byName.get(name)
    const installed = state.classList.contains('is-installed')
    const update = state.classList.contains('is-update')
    nameEl.innerHTML = `${name} <span class="tui__dim">v${update ? '1.0.0 → 1.1.0' : mod?.version ?? '1.0.0'}</span>`
    if (mod) descEl.textContent = mod.description
    button.textContent = update ? 'Update' : installed ? 'Uninstall' : 'Install'
  }

  function select(i) {
    sel = i
    rows.forEach((r, j) => r.classList.toggle('is-sel', j === i))
    describe(i)
  }

  function setState(i, kind, text) {
    const state = rows[i].querySelector('.tui__state')
    state.className = `tui__state${kind ? ` is-${kind}` : ''}`
    state.textContent = text
  }

  function toast(text) {
    toastEl.lastChild.textContent = ` ${text}`
    toastEl.classList.add('is-shown')
    setTimeout(() => toastEl.classList.remove('is-shown'), 1700)
  }

  function press(then) {
    button.classList.add('is-pressed')
    setTimeout(() => {
      button.classList.remove('is-pressed')
      then()
    }, 260)
  }

  const script = [
    () => select(1),
    () => press(() => { setState(1, 'installed', 'installed'); describe(1); toast('env-guard installed. Run /reload-plugins') }),
    () => select(2),
    () => press(() => { setState(2, 'installed', 'installed'); describe(2); toast('rm-rf-guard updated to 1.1.0') }),
    () => select(3),
    () => select(4),
    () => select(3),
    () => press(() => { setState(3, 'installed', 'installed'); describe(3); toast('force-push-guard installed') }),
    () => {
      rows.forEach((r, i) => setState(i, initial[i].cls.replace('tui__state', '').trim().replace('is-', ''), initial[i].text))
      select(0)
    },
  ]

  function loop() {
    if (visible && !document.hidden) {
      script[step % script.length]()
      step += 1
    }
    timer = setTimeout(loop, step % script.length === 0 ? 2200 : 1500)
  }

  select(sel)
  if (reducedMotion()) return

  if ('IntersectionObserver' in window) {
    new IntersectionObserver(([entry]) => {
      visible = entry.isIntersecting
      if (visible && !timer) loop()
    }, { threshold: 0.3 }).observe(root)
  }
}
