# Arcturus i18n Localization Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add complete English, Traditional Chinese, Simplified Chinese, and Japanese localization to the current Arcturus player experience without changing URLs, persisting translated domain data, or introducing a runtime i18n framework.

**Architecture:** Resolve one enabled locale per request in Astro middleware and expose it once on the root `<html>` element. Use a small typed TypeScript translation layer under `src/lib/i18n/`, one shared game-name catalog, and feature-local dictionaries for static and dynamic presentation. Browser renderers read the document locale; domain/game/protocol values remain language-neutral and player-facing strings are produced only at presentation boundaries.

**Tech Stack:** Astro 5, TypeScript, Bun test, Vitest, Playwright, Cloudflare Workers/D1. No new runtime i18n dependency.

**Spec:** `docs/superpowers/specs/2026-08-30-i18n-localization-design.md`

## Global Constraints

- Supported locales are exactly `en`, `zh-Hant`, `zh-Hans`, and `ja`.
- `SUPPORTED_LOCALES = ['en', 'zh-Hant', 'zh-Hans', 'ja']` from Task 1 onward.
- `ENABLED_LOCALES = ['en']` through Tasks 1–7; Task 8 enables all four together.
- Disabled locales must not be selected by picker, cookie, or `Accept-Language` in production request resolution.
- Eight rollout tickets map to eight implementation PRs, merged sequentially. One ticket must not be split across multiple PRs without explicit approval.
- Every feature PR authors all four translations for the surface it migrates even while production remains English-only.
- English is the authoring locale. Every migrated dictionary must have matching keys across all four locales before merge.
- Use complete sentence templates with named interpolation; do not assemble English-shaped fragments.
- Keep game, mission, achievement, multiplayer protocol, and persistence identifiers language-neutral.
- Do not create locale routes, locale DB columns, a CMS, ICU parsing, i18next/FormatJS, an environment locale flag, or a feature-flag service.
- Do not add bundled CJK fonts unless visual verification demonstrates a material problem.
- Reuse `src/lib/formatting.ts`, the existing settlement messages seam, and existing game renderers/clients. Do not refactor game engines unrelated to presentation.
- Locale is written once on `<html>`; do not add a locale attribute independently to each game root.
- Game display names have one translation source; feature dictionaries must not duplicate them.
- For every translation PR, temporarily set local `ENABLED_LOCALES` to all four, visually inspect only the migrated surfaces in all four locales, then revert the constant before committing/merging.

---

## Task 1 / PR 1: i18n Foundation, Shared Game Names, and Global Shell

**Purpose:** Establish the shared primitives and reuse seams that every later migration depends on while production remains English-only.

**Files:**
- Create: `src/lib/i18n/locale.ts`
- Create: `src/lib/i18n/locale.test.ts`
- Create: `src/lib/i18n/translate.ts`
- Create: `src/lib/i18n/translate.test.ts`
- Create: `src/lib/i18n/messages/common.ts`
- Create: `src/lib/i18n/messages/games.ts`
- Create: `src/components/LanguagePicker.astro`
- Create: `e2e/i18n-foundation.spec.ts`
- Modify: `src/env.d.ts`
- Modify: `src/middleware.ts`
- Modify: `src/layouts/AppLayout.astro`
- Modify: `src/components/UserNav.astro`
- Modify: `src/lib/game-stats/constants.ts`
- Modify: `src/lib/formatting.ts`
- Modify: `src/lib/formatting.test.ts`
- Modify: `src/lib/wallet/public-game-settlement.ts`
- Modify: `src/lib/wallet/public-game-settlement.test.ts`

**Interfaces:**
- Produces: `Locale`, `SUPPORTED_LOCALES`, `ENABLED_LOCALES`, `LOCALE_COOKIE`.
- Produces: `normalizeLocaleTag(tag): Locale | null`.
- Produces: `resolveRequestLocale({ cookieLocale, acceptLanguage, enabledLocales? }): Locale`.
- Produces: `getDocumentLocale(doc?: Document): Locale`.
- Produces: `defineMessages()` and `createTranslator()`.
- Produces: shared game-name lookup for all `GAME_TYPES` plus `daily-challenge`, `poker-mp`, and `blackjack-ranked`.
- Extends: locale-sensitive helpers in `src/lib/formatting.ts` with `locale: Locale = 'en'`.
- Extends: `PublicGameSettlementMessages` with `retryLabel`.

- [ ] **Step 1: Write failing locale-resolution tests**

Create `src/lib/i18n/locale.test.ts` with the exact contract:

```ts
expect(normalizeLocaleTag('zh-TW')).toBe('zh-Hant');
expect(normalizeLocaleTag('zh-CN')).toBe('zh-Hans');
expect(normalizeLocaleTag('zh')).toBe('zh-Hans');
expect(normalizeLocaleTag('ja-JP')).toBe('ja');
expect(normalizeLocaleTag('fr-CA')).toBeNull();

expect(resolveRequestLocale({
  cookieLocale: 'ja',
  acceptLanguage: 'zh-TW,zh;q=0.9,en;q=0.8',
  enabledLocales: ['en'],
})).toBe('en');

expect(resolveRequestLocale({
  cookieLocale: 'ja',
  acceptLanguage: 'en-US,en;q=0.9',
  enabledLocales: ['en', 'ja'],
})).toBe('ja');

expect(resolveRequestLocale({
  cookieLocale: null,
  acceptLanguage: 'fr-CA,zh-TW;q=0.8,ja;q=0.7',
  enabledLocales: ['en', 'zh-Hant', 'ja'],
})).toBe('zh-Hant');
```

Also assert cookie precedence over `Accept-Language`, malformed/disabled cookie skipping, q-value ordering, and English fallback when no recognized enabled match exists.

Run:

```bash
bun test src/lib/i18n/locale.test.ts
```

Expected: FAIL because the module does not exist.

- [ ] **Step 2: Implement the minimal locale module and document handoff helper**

Implement only:

