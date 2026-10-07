// Claude Mods site entry point. Plain ES modules, no build step.
import { loadCatalog } from './data.js'
import { initFlow } from './flow.js'
import { initHeroVideo, loadMediaManifest } from './media.js'
import { createRack } from './rack.js'
import { createStore } from './store.js'
import { initTui } from './tui.js'
import { initCopyButtons, initHeader, initReveal, initSpotlight, initTheme, reducedMotion } from './ui.js'
import { initWhatsNew } from './whatsnew.js'

let catalog = null
let store = null

initTheme()
initHeader()
initCopyButtons()
initSpotlight()
initReveal()
initFlow(document.querySelector('[data-flow]'))
initSingleInstall()
initTui(document.querySelector('[data-tui]'), () => catalog)
initFeatureCommands()
initOutroTiles()

const rack = createRack(document.querySelector('[data-rack]'), {
  onOpen: name => {
    if (store) store.open(name)
    else location.hash = name
  },
})

const mediaReady = loadMediaManifest()
mediaReady.then(media => {
  initHeroVideo(media)
  initTeaser(media)
})

loadCatalog()
  .then(async data => {
    catalog = data
    fillCounts(data)
    rack.setCatalog(data)
    const media = await mediaReady
    store = createStore(document.querySelector('#store'), data, { media })
    initWhatsNew(document.querySelector('[data-whatsnew]'), data, {
      onOpen: name => store.open(name),
      onCategory: id => store.showCategory(id),
      onShowNew: () => store.showNew(),
    })
  })
  .catch(error => {
    console.warn('Claude Mods: could not load the catalog.', error)
    const status = document.querySelector('[data-status]')
    const grid = document.querySelector('[data-grid]')
    if (grid) {
      grid.innerHTML = ''
      grid.removeAttribute('aria-busy')
    }
    if (status) status.innerHTML = 'The catalog could not be loaded. Browse it on <a href="https://github.com/plagemes/claude-mods#catalog">GitHub</a> instead.'
  })

// Every number on the page comes from the catalog; the HTML only holds rough fallbacks.
function fillCounts(data) {
  const { release } = data
  const set = (selector, value) => document.querySelectorAll(selector).forEach(el => { el.textContent = String(value) })
  set('[data-count]', data.mods.length)
  set('[data-cat-count]', data.categories.length)
  set('[data-new-count]', release.newCount)
  document.querySelectorAll('.specs [data-new-count]').forEach(el => { el.parentElement.hidden = !release.newCount })
  set('[data-new-label]', release.newLabel)
  set('[data-version]', `v${release.version}`)
  const tabs = document.querySelectorAll('.tui__tabs > span:not([data-tui-more])').length - 1
  set('[data-tui-more]', `+${Math.max(0, data.categories.length - tabs)}`)
  const pill = document.querySelector('[data-release]')
  const pillText = document.querySelector('[data-release-text]')
  if (pill && pillText) {
    if (release.newCount) {
      const cats = release.newCategories.length
      pillText.innerHTML = `v${release.version}<span class="release__sep" aria-hidden="true"></span>${release.newCount} new mods<span class="release__more">${cats ? `, ${cats} new categories` : ''}</span>`
    } else {
      pill.hidden = true
    }
  }
}

// "Just want one mod?": fill the <mod> slot from the suggestion pills.
function initSingleInstall() {
  const slot = document.querySelector('[data-single-slot]')
  const copy = document.querySelector('[data-single-copy]')
  const pills = [...document.querySelectorAll('[data-single]')]
  if (!slot || !copy) return
  for (const pill of pills) {
    pill.setAttribute('aria-pressed', 'false')
    pill.addEventListener('click', () => {
      const name = pill.dataset.single
      const same = pill.getAttribute('aria-pressed') === 'true'
      pills.forEach(p => p.setAttribute('aria-pressed', String(!same && p === pill)))
      slot.textContent = same ? '<mod>' : name
      copy.dataset.copy = `/plugin install ${same ? '<mod>' : name} --marketplace plagemes/claude-mods`
    })
  }
}

// Feature card: the slash menu mock steps through its suggestions.
function initFeatureCommands() {
  const menu = document.querySelector('[data-feature-commands] .slash__menu')
  if (!menu || reducedMotion()) return
  let visible = false
  let i = 0
  if ('IntersectionObserver' in window) new IntersectionObserver(([e]) => { visible = e.isIntersecting }).observe(menu)
  setInterval(() => {
    if (!visible || document.hidden) return
    const items = [...menu.children]
    i = (i + 1) % items.length
    items.forEach((li, j) => li.classList.toggle('is-sel', j === i))
  }, 1600)
}

// Closing CTA: a quiet field of tiles that switch on and off.
function initOutroTiles() {
  const field = document.querySelector('[data-outro-tiles]')
  if (!field) return
  const tiles = Array.from({ length: 180 }, () => {
    const el = document.createElement('i')
    if (Math.random() < 0.16) el.className = 'is-on'
    return el
  })
  field.append(...tiles)
  if (reducedMotion()) return
  let visible = false
  if ('IntersectionObserver' in window) new IntersectionObserver(([e]) => { visible = e.isIntersecting }).observe(field)
  setInterval(() => {
    if (!visible || document.hidden) return
    for (let k = 0; k < 3; k++) tiles[Math.floor(Math.random() * tiles.length)].classList.toggle('is-on')
  }, 500)
}

// Optional 20-second teaser: a button appears only when media.json lists a teaser that exists.
function initTeaser(media) {
  if (!media.teaserVideo) return
  const actions = document.querySelector('.hero__actions')
  if (!actions) return
  const probe = document.createElement('video')
  probe.preload = 'metadata'
  probe.muted = true
  probe.addEventListener('loadedmetadata', () => {
    const button = document.createElement('button')
    button.type = 'button'
    button.className = 'btn btn--ghost'
    button.textContent = 'Watch the teaser'
    const dialog = document.createElement('dialog')
    dialog.className = 'sheet sheet--video'
    dialog.setAttribute('aria-label', 'Claude Mods teaser video')
    dialog.innerHTML = `<button type="button" class="icon-btn sheet__close" aria-label="Close"><svg class="icon" aria-hidden="true"><use href="#i-close"/></svg></button>
      <video controls playsinline preload="none" ${media.teaserPoster ? `poster="${media.teaserPoster}"` : ''}><source src="${media.teaserVideo}" type="video/mp4"></video>`
    document.body.append(dialog)
    const video = dialog.querySelector('video')
    button.addEventListener('click', () => {
      dialog.showModal()
      video.play().catch(() => {})
    })
    dialog.addEventListener('click', e => { if (e.target === dialog || e.target.closest('.sheet__close')) dialog.close() })
    dialog.addEventListener('close', () => video.pause())
    actions.append(button)
  }, { once: true })
  probe.src = media.teaserVideo
}
