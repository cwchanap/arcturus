# Art Deco UI Revamp — Phase 1 (Foundation & Chrome) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Establish an Art Deco luxury design system (tokens, fonts, primitives) and apply it to the shared chrome — `AppLayout` header/footer and `UserNav`.

**Architecture:** All visual primitives live as CSS custom properties + semantic `.deco-*` classes in `src/styles/global.css` (single styling source of truth). Thin `.astro` components (`DecoIcon`, `DecoDivider`, `Button`) consume those classes. The chrome (`AppLayout`, `UserNav`) is re-marked-up to use them, with all emoji replaced by inline SVG. Legacy `--casino-*` tokens stay untouched so un-migrated pages (homepage, lobby, game tables) keep working until their own phases.

**Tech Stack:** Astro 5 (SSR, Cloudflare adapter), Tailwind CSS v4 (via Vite plugin), self-hosted fonts via `@fontsource` (Playfair Display + Jost), Bun, Playwright.

**Methodology note:** This phase is presentational. There is no new pure logic, so per the approved spec there are **no new unit tests**. Each task's verification gate is `bun run lint`, `bun run format:check`, and (where the component is exercised) `bun run build`, plus a dev-server visual check for chrome and the Playwright E2E suite at integration. This is a deliberate, honest adaptation of the test-first cycle to a CSS/markup change — do not fabricate meaningless unit tests.

## Global Constraints

- **Runtime:** Cloudflare Workers — never use `process.env`; use `Astro.locals.runtime.env`. (No server code changes here, but applies if touched.)
- **Code style (auto-enforced):** Tabs (width 2), single quotes, semicolons required. Unused vars must start with `_`.
- **Lint gate:** `bun run lint` runs `eslint . --max-warnings 0` — zero warnings allowed.
- **Dev server:** port **2000** (`http://localhost:2000`), not 4321.
- **Preserve test hooks:** Do **not** remove or rename any `data-testid` or `data-chip-balance` attribute, or change link `href`s / DOM structure that E2E relies on. Restyle only.
- **No emoji in chrome:** the header, footer, and `UserNav` must contain zero emoji after this phase.
- **Theme:** dark only. Do **not** change the global `body` background or `bodyClass` — the only global change is the font swap.
- **Legacy tokens untouched:** do not edit or remove existing `--casino-*`, `--felt-*`, `--glow-*` variables or the existing `.playing-card`, `.poker-chip`, `.felt-table`, `.btn-gold`, `.game-card`, `.action-btn`, `.neon-glow` rules.

---

## File Structure

| File                               | Responsibility                                                                                                                                 |
| ---------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| `package.json`                     | Add `@fontsource/playfair-display`, `@fontsource/jost` devDependencies                                                                         |
| `src/styles/global.css`            | **The design system.** Add `--deco-*` tokens, font-family rules, and all `.deco-*` semantic/utility/component classes. Legacy rules untouched. |
| `src/layouts/AppLayout.astro`      | Font imports (frontmatter) + restyled header & footer markup, dynamic year                                                                     |
| `src/components/DecoIcon.astro`    | **New.** Inline-SVG icon set (`chip`, `star`, `user`, `trophy`, `menu`, `calendar`)                                                            |
| `src/components/DecoDivider.astro` | **New.** Inline-SVG sunburst/fan section divider                                                                                               |
| `src/components/Button.astro`      | **Replace** dead confetti demo with a reusable deco button (`variant` + optional `href`)                                                       |
| `src/components/UserNav.astro`     | Restyle avatar / username / sign-in / sign-out to the deco language                                                                            |

---

## Task 1: Design-system foundation (fonts + tokens + classes)

**Files:**

- Modify: `package.json` (dependencies)
- Modify: `src/styles/global.css` (append new tokens + classes; legacy untouched)
- Modify: `src/layouts/AppLayout.astro:1-3` (frontmatter font imports only)

**Interfaces:**