```ts
export const SUPPORTED_LOCALES = ['en', 'zh-Hant', 'zh-Hans', 'ja'] as const;
export type Locale = (typeof SUPPORTED_LOCALES)[number];
export const ENABLED_LOCALES: readonly Locale[] = ['en'];
export const LOCALE_COOKIE = 'arcturus_locale';

export function normalizeLocaleTag(tag: string | null | undefined): Locale | null;
export function resolveRequestLocale(input: {
  cookieLocale: string | null | undefined;
  acceptLanguage: string | null | undefined;
  enabledLocales?: readonly Locale[];
}): Locale;
export function getDocumentLocale(doc?: Document): Locale;
```

`getDocumentLocale()` reads `document.documentElement.dataset.locale ?? document.documentElement.lang`, normalizes it, and returns `en` only when the document value is absent/malformed.

Keep `Accept-Language` parsing local: split ranges, parse optional `q`, sort descending, normalize each tag, select the first enabled match. Add no parser dependency.

Run the locale test. Expected: PASS.

- [ ] **Step 3: Write failing translator tests**

Create `src/lib/i18n/translate.test.ts` proving key parity, English development fallback, and named interpolation:

```ts
const messages = defineMessages({
  en: { greeting: 'Hello {name}', repeat: '{value} / {value}' },
  'zh-Hant': { greeting: '你好，{name}', repeat: '{value} / {value}' },
  'zh-Hans': { greeting: '你好，{name}', repeat: '{value} / {value}' },
  ja: { greeting: 'こんにちは、{name}', repeat: '{value} / {value}' },
});

expect(createTranslator('ja', messages)('greeting', { name: 'Aki' }))
  .toBe('こんにちは、Aki');
expect(createTranslator('en', messages)('repeat', { value: 3 }))
  .toBe('3 / 3');
```

Missing interpolation values must leave the unresolved token visible rather than throw; this makes incomplete development copy obvious without breaking gameplay.

Run:

```bash
bun test src/lib/i18n/translate.test.ts
```

Expected: FAIL before implementation, then PASS after adding only `defineMessages()` and `createTranslator()` in `translate.ts`. Do not add nested paths, ICU syntax, namespaces, or a singleton registry.

- [ ] **Step 4: Create one canonical game-name dictionary**

In `src/lib/i18n/messages/games.ts`, reuse `GAME_TYPE_LABELS` as the English branch and add the three lobby-only keys. The intended shape is:

```ts
export type GameNameKey =
  | keyof typeof GAME_TYPE_LABELS
  | 'daily-challenge'
  | 'poker-mp'
  | 'blackjack-ranked';

export function getGameName(locale: Locale, key: GameNameKey): string;
```

Change `GAME_TYPE_LABELS.poker` in `src/lib/game-stats/constants.ts` to the one canonical English label `Texas Hold'em Poker`. Use these English extras:

```ts
'daily-challenge': 'Daily Challenge'
'poker-mp': 'Multiplayer Poker'
'blackjack-ranked': 'Ranked Blackjack'
```

Add a test that every `GAME_TYPES` key plus the extras resolves in all four locales. Home/leaderboard/profile/game modules later call this lookup instead of adding their own translation of `Blackjack`, `Roulette`, etc.

- [ ] **Step 5: Extend existing formatting helpers with locale**

Update `src/lib/formatting.ts` instead of adding another formatter. Preserve current validation semantics and add `locale: Locale = 'en'` to locale-sensitive functions such as:

```ts
formatChipBalance(value: number, locale: Locale = 'en'): string
formatWholeNumber(value: number, locale: Locale = 'en'): string
formatPercentage(value: number, locale: Locale = 'en'): string
formatChipBalanceWithDecimals(
  value: number,
  minimumFractionDigits?: number,
  maximumFractionDigits?: number,
  locale?: Locale,
): string
```

Keep numeric formatting separate from translated nouns. Do not turn `formatSignedChipResult()` into an i18n helper; Task 2 removes/replaces that English presentation helper.

Add assertions for `en`, `zh-Hant`, and `ja` in `src/lib/formatting.test.ts`.

Run:

```bash
bun test src/lib/formatting.test.ts
```

- [ ] **Step 6: Wire locale into middleware before every early return**

At the top of `onRequest` in `src/middleware.ts`, before checking DB/auth bindings:

```ts
context.locals.locale = resolveRequestLocale({
  cookieLocale: context.cookies.get(LOCALE_COOKIE)?.value,
  acceptLanguage: context.request.headers.get('accept-language'),
});
```

Add `locale: Locale` to `App.Locals` in `src/env.d.ts`. The no-DB path must still receive locale before `next()`.

- [ ] **Step 7: Put locale on `<html>` once and migrate the shared shell**

Update `src/layouts/AppLayout.astro` to:

```astro
<html lang={locale} data-locale={locale}>
```

Translate the current header/footer/nav/legal/chip phrases using `messages/common.ts`; keep `ARCTURUS` as the brand. Format chip numbers with `formatChipBalance(balance, locale)` and a complete translated chip-count template.

Update `src/components/UserNav.astro` to localize `Profile`, `Sign In`, and `Join Free` from `Astro.locals.locale`.

Do not add locale props/data attributes to child game roots.

- [ ] **Step 8: Add the language picker without a locale endpoint**

`LanguagePicker.astro` renders only `ENABLED_LOCALES`. Once multiple locales are enabled, selecting one writes:

```text
arcturus_locale=<locale>; Max-Age=31536000; Path=/; SameSite=Lax
```

then reloads `window.location.href`. Use native labels `English`, `繁體中文`, `简体中文`, `日本語`. With `ENABLED_LOCALES = ['en']`, hide the control rather than render a useless one-option selector.

- [ ] **Step 9: Extend the shared settlement message seam**

Change:

```ts
export type PublicGameSettlementMessages = {
  failed: string;
  retrying: string;
  retryFailed: string;
  retryLabel: string;
};
```

and pass `options.messages.retryLabel` into `ensureSettlementRecoveryControls()` instead of the hard-coded `Retry settlement` in `public-game-settlement.ts`.

Update existing public-game settlement call sites/tests mechanically to continue supplying the current English `Retry settlement` until their owning game PR migrates them. Do not translate those games in Task 1.

Also change shared balance synchronization to read `getDocumentLocale(root.ownerDocument)` and use locale-aware numeric formatting plus `common` chip-count copy rather than `toLocaleString('en-US')` / `${formatted} chips`.

Run:

