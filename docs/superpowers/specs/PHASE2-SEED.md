# Phase 2 seed — Marketing & Lobby

Phase 1 (foundation & chrome) is complete: Art Deco design tokens + `.deco-*` classes live in `src/styles/global.css`, fonts (Playfair Display + Jost) load globally, and the shared chrome (`AppLayout` header/footer, `UserNav`) plus primitives (`Button`, `DecoIcon`, `DecoDivider`) are in the new language.

Phase 2 applies that system to the marketing and lobby surfaces:

- `src/pages/index.astro` — homepage hero, featured/all games, CTA banners, "why choose us". Replace the 🎰 emoji, gold-gradient text, and `from-yellow-*` buttons with the deco wordmark treatment, `Button` variants, `DecoDivider` section breaks, and brass/emerald panels.
- `src/components/GameCard.astro` — replace the giant emoji "art" and gold-gradient title; use `DecoIcon` (or per-game deco glyphs) and the deco panel/border treatment.
- `src/pages/signin.astro` — replace 🎰 + gold-gradient; deco panel, `Button`.
- `src/pages/profile.astro`, `src/pages/missions/daily.astro`, `src/pages/games/leaderboard.astro` — apply tokens, `deco-heading`, `Button`, `DecoDivider`.

At Phase 2, also:

- Migrate the global `body` background from the slate gradient to `--deco-obsidian` and apply `.deco-grain` globally (Phase 1 deliberately limited the only global change to fonts).
- Once no page references them, retire the legacy `--casino-*` / `--glow-*` tokens and the `.btn-gold` / gold-gradient utility patterns (game-table classes like `.felt-table`, `.playing-card`, `.poker-chip` stay until Phase 3).

Preserve E2E hooks throughout: `getByRole('link', { name: /Join Free/i })` must keep `href="/signin"`; `nav a` "Leaderboard" stays; homepage CTA copy substring "Join Free" is matched by `e2e/auth-ui.spec.ts`.
