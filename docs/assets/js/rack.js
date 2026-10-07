// The Rack: the hero visual. One tile per mod, a column per category, the store on top.
// Tiles light up as their mod "does its job", narrated by a status line underneath.
import { escapeHtml, iconHref } from './data.js'
import { reducedMotion } from './ui.js'

const EVENTS = {
  'secret-shield': 'denied Write: src/config.ts holds an sk-ant- key',
  'rm-rf-guard': 'blocked rm -rf ~/ (try rm -rf ./dist)',
  'force-push-guard': 'rewrote --force to --force-with-lease',
  'prod-guard': 'held terraform apply until you say PROD-OK',
  'env-guard': 'kept .env.production out of the context',
  'git-status-line': 'main  +2 ahead  3 changed',
  'auto-checkpoint': 'checkpoint 14 saved, /rollback to restore',
  'commit-composer': 'feat(auth): add magic-link sign-in',
  'main-branch-warn': 'heads up: editing directly on main',
  'cost-meter': '$0.42 this session, 128k tokens',
  'context-gauge': 'context 52% full',
  'cache-hit-meter': '71% of input served from cache',
  'token-budget': '80% of the $5.00 budget used',
  'turn-timer': 'that turn took 1m 48s',
  'output-trimmer': 'trimmed 4,812 lines of output to 40',
  'todo-pane': 'tasks: 4 of 6 done',
  'focus-timer': 'focus: 18:24 left',
  'quote-selection': 'quoted 12 lines into the prompt',
  'test-watch': '48 passed, 0 failed in 2.1s',
  'lint-on-save': '2 lint problems sent back to Claude',
  'no-skip-tests': 'blocked it.only in auth.test.ts',
  'typecheck-gate': 'type check clean, 0 errors',
  'auto-format': 'formatted 3 files',
  'tool-timeline': 'Bash npm test finished in 6.1s',
  'subagent-monitor': '2 subagents running: review, docs',
  'error-feed': 'new error: npm run build exited 1',
  'language-lock': 'answering in German, code stays English',
  'stack-detector': 'detected Next.js and Postgres',
  'done-chime': 'chime: turn finished in 1m 48s',
  'permission-ping': 'Claude is waiting for your approval',
  'ci-watch': 'CI passed on #128 in 4m 12s',
  'celebrate': 'tests are green again',
  'webhook-notify': 'posted "done" to #deploys',
  'decision-log': 'ADR-0007 recorded in docs/decisions',
  'session-journal': 'journal saved for today',
  'lessons-learned': 'lesson saved to CLAUDE.md',
  'resume-brief': 'last time: moving auth to sessions',
  'standup': 'standup ready: 6 commits, 2 PRs',
  'changelog-keeper': '2 entries added to Unreleased',
  'codeowners-hint': 'src/billing is owned by @payments',
  'review-agent': 'review done: 3 suggestions, 0 blockers',
}

const COLS = 10
const ROWS = 10