```bash
bun test src/lib/wallet/public-game-settlement.test.ts
```

- [ ] **Step 10: Add the production rollout-guard E2E**

`e2e/i18n-foundation.spec.ts` sets a Japanese cookie and a Japanese `Accept-Language` while only English is enabled and verifies:

```ts
await expect(page.locator('html')).toHaveAttribute('lang', 'en');
await expect(page.locator('html')).toHaveAttribute('data-locale', 'en');
```

It also asserts global shell copy remains English and disabled language options are not present.

Run:

```bash
bunx playwright test e2e/i18n-foundation.spec.ts
```

- [ ] **Step 11: Perform the local four-locale visual check and revert activation**

Temporarily change local `ENABLED_LOCALES` to all four. Inspect `/` plus one authenticated shell page at desktop and narrow mobile widths for nav/footer wrapping and CJK font fallback. Restore `ENABLED_LOCALES = ['en']` before staging files.

- [ ] **Step 12: Verify and commit PR 1**

Run:

```bash
bun run test
bun run lint
bun run format:check
bun run build
bunx playwright test e2e/i18n-foundation.spec.ts
```

Suggested commits:

```text
test: define locale and translation contracts
feat: add typed i18n foundation and game names
feat: localize shared shell seams
```

---

## Task 2 / PR 2: Home, Auth, Profile, Statistics, and Achievements

**Purpose:** Migrate account/discovery presentation and remove English achievement names from settlement/domain data.

**Files:**
- Create: `src/lib/i18n/messages/home.ts`
- Create: `src/lib/i18n/messages/auth.ts`
- Create: `src/lib/i18n/messages/profile.ts`
- Create: `src/lib/i18n/messages/achievements.ts`
- Modify: `src/pages/index.astro`
- Modify: `src/components/GameCard.astro`
- Modify: `src/pages/signin.astro`
- Modify: `src/pages/profile.astro`
- Modify: `src/pages/profile/statistics.astro`
- Modify: `src/components/profile/PlayerStatisticsSummary.astro`
- Modify: `src/lib/profile-statistics-renderer.ts`
- Modify: `src/lib/profile-statistics-renderer.test.ts`
- Modify: `src/lib/profile-statistics-client.ts`
- Modify: `src/lib/profile-statistics-client.test.ts`
- Modify: `src/lib/achievements/types.ts`
- Modify: `src/lib/achievements/achievement-rules.ts`
- Modify: `src/lib/achievements/achievement-rules.test.ts`
- Modify: `src/lib/achievements/achievements.ts`
- Modify: `src/lib/achievements/achievements.test.ts`
- Modify: `src/lib/wallet/types.ts`
- Modify: `src/lib/wallet/settle.ts`
- Modify: `src/lib/wallet/settle.test.ts`
- Modify: `src/lib/achievement-toast.ts`
- Modify: `src/lib/achievement-toast.test.ts`
- Modify: `src/lib/formatting.ts`
- Modify: `src/lib/formatting.test.ts`
- Test: `integration/profile-page.test.ts`
- Test: `e2e/auth-ui.spec.ts`
- Test: `e2e/profile.spec.ts`
- Test: `e2e/profile-statistics.spec.ts`

**Interfaces:**
- Consumes: Task 1 `getDocumentLocale()`, translator, formatting helpers, and `getGameName()`.
- Produces: achievement presentation lookup keyed by `AchievementId`.
- Changes: settlement `newAchievements` payload/queue entries from `{ id, name, icon }` to `{ id, icon }`.

- [ ] **Step 1: Write failing achievement presentation tests**

For every `ACHIEVEMENT_IDS` member, assert all four locales resolve `name` and `description`. Include the threshold formatting case for `comeback` so the number is formatted with the requested locale.

Keep unlock-rule assertions independent of locale.

- [ ] **Step 2: Remove player copy from achievement domain definitions**

Change the domain shape to:

```ts
export interface AchievementDefinition {
  id: AchievementId;
  category: AchievementCategory;
  icon: string;
}
```

Remove `name` and `description` from `ACHIEVEMENTS`. Preserve IDs, categories, icons, thresholds, and grant checks exactly. Change internal logs to use `achievement.id`.

Update `AchievementWithStatus` and its tests to reflect the language-neutral definition.

- [ ] **Step 3: Remove English achievement names from wallet settlement**

Change `SettleRoundResult.newAchievements` in `src/lib/wallet/types.ts` to:

```ts
newAchievements?: Array<{ id: string; icon: string }>;
```

Update `src/lib/wallet/settle.ts` so `buildFreshResult()` maps only `id` and `icon`. Update duplicate/fresh settlement tests to assert the new payload.

No API or DB row stores a translated achievement name.

- [ ] **Step 4: Resolve toast names from achievement IDs at display time**

Change `AchievementToastEntry` to `{ id, icon }`. `initAchievementToast()` obtains the active locale from `getDocumentLocale()` and resolves the visible name from `messages/achievements.ts` when the toast is shown.

Preserve queue timing/disposal behavior. Update `achievement-toast.test.ts` to set `document.documentElement.dataset.locale = 'ja'` and assert a Japanese name while the queued entry carries only the ID/icon.

- [ ] **Step 5: Migrate home and `GameCard` using the shared game-name source**

Replace the `name` strings in `src/pages/index.astro` with stable game-name keys. `GameCard.astro` receives/resolves a translated game name via `getGameName()` and localizes `Featured`, `{count} playing`, `Min {value}`, and `Play`. Replace its `Intl.NumberFormat('en-US')` with `formatWholeNumber(players, locale)`.

Do not create another home-specific translation for `Blackjack`, `Roulette`, `Texas Hold'em Poker`, etc.

- [ ] **Step 6: Migrate sign-in/profile Astro copy**

Translate page titles/headings, auth calls to action, verification states, account labels, tips, AI settings labels/status, accessible fallback labels, loading/error shells, and statistics headings.

Keep provider/model identifiers (`OpenAI`, `Gemini`, `GPT-4o`, etc.) unchanged.

- [ ] **Step 7: Localize the actual profile-statistics renderer**

In `src/lib/profile-statistics-renderer.ts`, call `getDocumentLocale(root.ownerDocument)` and translate:

