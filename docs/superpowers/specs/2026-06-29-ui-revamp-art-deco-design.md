# UI Revamp — Art Deco Luxury — Design (Phase 1: Foundation & Chrome)

**Status:** Approved for planning
**Date:** 2026-06-29
**Scope:** Establish an Art Deco luxury design system and apply it to the shared chrome (`AppLayout` header/footer, `UserNav`) and shared primitives (`Button`, deco ornaments). This is the foundation every later page inherits.

This is **Phase 1 of 3**. The full revamp covers the entire app, decomposed into independent cycles:

- **Phase 1 — Foundation & Chrome** *(this spec)*: design tokens, typography, shared primitives, header/footer/UserNav.
- **Phase 2 — Marketing & Lobby**: homepage, games lobby + `GameCard`, sign-in, profile, missions, leaderboard.
- **Phase 3 — Game tables**: `PlayingCard` / `PokerChip` / card containers, then the felt tables (Blackjack → Poker → Baccarat → Craps → multiplayer poker), one at a time.

Each phase gets its own spec → plan → implementation cycle. Phases 2–3 are **non-goals** here.

---

## 1. Goals

- Replace the generic "gold-on-dark-slate + emoji + system font" aesthetic with a distinctive **1920s Art Deco luxury** visual language.
- Define a single source of truth for design tokens (color, type, spacing, shadow, ornament) in `src/styles/global.css`.
- Load real, characterful fonts: **Playfair Display** (display) + **Jost** (body/UI).
- Remove emoji from the shared chrome and replace with an inline-SVG icon/glyph set.
- Restyle the `AppLayout` header, footer, and `UserNav` to the new language.
- Provide reusable primitives (`Button`, a deco divider/ornament) that Phases 2–3 build on.
- Do all of this **without breaking** existing pages or E2E tests — game pages keep rendering with their current styles until their phase.

## 2. Non-goals

- No restyle of the homepage, lobby, `GameCard`, sign-in, profile, missions, or leaderboard (Phase 2).
- No restyle of the in-game table UI, `PlayingCard`, `PokerChip`, or card containers (Phase 3).
- No changes to game logic, auth, routing, data, or any `data-testid` attribute.
- No new dependencies beyond font packages.
- No light theme. The app stays dark.

## 3. Decisions

| Topic | Decision |
| --- | --- |
| Aesthetic | Art Deco luxury — obsidian + emerald + brass, geometric, opulent, restrained |
| Theme | Dark only |
| Display font | Playfair Display (high-contrast serif) |
| Body/UI font | Jost (geometric grotesk, Futura-derived; deco-era DNA) |
| Font delivery | Self-hosted via `@fontsource` packages (Workers-reliable, no external request) |
| Emoji | Removed from chrome; replaced by inline SVG icons + deco glyphs |
| Token strategy | Add new `--deco-*` tokens; keep legacy `--casino-*` tokens intact for un-migrated pages |
| Logo | Typeset "ARCTURUS" wordmark + deco star mark (no slot-machine emoji) |
| Migration safety | Body font **and** background (`--deco-obsidian`) apply globally immediately (net win); per-page layout restyles and surface classes (panels, cards, tables) are deferred to later phases |

---

## 4. Design tokens

Added to `:root` in `src/styles/global.css`. Legacy `--casino-*` / `--felt-*` / `--glow-*` variables stay **unchanged** so game and marketing pages keep working until their phase.

### 4.1 Color

```css
/* Art Deco palette */
--deco-obsidian:      #0B0F0E;  /* base background, warm near-black */
--deco-obsidian-2:    #111815;  /* raised surface */
--deco-emerald-deep:  #0C3326;  /* deep panel / felt */
--deco-emerald:       #0E3B2E;  /* panel surface */
--deco-emerald-line:  #1C5C46;  /* emerald hairline / border */
--deco-brass:         #C8A55C;  /* primary metallic accent */
--deco-brass-bright:  #E4C988;  /* hover / highlight sheen */
--deco-brass-dim:     #8C7438;  /* pressed / muted brass */
--deco-ivory:         #F4EFE6;  /* primary text, warm off-white */
--deco-ivory-dim:     #C9C2B4;  /* secondary text */
--deco-muted:         #8A8377;  /* tertiary / captions */
--deco-oxblood:       #6E1F23;  /* danger / loss / hearts-diamonds accent */
--deco-oxblood-bright:#9A2D33;  /* danger hover */
```

