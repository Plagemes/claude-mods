/**
 * shared/render-safe.ts — keeps a Pane drawing from going blank. Pure (no `$`): a mod imports its vendored copy,
 * `node scripts/sync-shared.mjs add <mod> render-safe` writes `hooks/shared/render-safe.ts`, then
 * `import { hubTabBelow, paneFailure } from './shared/render-safe'`. scripts/check-render.mjs holds every mod to it.
 *
 * At the bottom of a `ui.render` chain, `await next(e)` resolves to the engine's own drawing, `{ type: 'engine', ref: 0 }`.
 * For a plugin's Pane that drawing is blank in the terminal and, in Claude Code Desktop, the placeholder
 * "Nothing to show yet — <plugin> has not drawn in this pane". The engine also refuses a WHOLE tree that holds an
 * engine node under a Box with a size, position, display or overflow prop (debug log: `ui.render (Pane): a hook
 * returned a tree that does not validate (engine node under a Box with prop "minWidth"); drawing the engine's own`),
 * so a tab owner that composed with `{await next(e)}` beneath the hub blanked the whole Claude Mods panel.
 * And a Pane hook that throws leaves the engine's own drawing too: the terminal closes the pane, the desktop shows the
 * placeholder. `paneFailure` draws a card with Retry in its place.
 */
import type { Elements, HookFailure, RenderElement } from 'claude-code'

/** The key of the hub's "nothing to show here yet" note, which a tab's own section replaces. */
export const HUB_TAB_EMPTY_KEY = 'hub-tab-empty'

type Node = { type?: unknown; props?: { key?: unknown } | null; children?: unknown }

/**
 * What the hooks beneath a tab hook drew (`await next(e)`), ready to go first in the tab's tree: the hub's frame when
 * this mod draws above the hub, another mod's section of a shared tab, or null. It drops the engine's own drawing and
 * the hub's empty-tab note; every other element is kept as it was (empty spacer Boxes included), and a Box left with
 * none of its children is dropped too.
 *
 *   `<Box flexDirection="column">{hubTabBelow(await next(e))}{await drawMine($, e)}</Box>`
 */
export function hubTabBelow(tree: unknown): RenderElement | null {
  if (tree === null || typeof tree !== 'object' || Array.isArray(tree)) return null
  const node = tree as Node
  if (node.type === 'engine' || node.props?.key === HUB_TAB_EMPTY_KEY) return null
  if (!Array.isArray(node.children) || node.children.length === 0) return tree as RenderElement
  const original: unknown[] = node.children
  const children = original.flatMap(child => (child !== null && typeof child === 'object' ? (hubTabBelow(child) ?? []) : [child]))
  if (node.type === 'Box' && children.length === 0) return null
  const isSame = children.length === original.length && children.every((child, index) => child === original[index])
  return (isSame ? tree : { ...node, children }) as RenderElement
}

/** Whether a tree draws nothing: no tree, the engine's own drawing, or Boxes holding only such things. */
export function isBlankTree(tree: unknown): boolean {
  if (typeof tree === 'string' || typeof tree === 'number') return tree === ''
  if (tree === null || tree === undefined || typeof tree !== 'object') return true
  const node = tree as Node
  if (node.type === 'engine') return true
  if (node.type !== 'Box') return false
  return !Array.isArray(node.children) || node.children.every(child => child === false || isBlankTree(child))
}

/** The elements `paneFailure` draws with: any surface's `$.ui.resolve(e)` table has them. */
type PaneTable = Pick<Elements['terminal'], 'Box' | 'Text' | 'Button'>

/**
 * The card a Pane hook's `.catch` draws when the drawing failed: what failed, and Retry (which should call
 * `$.ui.invalidate('ui.render')`), after what the hooks beneath drew (`below`, cleaned by hubTabBelow). Use it as
 *
 *   on('ui.render', { component: 'Pane', requestId: PANE }, draw).catch(async ($, e, next) =>
 *     next.error.kind === 're-entry' ? next(e)
 *       : paneFailure($.ui.resolve(e), { title: 'my-mod', failure: next.error, below: await next(e).catch(() => null), onRetry: () => $.ui.invalidate('ui.render') }))
 */
export function paneFailure(
  t: PaneTable,
  input: { title: string; failure: Pick<HookFailure, 'kind' | 'message'>; below?: unknown; onRetry: () => void },
): RenderElement {
  const { Box, Text, Button } = t
  const why = input.failure.kind === 'timeout' ? 'took too long to draw' : 'could not draw'
  const detail = (input.failure.message ?? '').replace(/\s+/g, ' ').trim().slice(0, 240)
  const card = Box({
    key: 'pane-failure',
    flexDirection: 'column',
    children: [
      Text({ bold: true, color: 'error', children: [`${input.title} ${why} this view`] }),
      ...(detail === '' ? [] : [Text({ dimColor: true, wrap: 'wrap', children: [detail] })]),
      Box({ flexDirection: 'row', children: [Button({ key: 'pane-retry', label: 'Retry', onPress: input.onRetry })] }),
    ],
  })
  const below = hubTabBelow(input.below)
  return below === null ? card : Box({ flexDirection: 'column', children: [below, card] })
}