- `No games played yet`;
- summary labels (`Total Hands`, `Most Played`, `Overall Win Rate`, `Net Profit`);
- per-game played/not-played state;
- metric labels (`Hands Played`, `Wins`, `Losses`, `Biggest Win`, ranks);
- `Unranked`;
- leaderboard/play action text.

Use `getGameName(locale, gameType)` instead of `GAME_TYPE_LABELS` and pass `locale` to numeric formatters.

Remove `formatSignedChipResult()` once all its call sites in this surface are replaced by a neutral signed-number formatter plus a complete translated chip-result template.

`profile-statistics-client.ts` keeps its fetch/control flow unchanged; update only any player-facing state it owns and its tests.

- [ ] **Step 8: Stabilize localization-sensitive tests**

Change English text locators to existing/new `data-testid` selectors only where text is not itself the behavior. Keep English assertions for English default rendering.

Run:

```bash
bun test src/lib/achievements src/lib/achievement-toast.test.ts src/lib/profile-statistics-renderer.test.ts src/lib/profile-statistics-client.test.ts
bunx vitest run integration/profile-page.test.ts
bunx playwright test e2e/auth-ui.spec.ts e2e/profile.spec.ts e2e/profile-statistics.spec.ts
```

- [ ] **Step 9: Perform the local four-locale visual check**

Temporarily enable all four locales and inspect `/`, `/signin`, `/profile`, and `/profile/statistics`. Check long Japanese/Chinese labels, game-card badges/buttons, profile forms, statistics cards, and toast width. Revert activation before staging.

- [ ] **Step 10: Verify and commit PR 2**

Run:

```bash
bun run test
bun run lint
bun run format:check
bun run build
```

Suggested commits:

```text
refactor: make achievement settlement locale-neutral
feat: localize home auth profile and statistics
```

---

## Task 3 / PR 3: Missions, Leaderboard, and Daily Challenge

**Purpose:** Keep progression/ranking APIs language-neutral while localizing their SSR and browser-rendered presentation.

**Files:**
- Create: `src/lib/i18n/messages/missions.ts`
- Create: `src/lib/i18n/messages/leaderboard.ts`
- Create: `src/lib/i18n/messages/daily-challenge.ts`
- Modify: `src/lib/missions/types.ts`
- Modify: `src/lib/missions/registry.ts`
- Modify: `src/lib/missions/registry.test.ts`
- Modify: `src/lib/missions/board.ts`
- Modify: `src/lib/missions/board.test.ts`
- Modify: `src/pages/missions/index.astro`
- Modify: `src/pages/games/leaderboard.astro`
- Modify: `src/pages/games/daily-challenge.astro`
- Modify: `src/lib/blackjack-run/daily-ui.ts`
- Modify: `src/lib/blackjack-run/daily-ui.test.ts`
- Test: `e2e/missions.spec.ts`
- Test: `e2e/leaderboard.spec.ts`
- Test: `e2e/daily-challenge.spec.ts`

**Interfaces:**
- Consumes: Task 1 document locale, shared game names, translator, and formatting.
- Changes: `MissionDefinition`/`MissionView` no longer carry English `title`/`description`.
- Produces: mission display lookup by `missionDefId`.

- [ ] **Step 1: Pin the language-neutral mission types with failing tests**

Change expected `MissionDefinition` to contain only:

```ts
id, period, metric, target, rewardChips, icon
```

and expected `MissionView` to contain `missionDefId`, progress/domain values, and icon but no `title`/`description`.

Update `buildMissionView()` tests first and run:

```bash
bun test src/lib/missions/board.test.ts src/lib/missions/registry.test.ts
```

Expected: FAIL before domain changes.

- [ ] **Step 2: Remove English text from registry and board/API projection**

Delete `title`/`description` from the mission registry objects and from `buildMissionView()`. Do not alter mission IDs, metrics, target values, rewards, reroll selection, claims, streaks, or DB queries.

The `/api/missions/board` response remains the same except that presentation text is absent.

- [ ] **Step 3: Add four-language mission presentation keyed by mission ID**

`messages/missions.ts` contains title plus complete description template for every current mission ID:

```text
daily-blackjack-5
daily-win-3
daily-slots-20
daily-craps-3
daily-baccarat-3
daily-keno-5
weekly-games-3
```

Descriptions use stable domain values and shared game names; they do not duplicate game translations.

- [ ] **Step 4: Update initial and refreshed mission rendering**

`src/pages/missions/index.astro` resolves copy from `missionDefId` both in initial SSR and in the browser path that re-renders `/api/missions/board` responses. Do not expect title/description from the API after this PR.

Translate streak labels, claim/reroll controls, reset labels, completion state, and errors shown to the player.

- [ ] **Step 5: Localize leaderboard using shared game names**

Translate overall/game/metric controls, headings, rank labels, empty/error states, row annotations, and accessible labels. Use `getGameName()` for game names rather than defining another game-name branch in `leaderboard.ts`.

Pass locale into number/percentage/chip formatting.

- [ ] **Step 6: Localize Daily Challenge SSR and `daily-ui.ts`**

Translate challenge intro/rules, status, countdown, result summary, rank labels, actions, loading/error/retry text, and the existing header chip synchronization.

`daily-ui.ts` obtains locale through `getDocumentLocale(root.ownerDocument)`; do not add a `data-locale` attribute to the daily-challenge root.

Replace its hard-coded `toLocaleString('en-US')` with shared formatting.

- [ ] **Step 7: Run targeted tests and E2E**

Add one non-English unit assertion for each of mission rendering, leaderboard presentation, and a dynamic Daily Challenge state.

Run:

```bash
bun test src/lib/missions src/lib/blackjack-run/daily-ui.test.ts
bunx playwright test e2e/missions.spec.ts e2e/leaderboard.spec.ts e2e/daily-challenge.spec.ts
```

- [ ] **Step 8: Perform the local four-locale visual check**

Temporarily enable all locales and inspect `/missions`, `/games/leaderboard`, and `/games/daily-challenge` at desktop/mobile widths. Pay special attention to tabs, tables, countdown/status pills, and mission cards. Revert activation.

- [ ] **Step 9: Verify and commit PR 3**

```bash
bun run test
bun run lint
bun run format:check
bun run build
```

