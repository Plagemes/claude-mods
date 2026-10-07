// The Rack: the hero visual. One tile per mod, a column per category, the store on top.
// Categories are racked in banks, one per release that introduced them (v1 on the left, v2 beside it),
// so every release adds a shelf instead of reshuffling the old one.
// Tiles light up as their mod "does its job", narrated by a status line underneath.
import { escapeHtml, iconHref, versionLabel } from './data.js'
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
  // v2 shelf
  'react-doctor': 'useEffect in Cart.tsx is missing [items]',
  'venv-guard': 'blocked pip install outside .venv',
  'node-version-check': 'Node 18 here, .nvmrc wants 22',
  'schema-sync': 'prisma generate done, 1 migration missing',
  'docker-lint': 'Dockerfile: pin node:latest to a version',
  'k8s-dry-run': 'kubectl apply ran as a dry run: 2 changes',
  'terraform-plan-pane': 'plan: 3 to add, 1 to change, 0 to destroy',
  'port-check': 'port 3000 is taken by node (pid 4120)',
  'sql-safety': 'DELETE FROM users has no WHERE',
  'seed-guard': 'held db:reset: DATABASE_URL is not local',
  'backup-before-migrate': 'dumped app_dev before migrating',
  'query-result-cap': 'added LIMIT 200 to the SELECT',
  'a11y-guard': '<img> in Hero.tsx needs alt text',
  'screenshot-check': 'screenshot of / at 1280px sent to Claude',
  'contrast-checker': '#9a9a9a on white is 2.8:1, needs 4.5:1',
  'bundle-size-watch': 'bundle grew 38 kB since the last build',
  'url-allowlist': 'WebFetch to pastebin.com is not allowed',
  'offline-mode': 'offline: npm install held until /offline off',
  'jwt-decode': 'token expires in 14 minutes',
  'scope-lock': 'blocked Edit: src/billing.ts is outside /scope',
  'task-queue': '3 prompts queued, next runs when Claude is free',
  'loop-breaker': 'same failing command 3 times: try another way',
  'edit-limit': 'this turn wants to touch 23 files: confirm?',
  'self-check': 'double-checked: all 4 asks done',
  'explain-diff': 'explained: 3 files changed, and why',
  'why-log': 'why: auth.ts changed to add rate limits',
  'learning-mode': 'left you 2 TODOs to finish yourself',
  'license-checker': 'GPL-3.0 package in an MIT project',
  'pii-in-logs': 'logger.info prints user.email',
  'crypto-guard': 'MD5 for passwords: use bcrypt or argon2',
  'audit-trail': 'action 812 appended to audit.jsonl',
  'flaky-detector': 'checkout.test.ts passed 3 of 5 runs',
  'regression-guard': '2 tests that passed at start now fail',
  'slow-test-flag': 'slowest: upload.test.ts at 4.2s',
  'net-retry': 'npm install retried after ETIMEDOUT',
  'watch-mode-guard': 'vitest --watch would hang: ran once instead',
  'mod-maker': 'mods/tab-title scaffolded, ready to fill in',
  'mod-doctor': '12 mods checked: 1 update, 0 conflicts',
  'quiet-mode': 'quiet: toasts and sounds paused',
  'streaks': '12-day streak',
}

const PLACEHOLDER_BANKS = [10, 10]
const ROWS = 10

export function createRack(root, { onOpen } = {}) {
  const deck = root.querySelector('[data-rack-deck]')
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

  function banksOf(data) {
    if (!data) return PLACEHOLDER_BANKS.map(cols => ({ since: null, columns: Array.from({ length: cols }, () => ({ cat: null, mods: [] })) }))
    const racked = data.categories.filter(c => c.id !== 'core')
    const releases = [...new Set(racked.map(c => c.since))]
    return releases.map(since => ({
      since,
      isNew: racked.some(c => c.since === since && c.isNew),
      columns: racked.filter(c => c.since === since).map(c => ({ cat: c, mods: data.mods.filter(m => m.category === c.id) })),
    }))
  }

  function build(data) {
    const banks = banksOf(data)
    const rows = data ? Math.max(1, ...banks.flatMap(b => b.columns.map(c => c.mods.length))) : ROWS
    const template = banks.map(b => `repeat(${b.columns.length}, minmax(0, 1fr))`).join(' var(--seam) ')
    const totalCols = banks.reduce((n, b) => n + b.columns.length, 0) + banks.length - 1
    deck.style.setProperty('--tpl', template)
    root.classList.toggle('rack--banked', banks.length > 1)

    const frag = document.createDocumentFragment()
    const add = (tag, className, col, row, html) => {
      const el = document.createElement(tag)
      el.className = className
      el.style.gridColumn = col
      el.style.gridRow = row
      if (html) el.innerHTML = html
      frag.append(el)
      return el
    }

    cells = []
    byName = new Map()
    const centre = (totalCols - 1) / 2
    let offset = 0
    banks.forEach((bank, b) => {
      const n = bank.columns.length
      if (b > 0) add('i', 'rack__seam', String(offset), '1 / -1')
      const count = bank.columns.reduce((sum, c) => sum + c.mods.length, 0)
      const label = bank.since
        ? `<b>${escapeHtml(versionLabel(bank.since))}</b><span>${count} ${bank.isNew ? 'new' : 'mods'}</span>`
        : '<b>&nbsp;</b>'
      add('span', `rack__label${bank.isNew ? ' is-new' : ''}`, `${offset + 1} / span ${n}`, '1', label)
      bank.columns.forEach((column, c) => {
        const col = offset + c + 1
        const head = add('span', 'rack__head', String(col), '2', column.cat ? `<svg class="icon"><use href="${iconHref(column.cat.id)}"/></svg>` : '')
        if (column.cat) {
          head.dataset.head = column.cat.id
          head.title = column.cat.title
        }
        for (let r = 0; r < rows; r++) {
          const mod = column.mods[r] ?? null
          const el = add('i', 'cell', String(col), String(r + 3))
          if (data && !mod) el.classList.add('is-empty')
          const distance = Math.hypot(col - 1 - centre, r + 1.5)
          el.style.setProperty('--d', String(Math.round(distance * 46 + Math.random() * 60)))
          if (mod) {
            el.dataset.mod = mod.name
            byName.set(mod.name, el)
          }
          cells.push({ el, mod })
        }
      })
      offset += n + 1
    })
    deck.replaceChildren(frag)

    if (data) {
      const tiles = data.mods.length
      const shelves = banks.length > 1 ? ` on ${banks.length} shelves, one per release` : ''
      root.setAttribute('aria-label', `A rack of ${tiles} mod tiles${shelves}: the mod store on top and a column of tiles for each of ${data.categories.length - 1} categories below. Tiles light up as each mod does its job.`)
    }
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
    deck.querySelectorAll('[data-head]').forEach(h => h.classList.toggle('is-active', h.dataset.head === categoryId))
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

  deck.addEventListener('pointerover', event => {
    const el = event.target.closest('.cell[data-mod]')
    if (!el || !catalog) return
    hovering = true
    const mod = catalog.byName.get(el.dataset.mod)
    if (mod) {
      setStatus(mod, mod.description, { type: false })
      highlightHead(mod.category)
    }
  })
  deck.addEventListener('pointerleave', () => { hovering = false })
  deck.addEventListener('click', event => {
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
