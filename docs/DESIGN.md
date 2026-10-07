# Claude Mods: design direction

The single source of truth for how Claude Mods looks, moves and speaks: on the site (`docs/`), in the README banner (`assets/banner-*.svg`), in the social preview (`docs/assets/og.png`) and in any generated media (`docs/media/PROMPTS.md`). The CSS tokens in `docs/assets/site.css` implement this document; if the two disagree, fix one of them so they match again.

---

## 1. Concept: the Rack

**One store, a hundred and one tiles, and the ones you choose light up.**

Claude Mods is a set of small, precise instruments for Claude Code. The visual idea follows the shape of the catalog itself: **1 store + 10 categories x 10 mods**. We draw it as a rack: a grid of quiet tiles in warm ink, with the store tile on top. When a mod is installed or does its job, its tile lights in **Ember**. Everything else in the system, from the logo to the motion to the copy, comes back to this one picture of a dark rack with a few warm lights.

- **Personality:** a craftsman's catalogue crossed with a terminal. Editorial serif headlines, exact monospace detail, generous dark space.
- **Feeling:** calm, warm, competent. A good tool on a good desk at night.
- **Memorable thing:** the lit tile. It appears in the mark, the hero rack, the banner, the OG image, the tier badges and the kicker dots.
- **Nod to Claude without borrowing it:** a warm clay-amber accent and a literary serif, never Anthropic's logo, spark or typefaces.

## 2. Name and lockup

| Element | Spec |
| --- | --- |
| Name | **Claude Mods** in prose. `claude-mods` only where an identifier is meant (repo, marketplace, CLI). |
| Wordmark | Newsreader 500. "Claude" in roman, "*Mods*" in italic Ember. Tracking -1.5%. |
| Mark | **The Slot:** a 3x3 grid of rounded squares (4.5 / 24 units, radius 1.2, pitch 6.25) where only the bottom-right tile is lit in Ember. The other eight sit at 28% of the text color. |
| App tile | The mark on a `surface-2` rounded square (radius 8 at 26px) with a 1px inner hairline. `docs/assets/favicon.svg` is the 32px version. |
| Technical lockup | `> claude-mods` in Martian Mono with the prompt in Ember. For CLI-flavored contexts only. |
| Clear space | The height of one mark tile on every side. |
| Minimum size | Mark 16px. Wordmark 14px cap height. |

**Do not** set "Mods" in roman, recolor the lit tile, light more than one tile in the mark, outline the wordmark, or pair the mark with the Anthropic logo. Every public surface carries the line: *"Claude Mods is an independent community project and is not affiliated with or endorsed by Anthropic."*

## 3. Color

Dark first. Light mode is a warm paper, not an inverted dark. One accent family only: **Ember** (clay-amber) and its highlight **Phosphor**. Categories are told apart by icon, never by color.

### Dark: Ink (default)

| Token | Value | Role |
| --- | --- | --- |
| `--bg` | `#0e0d0b` | Page. Warm near-black, never pure `#000`. |
| `--bg-2` | `#121110` | Alternate section band. |
| `--surface` | `#171613` | Cards, panels. |
| `--surface-2` | `#1e1c19` | Raised controls, icon tiles. |
| `--surface-3` | `#282622` | Selected rows, pressed states. |
| `--code-bg` | `#0a0908` | Terminals, code, command blocks. |
| `--line` / `-2` / `-3` | `rgba(240,232,218,.08 / .14 / .24)` | Hairlines, from quiet to strong. |
| `--text` | `#eee7db` | Primary text (15.8:1 on bg). |
| `--text-2` | `#aba496` | Secondary text (7.9:1). |
| `--text-3` | `#878073` | Tertiary, metadata (5.0:1, AA). |
| `--accent` **Ember** | `#ee8a4f` | Brand accent, lit tiles, primary buttons (7.7:1). |
| `--accent-2` **Phosphor** | `#ffc27a` | Highlights, glints, the white-hot center of a lit tile. |
| `--accent-text` | `#f19a64` | Ember tuned for small text. |
| `--accent-ink` | `#1b0f06` | Text on Ember. |
| `--ok` / `--deny` / `--warn` | `#a3d18f` / `#f47b6e` / `#f0c35a` | Terminal semantics only (pass, blocked, caution). |

### Light: Paper

