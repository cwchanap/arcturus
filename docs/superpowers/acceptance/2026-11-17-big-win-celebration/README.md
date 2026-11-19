# HPA-729 — browser-MCP acceptance record (big-win celebration)

**Date:** 2026-11-17 · **Spec:** [design](../../specs/2026-11-17-big-win-celebration-design.md) · **Game used for E2E:** Keno (`/games/keno`, guest session)

Browser MCP (chrome-devtools) is the end-to-end acceptance owner per the design; the Playwright spec `e2e/big-win-celebration.spec.ts` (8/8 passing) provides the numeric four-locale × two-viewport geometry regression and complements — not replaces — this record.

## Environment

- Server: `chrome-devtools-mcp@latest` (same server configured in `~/.pi/agent/mcp-adapter.json`), driven over stdio JSON-RPC.
- Browser flags: `--headless --isolated --executablePath=<playwright chromium-1254> --viewport=1280x800`.
- App: `bun run dev` (Astro + Cloudflare Workers dev server, `http://localhost:2000`), local D1 migrations applied, gitignored `.dev.vars` with local-only `APP_ENV=test` / `ENABLE_E2E_AUTH_BOOTSTRAP` / secrets.
- No debug route, no `window.__celebrate` global, no RNG rigging: celebrations were triggered through the production module via the browser's `import('/src/lib/celebration/index.ts')` on the running Vite dev server.

## 1. Real guest round through the UI

Tool calls (chrome-devtools MCP): `list_pages` → `navigate_page(/games/keno)` → `evaluate_script` clicks (three `.keno-cell` buttons 1/2/3, `.bet-chip[data-bet="5"]`, `#btn-draw`) → `wait_for(["won","lost","pushed"])` → `evaluate_script` reads result → `take_screenshot`.

Measured evidence returned by the page:

- `spotCount: "3/10"`, `currentBet: "5 chips"`, draw button enabled after picks;
- result: `lastResult: "0 of 3 lost 5 chips"`, `status: "Round complete"`, balance 1000 → 995 chips;
- screenshot: [`desktop-guest-round.png`](./desktop-guest-round.png) — round completes and renders normally with the celebration module wired into the game.

## 2. Fixed-tier celebrations (dev-module import, no rigging)

`evaluate_script`: `async () => { const fx = await import('/src/lib/celebration/index.ts'); fx.celebrateWin({ win: 60, stake: 10 }); }` (6× stake → **big**) and `{ win: 200, stake: 10 }` (20× → **huge**).

| Screenshot | Viewport | Tier | Visual finding |
| --- | --- | --- | --- |
| [desktop-big.png](./desktop-big.png) | 1280×800 | big | gold/red/blue chips + sparkles burst from center, alpha painted, rotation/mirrored chips visible; no ribbon (correct); game UI readable around it |
| [desktop-huge.png](./desktop-huge.png) | 1280×800 | huge | Art Deco ribbon centered; brass `Big Win` + ivory `200 chips` both inside the dark text-safe band, no clipping; strong contrast |
| [desktop-huge-ja.png](./desktop-huge-ja.png) | 1280×800 | huge, `arcturus_locale=ja` | fully localized page (`lang="ja"`); ribbon title `大勝利`, amount `200 チップ` inside the band |
| [phone-big.png](./phone-big.png) | 375×812 | big | burst stays inside the viewport (`overflow: hidden` overlay); no page overflow; controls unaffected |
| [phone-huge.png](./phone-huge.png) | 375×812 | huge | ribbon scales to `max-width: 92vw`; title/count still inside the scaled safe band; board intact below |

Lifecycle evidence (same session): after teardown `overlayChildCount: 0` (~1.9 s after trigger, 1.6 s timer) — nodes removed, no residue over the guest-round screenshot.

## 3. Reduced motion (`emulate(prefersReducedMotion: "reduce")`)

| Screenshot | Viewport | Tier | Measured / visual |
| --- | --- | --- | --- |
| [phone-big-reduced.png](./phone-big-reduced.png) | 375×812 | big | `imgCount: 0`, overlay children: 1 static badge; static `60 chips` pill, no motion, legible over the board |
| [phone-huge-reduced.png](./phone-huge-reduced.png) | 375×812 | huge | `imgCount: 1` (ribbon art only, no particles), `title: "Big Win"`, static `amountText: "200 chips"` |
| [desktop-big-reduced.png](./desktop-big-reduced.png) | 1280×800 | big | static badge only |
| [desktop-huge-reduced.png](./desktop-huge-reduced.png) | 1280×800 | huge | static ribbon/title/amount, no particles |

## 4. Console and compatibility

`list_console_messages` after all triggers: only `[vite] connecting/connected` debug lines and one pre-existing, unrelated form-field a11y hint. No errors or warnings from the celebration module; audio rejection paths stayed silent (headless autoplay).

## Visual acceptance summary

- Chips/sparkles paint with correct alpha and Art Deco palette; consistent with the site's dark-green/gold theme.
- Ribbon (shipped HPA-728 asset) with HTML `Big Win` title and animated net count; localized copy spot-checked for `en` and `ja` (numeric coverage for all four locales in the Playwright spec).
- No mobile overflow; overlay is `pointer-events: none` and `aria-hidden` (asserted in the Playwright spec), game controls and result text remain visible and usable.
- Reduced motion shows static localized amounts / static ribbon without particles while still timing out.

## Related gates (same branch)

- `bun run test`: 3149 pass / 0 fail
- `bun run lint`: 0 warnings · `bun run format:check`: clean
- `bunx astro check`: 0 errors / 0 warnings
- `bun run build`: Complete
- `bunx playwright test e2e/big-win-celebration.spec.ts`: 8 passed (en/zh-Hant/zh-Hans/ja × desktop/phone)