Suggested commits:

```text
refactor: make mission board presentation-neutral
feat: localize missions leaderboard and daily challenge
```

---

## Task 4 / PR 4: Blackjack and Ranked Blackjack

**Purpose:** Localize casual/ranked Blackjack as one coherent game family without bundling unrelated games into the review.

**Files:**
- Create: `src/lib/i18n/messages/blackjack.ts`
- Modify: `src/pages/games/blackjack.astro`
- Modify: `src/pages/games/blackjack/ranked.astro`
- Modify: `src/lib/blackjack/blackjackClient.ts`
- Modify: `src/lib/blackjack/blackjackClient.init.test.ts`
- Modify: `src/lib/blackjack/blackjackClient.test.ts`
- Modify: `src/lib/blackjack/llmBlackjackStrategy.ts`
- Modify: `src/lib/blackjack/llmBlackjackStrategy.test.ts`
- Modify: `src/lib/blackjack/presentation.ts`
- Modify: `src/lib/blackjack/presentation.test.ts`
- Modify: `src/lib/blackjack-run/client.ts` only for player-facing ranked/common client copy it owns
- Modify: `src/lib/blackjack-run/ranked-ui.ts`
- Modify: `src/lib/blackjack-run/ranked-ui.test.ts`
- Test: `e2e/blackjack-settings.spec.ts`
- Test: `e2e/blackjack-split.spec.ts`
- Test: `e2e/blackjack-llm.spec.ts`
- Test: `e2e/ranked-blackjack.spec.ts`

**Interfaces:**
- Consumes: Task 1 `getDocumentLocale()`, formatting, translator, game names.
- Keeps: Blackjack action/domain enums unchanged.
- Changes: deterministic/LLM advice presentation accepts the active locale without changing the authoritative move.

- [ ] **Step 1: Add failing Blackjack message tests**

Define message keys for casual/ranked page headings, wager controls, dealer/player labels, actions, outcomes, split-hand summaries, settlement recovery, settings, AI advisor, ranked countdown/status/result labels, and accessibility text.

Test a Japanese single-hand outcome and a Traditional Chinese split-hand summary with interpolation.

- [ ] **Step 2: Localize casual Blackjack SSR markup**

Replace the current static English in `blackjack.astro`, including page title, `Back to Games`, casual/ranked/daily links, dealer/player labels, betting/actions/settings/rules/payouts, achievement chrome, titles, and ARIA labels.

Use `getGameName()` for Blackjack/Daily Challenge rather than retranslating the game names.

- [ ] **Step 3: Localize `blackjackClient.ts` dynamic messages**

Read locale from `getDocumentLocale(root.ownerDocument)` once during initialization and translate:

- outcome messages;
- `Hand {n}`/overall split summaries;
- settlement failed/retrying/reset states;
- retry/reset labels passed into recovery controls;
- balance/current-bet text;
- settings feedback;
- AI advisor button/status/failure copy.

Do not change settlement/game-state semantics.

- [ ] **Step 4: Localize deterministic and optional-provider advice**

Add locale to the presentation-facing advice call:

```ts
getBlackjackStrategyAdvice(context, locale)
getBlackjackAdvice(context, settings, locale)
```

Keep `recommendedAction` as the existing enum. Local deterministic reasoning comes from `blackjack.ts`. When an AI provider is configured, the prompt explicitly requests the active language and still instructs the provider not to change the selected move.

Update unit tests so action/confidence remain identical across locales while reasoning changes language.

- [ ] **Step 5: Localize ranked Blackjack renderer and formatting**

`ranked-ui.ts` reads document locale and replaces:

```ts
new Intl.NumberFormat('en-US')
nextBalance.toLocaleString('en-US')
`${formatted} chips`
```

with shared formatting/common chip-count copy. Translate ranked status/countdown/result/action/error copy using `blackjack.ts`.

Keep protocol/public run state values unchanged.

- [ ] **Step 6: Run the full Blackjack-family verification**

```bash
bun test src/lib/blackjack src/lib/blackjack-run/ranked-ui.test.ts src/lib/blackjack-run/client.test.ts
bunx playwright test \
  e2e/blackjack-settings.spec.ts \
  e2e/blackjack-split.spec.ts \
  e2e/blackjack-llm.spec.ts \
  e2e/ranked-blackjack.spec.ts
```

- [ ] **Step 7: Perform the local four-locale visual check**

Temporarily enable all four and inspect casual Blackjack plus ranked Blackjack, including split layout, settings, AI advice, countdown/result panels, and narrow mobile controls. Revert activation.

- [ ] **Step 8: Verify and commit PR 4**

```bash
bun run test
bun run lint
bun run format:check
bun run build
```

Suggested commit:

```text
feat: localize blackjack and ranked blackjack
```

---

## Task 5 / PR 5: Small Client-Module Games

**Purpose:** Apply the established game translation pattern to Slots, Sic Bo, Pai Gow Poker, Three-Card Showdown, and Video Poker while converting their player-facing domain validation strings to stable codes.

**Files:**
- Create: `src/lib/i18n/messages/slots.ts`
- Create: `src/lib/i18n/messages/sic-bo.ts`
- Create: `src/lib/i18n/messages/pai-gow-poker.ts`
- Create: `src/lib/i18n/messages/three-card-showdown.ts`
- Create: `src/lib/i18n/messages/video-poker.ts`
- Modify: `src/lib/bet-validation.ts`
- Modify: `src/lib/bet-validation.test.ts`
- Modify: `src/pages/games/slots.astro`
- Modify: `src/lib/slots/slotsClient.ts`
- Modify: `src/lib/slots/slotsClient.test.ts`
- Modify: `src/pages/games/sic-bo.astro`
- Modify: `src/lib/sic-bo/game.ts`
- Modify: `src/lib/sic-bo/game.test.ts`
- Modify: `src/lib/sic-bo/client.ts`
- Modify: `src/lib/sic-bo/client.init.test.ts`
- Modify: `src/pages/games/pai-gow-poker.astro`
- Modify: `src/lib/pai-gow-poker/game.ts`
- Modify: `src/lib/pai-gow-poker/game.test.ts`
- Modify: `src/lib/pai-gow-poker/rules.ts`
- Modify: `src/lib/pai-gow-poker/rules.test.ts`
- Modify: `src/lib/pai-gow-poker/client.ts`
- Modify: `src/lib/pai-gow-poker/client.init.test.ts`
- Modify: `src/pages/games/three-card-showdown.astro`
- Modify: `src/lib/three-card-showdown/game.ts`
- Modify: `src/lib/three-card-showdown/game.test.ts`
- Modify: `src/lib/three-card-showdown/client.ts`
- Modify: `src/lib/three-card-showdown/client.init.test.ts`
- Modify: `src/pages/games/video-poker.astro`
- Modify: `src/lib/video-poker/game.ts`
- Modify: `src/lib/video-poker/game.test.ts`
- Modify: `src/lib/video-poker/client.ts`
- Modify: `src/lib/video-poker/client.init.test.ts`
- Test: `e2e/slots.spec.ts`
- Test: `e2e/sic-bo.spec.ts`
- Test: `e2e/pai-gow-poker.spec.ts`
- Test: `e2e/three-card-showdown.spec.ts`
- Test: `e2e/video-poker.spec.ts`

