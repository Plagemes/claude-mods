const COMPONENT_FILE = /^[A-Z][A-Za-z0-9]*\.(?:tsx|jsx|vue|svelte)$/
const STORY_FILE = /^(.+)\.(?:stories|story)\.[A-Za-z]+$/

export const basename = (path: string): string => path.slice(path.lastIndexOf('/') + 1)
export const dirname = (path: string): string => path.slice(0, Math.max(0, path.lastIndexOf('/')))
export const stemOf = (path: string): string => basename(path).replace(/\.[A-Za-z0-9]+$/, '')

/** A PascalCase .tsx, .jsx, .vue or .svelte file inside one of the component folders. */
export const isComponentPath = (path: string, folders: ReadonlySet<string>): boolean =>
  COMPONENT_FILE.test(basename(path)) && dirname(path).split('/').some(part => folders.has(part))

/** The component a story file is for: `Button.stories.tsx` is for `Button`. */
export const storyFor = (path: string): string | undefined => STORY_FILE.exec(basename(path))?.[1]

/** Does a directory listing hold a story for this component? */
export const hasStoryIn = (names: readonly string[], stem: string): boolean => names.some(name => storyFor(name) === stem)

/** The extension a story for this component would get. */
export const storyExtension = (path: string): string => (/\.(?:tsx|jsx)$/.test(path) ? basename(path).slice(basename(path).lastIndexOf('.') + 1) : 'ts')