export function createRack(root, { onOpen } = {}) {
  const grid = root.querySelector('[data-rack-grid]')
  const heads = root.querySelector('[data-rack-heads]')
  const statusIcon = root.querySelector('[data-status-icon] use')
  const statusName = root.querySelector('[data-status-name]')
  const statusMsg = root.querySelector('[data-status-msg]')

  let cells = []          // { el, mod }
  let byName = new Map()
  let catalog = null
  let running = false
  let visible = true
  let hovering = false
  let timers = []
  let typing = 0
  let queue = []

  // Placeholder tiles so the hero has its shape before the catalog arrives.
  build(null)

  function build(data) {
    const columns = data
      ? data.categories.filter(c => c.id !== 'core').map(c => ({ cat: c, mods: data.mods.filter(m => m.category === c.id) }))
      : Array.from({ length: COLS }, () => ({ cat: null, mods: [] }))
    const cols = Math.max(1, columns.length)
    const rows = data ? Math.max(1, ...columns.map(c => c.mods.length)) : ROWS
    root.style.setProperty('--cols', String(cols))
    grid.style.setProperty('--cols', String(cols))
    heads.style.setProperty('--cols', String(cols))

    heads.innerHTML = columns
      .map(c => c.cat ? `<span title="${escapeHtml(c.cat.title)}" data-head="${escapeHtml(c.cat.id)}"><svg class="icon"><use href="${iconHref(c.cat.id)}"/></svg></span>` : '<span></span>')
      .join('')

    const frag = document.createDocumentFragment()
    cells = []
    byName = new Map()
    const centre = (cols - 1) / 2
    for (let r = 0; r < rows; r++) {
      for (let c = 0; c < cols; c++) {
        const mod = columns[c].mods[r] ?? null
        const el = document.createElement('i')
        el.className = 'cell'
        if (data && !mod) el.classList.add('is-empty')
        const distance = Math.hypot(c - centre, r + 1.5)
        el.style.setProperty('--d', String(Math.round(distance * 46 + Math.random() * 60)))
        if (mod) {
          el.dataset.mod = mod.name
          el.dataset.col = String(c)
          byName.set(mod.name, el)
        }
        cells.push({ el, mod })
        frag.append(el)
      }
    }
    grid.replaceChildren(frag)
  }

  function setStatus(mod, message, { type = true } = {}) {
    if (!mod) return
    statusIcon?.setAttribute('href', iconHref(mod.category))
    statusName.textContent = mod.name
    cancelAnimationFrame(typing)
    if (!type || reducedMotion()) {
      statusMsg.textContent = message
      return
    }
    let shown = 0
    let last = 0
    statusMsg.textContent = ''
    const step = now => {
      if (now - last > 16) {
        shown += 2
        last = now
        statusMsg.textContent = message.slice(0, shown)
      }
      if (shown < message.length) typing = requestAnimationFrame(step)
    }
    typing = requestAnimationFrame(step)
  }

  function flash(el) {
    if (!el) return
    el.classList.add('is-hot')
    later(() => {
      el.classList.remove('is-hot')
      el.classList.add('is-on')
    }, 900)
  }

  function later(fn, ms) {
    const id = setTimeout(fn, ms)
    timers.push(id)
    return id
  }

  function nextEvent() {
    if (queue.length === 0) {
      const names = Object.keys(EVENTS).filter(n => byName.has(n))
      queue = (names.length ? names : [...byName.keys()]).sort(() => Math.random() - 0.5)
    }
    return queue.shift()
  }

  function tick() {
    if (!running || !catalog) return
    if (!hovering && visible && !document.hidden) {
      const name = nextEvent()
      const mod = catalog.byName.get(name)
      if (mod) {
        setStatus(mod, EVENTS[name] ?? mod.description)
        flash(byName.get(name))
        highlightHead(mod.category)
      }
      drift()
    }
    later(tick, 2600)
  }

  // Keep the rack alive: a few tiles quietly switch on or off between events.
  function drift() {
    const live = cells.filter(c => c.mod)
    const on = live.filter(c => c.el.classList.contains('is-on'))
    const ratio = on.length / Math.max(1, live.length)
    const pickFrom = ratio > 0.55 ? on : live.filter(c => !c.el.classList.contains('is-on'))
    const pick = pickFrom[Math.floor(Math.random() * pickFrom.length)]
    if (pick) later(() => pick.el.classList.toggle('is-on', ratio <= 0.55), 1200)
  }

  function highlightHead(categoryId) {
    heads.querySelectorAll('[data-head]').forEach(h => h.classList.toggle('is-active', h.dataset.head === categoryId))
  }

  function seedInstalled() {
    const live = cells.filter(c => c.mod)
    live.forEach(c => c.el.classList.toggle('is-on', Math.random() < 0.34))
  }

  function start() {
    if (running) return
    running = true
    const motion = !reducedMotion()
    if (motion) {
      root.classList.add('is-booting')
      const maxDelay = Math.max(...cells.map(c => Number(c.el.style.getPropertyValue('--d')) || 0))
      later(() => {
        root.classList.remove('is-booting')
        seedInstalled()
        tick()
      }, maxDelay + 1200)
    } else {
      seedInstalled()
      const first = catalog.byName.get('secret-shield') ?? catalog.mods[0]
      if (first) setStatus(first, EVENTS[first.name] ?? first.description, { type: false })
    }
  }

  grid.addEventListener('pointerover', event => {
    const el = event.target.closest('.cell[data-mod]')
    if (!el || !catalog) return
    hovering = true
    const mod = catalog.byName.get(el.dataset.mod)
    if (mod) {
      setStatus(mod, mod.description, { type: false })
      highlightHead(mod.category)
    }
  })
  grid.addEventListener('pointerleave', () => { hovering = false })
  grid.addEventListener('click', event => {
    const el = event.target.closest('.cell[data-mod]')
    if (el) onOpen?.(el.dataset.mod)
  })
  root.querySelector('[data-open-mod]')?.addEventListener('click', event => {
    onOpen?.(event.currentTarget.dataset.openMod)
  })

  if ('IntersectionObserver' in window) {
    new IntersectionObserver(([entry]) => { visible = entry.isIntersecting }).observe(root)
  }

  return {
    setCatalog(data) {
      catalog = data
      build(data)
      start()
    },
  }
}