**Interfaces:**
- Produces temporary shared `validateBetCode()` while preserving the old English `validateBet()` wrapper for unmigrated games.
- Produces local closed wager/arrangement codes in the migrated engines.
- Consumes: Task 1 document locale, translators, settlement message seam, formatting, game names.

- [ ] **Step 1: Add a language-neutral bet-validation seam**

In `src/lib/bet-validation.ts`, introduce:

```ts
export type BetValidationCode =
  | 'invalid-limits'
  | 'invalid-range'
  | 'out-of-range';

export function validateBetCode(
  amount: number,
  minBet: number,
  maxBet: number,
): BetValidationCode | null;
```

Refactor existing `validateBet()` to wrap `validateBetCode()` and preserve its current English return strings for games not migrated yet. Do not parse English strings in clients and do not duplicate min/max validation in five engines.

Add tests proving the code result independently of English formatting.

- [ ] **Step 2: Move Sic Bo/Three-Card/Video-Poker wager messages to codes**

For each game, change `getWagerError()` from `string | null` to a local union built from `BetValidationCode` plus any game-specific codes such as:

```ts
'twhole-number-required'
'insufficient-balance'
```

The client translates the code with that game's dictionary. Internal invariant throws may include the code for diagnostics; they must not be the player-visible presentation source.

Update engine/client tests accordingly.

- [ ] **Step 3: Move Pai Gow wager and arrangement errors to codes**

Apply the same wager-code rule to `PaiGowPokerGame.getWagerError()`.

In `src/lib/pai-gow-poker/rules.ts`, replace player-facing arrangement error strings with a closed `PaiGowArrangementErrorCode`. `client.ts` maps those codes to complete localized messages.

Move `CATEGORY_LABELS` out of `client.ts` into the Pai Gow dictionary. Keep rank glyphs `J/Q/K/A` visible as-is, but localize `RANK_NAMES`, suit names, `Joker`, and complete accessible card names.

- [ ] **Step 4: Localize each game's SSR page and dynamic client copy**

For Slots, Sic Bo, Pai Gow Poker, Three-Card Showdown, and Video Poker, translate the owned page/client text: title/back link, balance/wager labels, actions, status/outcomes, rules/paytables, settlement failure/retry/reset, settings, and ARIA/title/alt text.

Use `getGameName()` for game names and `getDocumentLocale()` for browser locale. Pass localized `retryLabel` through the shared settlement messages bag.

Do not alter probability, payout, draw, evaluation, or settlement math.

- [ ] **Step 5: Localize hand/category names only at presentation boundaries**

Keep evaluator categories/ranks as existing domain enums/values. Translate Video Poker/Pai Gow category labels where rendered. Do not change persistence or evaluator return identities to translated strings.

- [ ] **Step 6: Run unit and E2E tests**

```bash
bun test \
  src/lib/bet-validation.test.ts \
  src/lib/slots \
  src/lib/sic-bo \
  src/lib/pai-gow-poker \
  src/lib/three-card-showdown \
  src/lib/video-poker

bunx playwright test \
  e2e/slots.spec.ts \
  e2e/sic-bo.spec.ts \
  e2e/pai-gow-poker.spec.ts \
  e2e/three-card-showdown.spec.ts \
  e2e/video-poker.spec.ts
```

- [ ] **Step 7: Perform the local four-locale visual check**

Temporarily enable all locales and inspect all five game pages, especially paytables, action grids, Pai Gow card accessibility/arrangement feedback, and narrow button labels. Revert activation.

- [ ] **Step 8: Verify and commit PR 5**

```bash
bun run test
bun run lint
bun run format:check
bun run build
```

Suggested commits:

```text
refactor: expose language-neutral bet validation codes
feat: localize small client-module games
```

---

## Task 6 / PR 6: Baccarat, Roulette, and Keno

**Purpose:** Localize the three renderer-heavy public games through their existing renderer/client seams.

**Files:**
- Create: `src/lib/i18n/messages/baccarat.ts`
- Create: `src/lib/i18n/messages/roulette.ts`
- Create: `src/lib/i18n/messages/keno.ts`
- Modify: `src/pages/games/baccarat.astro`
- Modify: `src/lib/baccarat/BaccaratUIRenderer.ts`
- Modify: `src/lib/baccarat/llmBaccaratStrategy.ts`
- Modify: corresponding Baccarat renderer/LLM tests
- Modify: `src/pages/games/roulette.astro`
- Modify: `src/lib/roulette/RouletteUIRenderer.ts`
- Modify: `src/lib/roulette/rouletteClient.ts`
- Modify: `src/lib/roulette/spin-error-classification.ts`
- Modify: corresponding Roulette tests
- Modify: `src/pages/games/keno.astro`
- Modify: `src/lib/keno/KenoUIRenderer.ts`
- Modify: `src/lib/keno/kenoClient.ts`
- Modify: corresponding Keno tests
- Test: `e2e/baccarat.spec.ts`
- Test: `e2e/roulette.spec.ts`
- Test: `e2e/keno.spec.ts`

