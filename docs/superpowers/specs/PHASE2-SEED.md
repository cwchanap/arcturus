# Phase 2+3 — Marketing, Lobby & Game Tables (shipped on `ui-revamp-art-deco`)

> **Scope note (reconciliation):** The original Phase 1 plan
> (`docs/superpowers/plans/2026-06-29-ui-revamp-art-deco-phase1.md`) marked the
> global `body` background migration and the legacy class restyles as Phase 2/3
> non-goals for the Phase 1 branch. In practice the `ui-revamp-art-deco` branch
> carried Phase 1 + 2 + 3 together. This document reflects what actually shipped
> and supersedes the forward-looking statements in the prior seed.

Phase 1 (foundation & chrome) shipped: Art Deco design tokens + `.deco-*` classes
live in `src/styles/global.css`, fonts (Playfair Display + Jost) load globally,
and the shared chrome (`AppLayout` header/footer, `UserNav`) plus primitives
(`Button`, `DecoIcon`, `DecoDivider`) are in the new language.

Phase 2 (marketing & lobby) shipped in the same branch:

- `src/pages/index.astro` — homepage hero, featured/all games, CTA banners,
  "why choose us". The 🎰 emoji, gold-gradient text, and `from-yellow-*` buttons
  were replaced with the deco wordmark treatment, `Button` variants,
  `DecoDivider` section breaks, and brass/emerald panels.
- `src/components/GameCard.astro` — replaced the giant emoji "art" and
  gold-gradient title; uses `GameEmblem`/`DecoIcon` and the deco panel/border
  treatment (`deco-card`).
- `src/pages/signin.astro` — deco panel, `Button`.
- `src/pages/profile.astro`, `src/pages/missions/daily.astro`,
  `src/pages/games/leaderboard.astro` — tokens, `deco-heading`, `Button`,
  `DecoDivider` applied.

Phase 3 (game tables) shipped in the same branch:

- `src/pages/games/poker.astro`, `blackjack.astro`, `baccarat.astro` — obsidian
  body, Playfair brass titles, deco HUD, card backs, felt, chips, buttons.
- Legacy game-table classes `.felt-table`, `.playing-card`, `.poker-chip`,
  `.btn-gold` were **restyled in place** to the deco language (brass/obsidian)
  rather than retired, because the game pages still reference them. They remain
  the canonical classes for in-game surfaces.

Global changes that landed with this branch:

- The global `body` background was migrated to `--deco-obsidian`
  (`src/styles/global.css`). This was originally a Phase 2 task; it shipped with
  the branch. The original Phase 1 plan line forbidding it is superseded.
- `.deco-grain` is available; opt-in per surface (not applied globally).
- Legacy `--casino-*` / `--glow-*` tokens are retained where still referenced
  (e.g. `.game-card` rule was removed as dead CSS; `.felt-table`/`.btn-gold`
  keep using `--felt-*`/`--deco-*` tokens). Retire the remaining legacy tokens
  only when no rule references them.

E2E hooks preserved throughout: `getByRole('link', { name: /Join Free/i })` keeps
`href="/signin"`; nav `a` "Leaderboard" stays; homepage CTA copy substring
"Join Free" is matched by `e2e/auth-ui.spec.ts`; all `data-testid` hooks and
`data-chip-balance` are intact.

## Component contract notes

- **`Button.astro`** ships as an anchor-only primitive (`href` required, no
  `<button>` branch). This is an intentional YAGNI narrowing, not drift: all 7
  call sites (`src/pages/index.astro`) pass `href`. If a real `<button>` is
  needed later, reintroduce the discriminated union per the inline comment in
  `src/components/Button.astro` — don't add a dead branch speculatively.