### 4.2 Typography

```css
--font-display: 'Playfair Display', Georgia, serif;
--font-body:    'Jost', system-ui, sans-serif;

/* Type scale (rem) */
--text-xs: 0.75rem;  --text-sm: 0.875rem; --text-base: 1rem;
--text-lg: 1.25rem;  --text-xl: 1.75rem;  --text-2xl: 2.5rem;
--text-3xl: 3.5rem;  --text-display: 4.5rem;

/* Tracking — deco loves wide letter-spacing on small-caps labels */
--tracking-wide: 0.18em;   /* nav, labels, eyebrows */
--tracking-tight: -0.01em; /* large display headings */
```

### 4.3 Surface, border, shadow, ornament

```css
--radius-sm: 2px;     /* deco is sharp; corners are chamfered, not round */
--radius-md: 4px;
--border-brass: 1px solid var(--deco-brass);
--border-hairline: 1px solid rgba(200, 165, 92, 0.28);

--shadow-panel: 0 12px 40px rgba(0, 0, 0, 0.55);
--sheen-brass: 0 0 0 1px var(--deco-brass-bright), 0 0 24px rgba(228, 201, 136, 0.18);

/* subtle film-grain overlay applied to body for depth */
--grain-opacity: 0.04;
```

## 5. Typography setup

- Add dev dependencies: `@fontsource/playfair-display` and `@fontsource/jost` (self-hosted; no runtime network request, which matters on Workers).
- Import the specific weight CSS files once, in `AppLayout.astro`'s frontmatter (JS side-effect imports, e.g. `import '@fontsource/jost/400.css';`), since `AppLayout` already wraps every page. Weights:
  - Playfair Display: 500, 700, 800 (+ italic 500 for accents).
  - Jost: 400, 500, 600.
- The `font-family` declarations live in `global.css` (single styling source of truth): `body { font-family: var(--font-body); }` — applies globally and immediately improves every page.
- `h1–h6, .font-display { font-family: var(--font-display); }`.
- Chip balances and numeric stats use `font-variant-numeric: tabular-nums`.

This global font swap is the **only** Phase 1 change that touches all pages. It is purely additive (better fonts, same layout) and carries no regression risk to game logic.

## 6. Shared primitives

### 6.1 `Button.astro`