- Produces (consumed by all later tasks): CSS custom properties `--deco-obsidian`, `--deco-obsidian-2`, `--deco-emerald-deep`, `--deco-emerald`, `--deco-emerald-line`, `--deco-brass`, `--deco-brass-bright`, `--deco-brass-dim`, `--deco-ivory`, `--deco-ivory-dim`, `--deco-muted`, `--deco-oxblood`, `--deco-oxblood-bright`, `--font-display`, `--font-body`; and classes `.deco-grain`, `.deco-header`, `.deco-footer`, `.deco-wordmark`, `.deco-eyebrow`, `.deco-rule`, `.deco-link`, `.deco-footer-link`, `.deco-heading`, `.deco-chip-pill`, `.deco-btn`, `.deco-btn-primary`, `.deco-btn-outline`, `.deco-btn-ghost`.

- [ ] **Step 1: Install the font packages**

Run:

```bash
bun add -d @fontsource/playfair-display @fontsource/jost
```

Expected: both appear under `devDependencies` in `package.json`; `bun.lock` updates.

- [ ] **Step 2: Add deco tokens + classes to `global.css`**

Append the following to the **end** of `src/styles/global.css` (do not touch existing content). Use tabs for indentation to satisfy Prettier:

```css
/* ===== Art Deco design system (Phase 1) ===== */
:root {
	--deco-obsidian: #0b0f0e;
	--deco-obsidian-2: #111815;
	--deco-emerald-deep: #0c3326;
	--deco-emerald: #0e3b2e;
	--deco-emerald-line: #1c5c46;
	--deco-brass: #c8a55c;
	--deco-brass-bright: #e4c988;
	--deco-brass-dim: #8c7438;
	--deco-ivory: #f4efe6;
	--deco-ivory-dim: #c9c2b4;
	--deco-muted: #8a8377;
	--deco-oxblood: #6e1f23;
	--deco-oxblood-bright: #9a2d33;

	--font-display: 'Playfair Display', Georgia, 'Times New Roman', serif;
	--font-body: 'Jost', system-ui, -apple-system, sans-serif;

	--shadow-panel: 0 12px 40px rgba(0, 0, 0, 0.55);
	--sheen-brass: 0 0 0 1px var(--deco-brass-bright), 0 0 24px rgba(228, 201, 136, 0.18);
}

/* Global font swap — the ONLY change that touches every page */
body {
	font-family: var(--font-body);
}

h1,
h2,
h3,
h4,
h5,
h6,
.font-display {
	font-family: var(--font-display);
}

.font-body {
	font-family: var(--font-body);
}

/* Subtle film-grain overlay for depth (opt-in via class) */
.deco-grain {
	position: relative;
}
.deco-grain::after {
	content: '';
	position: absolute;
	inset: 0;
	pointer-events: none;
	z-index: 0;
	opacity: 0.04;
	mix-blend-mode: overlay;
	background-image: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='120' height='120'%3E%3Cfilter id='n'%3E%3CfeTurbulence type='fractalNoise' baseFrequency='0.8' numOctaves='2' stitchTiles='stitch'/%3E%3C/filter%3E%3Crect width='100%25' height='100%25' filter='url(%23n)'/%3E%3C/svg%3E");
}
.deco-grain > * {
	position: relative;
	z-index: 1;
}

/* Chrome surfaces */
.deco-header {
	background: rgba(11, 15, 14, 0.95);
	border-bottom: 1px solid rgba(200, 165, 92, 0.3);
	backdrop-filter: blur(6px);
}
.deco-footer {
	background: rgba(11, 15, 14, 0.95);
	border-top: 1px solid rgba(200, 165, 92, 0.3);
}

/* Wordmark + labels */
.deco-wordmark {
	font-family: var(--font-display);
	font-weight: 800;
	letter-spacing: 0.22em;
	color: var(--deco-brass-bright);
}
.deco-eyebrow {
	font-family: var(--font-body);
	text-transform: uppercase;
	letter-spacing: 0.18em;
	font-size: 0.66rem;
	color: var(--deco-muted);
}
.deco-heading {
	font-family: var(--font-display);
	color: var(--deco-brass-bright);
}

/* Hairline rule */
.deco-rule {
	height: 1px;
	background: linear-gradient(
		to right,
		transparent,
		var(--deco-brass) 20%,
		var(--deco-brass) 80%,
		transparent
	);
}

/* Links */
.deco-link {
	font-family: var(--font-body);
	text-transform: uppercase;
	letter-spacing: 0.18em;
	font-size: 0.78rem;
	color: var(--deco-ivory-dim);
	transition: color 0.18s ease;
}
.deco-link:hover {
	color: var(--deco-brass-bright);
}
.deco-footer-link {
	font-family: var(--font-body);
	font-size: 0.875rem;
	color: var(--deco-ivory-dim);
	transition: color 0.18s ease;
}
.deco-footer-link:hover {
	color: var(--deco-brass-bright);
}

/* Chip / framed pill */
.deco-chip-pill {
	display: inline-flex;
	align-items: center;
	gap: 0.5rem;
	padding: 0.45rem 1rem;
	border-radius: 2px;
	border: 1px solid rgba(200, 165, 92, 0.4);
	background: var(--deco-obsidian-2);
	color: var(--deco-brass-bright);
}

/* Buttons */
.deco-btn {
	display: inline-flex;
	align-items: center;
	justify-content: center;
	gap: 0.5rem;
	font-family: var(--font-body);
	font-weight: 500;
	text-transform: uppercase;
	letter-spacing: 0.12em;
	font-size: 0.82rem;
	padding: 0.7rem 1.5rem;
	border-radius: 2px;
	cursor: pointer;
	text-decoration: none;
	transition:
		box-shadow 0.18s ease,
		background-color 0.18s ease,
		color 0.18s ease,
		transform 0.18s ease;
}
.deco-btn-primary {
	background: var(--deco-brass);
	color: var(--deco-obsidian);
	border: 1px solid var(--deco-brass-bright);
}
.deco-btn-primary:hover {
	background: var(--deco-brass-bright);
	box-shadow: var(--sheen-brass);
	transform: translateY(-1px);
}
.deco-btn-outline {
	background: transparent;
	color: var(--deco-brass-bright);
	border: 1px solid var(--deco-brass);
}
.deco-btn-outline:hover {
	background: rgba(200, 165, 92, 0.1);
	box-shadow: var(--sheen-brass);
}
.deco-btn-ghost {
	background: transparent;
	color: var(--deco-ivory-dim);
	border: 1px solid transparent;
}
.deco-btn-ghost:hover {
	color: var(--deco-brass-bright);
}

@media (prefers-reduced-motion: reduce) {
	.deco-link,
	.deco-footer-link,
	.deco-btn {
		transition: none;
	}
	.deco-btn:hover {
		transform: none;
	}
}
```

