// The store: catalog grid, instant search, category + tier filters, detail sheet, deep links.
import { escapeHtml, iconHref, iconSvg, installCommand, sourceUrl, tierOf } from './data.js'
import { copyText, flashCopied, reducedMotion, toast } from './ui.js'

const RESERVED_IDS = new Set(['top', 'main', 'install', 'features', 'store', 'how', 'build'])

export function createStore(root, catalog, { media = {} } = {}) {
  const grid = root.querySelector('[data-grid]')
  const chipsRow = root.querySelector('[data-cats]')
  const banner = root.querySelector('[data-cat-banner]')
  const status = root.querySelector('[data-status]')
  const empty = root.querySelector('[data-empty]')
  const emptyQ = root.querySelector('[data-empty-q]')
  const search = root.querySelector('[data-search]')
  const tiers = root.querySelector('[data-tiers]')
  const sheet = document.querySelector('[data-sheet]')
  const sheetBody = document.querySelector('[data-sheet-body]')

  const { mods, categories, repository } = catalog
  const state = { q: '', tokens: [], cat: 'all', tier: 'all' }
  const cards = new Map()
  const catIndex = new Map(categories.map((c, i) => [c.id, i]))
  let groups = new Map()
  let lastFocus = null

  search.placeholder = window.innerWidth < 520 ? `Search ${mods.length} mods` : `Search ${mods.length} mods, commands, keywords`

  /* ---------- Render ---------- */
  renderChips()
  renderCards()
  apply()

  function renderChips() {
    const all = `<button type="button" class="chip" data-cat="all" aria-pressed="true"><svg class="icon" aria-hidden="true"><use href="#i-core"/></svg>All<span class="chip__count" data-chip-count>${mods.length}</span></button>`
    chipsRow.innerHTML = all + categories
      .map(c => `<button type="button" class="chip" data-cat="${escapeHtml(c.id)}" aria-pressed="false" title="${escapeHtml(c.title)}">${iconSvg(c.id)}${escapeHtml(c.short)}<span class="chip__count" data-chip-count>${c.count ?? 0}</span></button>`)
      .join('')
  }

  function cardHtml(mod) {
    const tier = tierOf(mod.tier)
    const cmd = installCommand(mod.name)
    const name = escapeHtml(mod.name)
    const tierBadge = `<span class="tier"><span class="bars bars--${tier.bars}" aria-hidden="true"><i></i><i></i><i></i></span>${escapeHtml(tier.label)}</span>`
    const meta = `<p class="card__meta"><span>${escapeHtml(mod.categoryInfo.short)}</span>${mod.version ? `<span class="card__ver">v${escapeHtml(mod.version)}</span>` : ''}</p>`
    const title = `<h3 class="card__title"><button type="button" class="card__open" data-open="${name}" aria-haspopup="dialog" data-hl="name">${name}</button></h3>`
    const desc = `<p class="card__desc" data-hl="desc">${escapeHtml(mod.description)}</p>`
    const commands = mod.commands.length
      ? `<ul class="card__cmds" aria-label="Commands">${mod.commands.map(c => `<li><code>${escapeHtml(c)}</code></li>`).join('')}</ul>`
      : ''
    const source = `<a class="card__link" href="${sourceUrl(mod.name, repository)}" aria-label="${name} source on GitHub"><svg class="icon" aria-hidden="true"><use href="#i-github"/></svg></a>`

    if (mod.name === 'mod-store') {
      return `<article class="card card--featured" id="${name}" data-name="${name}">
        <div class="card__main">
          <div class="card__top"><span class="card__icon">${iconSvg(mod.category)}</span>${tierBadge}</div>
          ${title}${meta}${desc}${commands}
        </div>
        <div class="card__side">
          <p class="card__side-label">Start here</p>
          <div class="cmd">
            <span class="cmd__prompt" aria-hidden="true">&gt;</span>
            <code class="cmd__text">${escapeHtml(cmd)}</code>
            <button class="cmd__copy" type="button" data-copy="${escapeHtml(cmd)}" aria-label="Copy install command for ${name}">
              <svg class="icon icon--copy" aria-hidden="true"><use href="#i-copy"/></svg>
              <svg class="icon icon--check" aria-hidden="true"><use href="#i-check"/></svg>
            </button>
          </div>
          <p class="card__side-note">Then run <code>/mods</code> to browse, install and update everything below.</p>
        </div>
      </article>`
    }

    return `<article class="card" id="${name}" data-name="${name}">
      <div class="card__top"><span class="card__icon">${iconSvg(mod.category)}</span>${tierBadge}</div>
      <div class="card__id">${title}${meta}</div>
      ${desc}
      ${commands}
      <div class="card__foot">
        <button type="button" class="card__copy" data-copy="${escapeHtml(cmd)}" aria-label="Copy install command for ${name}">
          <span class="swap"><svg class="icon icon--copy" aria-hidden="true"><use href="#i-copy"/></svg><svg class="icon icon--check" aria-hidden="true"><use href="#i-check"/></svg></span><span class="card__copy-label">Copy install</span>
        </button>
        ${source}
      </div>
    </article>`
  }

  function groupHtml(cat) {
    return `<div class="grid__group" data-group="${escapeHtml(cat.id)}">
      <span class="grid__group-icon">${iconSvg(cat.id)}</span>
      <div><h3>${escapeHtml(cat.title)}</h3><p>${escapeHtml(cat.tagline ?? '')}</p></div>
      <span class="grid__group-count" data-group-count></span>
    </div>`
  }

  function renderCards() {
    grid.innerHTML = categories.map(groupHtml).join('') + mods.map(cardHtml).join('')
    groups = new Map([...grid.querySelectorAll('[data-group]')].map(el => [el.dataset.group, el]))
    grid.removeAttribute('aria-busy')
    for (const el of grid.querySelectorAll('.card')) {
      const mod = catalog.byName.get(el.dataset.name)
      cards.set(mod.name, { el, mod, name: el.querySelector('[data-hl="name"]'), desc: el.querySelector('[data-hl="desc"]') })
    }
  }

  /* ---------- Filtering ---------- */
  function scoreOf(mod, tokens) {
    if (tokens.length === 0) return 1
    let total = 0
    const name = mod.name
    const desc = mod.description.toLowerCase()
    const cat = `${mod.categoryInfo.title} ${mod.categoryInfo.short}`.toLowerCase()
    for (const raw of tokens) {
      const t = raw.replace(/^\//, '')
      let s = 0
      if (name === t) s = 100
      else if (name.startsWith(t)) s = 70
      else if (name.includes(t)) s = 50
      else if (mod.commands.some(c => c.slice(1).startsWith(t))) s = 45
      else if (mod.keywords.some(k => k.toLowerCase().includes(t))) s = 22
      else if (cat.includes(t)) s = 18
      else if (desc.includes(t)) s = 12
      else if (tierOf(mod.tier).label.toLowerCase() === t) s = 8
      else return 0
      total += s
    }
    return total
  }

  function passesTier(mod) {
    return state.tier === 'all' || mod.tier === state.tier
  }

  function apply() {
    const scored = mods.map(mod => ({ mod, score: passesTier(mod) ? scoreOf(mod, state.tokens) : 0 }))
    const perCat = new Map()
    let total = 0
    for (const { mod, score } of scored) {
      if (score <= 0) continue
      total += 1
      perCat.set(mod.category, (perCat.get(mod.category) ?? 0) + 1)
    }

    const visible = scored
      .filter(s => s.score > 0 && (state.cat === 'all' || s.mod.category === state.cat))
      .sort((a, b) => (state.tokens.length ? b.score - a.score : 0) || a.mod.index - b.mod.index)
    // Grouped by category when browsing everything; a flat ranked list while searching.
    const grouped = state.tokens.length === 0 && state.cat === 'all'
    const order = new Map(visible.map((s, i) => [s.mod.name, grouped ? (catIndex.get(s.mod.category) ?? 99) * 1000 + 1 + i : i]))
    const groupCounts = new Map()
    for (const s of visible) groupCounts.set(s.mod.category, (groupCounts.get(s.mod.category) ?? 0) + 1)
    for (const [id, el] of groups) {
      const n = groupCounts.get(id) ?? 0
      el.hidden = !grouped || n === 0
      el.style.order = String((catIndex.get(id) ?? 99) * 1000)
      el.querySelector('[data-group-count]').textContent = `${n} ${n === 1 ? 'mod' : 'mods'}`
    }

    for (const [name, card] of cards) {
      const rank = order.get(name)
      card.el.hidden = rank === undefined
      card.el.style.order = rank === undefined ? '' : String(rank)
      if (rank !== undefined) {
        card.name.innerHTML = highlight(card.mod.name, state.tokens)
        card.desc.innerHTML = highlight(card.mod.description, state.tokens)
      }
    }

    for (const chip of chipsRow.querySelectorAll('.chip')) {
      const id = chip.dataset.cat
      const n = id === 'all' ? total : perCat.get(id) ?? 0
      chip.querySelector('[data-chip-count]').textContent = String(n)
      chip.classList.toggle('is-zero', n === 0 && id !== state.cat)
      chip.setAttribute('aria-pressed', String(id === state.cat))
    }

    renderBanner(visible.length)

    const catInfo = categories.find(c => c.id === state.cat)
    const quoted = state.q ? ` matching "${state.q}"` : ''
    const scope = catInfo ? ` in ${catInfo.short}` : ''
    const tierWord = state.tier === 'all' ? '' : ` ${tierOf(state.tier).label.toLowerCase()}`
    status.textContent = visible.length === mods.length
      ? `All ${mods.length} mods`
      : `${visible.length}${tierWord} ${visible.length === 1 ? 'mod' : 'mods'}${scope}${quoted}`

    empty.hidden = visible.length > 0
    if (visible.length === 0) emptyQ.textContent = state.q ? `“${state.q}”` : 'those filters'
    return visible
  }

  function renderBanner(count) {
    const cat = categories.find(c => c.id === state.cat)
    if (!cat) {
      banner.hidden = true
      return
    }
    const art = media.categoryArt?.[cat.id]
    banner.hidden = false
    banner.classList.toggle('has-art', Boolean(art))
    if (art) banner.style.setProperty('--art', `url("${art}")`)
    else banner.style.removeProperty('--art')
    banner.innerHTML = `<span class="cat-banner__icon">${iconSvg(cat.id)}</span>
      <div><h3>${escapeHtml(cat.title)}</h3><p>${escapeHtml(cat.tagline ?? '')} <span class="t-dim">${count} of ${cat.count ?? count}</span></p></div>`
  }

  function highlight(text, tokens) {
    const parts = tokens.map(t => t.replace(/^\//, '')).filter(Boolean)
    if (parts.length === 0) return escapeHtml(text)
    const re = new RegExp(`(${parts.map(p => p.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|')})`, 'gi')
    return text.split(re).map((seg, i) => (i % 2 ? `<mark>${escapeHtml(seg)}</mark>` : escapeHtml(seg))).join('')
  }

  function withTransition(update) {
    if (!document.startViewTransition || reducedMotion()) {
      update()
      return
    }
    const named = []
    const name = () => {
      for (const { el } of cards.values()) {
        if (el.hidden) continue
        if (!isNearViewport(el)) continue
        el.style.viewTransitionName = `mod-${el.dataset.name}`
        named.push(el)
      }
    }
    name()
    const vt = document.startViewTransition(() => {
      update()
      name()
    })
    vt.finished.finally(() => named.forEach(el => { el.style.viewTransitionName = '' }))
  }

  function isNearViewport(el) {
    const r = el.getBoundingClientRect()
    return r.bottom > -200 && r.top < window.innerHeight + 200
  }

  /* ---------- Events ---------- */
  let inputTimer = 0
  search.addEventListener('input', () => {
    clearTimeout(inputTimer)
    inputTimer = setTimeout(() => {
      state.q = search.value.trim()
      state.tokens = state.q.toLowerCase().split(/\s+/).filter(Boolean)
      apply()
    }, 40)
  })
  search.addEventListener('keydown', event => {
    if (event.key === 'Escape') {
      if (search.value) {
        search.value = ''
        state.q = ''
        state.tokens = []
        apply()
      } else {
        search.blur()
      }
    } else if (event.key === 'Enter') {
      const first = [...cards.values()].filter(c => !c.el.hidden).sort((a, b) => Number(a.el.style.order) - Number(b.el.style.order))[0]
      if (first) open(first.mod.name)
    }
  })

  chipsRow.addEventListener('click', event => {
    const chip = event.target.closest('.chip')
    if (!chip) return
    const next = chip.dataset.cat === state.cat && chip.dataset.cat !== 'all' ? 'all' : chip.dataset.cat
    withTransition(() => {
      state.cat = next
      apply()
    })
  })

  tiers.addEventListener('click', event => {
    const button = event.target.closest('[data-tier]')
    if (!button) return
    setTier(button.dataset.tier)
  })
  tiers.addEventListener('keydown', event => {
    if (!['ArrowLeft', 'ArrowRight'].includes(event.key)) return
    const buttons = [...tiers.querySelectorAll('[data-tier]')]
    const i = buttons.findIndex(b => b.dataset.tier === state.tier)
    const next = buttons[(i + (event.key === 'ArrowRight' ? 1 : buttons.length - 1)) % buttons.length]
    setTier(next.dataset.tier)
    next.focus()
    event.preventDefault()
  })

  function setTier(tier, { animate = true } = {}) {
    const update = () => {
      state.tier = tier
      for (const b of tiers.querySelectorAll('[data-tier]')) {
        const on = b.dataset.tier === tier
        b.setAttribute('aria-checked', String(on))
        b.tabIndex = on ? 0 : -1
      }
      apply()
    }
    if (animate) withTransition(update)
    else update()
  }
  for (const b of tiers.querySelectorAll('[data-tier]')) b.tabIndex = b.dataset.tier === state.tier ? 0 : -1

  grid.addEventListener('click', event => {
    const opener = event.target.closest('[data-open]')
    if (opener) open(opener.dataset.open)
  })

  document.addEventListener('keydown', event => {
    if (event.key !== '/' || event.metaKey || event.ctrlKey || event.altKey) return
    const t = event.target
    if (t instanceof HTMLElement && (t.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName))) return
    if (sheet.open) return
    event.preventDefault()
    const head = root.querySelector('.section-head')
    const rect = search.closest('.search').getBoundingClientRect()
    if (rect.top < 64 || rect.bottom > window.innerHeight) {
      const top = window.scrollY + head.getBoundingClientRect().bottom - 56
      window.scrollTo({ top, behavior: reducedMotion() ? 'auto' : 'smooth' })
    }
    search.focus({ preventScroll: true })
    search.select()
  })

  const toolbar = root.querySelector('.toolbar')
  const syncStuck = () => {
    const top = toolbar.getBoundingClientRect().top
    const end = grid.getBoundingClientRect().bottom
    toolbar.classList.toggle('is-stuck', top <= 64.5 && end > 140)
  }
  window.addEventListener('scroll', syncStuck, { passive: true })
  syncStuck()

  /* ---------- Detail sheet + deep links ---------- */
  function open(name, { fromHash = false } = {}) {
    const mod = catalog.byName.get(name)
    if (!mod) return false
    const card = cards.get(name)

    if (card.el.hidden) {
      search.value = ''
      state.q = ''
      state.tokens = []
      state.cat = 'all'
      setTier('all', { animate: false })
    }
    for (const c of cards.values()) c.el.classList.toggle('is-target', c.el === card.el)
    card.el.scrollIntoView({ block: 'center', behavior: fromHash || reducedMotion() ? 'auto' : 'smooth' })

    if (!sheet.open) lastFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null
    sheetBody.innerHTML = sheetHtml(mod)
    if (!sheet.open) {
      if (typeof sheet.showModal === 'function') sheet.showModal()
      else sheet.setAttribute('open', '')
    }
    sheet.scrollTop = 0
    sheetBody.focus({ preventScroll: true })

    if (location.hash !== `#${name}`) history.replaceState(null, '', `#${name}`)
    return true
  }

  function sheetHtml(mod) {
    const tier = tierOf(mod.tier)
    const cmd = installCommand(mod.name)
    const keywords = mod.keywords.filter(k => k !== 'claude-mods' && k !== mod.category)
    const related = mods.filter(m => m.category === mod.category && m.name !== mod.name)
    const start = Math.max(0, related.findIndex(m => m.index > mod.index))
    const picks = [...related.slice(start), ...related.slice(0, start)].slice(0, 3)
    return `
      <button type="button" class="icon-btn sheet__close" data-close aria-label="Close"><svg class="icon" aria-hidden="true"><use href="#i-close"/></svg></button>
      <div class="sheet__head">
        <span class="sheet__icon">${iconSvg(mod.category)}</span>
        <div>
          <h2 class="sheet__title" id="sheet-title">${escapeHtml(mod.name)}</h2>
          <div class="sheet__meta">
            <span>${escapeHtml(mod.categoryInfo.title)}</span>
            <span class="tier"><span class="bars bars--${tier.bars}" aria-hidden="true"><i></i><i></i><i></i></span>${escapeHtml(tier.label)}</span>
            ${mod.version ? `<span class="card__ver">v${escapeHtml(mod.version)}</span>` : ''}
          </div>
        </div>
      </div>
      <p class="sheet__desc">${escapeHtml(mod.description)}</p>
      <div>
        <p class="sheet__label">Install</p>
        <div class="cmd">
          <span class="cmd__prompt" aria-hidden="true">&gt;</span>
          <code class="cmd__text">${escapeHtml(cmd)}</code>
          <button class="cmd__copy" type="button" data-copy="${escapeHtml(cmd)}" aria-label="Copy install command for ${escapeHtml(mod.name)}">
            <svg class="icon icon--copy" aria-hidden="true"><use href="#i-copy"/></svg>
            <svg class="icon icon--check" aria-hidden="true"><use href="#i-check"/></svg>
          </button>
        </div>
      </div>
      ${mod.commands.length ? `<div><p class="sheet__label">Commands</p><ul class="sheet__cmds">${mod.commands.map(c => `<li><code>${escapeHtml(c)}</code></li>`).join('')}</ul></div>` : ''}
      ${keywords.length ? `<div><p class="sheet__label">Keywords</p><ul class="sheet__kw">${keywords.map(k => `<li>${escapeHtml(k)}</li>`).join('')}</ul></div>` : ''}
      <div class="sheet__actions">
        <a class="btn btn--primary" href="${sourceUrl(mod.name, repository)}">View source on GitHub <svg class="icon" aria-hidden="true"><use href="#i-external"/></svg></a>
        <button type="button" class="btn btn--ghost" data-copy-link>Copy link</button>
      </div>
      ${picks.length ? `<div><p class="sheet__label">More in ${escapeHtml(mod.categoryInfo.short)}</p><div class="sheet__related">${picks.map(m => `
        <a href="#${escapeHtml(m.name)}" data-open-related="${escapeHtml(m.name)}"><svg class="icon" aria-hidden="true"><use href="${iconHref(m.category)}"/></svg><div><b>${escapeHtml(m.name)}</b><span>${escapeHtml(m.description)}</span></div></a>`).join('')}
      </div></div>` : ''}`
  }

  sheet.addEventListener('click', async event => {
    if (event.target === sheet) {
      sheet.close()
      return
    }
    if (event.target.closest('[data-close]')) {
      sheet.close()
      return
    }
    const related = event.target.closest('[data-open-related]')
    if (related) {
      event.preventDefault()
      open(related.dataset.openRelated)
      return
    }
    const link = event.target.closest('[data-copy-link]')
    if (link) {
      const ok = await copyText(location.href)
      if (ok) {
        flashCopied(link)
        toast('Link copied')
      }
    }
  })

  sheet.addEventListener('close', () => {
    if (location.hash) history.replaceState(null, '', location.pathname + location.search)
    const target = [...cards.values()].find(c => c.el.classList.contains('is-target'))
    const focusTo = target?.el.querySelector('.card__open') ?? lastFocus
    focusTo?.focus({ preventScroll: true })
  })

  function fromHash() {
    const name = decodeURIComponent(location.hash.slice(1))
    if (!name || RESERVED_IDS.has(name)) return
    if (catalog.byName.has(name)) open(name, { fromHash: true })
  }
  window.addEventListener('hashchange', fromHash)
  fromHash()

  return { open }
}
