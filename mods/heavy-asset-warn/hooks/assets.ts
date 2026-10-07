export type Kind = 'image' | 'video' | 'font'
export type Limits = Record<Kind, number>

const KB = 1024
const EXTENSIONS: Record<Kind, readonly string[]> = {
  image: ['png', 'jpg', 'jpeg', 'gif', 'bmp', 'tif', 'tiff', 'webp', 'avif', 'svg', 'heic', 'ico'],
  video: ['mp4', 'm4v', 'mov', 'webm', 'avi', 'mkv', 'ogv'],
  font: ['ttf', 'otf', 'woff', 'woff2', 'eot'],
}
const WHY: Record<Kind, string> = {
  image: 'slow page loads',
  video: 'are far too heavy to ship with the page',
  font: 'delay text rendering',
}

export const limitsFrom = (options: Record<string, unknown>): Limits => {
  const kb = (value: unknown, fallback: number): number => (typeof value === 'number' && value > 0 ? value : fallback) * KB
  return { image: kb(options.imageKb, 300), video: kb(options.videoKb, 2048), font: kb(options.fontKb, 200) }
}

const extensionOf = (path: string): string => (/\.([A-Za-z0-9]+)$/.exec(path)?.[1] ?? '').toLowerCase()

export const kindOf = (path: string): Kind | undefined =>
  (Object.keys(EXTENSIONS) as Kind[]).find(kind => EXTENSIONS[kind].includes(extensionOf(path)))

/** The kind of asset the file is when it is over that kind's limit; undefined when it is fine or not an asset. */
export const heavyKind = (path: string, size: number, limits: Limits): Kind | undefined => {
  const kind = kindOf(path)
  return kind !== undefined && size > limits[kind] ? kind : undefined
}

export const formatSize = (bytes: number): string => (bytes >= KB * KB ? `${(bytes / (KB * KB)).toFixed(1)} MB` : `${Math.round(bytes / KB)} KB`)

/** What to do about it, by format. */
export const adviceFor = (path: string, kind: Kind): string => {
  const extension = extensionOf(path)
  if (kind === 'image') {
    if (extension === 'gif') return 'replace an animated GIF with a muted looping video (ffmpeg -i in.gif -c:v libvpx-vp9 out.webm) or animated WebP'
    if (extension === 'svg') return 'optimize it with svgo (npx svgo in.svg) and drop embedded raster images or editor metadata'
    if (extension === 'webp' || extension === 'avif') return 'it is already a modern format: resize it to the largest size it is shown at, lower the quality, and serve responsive sizes with srcset'
    return 'convert it to WebP or AVIF (cwebp -q 80 in.png -o out.webp), resize it to the largest size it is shown at, and serve responsive sizes with srcset'
  }
  if (kind === 'video') return 're-encode it (ffmpeg -crf 28, H.264 or VP9/AV1), lower the resolution, or host it on a CDN or streaming service; use preload="none" and a poster image'
  return extension === 'woff2'
    ? 'subset it to the characters you use (pyftsubset or glyphhanger) and load it with font-display: swap'
    : 'convert it to WOFF2 (woff2_compress) and subset it to the characters you use'
}

export type Heavy = { path: string; size: number; kind: Kind }

export const describe = (item: Heavy, limits: Limits, shownPath: string): string =>
  `${shownPath} is ${formatSize(item.size)} (${item.kind}s over ${formatSize(limits[item.kind])} ${WHY[item.kind]}): ${adviceFor(item.path, item.kind)}.`