- [ ] **Step 3: Wire the font imports in `AppLayout.astro`**

In `src/layouts/AppLayout.astro`, the frontmatter currently begins:

```astro
---
import '../styles/global.css';
import UserNav from '../components/UserNav.astro';
---
```

Insert the font imports immediately after the `global.css` import:

```astro
---
import '../styles/global.css';
import '@fontsource/playfair-display/500.css';
import '@fontsource/playfair-display/700.css';
import '@fontsource/playfair-display/800.css';
import '@fontsource/playfair-display/500-italic.css';
import '@fontsource/jost/400.css';
import '@fontsource/jost/500.css';
import '@fontsource/jost/600.css';
import UserNav from '../components/UserNav.astro';
---
```

- [ ] **Step 4: Format, lint, and build**

Run:

```bash
bun run format && bun run lint && bun run build
```

Expected: format rewrites nothing problematic, lint exits 0, `astro build` completes with no errors.

- [ ] **Step 5: Visual smoke check**

Run `bun run dev`, open `http://localhost:2000`. Expected: body text now renders in **Jost**, headings in **Playfair Display** (the homepage hero serif visibly changes). No layout breakage. Stop the dev server.

- [ ] **Step 6: Commit**

```bash
git add package.json bun.lock src/styles/global.css src/layouts/AppLayout.astro
git commit -m "feat(ui): Art Deco design tokens, fonts, and base classes"
```

---

