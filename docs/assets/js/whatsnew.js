// "What's new": the categories the latest release added, and a few of its mods to try first.
// Everything is rendered from the catalog, so a partial or later release still reads correctly.
import { escapeHtml, iconSvg, installCommand } from './data.js'

// Editorial picks, each with a two-line transcript of what you would see. Missing mods are skipped.
const PICKS = [
  { name: 'scope-lock', lines: [['cmd', '/scope src/auth'], ['deny', 'src/billing.ts is outside the scope']] },
  { name: 'task-queue', lines: [['cmd', '/queue add tests for the importer'], ['ok', '#3 in line, runs when Claude is free']] },
  { name: 'screenshot-check', lines: [['tool', 'Edit(src/components/Header.tsx)'], ['ok', 'screenshot at 1280px shown to Claude']] },
  { name: 'backup-before-migrate', lines: [['tool', 'Bash(npx prisma migrate dev)'], ['ok', 'app_dev saved to .backups/ first']] },
  { name: 'mod-maker', lines: [['cmd', '/new-mod tab-title'], ['ok', 'mods/tab-title/ ready to fill in']] },
  { name: 'regression-guard', lines: [['tool', 'Bash(npm test)'], ['deny', '2 tests green at start now fail']] },
]
const MAX_PICKS = 6

const LINE = {
  cmd: text => `<span class="t-acc">&gt;</span> ${escapeHtml(text)}`,
  tool: text => `<span class="t-dot">&#9679;</span>${escapeHtml(text)}`,
  ok: text => `<span class="t-ok">&#10003;</span> ${escapeHtml(text)}`,
  deny: text => `<span class="t-deny">&#10005;</span> ${escapeHtml(text)}`,
}

export function initWhatsNew(root, catalog, { onOpen, onCategory, onShowNew } = {}) {
  if (!root) return
  const { release, newMods, repository } = catalog
  if (!release.newCount) {
    // Nothing is new (for example a first release): hide the section and every link to it.
    root.hidden = true
    document.querySelectorAll('a[href="#new"]').forEach(a => { a.hidden = true })
    return
  }

  const shelf = root.querySelector('[data-new-shelf]')
  const picksEl = root.querySelector('[data-new-picks]')
  const showLabel = root.querySelector('[data-show-new-label]')

  shelf.innerHTML = release.newCategories.map(c => `
    <li><button type="button" class="shelf__item" data-new-cat="${escapeHtml(c.id)}">
      <span class="shelf__icon">${iconSvg(c.id)}</span>
      <span class="shelf__count">${c.count} ${c.count === 1 ? 'mod' : 'mods'}</span>
      <span class="shelf__title">${escapeHtml(c.title)}</span>
      <span class="shelf__tag">${escapeHtml(c.tagline ?? '')}</span>
    </button></li>`).join('')
  shelf.hidden = release.newCategories.length === 0

  const picks = PICKS.filter(p => catalog.byName.get(p.name)?.isNew)
  for (const mod of newMods) {
    if (picks.length >= MAX_PICKS) break
    if (!picks.some(p => p.name === mod.name) && !picks.some(p => catalog.byName.get(p.name).category === mod.category)) picks.push({ name: mod.name, lines: [] })
  }
  picksEl.innerHTML = picks.slice(0, MAX_PICKS).map(p => pickHtml(catalog.byName.get(p.name), p.lines, repository)).join('')

  showLabel.textContent = `Browse all ${release.newCount} new mods`

  shelf.addEventListener('click', event => {
    const item = event.target.closest('[data-new-cat]')
    if (item) onCategory?.(item.dataset.newCat)
  })
  picksEl.addEventListener('click', event => {
    const opener = event.target.closest('[data-open-pick]')
    if (opener) onOpen?.(opener.dataset.openPick)
  })
  root.querySelector('[data-show-new]')?.addEventListener('click', () => onShowNew?.())
}

function pickHtml(mod, lines, repository) {
  const name = escapeHtml(mod.name)
  const cmd = installCommand(mod.name, repository)
  const term = lines.length
    ? `<div class="pick__term" aria-hidden="true">${lines.map(([kind, text]) => `<p class="is-${kind}">${LINE[kind](text)}</p>`).join('')}</div>`
    : ''
  return `<article class="pick">
    <div class="pick__top">
      <span class="card__icon">${iconSvg(mod.category)}</span>
      <span class="pick__cat">${escapeHtml(mod.categoryInfo.title)}</span>
    </div>
    <h4 class="pick__name"><button type="button" class="pick__open" data-open-pick="${name}" aria-haspopup="dialog">${name}</button></h4>
    ${term}
    <p class="pick__desc">${escapeHtml(mod.description)}</p>
    <div class="pick__foot">
      <button type="button" class="card__copy" data-copy="${escapeHtml(cmd)}" aria-label="Copy install command for ${name}">
        <span class="swap"><svg class="icon icon--copy" aria-hidden="true"><use href="#i-copy"/></svg><svg class="icon icon--check" aria-hidden="true"><use href="#i-check"/></svg></span><span>Copy install</span>
      </button>
      ${mod.commands.length ? `<code class="pick__cmd">${escapeHtml(mod.commands[0])}</code>` : ''}
    </div>
  </article>`
}
