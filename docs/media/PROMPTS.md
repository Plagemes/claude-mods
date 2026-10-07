# Claude Mods: generated media prompt pack

Production prompts for GPTImage (stills) and Veo 3 / Google Flow (video). Every asset here is **optional**: the site already ships code-made visuals (the rack, terminal mocks, glow and grain), and each generated file plugs into a slot that stays invisible until the file exists and loads. Art direction follows [`../DESIGN.md`](../DESIGN.md).

## How slots work

The site reads [`media.json`](media.json) at runtime. A slot set to `null` is ignored, so nothing is requested and nothing breaks. To turn a slot on:

1. Generate the asset with the prompt below and export it to the exact file name.
2. Put it in `docs/media/`.
3. Set its key in `docs/media/media.json` to the relative path, for example `"heroVideo": "media/hero.mp4"`.
4. Check the site in both themes and with reduced motion. If a file fails to load, the code-made visual stays.

| Slot key | File | Plugs into | Fallback when absent |
| --- | --- | --- | --- |
| `heroStill` | `hero-still.webp` | Hero backdrop behind the rack (36% opacity dark, 18% multiply light, fades out downward) | Ember glow and dot grid |
| `heroVideo` | `hero.mp4` | Hero backdrop loop (42% dark, 22% light). Skipped with reduced motion or Save-Data | `heroStill`, then the glow |
| `heroPoster` | `hero-poster.webp` | First frame shown while `hero.mp4` buffers | none needed |
| `teaserVideo` | `teaser.mp4` | Adds a "Watch the teaser" button to the hero, which opens a video dialog | Button is not shown |
| `teaserPoster` | `teaser-poster.webp` | Poster frame in the teaser dialog | Black frame |
| `categoryArt.<id>` | `cat-<id>.webp` | Right side of the category banner in the store when that category chip is selected | Icon-only banner |
| none (static) | `og-plate.webp` | Background plate for `docs/assets/og.png`, composited with live type | Current code-made OG image |

Example with everything switched on:

```json
{
  "heroStill": "media/hero-still.webp",
  "heroVideo": "media/hero.mp4",
  "heroPoster": "media/hero-poster.webp",
  "teaserVideo": "media/teaser.mp4",
  "teaserPoster": "media/teaser-poster.webp",
  "categoryArt": { "security": "media/cat-security.webp", "git": "media/cat-git.webp" }
}
```

## Shared style block

Paste this block at the end of every prompt, still or video. It keeps the set coherent.