| Token | Value | Role |
| --- | --- | --- |
| `--bg` | `#f4efe6` | Warm paper. |
| `--bg-2` | `#efe9de` | Alternate band. |
| `--surface` | `#fbf8f2` | Cards. |
| `--surface-2` / `-3` | `#f3eee5` / `#e9e2d5` | Controls, selected. |
| `--code-bg` | `#fffdf9` | Code and terminals. |
| `--line` / `-2` / `-3` | `rgba(48,36,20,.10 / .16 / .28)` | Hairlines. |
| `--text` / `-2` / `-3` | `#1a1814` / `#56504a` / `#6b645a` | 15.5:1 / 6.9:1 / 5.1:1 on bg. |
| `--accent` **Clay** | `#b9531f` | Accent for large type, marks and button fills (button text 4.6:1). |
| `--accent-2` | `#e07434` | Highlights. |
| `--accent-text` | `#a84a1a` | Accent for small text (5.0:1). |
| `--ok` / `--deny` / `--warn` | `#3e7a33` / `#b4382b` / `#93680e` | Terminal semantics. |

**Rules.** Ember covers at most about 5% of any screen. Never put a gradient between two hues; glows go from Ember to transparent. No purple, no blue-violet gradients, no neon. Contrast meets WCAG AA for all text, including `--text-3`. Small accent text always uses `--accent-text`; `--accent` is for large type, marks and fills.

## 4. Typography

| Role | Family | Settings |
| --- | --- | --- |
| Display | **Newsreader** (Google Fonts, variable `opsz`) | 400, optical sizing auto, tracking -2.2%, line height 0.98 to 1.05. Emphasis in *italic Ember*. |
| UI and body | **Host Grotesk** | 400 / 500 / 600. 16px base, line height 1.55 to 1.6. |
| Code, labels, numbers | **Martian Mono** (variable `wdth`) | Code at 87.5% width, 0.78 to 0.82rem. Kickers at 100% width, 0.7rem, UPPERCASE, tracking +14%. |

Scale (fluid): hero `clamp(2.6rem, 1.5rem + 4vw, 4.6rem)`, H2 `clamp(2.15rem, 1.45rem + 2.6vw, 3.6rem)`, lede 1.05 to 1.25rem, body 1rem, small 0.8 to 0.9rem, micro 0.62 to 0.7rem mono.

- One italic Ember phrase per headline at most, and it carries the meaning: "Make Claude Code *yours*", "Events in. *Your rules* out."
- Mod names, commands, paths and versions are always mono. Mod names stay lowercase-kebab as they are.
- Numbers in stats use the display serif with tabular figures.
- Fallbacks: Iowan Old Style / Palatino / Georgia; system-ui; ui-monospace / SF Mono / Menlo / Consolas.
- In SVG for GitHub (banners), all text is converted to paths. No webfonts inside SVG.

## 5. Space, shape, surface

- **Grid:** 4px base. Section padding `clamp(80px, 9vw, 128px)`. Max content width 1200px. Gutters 16px under 640px, 28px to 1024px, 48px above. No horizontal scroll at 360px.
- **Radii:** 6 (chips, kbd), 10 to 12 (controls, commands), 16 (cards), 22 (panels, feature cards, sheets).
- **Borders:** 1px hairlines from the `--line` scale. Depth comes from hairlines plus soft long shadows, not heavy drop shadows.
- **Shadows:** `--shadow-md` for cards on hover, `--shadow-lg` for hero panels and sheets (a 1px inner top highlight, a 1px outer ring, a long soft fall-off).
- **Texture:** a fixed film-grain overlay (SVG turbulence, 4.5 to 5.5% opacity) and a dotted 22px grid masked to fade around the hero. One warm radial glow per hero-type section, never more.
- **Focus:** 2px Ember outline, 3px offset, on every interactive element.

## 6. Iconography

24px grid, 1.6px stroke, round caps and joins, no fills except the **one lit element** per icon, drawn in Ember through `--icon-lit`. The lit element always marks the thing the category is about.

| Category | Icon | Lit element |
| --- | --- | --- |
| Core | The Slot, a 3x3 tile grid | Bottom-right tile |
| Security & Guardrails | Shield | The check inside |
| Git & Versioning | Branch with two commits | The branch tip |
| Cost, Tokens & Context | Gauge | Needle and hub |
| Productivity | Double chevron | The leading chevron |
| Code Quality & Tests | Braces | The check between them |
| Panes & Dashboards | Window with a sidebar | The sparkline |
| Prompt & System Prompt | Speech bubble with text | The caret |
| Notifications & Audio | Bell | The badge dot |
| Memory & Knowledge | Notebook | The ribbon |
| Team & Docs | Two people | The second person |

Icons live as `<symbol>`s in `docs/index.html` (`#i-<category>`). Utility icons (copy, check, arrow, search, close, sun, moon, GitHub) follow the same grid and stroke but have no lit element.

## 7. Components

