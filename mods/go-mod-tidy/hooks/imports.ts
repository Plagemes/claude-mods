/** `import "x"`, `import alias "x"`, and the lines of an import block (`alias "x"`), also when only a fragment of the file is given. */
const IMPORT_LINE = /^[ \t]*(?:import[ \t]+)?(?:([A-Za-z_]\w*|\.)[ \t]+)?"([^"\s]+)"[ \t]*(?:\/\/.*)?$/gm
/** Words that can stand before a string on its own line without being an import alias. */
const NOT_ALIASES = new Set(['return', 'case', 'go', 'defer', 'break', 'continue', 'goto', 'fallthrough', 'default', 'else', 'var', 'const', 'type'])
/** A path whose first element has a dot (`github.com/x/y`, `golang.org/x/net`) names a module go.mod may need. */
const MODULE_PATH = /^[^/]+\.[^/]+/

/** The module-style import paths in `text` (a whole Go file, or the part of one an edit touches). */
export function moduleImports(text: string): Set<string> {
  const paths = new Set<string>()
  for (const match of text.matchAll(IMPORT_LINE)) {
    const path = match[2] as string
    if (!NOT_ALIASES.has(match[1] ?? '') && MODULE_PATH.test(path)) paths.add(path)
  }
  return paths
}

/** The module-style imports that one text has and the other does not. */
export function changedImports(before: string, after: string): string[] {
  const was = moduleImports(before)
  const is = moduleImports(after)
  return [...is].filter(path => !was.has(path)).concat([...was].filter(path => !is.has(path)))
}

/** The module path a go.mod declares (`module example.com/app`), if it has one. */
export function modulePathOf(goMod: string): string | undefined {
  return /^[ \t]*module[ \t]+"?([^\s"]+)"?/m.exec(goMod)?.[1]
}

/** Whether an import path belongs to the module itself, which go.mod never lists. */
export const isOwnPackage = (path: string, modulePath: string | undefined): boolean =>
  modulePath !== undefined && (path === modulePath || path.startsWith(`${modulePath}/`))

const REQUIRE = /^[ \t]*(?:require[ \t]+)?([\w.~/-]+\.[\w.~/-]+)[ \t]+(v[\w.+-]+)/gm

/** `module version` pairs of a go.mod's requirements. */
export function requirements(goMod: string): Map<string, string> {
  const found = new Map<string, string>()
  for (const match of goMod.matchAll(REQUIRE)) found.set(match[1] as string, match[2] as string)
  return found
}

/** What changed between two go.mod files, in words: modules added, removed or moved to another version. */
export function describeChange(before: string, after: string): string {
  const was = requirements(before)
  const is = requirements(after)
  const added = [...is].filter(([name]) => !was.has(name)).map(([name, version]) => `${name} ${version}`)
  const removed = [...was.keys()].filter(name => !is.has(name))
  const moved = [...is].filter(([name, version]) => was.has(name) && was.get(name) !== version).map(([name]) => name)
  const part = (label: string, items: readonly string[]) => (items.length === 0 ? [] : [`${label} ${items.slice(0, 5).join(', ')}${items.length > 5 ? ` (+${items.length - 5})` : ''}`])
  return [...part('added', added), ...part('removed', removed), ...part('changed version of', moved)].join('; ')
}