## Task 2: `DecoIcon` component (inline-SVG icon set)

**Files:**

- Create: `src/components/DecoIcon.astro`

**Interfaces:**

- Consumes: nothing (self-contained inline SVG; color via `currentColor`).
- Produces: `DecoIcon` component with props `{ name: 'chip' | 'star' | 'user' | 'trophy' | 'menu' | 'calendar'; size?: number; class?: string }`. Renders a 24×24 `viewBox` `<svg>` using `stroke="currentColor"` so the parent's text color drives the icon color. Consumed by Tasks 5 and 6.

- [ ] **Step 1: Create the component**

Create `src/components/DecoIcon.astro` with exactly:

```astro
---
interface Props {
	name: 'chip' | 'star' | 'user' | 'trophy' | 'menu' | 'calendar';
	size?: number;
	class?: string;
}

const { name, size = 20, class: className = '' } = Astro.props;
---

<svg
	width={size}
	height={size}
	viewBox="0 0 24 24"
	fill="none"
	stroke="currentColor"
	stroke-width="1.5"
	stroke-linecap="round"
	stroke-linejoin="round"
	class={className}
	aria-hidden="true"
>
	{
		name === 'chip' && (
			<>
				<circle cx="12" cy="12" r="9" />
				<circle cx="12" cy="12" r="4.5" stroke-dasharray="2 2" />
				<line x1="12" y1="3" x2="12" y2="5.5" />
				<line x1="12" y1="18.5" x2="12" y2="21" />
				<line x1="3" y1="12" x2="5.5" y2="12" />
				<line x1="18.5" y1="12" x2="21" y2="12" />
			</>
		)
	}
	{name === 'star' && <path d="M12 2 L14 10 L22 12 L14 14 L12 22 L10 14 L2 12 L10 10 Z" />}
	{
		name === 'user' && (
			<>
				<circle cx="12" cy="8" r="4" />
				<path d="M4 21a8 8 0 0 1 16 0" />
			</>
		)
	}
	{
		name === 'trophy' && (
			<>
				<path d="M8 4h8v5a4 4 0 0 1-8 0z" />
				<path d="M8 5H5a2 2 0 0 0 0 4h1.2" />
				<path d="M16 5h3a2 2 0 0 1 0 4h-1.2" />
				<line x1="12" y1="13" x2="12" y2="16" />
				<path d="M9.5 16h5l.5 4h-6z" />
			</>
		)
	}
	{
		name === 'menu' && (
			<>
				<line x1="4" y1="7" x2="20" y2="7" />
				<line x1="4" y1="12" x2="20" y2="12" />
				<line x1="4" y1="17" x2="20" y2="17" />
			</>
		)
	}
	{
		name === 'calendar' && (
			<>
				<rect x="4" y="5" width="16" height="16" rx="1" />
				<line x1="4" y1="9" x2="20" y2="9" />
				<line x1="9" y1="3" x2="9" y2="6" />
				<line x1="15" y1="3" x2="15" y2="6" />
			</>
		)
	}
</svg>
```

- [ ] **Step 2: Format and lint**

Run:

```bash
bun run format && bun run lint
```

Expected: exits 0 (no warnings). The component is not yet imported anywhere, so this gate confirms it parses and is style-clean; it is exercised by `build` in Task 5.

- [ ] **Step 3: Commit**

```bash
git add src/components/DecoIcon.astro
git commit -m "feat(ui): add DecoIcon inline-SVG icon set"
```

---

## Task 3: `DecoDivider` component (sunburst/fan ornament)

**Files:**

- Create: `src/components/DecoDivider.astro`

**Interfaces:**

- Consumes: nothing (inline SVG; tone color resolved to a CSS var).
- Produces: `DecoDivider` component with props `{ tone?: 'brass' | 'emerald'; class?: string }`. Renders flanking hairline rules and a centered fan glyph. Consumed by Task 5 (footer).

- [ ] **Step 1: Create the component**

Create `src/components/DecoDivider.astro` with exactly:

```astro
---
interface Props {
	tone?: 'brass' | 'emerald';
	class?: string;
}

const { tone = 'brass', class: className = '' } = Astro.props;
const color = tone === 'emerald' ? 'var(--deco-emerald-line)' : 'var(--deco-brass)';
const ruleStyle = `background:linear-gradient(to right,transparent,${color} 35%,${color} 65%,transparent)`;
---

<div class={`flex items-center justify-center gap-4 ${className}`.trim()} style={`color:${color}`}>
	<span class="h-px flex-1" style={ruleStyle}></span>
	<svg
		width="36"
		height="20"
		viewBox="0 0 36 20"
		fill="none"
		stroke="currentColor"
		stroke-width="1"
		stroke-linecap="round"
		aria-hidden="true"
	>
		<path d="M18 19 L6 6"></path>
		<path d="M18 19 L10 4"></path>
		<path d="M18 19 L14 3"></path>
		<path d="M18 19 L18 2"></path>
		<path d="M18 19 L22 3"></path>
		<path d="M18 19 L26 4"></path>
		<path d="M18 19 L30 6"></path>
		<circle cx="18" cy="19" r="1.4" fill="currentColor" stroke="none"></circle>
	</svg>
	<span class="h-px flex-1" style={ruleStyle}></span>
</div>
```

- [ ] **Step 2: Format and lint**

Run:

```bash
bun run format && bun run lint
```

Expected: exits 0.

- [ ] **Step 3: Commit**

```bash
git add src/components/DecoDivider.astro
git commit -m "feat(ui): add DecoDivider sunburst ornament"
```

---

## Task 4: Reusable deco `Button` (replace dead confetti demo)

**Files:**

- Modify (full replace): `src/components/Button.astro`