> **Style:** dark, warm and tactile, like macro product photography at night. Deep warm-black ink background (#0e0d0b), never pure black. A single warm light source in ember clay-amber (#ee8a4f) with a pale phosphor highlight (#ffc27a) at its hottest point. Surfaces are matte ceramic, dark anodized aluminum and soft-touch rubber with fine grain. Shallow depth of field, 100mm macro lens look, gentle film grain, soft falloff into darkness. Calm, precise, premium. Generous empty dark space.
>
> **Avoid:** text, letters, numbers, logos, watermarks, user-interface screens, people, hands, faces, robots, brains, glowing circuit boards, holograms, neon, purple, blue, cyan, rainbow gradients, lens-flare streaks, sci-fi clichés, clutter.

Palette reference: ink `#0e0d0b`, surface `#171613`, raised `#1e1c19`, ember `#ee8a4f`, phosphor `#ffc27a`, paper `#eee7db`. One accent hue only.

---

## GPTImage stills

Settings for every still: model `gpt-image-1` (or newer), `quality: high`, `background: opaque`, output PNG, then convert to WebP (quality 80) at the final size. Generate 2 to 4 variations and pick the one with the cleanest negative space.

### 1. Hero still: `hero-still.webp`

- **Generate at:** 1536x1024 (3:2). **Deliver:** 1920x1080 (16:9), crop from the center with the subject kept in the right half, WebP, 250 KB or less.
- **Plugs into:** `heroStill`, also usable as `heroPoster` if it matches the first frame of `hero.mp4`.

```text
A wide, low-angle macro photograph of a rack of small square matte ceramic tiles laid out in a precise grid on a dark surface, receding gently out of focus. The tiles are deep warm charcoal with softly rounded corners and a tiny recessed dot at the center of each. A handful of tiles, scattered irregularly in the right half of the frame, glow from within in warm ember amber, as if lit by an LED underneath; the brightest one has a pale phosphor-white core and casts a soft warm bloom onto its neighbors. The left half of the frame falls off into deep, empty, warm darkness for headline text. Calm, quiet, exact.
[Shared style block]
```

### 2. Category illustrations: `cat-<id>.webp`

- **Generate at:** 1536x1024 (3:2). **Deliver:** 1536x512 (3:1), cropped so the subject sits in the **right third** and the left two thirds stay dark and empty (the banner title sits there). WebP, 120 KB or less each.
- **Plugs into:** `categoryArt.<id>`; shown on the right of the store's category banner, behind a fade.
- Each prompt shares one recipe: **a single object, matte and dark, with exactly one element lit in ember**, echoing the lit element of that category's icon (see DESIGN.md, Iconography).

| id | Prompt (append the shared style block) |
| --- | --- |
| `core` | `A three-by-three grid of small matte charcoal ceramic tiles seen at a low three-quarter angle on the right side of the frame. Only the bottom-right tile glows ember from within, with a phosphor-white core, lighting the edges of its neighbors. Everything else is dark and empty.` |
| `security` | `A heavy, closed latch mechanism machined from dark anodized aluminum, seen close up on the right side of the frame. A thin line of warm ember light leaks from the seam where the latch locks, as if something is safely held shut. Precise, solid, reassuring.` |
| `git` | `Two slim dark metal rails on a matte surface, running in parallel and then diverging gently like a branch, photographed low on the right side of the frame. At the point where they split sits a single small bead glowing ember amber. The rails fade into soft focus.` |
| `cost` | `A minimalist analog gauge with a matte black face and no markings or numbers, seen at a slight angle on the right side of the frame. A thin needle glows ember amber and points just past the middle. A faint warm reflection on the glass.` |
| `productivity` | `A short row of matte charcoal mechanical keycaps with no legends, seen at a low angle on the right side of the frame. One key is pressed down and glows ember from beneath, lighting the gaps between the keys. Crisp, tactile, fast.` |
| `quality` | `A pair of dark precision calipers gently closing on a small matte ceramic tile on the right side of the frame. A thin rim of ember light traces the exact edge being measured. Clean, exact, quiet.` |
| `observability` | `A slab of dark smoked glass standing upright on the right side of the frame. Inside the glass, a single thin line of ember light rises and falls like a soft sparkline, glowing brightest at its peak. No screens, no text.` |
| `prompting` | `A sheet of thick dark paper with a fine tooth, seen close and low on the right side of the frame. A single short vertical bar of ember light stands on the paper like a text cursor, casting a soft warm glow across the grain.` |
| `notifications` | `A small, smooth bell turned from dark metal, resting on a matte surface on the right side of the frame. Its rim catches a warm ember edge light, and a faint ring of warm haze spreads around it as if it has just chimed.` |
| `memory` | `A closed hardcover notebook in matte charcoal on the right side of the frame, seen at a low three-quarter angle. A single ribbon bookmark trails out of the pages and glows a warm ember amber.` |
| `team` | `Two matte ceramic tiles standing side by side, almost touching, on the right side of the frame. One glows ember from within; the other reflects its warm light on the facing edge. Quiet, collaborative.` |
| `stacks` | `Three thin slabs of dark slate stacked with small gaps between them on the right side of the frame, seen at a low angle. Only the top slab glows ember along its edges, lighting the slabs beneath from above.` |
| `devops` | `A small, smooth cloud-shaped form carved from matte charcoal ceramic, resting on a dark surface on the right side of the frame. A single thin vertical line of ember light rises from its center like a deploy going up.` |
| `data` | `A short stack of three dark anodized aluminum discs, like a database cylinder, on the right side of the frame. The seam between the middle discs glows as a thin ember ring; the rest stays dark.` |
| `frontend` | `A round lens of dark smoked glass held upright in a matte black ring on the right side of the frame. At its center a single ember point of light, like a pupil, with a soft warm halo in the glass.` |
| `api` | `Two slim dark metal rods laid in parallel on a matte surface on the right side of the frame, offset like an exchange. A small bead of ember light travels along the upper rod, brightest at its tip.` |
| `agents` | `One small matte ceramic tile raised on a short stem above three identical tiles in a row, on the right side of the frame. Only the raised tile glows ember, casting warm light down onto the three below.` |
| `learning` | `A folded square of thick dark card on the right side of the frame, seen low, with a single silk tassel hanging from one corner. The tassel glows a warm ember amber; everything else falls into shadow.` |
| `compliance` | `A sheet of heavy charcoal paper with a deckled edge on the right side of the frame. Pressed into its lower corner, a round wax seal that glows ember from within, as if still warm.` |
| `performance` | `A minimalist stopwatch with a matte black case and no markings, seen at a slight angle on the right side of the frame. Its single hand glows ember amber and points to one o'clock.` |
| `ecosystem` | `Three small matte charcoal ceramic tiles in an L shape on the right side of the frame, with the fourth corner empty. In the empty slot a thin plus sign of ember light floats just above the surface.` |

### 3. Open Graph plate: `og-plate.webp`

- **Generate at:** 1536x1024. **Deliver:** 1280x640 (2:1) after cropping to 1536x768 and resizing. WebP, 200 KB or less.
- **Plugs into:** the template `docs/media/og-template.html?plate=og-plate.webp`, which sets the headline, lockup and rack in live type over the plate. Render it with Playwright at a 1280x640 viewport and save the screenshot as `docs/assets/og.png` (quantize to 256 colors to keep it near 400 KB).

```text
A wide, dark, atmospheric macro photograph. On the far right, a cluster of small matte charcoal ceramic tiles in a loose grid, three of them glowing ember amber from within with phosphor-white cores, their warm bloom fading into the dark. The left sixty percent of the frame is empty, deep warm darkness with only the faintest texture, reserved for large headline type.
[Shared style block]
```

---

## Veo 3 / Google Flow video

Settings: Veo 3 (Quality) in Google Flow, 16:9, 1080p, 24 fps. Veo generates sound; the hero loop is muted on the site, and the teaser uses its own mix (see below). Export H.264 MP4 (`-movflags +faststart`, `-pix_fmt yuv420p`), and grab the first frame as the poster WebP.

### 4. Hero loop: `hero.mp4` (8 seconds)

- **Aspect / size:** 16:9, 1920x1080, 24 fps, 8.0 s, seamless loop. H.264 at CRF 26 to 28, **4 MB or less**, audio track removed (`-an`).
- **Poster:** `hero-poster.webp`, the first frame, 1920x1080, 150 KB or less.
- **Plugs into:** `heroVideo` and `heroPoster`. Plays muted and looped behind the rack at 42% opacity (22% multiply in light mode), fading out toward the bottom, paused when off screen, never loaded with reduced motion or Save-Data.

```text
A slow, steady macro dolly shot gliding sideways from left to right, very low over a vast grid of small matte charcoal ceramic tiles with rounded corners, each with a tiny recessed dot in its center. The tiles stretch into soft focus. As the camera drifts, individual tiles quietly light up from within in warm ember amber, one at a time in an unhurried rhythm, glow for a moment with a phosphor-white core, and settle into a dim warm afterglow; a few others gently fade back to dark. The light spills softly onto neighboring tiles. The upper left of the frame stays darker and emptier. The motion is constant and calm, with no cuts, no camera shake and no speed ramps, so the last frame matches the first for a seamless loop.
Audio: none needed; near silence.
[Shared style block]
```

Loop tip: generate 8 s, then in an editor crossfade the last 0.75 s into the first 0.75 s, or ask Flow to extend the clip and trim to a point where the dolly position repeats.

### 5. Product teaser: `teaser.mp4` (20 seconds)

- **Aspect / size:** 16:9, 1920x1080, 24 fps, 20 s, H.264 CRF 23, AAC 128 kbps, **12 MB or less**.
- **Poster:** `teaser-poster.webp` taken from shot 3, 1920x1080.
- **Plugs into:** `teaserVideo` and `teaserPoster`. Opens in a dialog with controls from the "Watch the teaser" button in the hero; it never autoplays.
- **Build it in Flow** as three generated shots in the scene builder (8 s + 8 s + 4 s, trimmed). Keep one seed and the shared style block across all shots. Overlay the on-screen type afterwards in an editor, set in Newsreader and Martian Mono; never ask the model to render text.

| Time | Shot | Prompt (append the shared style block) | Overlay added in edit |
| --- | --- | --- | --- |
| 0 to 7 s | **Dark rack** | `Complete darkness slowly reveals a close macro view of a grid of matte charcoal ceramic tiles, lit only by a faint warm ambient glow. The camera pushes in very slowly. Nothing is lit yet. Low, warm room tone with a soft electrical hum.` | 1.5 s: "Claude Code, out of the box." (Newsreader, paper) |
| 7 to 15 s | **Lights on** | `The same grid of tiles. One tile near the center ignites in warm ember amber with a phosphor-white core; then, in a gentle cascade spreading outward, more tiles light one after another, each with a soft click and a warm bloom. The camera continues its slow push and tilts up slightly. Soft, satisfying mechanical clicks, each one lighter than the last.` | 8 s: "Guardrails. Status lines. Live panes." 11 s: "Slash commands. Sounds. Memory." |
| 15 to 20 s | **Pull back** | `The camera pulls back smoothly and rises to reveal the whole rack: a neat square grid of tiles with about a third of them glowing ember, and a single wider tile above the grid lit steadily. The rest of the frame falls into deep warm darkness. A single warm, resonant chime as the move settles.` | 16 s: lockup "Claude *Mods*" plus the mono line `> /plugin install mod-store@claude-mods`; 18.5 s: "plagemes.github.io/claude-mods" |

**Sound:** keep Veo's generated clicks and chime, add no music, normalize to -16 LUFS, and fade the last 0.5 s.

---

## Delivery checklist

- [ ] Exact file name and size from this document; WebP for stills, H.264 MP4 for video.
- [ ] No text, logos or UI rendered by the model; type is added live or in edit.
- [ ] One accent hue (ember). Check that nothing reads as purple, blue or neon.
- [ ] Negative space where the layout needs it (left for hero and OG, left two thirds for category banners).
- [ ] Hero loop 4 MB or less, teaser 12 MB or less, stills within their budgets.
- [ ] `media.json` updated; site checked in dark, light and reduced motion at 1440px and 390px.
