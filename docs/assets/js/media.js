// Optional generated media (see media/PROMPTS.md). Every slot is listed in media/media.json;
// a slot that is null, missing or fails to load leaves the code-made visuals in place.
import { reducedMotion } from './ui.js'

export async function loadMediaManifest() {
  try {
    const response = await fetch('media/media.json', { credentials: 'same-origin' })
    if (!response.ok) return {}
    return await response.json()
  } catch {
    return {}
  }
}

export function initHeroVideo(manifest) {
  const video = document.querySelector('[data-hero-video]')
  const hero = video?.closest('.hero')
  if (!video || !hero) return
  if (manifest.heroStill) initHeroStill(hero, manifest.heroStill)
  if (!manifest.heroVideo) return
  const saveData = navigator.connection?.saveData === true
  if (reducedMotion() || saveData) return

  if (manifest.heroPoster) video.poster = manifest.heroPoster
  video.addEventListener('loadeddata', () => {
    hero.classList.add('has-video')
    video.play().catch(() => hero.classList.remove('has-video'))
  }, { once: true })
  video.addEventListener('error', () => hero.classList.remove('has-video'), { once: true })
  const source = document.createElement('source')
  source.src = manifest.heroVideo
  source.type = 'video/mp4'
  source.addEventListener('error', () => hero.classList.remove('has-video'), { once: true })
  video.append(source)
  video.load()

  if ('IntersectionObserver' in window) {
    new IntersectionObserver(([entry]) => {
      if (!hero.classList.contains('has-video')) return
      if (entry.isIntersecting) video.play().catch(() => {})
      else video.pause()
    }).observe(hero)
  }
}

// A generated still sits behind the rack once it has loaded; until then the code-made glow shows.
function initHeroStill(hero, src) {
  const backdrop = hero.querySelector('.hero__backdrop')
  const img = new Image()
  img.decoding = 'async'
  img.onload = () => {
    backdrop.style.setProperty('--still', `url("${src}")`)
    backdrop.classList.add('has-still')
  }
  img.src = src
}