**Context:** The current `Button.astro` is unused dead code — a purple confetti demo whose `<script>` binds to `document.body.querySelector('button')` (the page's first button), a footgun. Replace it entirely with a reusable primitive. Do not remove `canvas-confetti` from `package.json` (out of scope; games may use it).

**Interfaces:**

- Consumes: `.deco-btn`, `.deco-btn-primary`, `.deco-btn-outline`, `.deco-btn-ghost` from Task 1.
- Produces: `Button` component that renders an `<a>` when `href` is set, otherwise a `<button>`. `variant` defaults to `'primary'`. Props are a discriminated union keyed on `href` so anchor-only attrs (`target`, `rel`, `download`, …) and button-only attrs (`disabled`, `type`, …) are type-checked for the right branch, and any remaining standard attributes are forwarded via `{...rest}` onto the rendered element. Available for Phase 2 (not wired into chrome here).

- [ ] **Step 1: Replace the file contents**

Replace the entire contents of `src/components/Button.astro` with:

```astro
---
import type { HTMLAttributes } from 'astro/types';

type Variant = 'primary' | 'outline' | 'ghost';

// Discriminated by `href`: anchor branch renders an `<a>` and only accepts
// anchor attributes; button branch renders a `<button>` and only accepts
// button attributes. Remaining standard attributes spread via `{...rest}`.
type Props =
	| (Omit<HTMLAttributes<'a'>, 'class'> & {
			variant?: Variant;
			href: string;
			type?: never;
			class?: string;
	  })
	| (Omit<HTMLAttributes<'button'>, 'class' | 'type'> & {
			variant?: Variant;
			href?: undefined;
			type?: 'button' | 'submit';
			class?: string;
	  });

const { variant = 'primary', href, type = 'button', class: className = '', ...rest } = Astro.props;

const variantClass =
	variant === 'outline'
		? 'deco-btn-outline'
		: variant === 'ghost'
			? 'deco-btn-ghost'
			: 'deco-btn-primary';

const cls = `deco-btn ${variantClass} ${className}`.trim();
---

{
	href ? (
		<a href={href} class={cls} {...rest}>
			<slot />
		</a>
	) : (
		<button type={type} class={cls} {...rest}>
			<slot />
		</button>
	)
}
```

- [ ] **Step 2: Format, lint, and build**

Run:

```bash
bun run format && bun run lint && bun run build
```

Expected: all exit 0. `build` confirms removing the confetti script broke no import (we verified there are no `<Button>` call sites).

- [ ] **Step 3: Commit**

```bash
git add src/components/Button.astro
git commit -m "feat(ui): replace confetti demo Button with deco button primitive"
```

---

## Task 5: Restyle `AppLayout` header & footer

**Files:**

- Modify: `src/layouts/AppLayout.astro` (header block `:47-107`, footer block `:111-164`; line numbers approximate — match on content)

**Interfaces:**

- Consumes: `DecoIcon` (Task 2), `DecoDivider` (Task 3), and `.deco-*` classes (Task 1).
- Produces: restyled chrome. Preserves `data-chip-balance`, all nav/footer `href`s, and `<UserNav />`.

- [ ] **Step 1: Import the new components**

In `src/layouts/AppLayout.astro` frontmatter, after the `UserNav` import, add:

```astro
import DecoIcon from '../components/DecoIcon.astro'; import DecoDivider from
'../components/DecoDivider.astro';
```

- [ ] **Step 2: Replace the `<header>` block**

Find the existing `<header …>…</header>` (the block starting `<header` around line 47) and replace the whole element with:

```astro
<header class={`deco-header deco-grain ${headerPositionClass}`.trim()}>
	<div class="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
		<div class="flex justify-between items-center h-20">
			<a href="/" class="group flex items-center gap-3">
				<DecoIcon
					name="star"
					size={30}
					class="text-[var(--deco-brass)] transition-transform duration-300 group-hover:rotate-45"
				/>
				<div class="leading-tight">
					<div class="deco-wordmark text-2xl">ARCTURUS</div>
					<div class="deco-rule my-1"></div>
					<div class="deco-eyebrow">Premium Casino</div>
				</div>
			</a>

			<nav class="hidden md:flex items-center gap-8">
				<a href="/missions/daily" class="deco-link">Daily Mission</a>
				<a href="/games/tournaments" class="deco-link">Tournaments</a>
				<a href="/games/leaderboard" class="deco-link">Leaderboard</a>
			</nav>

			<div class="flex items-center gap-4">
				{
					user && (
						<div class="deco-chip-pill hidden md:inline-flex">
							<DecoIcon name="chip" size={18} class="text-[var(--deco-brass)]" />
							<span class="font-body font-medium tabular-nums" data-chip-balance>
								{formattedChipBalance ? `${formattedChipBalance} chips` : '— chips'}
							</span>
						</div>
					)
				}
				<UserNav />
			</div>
		</div>
	</div>
</header>
```

Note: `text-[var(--deco-brass)]` is a Tailwind v4 arbitrary color using a bare CSS variable (no opacity modifier), which is supported. The chip value keeps `data-chip-balance` and the exact text expression.

- [ ] **Step 3: Replace the `<footer>` block**

Find the existing `<footer …>…</footer>` and replace the whole element with:

```astro
<footer class={`deco-footer ${footerClass}`.trim()}>
	<div class="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-12">
		<DecoDivider class="mb-10" />
		<div class="grid grid-cols-1 md:grid-cols-2 gap-8">
			<div>
				<h3 class="deco-heading text-lg mb-4">Games</h3>
				<ul class="space-y-2">
					<li><a href="/#games" class="deco-footer-link">All Games</a></li>
					<li><a href="/games/poker" class="deco-footer-link">Poker</a></li>
					<li><a href="/games/blackjack" class="deco-footer-link">Blackjack</a></li>
				</ul>
			</div>
			<div>
				<h3 class="deco-heading text-lg mb-4">Arcturus</h3>
				<ul class="space-y-2">
					<li><a href="/missions/daily" class="deco-footer-link">Daily Mission</a></li>
					<li><a href="/games/leaderboard" class="deco-footer-link">Leaderboard</a></li>
					<li><a href="/profile" class="deco-footer-link">Profile</a></li>
				</ul>
			</div>
		</div>
		<div class="deco-rule mt-10 mb-6"></div>
		<p class="text-center text-sm" style="color: var(--deco-muted)">
			© {new Date().getFullYear()} Arcturus Casino. All rights reserved. Play responsibly.
		</p>
	</div>
</footer>
```

Preserve every existing footer `href` from the original `AppLayout` footer — do **not** introduce placeholder `href="#"` links, which would regress real navigation (the Leaderboard link, in particular, is asserted by E2E). Only the structure/styling changes to the `deco-footer` markup.

- [ ] **Step 4: Format, lint, and build**

Run:

```bash
bun run format && bun run lint && bun run build
```

Expected: all exit 0. `build` now exercises `DecoIcon` and `DecoDivider` for the first time.

- [ ] **Step 5: Visual check (logged-out and logged-in)**

Run `bun run dev`, open `http://localhost:2000`. Confirm:

- Header shows the brass star mark + "ARCTURUS" Playfair wordmark + sunburst rule + "PREMIUM CASINO" eyebrow — **no 🎰 emoji**.
- Nav links are wide-tracked small-caps, ivory → brass on hover.
- Footer has a centered fan divider, Playfair brass headings, and the year renders as the current year (not 2025).
- If you can log in locally, the chip pill shows the brass-framed chip icon + tabular value; otherwise verify the pill is absent when logged out.
  Stop the dev server.

- [ ] **Step 6: Commit**

```bash
git add src/layouts/AppLayout.astro
git commit -m "feat(ui): restyle header and footer in Art Deco language"
```

---

## Task 6: Restyle `UserNav`

**Files:**

- Modify (full replace): `src/components/UserNav.astro`

**Interfaces:**

- Consumes: `DecoIcon` (Task 2), `.deco-link` / `.deco-btn*` (Task 1).
- Produces: restyled user control. Same behavior and links (`/profile`, `/signin`).

- [ ] **Step 1: Replace the file contents**

Replace the entire contents of `src/components/UserNav.astro` with:

```astro
---
import DecoIcon from './DecoIcon.astro';

const user = Astro.locals.user;
---

<div class="flex items-center gap-4">
	{
		user ? (
			<div class="flex items-center gap-3">
				{user.image ? (
					<img
						src={user.image}
						alt={user.name}
						class="h-8 w-8 rounded-full"
						style="border: 1px solid var(--deco-brass)"
					/>
				) : (
					<span
						class="flex h-8 w-8 items-center justify-center rounded-full"
						style="border: 1px solid var(--deco-brass); color: var(--deco-brass)"
					>
						<DecoIcon name="user" size={16} />
					</span>
				)}
				<span class="font-body text-sm" style="color: var(--deco-ivory)">
					{user.name}
				</span>
				<a href="/profile" class="deco-link">
					Profile
				</a>
			</div>
		) : (
			<div class="flex items-center gap-3">
				<a href="/signin" class="deco-link">
					Sign In
				</a>
				<a href="/signin" class="deco-btn deco-btn-primary">
					Join Free
				</a>
			</div>
		)
	}
</div>
```

- [ ] **Step 2: Format, lint, and build**

Run:

```bash
bun run format && bun run lint && bun run build
```

Expected: all exit 0.

- [ ] **Step 3: Visual check**

Run `bun run dev`, open `http://localhost:2000`. Logged out: "Sign In" (deco link) + "Join Free" (brass button). Logged in: brass-framed avatar/fallback + ivory username + brass "Profile" link. No indigo/gray remnants. Stop the dev server.

- [ ] **Step 4: Commit**

```bash
git add src/components/UserNav.astro
git commit -m "feat(ui): restyle UserNav to Art Deco language"
```

---

## Task 7: Integration verification & Phase 2 seed

**Files:**

- Create: `docs/superpowers/specs/PHASE2-SEED.md` (short note) — optional; or append a note to the Phase 1 spec.

**Interfaces:** none (verification + handoff only).

- [ ] **Step 1: Full static gates**

Run:

```bash
bun run format:check && bun run lint && bun run build
```

Expected: all exit 0.

- [ ] **Step 2: Run the E2E suite**

Run:

```bash
bun run test:e2e
```

Expected: all existing Playwright specs pass. **Local caveat (from CLAUDE.md):** local E2E needs the auth bootstrap vars in `.dev.vars` (`APP_ENV=test`, `ENABLE_E2E_AUTH_BOOTSTRAP=true`, `E2E_AUTH_BOOTSTRAP_SECRET`). If those are not configured locally, the auth-dependent specs will fail to bootstrap — in that case, confirm the suite is green in CI instead, and rely on the visual checks from Tasks 5–6 locally. Any failure that is a _selector/structure_ regression (not an auth-bootstrap issue) must be fixed by restoring the missing hook.

- [ ] **Step 3: Confirm no emoji remain in chrome**

Run:

```bash
grep -nP "[\x{1F000}-\x{1FAFF}\x{2600}-\x{27BF}\x{1F1E6}-\x{1F1FF}]" src/layouts/AppLayout.astro src/components/UserNav.astro || echo "OK: no emoji in chrome"
```

Expected: `OK: no emoji in chrome`.

- [ ] **Step 4: Seed Phase 2**

Create `docs/superpowers/specs/PHASE2-SEED.md`:

```markdown
# Phase 2 seed — Marketing & Lobby

Apply the Art Deco design system (tokens + `.deco-*` classes + `DecoIcon`/`DecoDivider`/`Button` from Phase 1) to:

- `src/pages/index.astro` (homepage hero, featured/all games, CTA, "why choose us")
- `src/components/GameCard.astro` (replace giant emoji art + gold-gradient title)
- `src/pages/signin.astro`
- `src/pages/profile.astro`, `src/pages/missions/daily.astro`, `src/pages/games/leaderboard.astro`

At Phase 2, migrate the global `body` background to obsidian and apply `.deco-grain` globally; retire the legacy `--casino-*` tokens once no page references them.
```

- [ ] **Step 5: Commit**

```bash
git add -f docs/superpowers/specs/PHASE2-SEED.md
git commit -m "chore(ui): verify Phase 1 chrome revamp; seed Phase 2"
```

---

## Self-Review

**Spec coverage** (each Phase 1 spec section → task):

- §4 tokens → Task 1. §5 typography setup → Task 1 (install + imports + font-family). §6.1 Button → Task 4. §6.2 DecoDivider → Task 3. §6.3 DecoIcon → Task 2. §7.1 header → Task 5. §7.2 footer (+ dynamic year) → Task 5. §7.3 UserNav → Task 6. §8 change map → covered across Tasks 1–6. §9 edge cases: font fallbacks (Task 1 var fallbacks), logged-out chip pill (Task 5 conditional), tabular-nums (Task 5), reduced-motion (Task 1 media query), mobile nav hidden (`hidden md:flex` preserved in Task 5). §10 testing → Tasks 1–7 gates + Task 7 E2E. §11 risks → addressed (legacy tokens untouched, font fallbacks, weight-scoped imports, Button API additive/replacement). §12 DoD → Task 7.
- Gap check: spec §4.3 mentioned `--radius-sm/md`, `--border-brass`, `--border-hairline`, `--tracking-*`, `--grain-opacity` as illustrative tokens. The plan implements their _effect_ via concrete class values (radius `2px`, hairline borders, letter-spacing inline) rather than emitting unused custom properties — YAGNI. No behavior gap.

**Placeholder scan:** No "TBD"/"TODO"/"add error handling"/"similar to Task N". Every code step contains complete, runnable content.

**Type/name consistency:** `DecoIcon` prop `name` union (`chip|star|user|trophy|menu|calendar`) is consistent across definition (Task 2) and all call sites (Tasks 5, 6) — only `star`, `chip`, `user` are used, all valid members. `DecoDivider` `tone` (`brass|emerald`) consistent (Task 3 def; Task 5 uses default brass). `Button` `variant` (`primary|outline|ghost`) consistent (Task 4 def; consumed Phase 2). Class names (`.deco-header`, `.deco-grain`, `.deco-wordmark`, `.deco-rule`, `.deco-eyebrow`, `.deco-link`, `.deco-footer-link`, `.deco-heading`, `.deco-chip-pill`, `.deco-btn*`) are all defined in Task 1 and referenced verbatim in Tasks 4–6.