**Interfaces:**
- Consumes: document locale, shared settlement messages, formatting, shared game names, and `validateBetCode()` when these games expose shared validation results.
- Changes: Roulette code-to-copy mapper becomes locale-aware instead of embedding English.

- [ ] **Step 1: Write representative renderer tests in non-English locales**

Set `document.documentElement.dataset.locale` in renderer/client tests and assert one dynamic Japanese/Traditional Chinese state for Baccarat, Roulette, and Keno before changing implementation.

- [ ] **Step 2: Localize Baccarat through its renderer seam**

Translate Baccarat SSR page labels/rules/actions and `BaccaratUIRenderer` dynamic state/outcomes. If deterministic/LLM Baccarat advice is visible to the player, keep its authoritative recommendation language-neutral and localize/rewrite only explanation text using the active locale.

Switch any player-facing bet validation to `validateBetCode()` plus Baccarat message lookup rather than exposing `validateBet()` English.

- [ ] **Step 3: Make Roulette rejection classification return localized copy**

Keep `SpinHttpError` status/code semantics unchanged. Change:

```ts
messageForSpinRejection(err: SpinHttpError, locale: Locale): string
```

and resolve `401`, `INSUFFICIENT_BALANCE`, `SETTLEMENT_CONFLICT`, and default rejection through `messages/roulette.ts`.

Translate page/renderer/client status, bet labels, spin result, recovery controls, and accessibility copy. Do not translate server error codes.

- [ ] **Step 4: Localize Keno renderer/client**

Translate Keno page labels, selection guidance, quick-pick/clear/draw controls, draw/result status, payout labels, settlement recovery, errors, and accessibility copy through the existing `KenoUIRenderer`/`kenoClient` seam.

Use locale-aware number/chip formatting and shared game name.

- [ ] **Step 5: Run unit and E2E tests**

```bash
bun test src/lib/baccarat src/lib/roulette src/lib/keno
bunx playwright test e2e/baccarat.spec.ts e2e/roulette.spec.ts e2e/keno.spec.ts
```

- [ ] **Step 6: Perform the local four-locale visual check**

Temporarily enable all locales and inspect Baccarat, Roulette, and Keno at desktop/mobile widths, including table/bet layouts and dynamic result panels. Revert activation.

- [ ] **Step 7: Verify and commit PR 6**

```bash
bun run test
bun run lint
bun run format:check
bun run build
```

Suggested commit:

```text
feat: localize baccarat roulette and keno
```

---

## Task 7 / PR 7: Craps, Poker, and Multiplayer Poker

**Purpose:** Finish the largest remaining player surfaces while leaving multiplayer/server protocol state untouched.

**Files:**
- Create: `src/lib/i18n/messages/craps.ts`
- Create: `src/lib/i18n/messages/poker.ts`
- Create: `src/lib/i18n/messages/multiplayer-poker.ts`
- Modify: `src/pages/games/craps.astro`
- Modify: `src/lib/craps/CrapsGame.ts` only where a player-facing result is currently an English string
- Modify: `src/lib/craps/llmCrapsStrategy.ts`
- Modify: corresponding Craps tests
- Modify: `src/pages/games/poker.astro`
- Modify: `src/lib/poker/constants.ts`
- Modify: `src/lib/poker/PokerUIRenderer.ts`
- Modify: `src/lib/poker/PokerUIRenderer.test.ts`
- Modify: `src/lib/poker/AIRivalAssistant.ts`
- Modify: `src/lib/poker/AIRivalAssistant.test.ts`
- Modify: `src/lib/poker/llmAIStrategy.ts`
- Modify: corresponding Poker tests
- Modify: `src/pages/games/poker-mp/index.astro`
- Modify: `src/pages/games/poker-mp/[code].astro`
- Modify: `src/lib/mp-poker/client.ts`
- Modify: `src/lib/mp-poker/client.test.ts`
- Test: `e2e/craps.spec.ts`
- Test: `e2e/poker-turn-flow.spec.ts`
- Test: `e2e/multiplayer-poker.spec.ts`

**Interfaces:**
- Consumes: all shared i18n primitives and game names.
- Keeps: `src/lib/mp-poker/protocol.ts` and server room protocol values language-neutral.
- Changes: poker hand names/category labels become presentation lookups rather than English constants used as UI copy.

- [ ] **Step 1: Add failing Craps/Poker/MP presentation tests**

Add one non-English dynamic renderer/advice assertion for each surface. For MP, set document locale and prove a room/lobby status label changes without changing protocol values in the mocked message.

- [ ] **Step 2: Localize Craps page and advice/status presentation**

Translate the large Craps table/page labels, bet names/descriptions, status/results, settings, settlement controls, game rules, and accessibility text in `craps.astro` using stable bet/domain values.

Localize deterministic/LLM explanation text in `llmCrapsStrategy.ts` while keeping selected bet/recommendation identities unchanged.

If `CrapsGame` exposes a player-visible English result, replace only that result with a closed code and translate at the page/client boundary.

- [ ] **Step 3: Move Poker hand names to the Poker dictionary**

Keep `HAND_RANKINGS` numeric. Stop treating `HAND_NAMES` in `src/lib/poker/constants.ts` as player-facing English. Renderer/advisor code resolves the hand-ranking/category key through `messages/poker.ts`.

Translate page actions, table labels, status, settings, AI rival/advice, errors, rules, and accessible card/hand copy. Keep card rank glyphs and game-state enums unchanged.

Optional provider prompts request the active language without allowing the model to change authoritative game decisions.

- [ ] **Step 4: Localize multiplayer Poker UI without translating protocol**

Translate lobby/create/join copy in `poker-mp/index.astro` and room/table/action/status/error/accessibility copy in `[code].astro` and `src/lib/mp-poker/client.ts`.

Use existing protocol codes/state to select presentation messages. Do not alter `src/lib/mp-poker/protocol.ts`, room codes, websocket message types, timers, or server room state merely for localization.

- [ ] **Step 5: Run targeted test suites**

```bash
bun test src/lib/craps src/lib/poker src/lib/mp-poker
bunx playwright test e2e/craps.spec.ts e2e/poker-turn-flow.spec.ts
bun run test:e2e:mp
```

The regular `multiplayer-poker.spec.ts` path is covered by the dedicated MP configuration/script; do not invent a second MP harness.