- **Kicker:** a 7px Ember tile with a soft glow, then mono uppercase text. Opens every section.
- **Command block:** `code-bg`, hairline border, Ember `>` prompt, mono command, square copy button that turns into a green check for 1.8s. Long commands scroll inside the block with a fade at the right edge; the page never scrolls sideways.
- **Tier badge:** three ascending bars. **Essential** (catalog `simple`) lights one bar; **Advanced** (catalog `complex`) lights all three. Mono, uppercase, 0.58rem.
- **Mod card:** icon tile and tier badge on top, mono name, category and version, description, command chips in Ember-soft, then *Copy install* and a GitHub link. The whole card opens the detail sheet. On phones it collapses to a compact row.
- **Category chips:** pill, icon, short name and a mono count of current matches. Selected is inverted (paper on ink).
- **Rack:** the hero visual. A store bar, ten category icons, a 10x10 grid of tiles and a status line that narrates what a mod just did.
- **Sheet:** the mod detail dialog. A centered card on desktop, a bottom sheet on phones.

## 8. Motion

**Principle: things light up; they do not fly around.** Motion is light changing state, the way an LED or a phosphor screen does.

| Token | Value | Use |
| --- | --- | --- |
| `--dur-1` | 140ms | Hover, press, color changes. |
| `--dur-2` | 260ms | Toggles, toasts, chips. |
| `--dur-3` | 700ms | Reveals, sheet entrance. |
| `--ease` | `cubic-bezier(.2,.7,.1,1)` | Default. |
| `--ease-out` | `cubic-bezier(.16,1,.3,1)` | Entrances. |

- **Lighting:** a tile flashes Ember in 120ms, then settles to a soft "installed" glow over 900ms.
- **Boot:** on load the rack lights in a wave from the store tile outward, 46ms per step.
- **Reveals:** 18px rise plus fade, staggered 70ms between siblings, once per element.
- **Narration:** the status line types at about 120 characters per second, with a blinking block caret.
- **Filtering:** View Transitions morph cards between filters where supported.
- Loops pause when off screen or when the tab is hidden.
- **`prefers-reduced-motion`:** no boot wave, no typing, no loops, no hero video. The rack shows a still, lit state and everything else appears at once.

## 9. Imagery and media

Code-made visuals come first: the rack, terminal mocks, panes and the slash menu are HTML and CSS, so they stay sharp, themeable and light. Generated media is optional and plugs into slots listed in `docs/media/media.json`; each prompt in `docs/media/PROMPTS.md` follows these rules:

- Warm ink darkness, a single Ember light source, phosphor highlights. Physical, tactile, macro-photographic.
- Subjects are abstract hardware: tiles, keys, slots, modules, light. No people, no faces, no robots, no brains, no glowing circuit boards, no floating holograms.
- No text, no logos, no UI chrome in images; type is always set live on top.
- Leave negative space where the layout puts copy (usually left).

## 10. Voice and tone

Precise, warm and a little dry. We sound like a senior engineer who likes their tools.

- **Second person, present tense, short sentences.** "Ten guards catch leaked secrets before they run."
- **Concrete over abstract.** Name the command, the file, the number. "Stopped at 100%, not surprised by the invoice."
- **Calm confidence.** No "revolutionary", "supercharge", "unleash", "AI-powered", "seamless" or "magic".
- **No emoji.** Use the lit tile, an icon or a well-chosen word.
- **Respect the reader's time.** One idea per sentence; headlines under eight words where possible.
- **Be honest about scope.** Say what a mod does and does not do. Mods are community-made, and we say so.

| Instead of | Write |
| --- | --- |
| "Supercharge your AI coding workflow!" | "Make Claude Code yours, one hook at a time." |
| "Seamlessly integrates with your stack" | "Detects your stack and gives Claude the right conventions for it." |
| "Never worry about costs again" | "Set a budget. Get warned at 80% and stopped at 100%." |
| "Click here to learn more" | "Read the contributing guide" |

## 11. Do and don't

**Do**
- Keep pages mostly ink and paper, with Ember as the light.
- Use mono for anything a user could type.
- Show the real thing: commands, file names, terminal output, actual mod names from `docs/data/mods.json`.
- Let one element per view be lit or animated, and let the rest stay quiet.
- Test both themes, 360px width and reduced motion before shipping.

**Don't**
- Use purple or blue gradients, glassmorphism stacks, 3D blobs or stock "AI" imagery.
- Mix a second accent hue or color-code categories.
- Center long body text or let body lines run past about 70 characters.
- Animate layout (width, height, top) or loop motion that cannot be paused or reduced.
- Use the Anthropic logo or spark, or imply official endorsement.

## 12. Where things live

| Asset | Path |
| --- | --- |
| Tokens and components | `docs/assets/site.css` |
| Icons (SVG symbols) | `docs/index.html` |
| Favicon | `docs/assets/favicon.svg` |
| Social preview (1280x640) | `docs/assets/og.png` |
| README banners | `assets/banner-dark.svg`, `assets/banner-light.svg` |
| README screenshots | `assets/store-dark.png`, `assets/store-light.png` |
| Media slots and prompts | `docs/media/media.json`, `docs/media/PROMPTS.md` |