Restyle the existing `src/components/Button.astro` to deco variants (keep its current prop/API surface; only the rendered classes/styles change so call sites don't break):

- **Primary (brass):** brass fill, obsidian text, thin chamfered frame; hover adds `--sheen-brass`. Replaces the `from-yellow-400…` gradient look.
- **Outline (brass):** transparent fill, brass hairline border, brass text; hover fills faint brass.
- **Ghost / nav:** text-only, ivory → brass on hover, wide-tracked small-caps.
- Shared: square-ish corners (`--radius-sm`), letter-spaced uppercase label, 150ms ease transitions.

If the current `Button.astro` API is too thin, add a `variant` prop (`primary | outline | ghost`) with `primary` as default.

### 6.2 `DecoDivider.astro` (new)

A reusable inline-SVG ornament: a centered brass sunburst/fan glyph flanked by thin tapering rules. Props: `width`, `tone` (`brass | emerald`). Used as section separators in this and later phases. No external image — pure inline SVG so it scales and recolors cleanly.

### 6.3 Icon glyphs (new, lightweight)

A tiny set of inline-SVG icons to replace chrome emoji: chip/coin, star (Arcturus mark), menu, user, trophy, calendar/mission. Implemented as small `.astro` snippets or a single `DecoIcon.astro` with a `name` prop. Stroke-based, brass-colored, deco geometry.

## 7. Header / footer / UserNav redesign

All in `src/layouts/AppLayout.astro` (+ `src/components/UserNav.astro`). Structure and links are preserved; only presentation changes. No `data-chip-balance` or other hooks are removed.

### 7.1 Header

- Background: `--deco-obsidian` with a 1px brass hairline bottom border and a faint sunburst motif behind the wordmark.
- **Logo:** deco star mark (SVG) + "ARCTURUS" in Playfair small-caps with `--tracking-wide`, a thin sunburst rule underneath, and the eyebrow "PREMIUM CASINO" in Jost wide-tracked uppercase. Replaces the 🎰 emoji and the gold gradient text.
- **Nav:** Daily Mission / Tournaments / Leaderboard in Jost small-caps, ivory → brass hover with a growing brass underline.
- **Chip balance pill:** brass-hairline framed, obsidian fill, inline chip SVG (replaces the existing coin `<svg>`), tabular-nums value in brass. Keeps `data-chip-balance`.

### 7.2 Footer

- Obsidian background, brass hairline top border, a `DecoDivider` above the columns.
- Column headings in Playfair brass; links in Jost ivory-dim → brass hover.
- Keep all existing links/structure; restyle only. Update the year line to render dynamically (`new Date().getFullYear()`) instead of the hardcoded `© 2025`.

### 7.3 `UserNav.astro`

Restyle the avatar/sign-in/sign-out control to brass-hairline framing and Jost small-caps, matching the header. Preserve behavior and any test hooks.

## 8. File-level change map

| File | Change |
| --- | --- |
| `package.json` | Add `@fontsource/playfair-display`, `@fontsource/jost` (devDeps) |
| `src/styles/global.css` | Add `--deco-*` tokens, font imports, `body`/heading font rules, grain overlay, deco utility classes; **legacy tokens untouched** |
| `src/components/Button.astro` | Deco variants (primary/outline/ghost) |
| `src/components/DecoDivider.astro` | **New** — inline-SVG sunburst/fan divider |
| `src/components/DecoIcon.astro` | **New** — inline-SVG icon set (chip, star, user, trophy, menu, calendar) |
| `src/layouts/AppLayout.astro` | Header + footer restyle, font imports, emoji → SVG, dynamic year |
| `src/components/UserNav.astro` | Deco restyle, emoji/icon swap |

No other files change in Phase 1.

## 9. Error handling & edge cases

- **Fonts fail to load:** `--font-body`/`--font-display` declare system fallbacks (`system-ui`, `Georgia`), so text always renders.
- **Logged-out state:** chip pill is conditionally rendered exactly as today; restyle must not assume `user` exists.
- **Long chip values:** pill uses tabular-nums and flexes; no fixed width that could clip large balances.
- **Mobile:** header collapses as it does now (nav hidden under `md`); deco wordmark and chip pill must remain legible at small sizes. A menu glyph stands in for future mobile nav but does not change current behavior.
- **Reduced motion:** hover sheen/underline transitions respect `prefers-reduced-motion: reduce` (disabled or instant).

## 10. Testing & verification

- **No new unit tests** — Phase 1 is presentational; there is no new pure logic to test. (`DecoDivider`/`DecoIcon` are static SVG.)
- **E2E must stay green:** run the existing Playwright suite. Header/footer restyle preserves every selector and `data-testid`; the global font change is cosmetic. Any failure indicates an accidental structural/hook change to fix.
- **Manual verification:** run `bun run dev` (port 2000) and visually confirm header, footer, chip pill, and `Button` variants across logged-in and logged-out states, desktop and mobile widths.
- **Lint/format:** `bun run lint` (max 0 warnings) and `bun run format:check` must pass; tabs, single quotes, semicolons per repo style.
- **Build:** `bun run build` succeeds for the Cloudflare target.

## 11. Risks & mitigations

| Risk | Mitigation |
| --- | --- |
| Legacy pages look inconsistent mid-migration | Accepted and expected; phasing is explicit. Legacy tokens stay intact so nothing regresses, only the chrome + fonts change globally. |
| Global font swap shifts game-page layouts subtly | Jost/Playfair fall back to similar-metric system fonts; spot-check game pages render and E2E passes. |
| Self-hosted fonts increase bundle size | Import only the specific weights needed; `@fontsource` ships subsettable woff2. |
| `Button.astro` API change breaks call sites | Keep existing props; add `variant` as optional with a backwards-compatible default. |

## 12. Definition of done (Phase 1)

- New `--deco-*` tokens and font setup live in `global.css`; legacy tokens untouched.
- Playfair + Jost load (self-hosted) and apply globally with system fallbacks.
- Header, footer, and `UserNav` render in the Art Deco language with no emoji and dynamic year.
- `Button`, `DecoDivider`, `DecoIcon` exist and are reusable by Phase 2.
- `bun run lint`, `bun run format:check`, `bun run build`, and the Playwright E2E suite all pass.
- A short follow-up note seeds Phase 2 (apply this system to homepage + lobby).