- [ ] **Step 6: Perform the local four-locale visual check**

Temporarily enable all locales and inspect Craps, single-player Poker, MP lobby, and an MP room. Pay special attention to Craps table cell sizing, Poker action controls/advice, and room status/action wrapping. Revert activation.

- [ ] **Step 7: Verify and commit PR 7**

```bash
bun run test
bun run lint
bun run format:check
bun run build
```

Suggested commit:

```text
feat: localize craps poker and multiplayer poker
```

If this PR proves unreviewable during implementation, stop and ask before changing the approved one-ticket/one-PR boundary; do not silently split the ticket.

---

## Task 8 / PR 8: Completeness Audit, Visual QA, and Locale Activation

**Purpose:** Prove no known player-facing English leaks remain, then expose Traditional Chinese, Simplified Chinese, and Japanese together.

**Files:**
- Modify: `src/lib/i18n/locale.ts`
- Modify: `src/lib/i18n/locale.test.ts`
- Modify: `e2e/i18n-foundation.spec.ts` or rename/add `e2e/i18n-activation.spec.ts`
- Modify: any migrated presentation file where the audit finds a real player-facing gap
- Modify: `src/lib/bet-validation.ts` only if the English compatibility wrapper has no remaining caller

**Interfaces:**
- Changes: `ENABLED_LOCALES` from `['en']` to all `SUPPORTED_LOCALES`.
- Removes: temporary English compatibility presentation paths only when `rg`/tests prove they are unused.

- [ ] **Step 1: Run a hard-coded locale-formatting audit**

From repo root run:

```bash
rg -n "Intl\.NumberFormat\(['\"]en-US|toLocaleString\(['\"]en-US|toLocaleDateString\(['\"]en-US" \
  src/pages src/components src/lib
```

For every match, classify whether it is player-facing. Replace player-facing matches with Task 1 formatting helpers and active document/request locale. Leave non-player protocol/log/test fixtures alone and document the reason in the PR if a match intentionally remains.

- [ ] **Step 2: Audit known English-bearing presentation/domain seams**

Run:

```bash
rg -n \
  "Retry settlement|Reset round|Wager must|Bet must be|Wager exceeds|Player wins|Dealer wins|High Card|Royal Flush|Jack|Queen|King|Ace|Joker| chips" \
  src/pages src/components src/lib
```

Inspect each production match. Player-facing display copy must be in a message dictionary or generated from translated complete templates. Invariant exceptions/logs/tests may remain English if they are never shown to players.

Also confirm all `getWagerError`/arrangement errors used by migrated clients return stable codes, not English presentation strings.

- [ ] **Step 3: Prove dictionary completeness**

Add/extend a unit test that imports every message module and asserts all four locale branches have the English key set. Separately assert `messages/games.ts` covers every `GAME_TYPES` value plus the three extras.

Run:

```bash
bun test src/lib/i18n
```

- [ ] **Step 4: Remove the temporary English `validateBet()` wrapper if unused**

Run:

```bash
rg -n "\bvalidateBet\(" src --glob '!src/lib/bet-validation.ts' --glob '!*.test.ts'
```

If there are zero production callers, delete the English-string wrapper and retain only `validateBetCode()`. If callers remain, convert the remaining player-facing caller to codes in this PR before removal; do not delete a still-used API.

- [ ] **Step 5: Enable all four locales**

Change:

```ts
export const ENABLED_LOCALES: readonly Locale[] = SUPPORTED_LOCALES;
```

or the equivalent immutable all-four value. No environment flag or staged percentage rollout is added.

Update locale tests so Japanese/Chinese cookies and `Accept-Language` are now accepted by default production resolution.

- [ ] **Step 6: Add the one activation E2E path**

The activation spec starts without a locale cookie, verifies browser-language detection, then uses the visible picker and verifies persistence across navigation:

```ts
await expect(page.locator('html')).toHaveAttribute('lang', 'ja');
// choose 繁體中文
// assert arcturus_locale=zh-Hant
// navigate to another translated surface
await expect(page.locator('html')).toHaveAttribute('lang', 'zh-Hant');
```

Also verify a representative shell label and one game/progression label change. Do not duplicate every E2E suite four times.

- [ ] **Step 7: Run final four-locale visual QA**

Inspect these representative surfaces in all four locales at desktop and narrow mobile widths:

```text
/
/signin
/profile
/profile/statistics
/missions
/games/leaderboard
/games/daily-challenge
/games/blackjack
/games/blackjack/ranked
/games/slots
/games/sic-bo
/games/pai-gow-poker
/games/three-card-showdown
/games/video-poker
/games/baccarat
/games/roulette
/games/keno
/games/craps
/games/poker
/games/poker-mp
```

Check clipping, wrapping, button/table sizing, font fallback, accessible labels, and dynamic result/status states. Add a CJK font only if this verification demonstrates a real readability/layout defect that cannot be solved with existing system fallback.

- [ ] **Step 8: Run final verification**

```bash
bun run test
bun run lint
bun run format:check
bun run build
bun run test:e2e:ci
```

Run the MP suite separately because it uses its own config:

```bash
bun run test:e2e:mp
```

Expected: all checks PASS with all four locales enabled.

- [ ] **Step 9: Commit PR 8**

Suggested commits:

```text
fix: close i18n completeness gaps
feat: enable four-language localization
```

---

## Rollout Summary

| Ticket / PR | Surface | Production locales after merge |
| --- | --- | --- |
| 1 | Foundation, shared game names, global shell | English only |
| 2 | Home, auth, profile, statistics, achievements | English only |
| 3 | Missions, leaderboard, daily challenge | English only |
| 4 | Blackjack + ranked Blackjack | English only |
| 5 | Slots, Sic Bo, Pai Gow, Three-Card, Video Poker | English only |
| 6 | Baccarat, Roulette, Keno | English only |
| 7 | Craps, Poker, multiplayer Poker | English only |
| 8 | Completeness + activation | English + Traditional Chinese + Simplified Chinese + Japanese |

The sequence deliberately establishes shared reuse points before large-scale copy migration. Do not add another i18n abstraction during later tasks unless an actual translation requirement cannot be expressed by the locale helper, feature dictionaries, interpolation, and existing presentation seams.