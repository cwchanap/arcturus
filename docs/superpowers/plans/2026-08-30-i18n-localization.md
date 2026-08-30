# Arcturus i18n Localization Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add complete English, Traditional Chinese, Simplified Chinese, and Japanese localization to the current Arcturus player experience without changing URLs, persisting translated domain data, or introducing a runtime i18n framework.

**Architecture:** Resolve one enabled locale per request in Astro middleware and expose it once on `<html>`. Use a small typed TypeScript translation layer under `src/lib/i18n/`, compile-time-complete feature dictionaries, one shared game-name catalog, one localized chip-amount convention, and existing presentation seams. Browser renderers read the document locale; domain/game/protocol values remain language-neutral and player-facing strings are produced only at presentation boundaries.

**Tech Stack:** Astro 5, TypeScript strict mode, Bun test, Vitest/Astro Container, Playwright, Cloudflare Workers/D1, ESLint flat config. No new runtime i18n dependency.

**Spec:** `docs/superpowers/specs/2026-08-30-i18n-localization-design.md`

## Global Constraints

- Supported locales are exactly `en`, `zh-Hant`, `zh-Hans`, and `ja`.
- `SUPPORTED_LOCALES = ['en', 'zh-Hant', 'zh-Hans', 'ja']` from Task 1 onward.
- `ENABLED_LOCALES = ['en']` through Tasks 1–8; Task 9 enables all four together.
- Disabled locales must not be selected by picker, cookie, or `Accept-Language` in production request resolution.
- Nine rollout tickets map to nine implementation PRs, merged sequentially. One ticket must not be split across multiple PRs without explicit approval.
- Every feature PR authors all four translations for the surface it migrates even while production remains English-only.
- English is the authoring locale. `defineMessages()` must make missing non-English keys a TypeScript/build error.
- Use complete sentence templates with named interpolation; do not assemble English-shaped fragments.
- Keep game, mission, achievement, ranking, multiplayer protocol, and persistence identifiers language-neutral.
- Do not create locale routes, locale DB columns, a CMS, ICU parsing, i18next/FormatJS, an environment locale flag, or a feature-flag service.
- Do not add bundled CJK fonts unless visual verification demonstrates a material problem.
- Reuse `src/lib/formatting.ts`, the existing settlement messages seam, shared bet validation, and existing game renderers/clients.
- Locale is written once on `<html>`; do not add a locale attribute independently to each game root.
- Game display names have one translation source; feature dictionaries must not duplicate them.
- Virtual money is chips, not USD. Migrated surfaces use `formatChips(value, locale)` and remove `$` prefixes.
- Exhaustive presentation catalogs use closed domain key types, not `string`.
- For every translation PR, temporarily enable all four locales locally, visually inspect only the migrated surfaces, then revert `ENABLED_LOCALES` before committing/merging.
- Each translation PR appends new canonical casino terms to `docs/i18n-glossary.md`; the glossary is editorial only and is never a runtime string-fragment source.

---

## Task 1 / PR 1: i18n Foundation, Shared Game Names, Chip Convention, and Global Shell

**Purpose:** Establish the shared primitives/reuse seams every later migration depends on while keeping production English-only.

**Files:**
- Create: `src/lib/i18n/locale.ts`
- Create: `src/lib/i18n/locale.test.ts`
- Create: `src/lib/i18n/translate.ts`
- Create: `src/lib/i18n/translate.test.ts`
- Create: `src/lib/i18n/messages/common.ts`
- Create: `src/lib/i18n/messages/games.ts`
- Create: `src/components/LanguagePicker.astro`
- Create: `docs/i18n-glossary.md`
- Modify: `src/env.d.ts`
- Modify: `src/middleware.ts`
- Modify: `src/layouts/AppLayout.astro`
- Modify: `src/components/UserNav.astro`
- Modify: `src/lib/game-stats/constants.ts`
- Modify: `src/lib/formatting.ts`
- Modify: `src/lib/formatting.test.ts`
- Modify: `src/lib/wallet/public-game-settlement.ts`
- Modify: `src/lib/wallet/public-game-settlement.test.ts`
- Modify mechanically for required `retryLabel`: `src/lib/sic-bo/client.ts`
- Modify mechanically for required `retryLabel`: `src/lib/pai-gow-poker/client.ts`
- Modify mechanically for required `retryLabel`: `src/lib/three-card-showdown/client.ts`
- Modify mechanically for required `retryLabel`: `src/lib/video-poker/client.ts`
- Modify: `integration/daily-challenge-pages.test.ts`
- Modify: `integration/profile-page.test.ts`

**Interfaces:**
- Produces: `Locale`, `SUPPORTED_LOCALES`, `ENABLED_LOCALES`, `LOCALE_COOKIE`.
- Produces: `normalizeLocaleTag(tag): Locale | null`.
- Produces: `resolveRequestLocale({ cookieLocale, acceptLanguage, enabledLocales? }): Locale`.
- Produces: `getDocumentLocale(doc?: Document): Locale`.
- Produces: type-level `defineMessages()` and `createTranslator()`.
- Produces: `getGameName(locale, key)` for all `GAME_TYPES` plus `daily-challenge`, `poker-mp`, `blackjack-ranked`.
- Produces: `formatChips(value, locale)` from the common i18n presentation module.
- Extends: locale-sensitive numeric helpers in `src/lib/formatting.ts` with `locale: Locale = 'en'`.
- Extends: `PublicGameSettlementMessages` with required `retryLabel`.

- [ ] **Step 1: Write locale-resolution tests**

Create `src/lib/i18n/locale.test.ts` with the contract:

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

Also assert cookie precedence, malformed/disabled cookie skipping, q-value ordering, and English fallback when no recognized enabled match exists.

Run:

```bash
bun test src/lib/i18n/locale.test.ts
```

Expected: RED because the module does not exist.

- [ ] **Step 2: Implement the minimal locale module**

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

`getDocumentLocale()` reads `document.documentElement.dataset.locale ?? document.documentElement.lang` and returns English only for an absent/malformed document value. Parse `Accept-Language` locally; add no parser dependency.

Run the locale test again; expected: PASS.

- [ ] **Step 3: Make message parity compile-time, not runtime machinery**

In `src/lib/i18n/translate.ts`, make English define the message key shape. The three other branches must be typed from it. `defineMessages()` is a zero-runtime-cost identity helper; `createTranslator()` only selects the branch and replaces named `{token}` placeholders.

Use a signature that infers the key set from `en` first and rejects both missing and extra locale keys, for example via an exact mapped type / `satisfies` helper. The required call-site contract is:

```ts
const messages = defineMessages({
  en: { greeting: 'Hello {name}', repeat: '{value} / {value}' },
  'zh-Hant': { greeting: '你好，{name}', repeat: '{value} / {value}' },
  'zh-Hans': { greeting: '你好，{name}', repeat: '{value} / {value}' },
  ja: { greeting: 'こんにちは、{name}', repeat: '{value} / {value}' },
});
```

Deleting `ja.greeting` (or adding a locale-only key) must fail `bun run build` without a runtime parity checker. `src/lib/i18n/translate.test.ts` tests interpolation/repeated placeholders and locale selection only.

Run:

```bash
bun test src/lib/i18n/translate.test.ts
bun run build
```

- [ ] **Step 4: Create the canonical game-name catalog**

Keep `GAME_TYPE_LABELS` as the English map for `GAME_TYPES`; change `poker` to `Texas Hold'em Poker`.

`messages/games.ts` reuses that English map and adds:

```ts
'daily-challenge': 'Daily Challenge'
'poker-mp': 'Multiplayer Poker'
'blackjack-ranked': 'Ranked Blackjack'
```

Export `GameNameKey` and `getGameName(locale, key)`. Add the one runtime completeness test that checks every `GAME_TYPES` member plus the three extras resolves in every locale, because this catalog crosses modules.

- [ ] **Step 5: Establish the chip convention and numeric formatting**

Extend `src/lib/formatting.ts` with locale arguments for numeric/percentage/date formatting while preserving current validation semantics.

In `messages/common.ts`, define the shared localized chip phrase and export:

```ts
export function formatChips(value: number, locale: Locale): string;
```

Use locale-aware number formatting internally. English handles only the real singular distinction (`1 chip`, otherwise `N chips`); Chinese/Japanese use their natural invariant noun form. Do not add a plural framework.

Task 1 migrates only shell/shared-settlement chip text to this helper. Later surface PRs replace their `$`, bare-number, and `N chips` variants as they migrate.

Add formatting/chip tests for all four locales.

- [ ] **Step 6: Wire locale before middleware early returns**

At the top of `onRequest`:

```ts
context.locals.locale = resolveRequestLocale({
  cookieLocale: context.cookies.get(LOCALE_COOKIE)?.value,
  acceptLanguage: context.request.headers.get('accept-language'),
});
```

Add required `locale: Locale` to `App.Locals`. The no-DB/auth path must receive locale before `next()`.

- [ ] **Step 7: Fix Astro container locals so required fields cannot disappear silently**

In `integration/daily-challenge-pages.test.ts` and `integration/profile-page.test.ts`, set `locale: 'en'` in every fixture.

Remove the whole-object `as App.Locals` cast. If fake Cloudflare runtime data still needs a cast, isolate it:

```ts
const runtime = { /* existing fake bindings */ } as App.Locals['runtime'];

const locals: App.Locals = {
  runtime,
  locale: 'en',
  session: null,
  user: null,
};
```

This keeps future top-level `App.Locals` additions compile-checked.

- [ ] **Step 8: Put locale on `<html>` once and migrate the shell**

Use:

```astro
<html lang={locale} data-locale={locale}>
```

Translate header/footer/nav/legal copy and `UserNav.astro`, use `formatChips()` for the header balance, and keep `Arcturus` unchanged. Do not add locale attributes to child game roots.

Extend both Astro container tests to assert the rendered root document has `lang="en"` and `data-locale="en"`. These container assertions plus locale resolver unit tests replace a foundation-only Playwright spec.

- [ ] **Step 9: Add the language picker without an API endpoint**

Render only `ENABLED_LOCALES`. When multiple locales are enabled, selecting one writes:

```text
arcturus_locale=<locale>; Max-Age=31536000; Path=/; SameSite=Lax
```

then reloads the current URL. Hide the control while only English is enabled.

- [ ] **Step 10: Extend the shared settlement copy seam**

Change:

```ts
export type PublicGameSettlementMessages = {
  failed: string;
  retrying: string;
  retryFailed: string;
  retryLabel: string;
};
```

Use `options.messages.retryLabel` in `public-game-settlement.ts`. Update the four current call sites listed above to pass the existing English label only; full localization remains in their owning game PR.

Change shared balance synchronization to `getDocumentLocale(root.ownerDocument)` + `formatChips()` rather than `toLocaleString('en-US')` / `${formatted} chips`.

Run:

```bash
bun test src/lib/wallet/public-game-settlement.test.ts src/lib/sic-bo/client.init.test.ts src/lib/pai-gow-poker/client.init.test.ts src/lib/three-card-showdown/client.init.test.ts src/lib/video-poker/client.init.test.ts
```

- [ ] **Step 11: Create the terminology glossary**

Create `docs/i18n-glossary.md` with this initial table and use it as the editorial vocabulary source:

| English | 繁體中文 | 简体中文 | 日本語 |
| --- | --- | --- | --- |
| Chips | 籌碼 | 筹码 | チップ |
| Player | 玩家 | 玩家 | プレイヤー |
| Dealer | 荷官 | 荷官 | ディーラー |
| Banker | 莊家 | 庄家 | バンカー |
| Bet | 下注 | 下注 | ベット |
| Wager | 下注額 | 下注额 | 賭け金 |
| Payout | 派彩 | 派彩 | 払戻し |
| Win | 勝 | 胜 | 勝ち |
| Loss | 負 | 负 | 負け |
| Push | 和局 | 和局 | 引き分け |
| Leaderboard | 排行榜 | 排行榜 | ランキング |
| Rank | 名次 | 名次 | 順位 |

Later PRs append game-specific canonical terms; runtime strings still use complete sentence templates.

- [ ] **Step 12: Local four-locale visual check and verification**

Temporarily enable all four locally; inspect `/` plus one authenticated shell page at desktop/narrow widths for nav/footer wrapping, chip text, and CJK fallback. Revert activation before staging.

Run:

```bash
bun run test
bun run lint
bun run format:check
bun run build
```

Suggested commits: `test: define locale and message contracts`, `feat: add typed i18n foundation and chip formatting`, `feat: localize shared shell seams`.

---

## Task 2 / PR 2: Home, Auth, Profile, Statistics, Achievements, and Achievement JSON Boundaries

**Purpose:** Migrate account/discovery presentation and remove English achievement names from domain, wallet, toast, and Roulette's independent response typing.

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
- Modify: `src/lib/roulette/rouletteClient.ts`
- Modify: `src/lib/roulette/rouletteClient.integration.test.ts`
- Modify: `src/pages/api/roulette/spin.ts`
- Modify: `src/lib/roulette/spin-api.test.ts`
- Modify: `src/lib/formatting.ts`
- Modify: `src/lib/formatting.test.ts`
- Test: `integration/profile-page.test.ts`
- Test: `e2e/auth-ui.spec.ts`
- Test: `e2e/profile.spec.ts`
- Test: `e2e/profile-statistics.spec.ts`

**Interfaces:**
- Consumes: Task 1 document locale, translator, `formatChips()`, and `getGameName()`.
- Produces: achievement presentation lookup keyed by `AchievementId`.
- Changes: settlement/toast achievement payload from `{ id, name, icon }` to `{ id: AchievementId, icon }`.

- [ ] **Step 1: Add failing achievement presentation tests**

For every `ACHIEVEMENT_IDS` member, assert all four locales resolve name/description. Include locale-aware threshold/chip formatting. Keep unlock-rule tests language-neutral.

- [ ] **Step 2: Make achievement definitions language-neutral**

Change:

```ts
export interface AchievementDefinition {
  id: AchievementId;
  category: AchievementCategory;
  icon: string;
}
```

Remove `name`/`description` from `ACHIEVEMENTS`; preserve IDs, categories, icons, thresholds, checks, and persistence.

- [ ] **Step 3: Remove achievement English from wallet and Roulette response contracts**

Change `SettleRoundResult.newAchievements` to:

```ts
Array<{ id: AchievementId; icon: string }>
```

Update `buildFreshResult()` and wallet tests.

Update Roulette's independent `SpinResponse` to the same no-name shape now, not in Task 6. In `src/pages/api/roulette/spin.ts`, type-check the success response's `newAchievements` field against `SettleRoundResult['newAchievements']` before `Response.json`; update `spin-api.test.ts` to expect `{ id, icon }` only.

- [ ] **Step 4: Resolve toast names by ID and document locale**

Change `AchievementToastEntry` to `{ id: AchievementId; icon: string }`. Resolve the displayed name through `messages/achievements.ts` using `getDocumentLocale()`. Preserve queue/timing behavior. Test Japanese document locale with ID/icon-only input.

- [ ] **Step 5: Migrate home and `GameCard` without duplicating game names**

Replace home game-name strings with stable `GameNameKey`s. `GameCard.astro` localizes `Featured`, playing-count text, minimum-bet text, and `Play`; player count uses active locale and minimum bet uses `formatChips()`. Game titles come only from `getGameName()`.

- [ ] **Step 6: Migrate sign-in/profile Astro copy**

Translate page titles/headings, auth calls to action, verification states, account labels, tips, AI settings labels/status, accessibility fallback labels, loading/error shells, and statistics headings. Provider/model identifiers remain unchanged.

- [ ] **Step 7: Localize profile statistics renderer/client**

Renderer reads `getDocumentLocale(root.ownerDocument)` and localizes summary labels, empty state, game names, played state, metrics, ranks, `Unranked`, action links, and chip values. Replace direct `toLocale*`/English chip text in these owned files with shared helpers.

Delete `formatSignedChipResult()` once its production callers are gone; format signed numeric value plus complete translated chip-result text instead.

- [ ] **Step 8: Run tests**

```bash
bun test src/lib/achievements src/lib/achievement-toast.test.ts src/lib/wallet src/lib/profile-statistics-renderer.test.ts src/lib/profile-statistics-client.test.ts src/lib/roulette/rouletteClient.integration.test.ts src/lib/roulette/spin-api.test.ts
bunx vitest run integration/profile-page.test.ts
bunx playwright test e2e/auth-ui.spec.ts e2e/profile.spec.ts e2e/profile-statistics.spec.ts
```

- [ ] **Step 9: Local visual check and verification**

Temporarily enable all locales; inspect `/`, `/signin`, `/profile`, `/profile/statistics`, game cards, statistics cards, forms, and an achievement toast. Revert activation.

Run `bun run test`, `bun run lint`, `bun run format:check`, `bun run build`.

---

## Task 3 / PR 3: Missions, Leaderboard, Daily Challenge, and Cache Variation

**Purpose:** Close string-key holes, keep progression/ranking APIs neutral, move ranking labels to presentation, and make the cache safe for automatic language detection.

**Files:**
- Create: `src/lib/i18n/messages/missions.ts`
- Create: `src/lib/i18n/messages/leaderboard.ts`
- Create: `src/lib/i18n/messages/daily-challenge.ts`
- Modify: `src/lib/missions/types.ts`
- Modify: `src/lib/missions/registry.ts`
- Modify: `src/lib/missions/registry.test.ts`
- Modify: `src/lib/missions/board.ts`
- Modify: `src/lib/missions/board.test.ts`
- Modify: `src/lib/game-stats/constants.ts`
- Modify: `src/lib/game-stats/game-stats.ts`
- Modify: `src/pages/missions/index.astro`
- Modify: `src/pages/games/leaderboard.astro`
- Modify: `src/pages/games/daily-challenge.astro`
- Modify: `src/lib/blackjack-run/daily-ui.ts`
- Modify: `src/lib/blackjack-run/daily-ui.test.ts`
- Modify: `integration/daily-challenge-pages.test.ts`
- Test: `e2e/missions.spec.ts`
- Test: `e2e/leaderboard.spec.ts`
- Test: `e2e/daily-challenge.spec.ts`

**Interfaces:**
- Produces: `MISSION_IDS` / `MissionId`.
- Changes: `MissionDefinition.id` and `MissionView.missionDefId` to `MissionId`; title/description leave domain/view payloads.
- Changes: `RANKING_METRIC_LABELS` leaves game-stat constants; leaderboard messages are exhaustive over `RankingMetric`.

- [ ] **Step 1: Close mission IDs before removing copy**

Add:

```ts
export const MISSION_IDS = [
  'daily-blackjack-5',
  'daily-win-3',
  'daily-slots-20',
  'daily-craps-3',
  'daily-baccarat-3',
  'daily-keno-5',
  'weekly-games-3',
] as const;
export type MissionId = (typeof MISSION_IDS)[number];
```

Use `MissionId` on `MissionDefinition.id` and `MissionView.missionDefId`. Keep DB/input lookup functions allowed to accept `string` where they validate/resolve persisted values.

Add tests that every registry definition ID belongs to `MISSION_IDS` and every `MISSION_IDS` value resolves to a definition.

- [ ] **Step 2: Remove mission English from registry/API view**

Delete title/description fields without changing metrics, targets, rewards, rerolls, claims, streaks, or DB queries.

`messages/missions.ts` must be typed exhaustively by `MissionId` for all four locales, so adding a mission without copy is a build error.

- [ ] **Step 3: Update initial and refreshed mission rendering**

`src/pages/missions/index.astro` resolves title/description from `missionDefId` in both SSR and the JS path that re-renders `/api/missions/board`. Translate streak, claim/reroll, reset, completion, error, and chip copy. Replace direct `toLocale*` formatting in the page.

- [ ] **Step 4: Move ranking metric display data to i18n**

Keep `RANKING_METRICS` language-neutral, remove `RANKING_METRIC_LABELS` from `src/lib/game-stats/constants.ts`, and remove its re-export from `game-stats.ts`.

In `messages/leaderboard.ts`, provide an exhaustive `Record<RankingMetric, string>` per locale (or an equivalent typed lookup). Translate all controls/headings/rank/empty/error/row labels; game names come from `getGameName()` and chips from `formatChips()`.

- [ ] **Step 5: Localize Daily Challenge and dynamic UI**

Translate rules, status/countdown, result summary, rank, actions, loading/error/retry, and header balance. `daily-ui.ts` reads `getDocumentLocale(root.ownerDocument)`. Replace explicit and implicit ad-hoc locale formatting in the page/UI files.

- [ ] **Step 6: Fix guest cache variation**

Change the guest Daily Challenge response to:

```text
Vary: Cookie, Accept-Language
```

Keep authenticated `private, no-store` behavior unchanged.

Update `integration/daily-challenge-pages.test.ts` to assert the exact new guest `Vary` value and unchanged authenticated `null` value. This makes automatic browser-language detection cache-safe before activation.

- [ ] **Step 7: Run tests**

```bash
bun test src/lib/missions src/lib/blackjack-run/daily-ui.test.ts
bunx vitest run integration/daily-challenge-pages.test.ts
bunx playwright test e2e/missions.spec.ts e2e/leaderboard.spec.ts e2e/daily-challenge.spec.ts
```

- [ ] **Step 8: Glossary, visual check, verification**

Append the canonical progression/ranking terms used by these dictionaries to `docs/i18n-glossary.md` if they are not already present.

Temporarily enable all locales; inspect missions, leaderboard, and Daily Challenge on desktop/mobile, then revert.

Run `bun run test`, `bun run lint`, `bun run format:check`, `bun run build`.

---

## Task 4 / PR 4: Blackjack and Ranked Blackjack

**Purpose:** Localize casual/ranked Blackjack as one coherent game family.

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
- Modify: `src/lib/blackjack-run/client.ts`
- Modify: `src/lib/blackjack-run/ranked-ui.ts`
- Modify: `src/lib/blackjack-run/ranked-ui.test.ts`
- Test: `e2e/blackjack-settings.spec.ts`
- Test: `e2e/blackjack-split.spec.ts`
- Test: `e2e/blackjack-llm.spec.ts`
- Test: `e2e/ranked-blackjack.spec.ts`

- [ ] **Step 1: Append Blackjack terminology and add message tests**

Add canonical glossary rows for Blackjack, Hit, Stand, Double Down, Split, Natural, Dealer Hand, and Player Hand. Add failing message/presentation tests for page headings, wager controls, actions, outcomes, split summaries, recovery, settings, AI advisor, ranked countdown/status/results, accessibility, and chip amounts.

- [ ] **Step 2: Localize casual Blackjack SSR and client copy**

Translate static copy/ARIA/title/rules/settings/payouts and all dynamic `blackjackClient.ts` outcome/split/recovery/reset/balance/current-bet/settings/AI copy. Use `getGameName()`, `getDocumentLocale()`, `formatChips()`, and shared settlement messages. Remove all `$` and direct `toLocale*` formatting from owned files.

- [ ] **Step 3: Localize deterministic/provider advice without changing decisions**

Local deterministic reasoning uses messages. Optional AI prompt requests the locale but cannot change `recommendedAction`. Test identical recommended action across locales.

- [ ] **Step 4: Localize ranked renderer**

Translate ranked wager/actions/status/countdown/result/error text and replace ranked `Intl.NumberFormat('en-US')`, `toLocaleString('en-US')`, `$`, and `${formatted} chips` with shared locale/chip helpers.

- [ ] **Step 5: Run tests and visual verification**

```bash
bun test src/lib/blackjack src/lib/blackjack-run/ranked-ui.test.ts src/lib/blackjack-run/client.test.ts
bunx playwright test e2e/blackjack-settings.spec.ts e2e/blackjack-split.spec.ts e2e/blackjack-llm.spec.ts e2e/ranked-blackjack.spec.ts
```

Temporarily enable all locales; inspect casual/ranked Blackjack including split layout, settings, advice, countdown/result, and narrow controls; revert activation.

Run `bun run test`, `bun run lint`, `bun run format:check`, `bun run build`.

---

## Task 5 / PR 5: Small Client-Module Games

**Purpose:** Localize Slots, Sic Bo, Pai Gow Poker, Three-Card Showdown, and Video Poker while converting player-facing validation strings to stable codes.

**Files:**
- Create: `src/lib/i18n/messages/slots.ts`
- Create: `src/lib/i18n/messages/sic-bo.ts`
- Create: `src/lib/i18n/messages/pai-gow-poker.ts`
- Create: `src/lib/i18n/messages/three-card-showdown.ts`
- Create: `src/lib/i18n/messages/video-poker.ts`
- Modify: `src/lib/bet-validation.ts`
- Modify: `src/lib/bet-validation.test.ts`
- Modify: `src/pages/games/slots.astro`, `src/lib/slots/slotsClient.ts`, `src/lib/slots/slotsClient.test.ts`
- Modify: `src/pages/games/sic-bo.astro`, `src/lib/sic-bo/game.ts`, `src/lib/sic-bo/game.test.ts`, `src/lib/sic-bo/client.ts`, `src/lib/sic-bo/client.init.test.ts`
- Modify: `src/pages/games/pai-gow-poker.astro`, `src/lib/pai-gow-poker/game.ts`, `src/lib/pai-gow-poker/game.test.ts`, `src/lib/pai-gow-poker/rules.ts`, `src/lib/pai-gow-poker/rules.test.ts`, `src/lib/pai-gow-poker/client.ts`, `src/lib/pai-gow-poker/client.init.test.ts`
- Modify: `src/pages/games/three-card-showdown.astro`, `src/lib/three-card-showdown/game.ts`, `src/lib/three-card-showdown/game.test.ts`, `src/lib/three-card-showdown/client.ts`, `src/lib/three-card-showdown/client.init.test.ts`
- Modify: `src/pages/games/video-poker.astro`, `src/lib/video-poker/game.ts`, `src/lib/video-poker/game.test.ts`, `src/lib/video-poker/client.ts`, `src/lib/video-poker/client.init.test.ts`
- Test: `e2e/slots.spec.ts`, `e2e/sic-bo.spec.ts`, `e2e/pai-gow-poker.spec.ts`, `e2e/three-card-showdown.spec.ts`, `e2e/video-poker.spec.ts`

**Interfaces:**
- Produces: `validateBetCode()` while preserving current English `validateBet()` only for unmigrated callers.
- Produces: local closed wager/arrangement code unions in migrated games.

- [ ] **Step 1: Add the language-neutral shared bet-validation result**

Add:

```ts
export type BetValidationCode = 'invalid-limits' | 'invalid-range' | 'out-of-range';
export function validateBetCode(amount: number, minBet: number, maxBet: number): BetValidationCode | null;
```

Refactor current `validateBet()` to wrap it and preserve current English strings temporarily. Test codes directly.

- [ ] **Step 2: Convert game-specific displayed validation to codes**

Sic Bo, Three-Card Showdown, and Video Poker `getWagerError()` return a local closed union of `BetValidationCode` plus `whole-number-required` / `insufficient-balance` codes. Pai Gow applies the same wager rule and replaces arrangement error strings with `PaiGowArrangementErrorCode`.

Clients translate codes; invariant exceptions may carry codes but cannot source UI copy.

- [ ] **Step 3: Move Pai Gow display identities/accessibility into i18n**

Move `CATEGORY_LABELS` to the Pai Gow dictionary. Keep visible rank glyphs; localize Jack/Queen/King/Ace, suits, Joker, and complete accessible card names.

- [ ] **Step 4: Localize all five surfaces and chip formatting**

Translate title/back link, balance/wager labels, actions, status/outcomes, rules/paytables, settlement failure/retry/reset, settings, ARIA/title/alt text. Remove `$`/bare chip conventions and direct locale formatting from owned files; use `formatChips()`.

- [ ] **Step 5: Preserve evaluator identities**

Translate hand/category names only where rendered. Evaluator/domain category values remain unchanged.

- [ ] **Step 6: Run tests and visual verification**

```bash
bun test src/lib/bet-validation.test.ts src/lib/slots src/lib/sic-bo src/lib/pai-gow-poker src/lib/three-card-showdown src/lib/video-poker
bunx playwright test e2e/slots.spec.ts e2e/sic-bo.spec.ts e2e/pai-gow-poker.spec.ts e2e/three-card-showdown.spec.ts e2e/video-poker.spec.ts
```

Append canonical terms for the five games to the glossary, including the labels actually used by their rules/paytables. Temporarily enable all locales; inspect paytables, action grids, Pai Gow arrangement/accessibility, and narrow labels; revert activation.

Run `bun run test`, `bun run lint`, `bun run format:check`, `bun run build`.

---

## Task 6 / PR 6: Baccarat, Roulette, and Keno

**Purpose:** Localize the three renderer-heavy public games through existing renderer/client seams.

**Files:**
- Create: `src/lib/i18n/messages/baccarat.ts`
- Create: `src/lib/baccarat/BaccaratUIRenderer.test.ts`
- Modify: `src/pages/games/baccarat.astro`
- Modify: `src/lib/baccarat/BaccaratUIRenderer.ts`
- Modify: `src/lib/baccarat/llmBaccaratStrategy.ts`
- Modify: `src/lib/baccarat/llmBaccaratStrategy.test.ts`
- Create: `src/lib/i18n/messages/roulette.ts`
- Modify: `src/pages/games/roulette.astro`
- Modify: `src/lib/roulette/RouletteUIRenderer.ts`
- Modify: `src/lib/roulette/RouletteUIRenderer.test.ts`
- Modify: `src/lib/roulette/rouletteClient.ts`
- Modify: `src/lib/roulette/rouletteClient.integration.test.ts`
- Modify: `src/lib/roulette/spin-error-classification.ts`
- Modify: `src/lib/roulette/spin-error-classification.test.ts`
- Create: `src/lib/i18n/messages/keno.ts`
- Modify: `src/pages/games/keno.astro`
- Modify: `src/lib/keno/KenoUIRenderer.ts`
- Modify: `src/lib/keno/KenoUIRenderer.test.ts`
- Modify: `src/lib/keno/kenoClient.ts`
- Modify: `src/lib/keno/kenoClient.test.ts`
- Test: `e2e/baccarat.spec.ts`, `e2e/roulette.spec.ts`, `e2e/keno.spec.ts`

- [ ] **Step 1: Add representative non-English renderer tests**

Set document locale in renderer/client tests and assert one Japanese or Traditional Chinese dynamic state for each game before implementation.

- [ ] **Step 2: Localize Baccarat**

Translate SSR rules/actions and renderer state/outcomes. Deterministic/LLM advice keeps authoritative recommendation neutral and localizes only explanation. Convert any displayed shared bet validation to `validateBetCode()` + Baccarat messages. Use `formatChips()` and remove direct locale formatting.

- [ ] **Step 3: Localize Roulette code-to-copy mapping**

Keep `SpinHttpError` status/code unchanged. Change:

```ts
messageForSpinRejection(err: SpinHttpError, locale: Locale): string
```

Resolve `401`, `INSUFFICIENT_BALANCE`, `SETTLEMENT_CONFLICT`, and default rejection in Roulette messages. Translate page/renderer/client state, recovery, accessibility, and chip values; remove `$` and implicit `toLocaleString()`.

- [ ] **Step 4: Localize Keno**

Translate page, selection guidance, quick-pick/clear/draw, result/status, payouts, recovery, errors, and accessibility using existing renderer/client seams. Replace bare chip values and direct locale formatting with `formatChips()`.

- [ ] **Step 5: Run tests and visual verification**

```bash
bun test src/lib/baccarat src/lib/roulette src/lib/keno
bunx playwright test e2e/baccarat.spec.ts e2e/roulette.spec.ts e2e/keno.spec.ts
```

Append canonical Baccarat/Roulette/Keno terms used by the dictionaries to the glossary. Temporarily enable all locales; inspect all three layouts/result panels at desktop/mobile; revert activation.

Run `bun run test`, `bun run lint`, `bun run format:check`, `bun run build`.

---

## Task 7 / PR 7: Craps

**Purpose:** Localize the largest remaining individual game and remove its display strings from domain validation/constants before touching Poker.

**Files:**
- Create: `src/lib/i18n/messages/craps.ts`
- Modify: `src/pages/games/craps.astro`
- Modify: `src/lib/craps/types.ts`
- Modify: `src/lib/craps/constants.ts`
- Modify: `src/lib/craps/CrapsGame.ts`
- Modify: `src/lib/craps/CrapsGame.test.ts`
- Modify: `src/lib/craps/llmCrapsStrategy.ts`
- Modify: `src/lib/craps/craps-advice.test.ts`
- Test: `e2e/craps.spec.ts`

**Interfaces:**
- Produces: language-neutral runtime `BET_TYPES` plus `BetType` derived from it.
- Produces: `CrapsBetErrorCode` + structured message context from `CrapsGame.canPlaceBet()`.
- Changes: localized bet labels become exhaustive `Record<BetType, string>` presentation data.

- [ ] **Step 1: Make Craps bet identity exhaustive without English labels**

Replace the handwritten type-only union with one runtime key source:

```ts
export const BET_TYPES = [
  'passLine', 'dontPass', 'passLineOdds', 'dontPassOdds',
  'come', 'dontCome', 'place4', 'place5', 'place6', 'place8',
  'place9', 'place10', 'field', 'big6', 'big8', 'buy4', 'buy5',
  'buy6', 'buy8', 'buy9', 'buy10', 'lay4', 'lay5', 'lay6',
  'lay8', 'lay9', 'lay10', 'hard4', 'hard6', 'hard8', 'hard10',
  'any7', 'anyCraps', 'aceDeuce', 'aces', 'boxcars', 'yo', 'ce',
] as const;
export type BetType = (typeof BET_TYPES)[number];
```

Use the neutral key list/set for restored-state membership validation. Remove `BET_LABELS` from domain constants; `messages/craps.ts` provides an exhaustive localized `Record<BetType, string>`.

- [ ] **Step 2: Convert `canPlaceBet()` to stable codes/context**

Change the result from `{ ok: boolean; error?: string }` to a closed code result such as:

```ts
export type CrapsBetErrorCode =
  | 'invalid-amount'
  | 'come-out-only'
  | 'point-only'
  | 'missing-pass-line'
  | 'missing-dont-pass'
  | 'duplicate-pass-line'
  | 'duplicate-dont-pass'
  | 'below-minimum'
  | 'above-maximum'
  | 'above-max-odds'
  | 'insufficient-balance';
```

Return numeric/context values separately (`min`, `max`, `remaining`, `multiplier`, `betType`) rather than embedding them in English. Update `CrapsGame.test.ts` to assert code/context.

- [ ] **Step 3: Localize Craps page/advice and chips**

Translate table labels/descriptions, status/results, settings, recovery, rules, bet validation, advice, and accessibility. Use the typed bet-label dictionary and `formatChips()`; remove `$` and direct `toLocale*` formatting from Craps-owned files.

- [ ] **Step 4: Run tests and visual verification**

```bash
bun test src/lib/craps
bunx playwright test e2e/craps.spec.ts
```

Append canonical Craps terms (including Pass Line, Don't Pass, Come, Don't Come, Odds, Place, Buy, Lay, Hardway, Field) to the glossary. Temporarily enable all locales; inspect table cell sizing, bet descriptions, errors, settings, and results at desktop/mobile; revert.

Run `bun run test`, `bun run lint`, `bun run format:check`, `bun run build`.

---

## Task 8 / PR 8: Single-Player Poker and Multiplayer Poker

**Purpose:** Localize the remaining Poker surfaces while leaving shared multiplayer/server protocol values unchanged.

**Files:**
- Create: `src/lib/i18n/messages/poker.ts`
- Create: `src/lib/i18n/messages/multiplayer-poker.ts`
- Modify: `src/pages/games/poker.astro`
- Modify: `src/lib/poker/constants.ts`
- Modify: `src/lib/poker/PokerUIRenderer.ts`
- Modify: `src/lib/poker/PokerUIRenderer.test.ts`
- Modify: `src/lib/poker/AIRivalAssistant.ts`
- Modify: `src/lib/poker/AIRivalAssistant.test.ts`
- Modify: `src/lib/poker/llmAIStrategy.ts`
- Modify: `src/lib/poker/llmAIStrategy.test.ts`
- Modify: `src/pages/games/poker-mp/index.astro`
- Modify: `src/pages/games/poker-mp/[code].astro`
- Modify: `src/lib/mp-poker/client.ts`
- Modify: `src/lib/mp-poker/client.test.ts`
- Test: `e2e/poker-turn-flow.spec.ts`
- Test: `e2e/multiplayer-poker.spec.ts`

**Interfaces:**
- Keeps: `src/lib/mp-poker/protocol.ts` and server room protocol values language-neutral.
- Changes: poker hand labels become presentation data keyed by a closed `HAND_RANKINGS` identity instead of positional English `HAND_NAMES`.

- [ ] **Step 1: Replace positional Poker hand names with a closed presentation key**

Keep `HAND_RANKINGS` as the neutral ranking source. Define/use `PokerHandNameKey = keyof typeof HAND_RANKINGS` (or an equivalent closed key already carried by the evaluator) and remove English `HAND_NAMES` as presentation data.

`messages/poker.ts` provides all hand labels exhaustively by that key. Renderer logic must set/translate a hand key, not a raw English hand name.

- [ ] **Step 2: Localize single-player Poker**

Translate page actions, table labels, status, phase/pot text, settings, AI rival/advice, errors, rules, and accessible card/hand copy. Replace opponent/pot/bet/balance `$...toLocaleString()` paths with `formatChips()` and locale helpers. Provider prompts request active language but cannot change authoritative decisions.

- [ ] **Step 3: Localize multiplayer Poker without translating protocol**

Translate lobby/create/join copy and room/table/action/status/error/accessibility in the two Astro pages and `mp-poker/client.ts`. Use existing protocol codes/state as lookup inputs; do not alter protocol message types, room codes, timers, websocket/server state.

- [ ] **Step 4: Run tests and visual verification**

```bash
bun test src/lib/poker src/lib/mp-poker
bunx playwright test e2e/poker-turn-flow.spec.ts
bun run test:e2e:mp
```

Append canonical Poker/MP terms (Fold, Check, Call, Raise, Pot, Blinds, and hand categories) to the glossary. Temporarily enable all locales; inspect single-player Poker, MP lobby, and an MP room, especially action/status wrapping; revert.

Run `bun run test`, `bun run lint`, `bun run format:check`, `bun run build`.

---

## Task 9 / PR 9: Completeness Audit, Permanent Formatting Guard, Visual QA, and Locale Activation

**Purpose:** Remove remaining English/formatting compatibility seams, install permanent enforcement, then expose Traditional Chinese, Simplified Chinese, and Japanese together.

**Files:**
- Modify: `src/lib/i18n/locale.ts`
- Modify: `src/lib/i18n/locale.test.ts`
- Modify: `eslint.config.js`
- Create: `e2e/i18n-activation.spec.ts`
- Modify: `src/lib/bet-validation.ts`
- Modify: `src/lib/bet-validation.test.ts`
- Modify: any already-migrated presentation file only when the explicit audits below identify a remaining player-facing leak

- [ ] **Step 1: Audit all ad-hoc production locale formatting, including implicit locale calls**

Run a broad search; do not search only for `en-US`:

```bash
rg -n "\.toLocale(String|DateString|TimeString)\(|new Intl\.(NumberFormat|DateTimeFormat|RelativeTimeFormat|ListFormat)" \
  src/pages src/components src/lib \
  --glob '!src/lib/formatting.ts' \
  --glob '!src/lib/i18n/**' \
  --glob '!*.test.ts'
```

Every player-facing match must be replaced by `src/lib/formatting.ts` / i18n presentation helpers. If an internal non-player production use genuinely needs an exception, move that locale operation behind an explicitly named shared helper rather than leaving an inline call.

Expected before enabling the lint guard: zero matches outside the allowed shared modules.

- [ ] **Step 2: Install the permanent ESLint formatting guard**

After Step 1 is clean, add an ESLint flat-config block for production `src/**/*.{ts,tsx,astro}` excluding `src/lib/formatting.ts`, `src/lib/i18n/**`, and test files.

Use `no-restricted-syntax` selectors to reject:

- member calls named `toLocaleString`, `toLocaleDateString`, or `toLocaleTimeString`;
- direct `Intl` constructor/call formatting outside the allowed shared modules.

The message should direct developers to `src/lib/formatting.ts` / `src/lib/i18n/`. Run `bun run lint` and keep this rule permanently after rollout.

- [ ] **Step 3: Audit known English-bearing presentation seams and chip convention**

Run:

```bash
rg -n "Retry settlement|Reset round|Wager must|Bet must be|Wager exceeds|Player wins|Dealer wins|High Card|Royal Flush|Jack|Queen|King|Ace|Joker| chips" src/pages src/components src/lib
```

Inspect every production match. Player-facing copy must resolve from a dictionary/helper; invariant exceptions/logs may stay English only when they are not surfaced.

Also inspect player-facing `$` usage in game/profile/progression files and verify virtual chip amounts use `formatChips()` rather than currency/bare-number conventions. Payout ratios such as `3:2` remain unchanged.

- [ ] **Step 4: Remove the temporary English `validateBet()` wrapper**

```bash
rg -n "\bvalidateBet\(" src --glob '!src/lib/bet-validation.ts' --glob '!*.test.ts'
```

Convert any remaining production caller to `validateBetCode()` and localized presentation, then delete `validateBet()` and its English-string tests. Keep `validateBetCode()`.

- [ ] **Step 5: Verify compile-time dictionary coverage and runtime cross-module coverage**

Do **not** add a runtime test that imports every message module to compare keys; TypeScript already enforces feature key parity.

Keep/run the one runtime cross-module test that the shared games catalog covers every `GAME_TYPES` member plus lobby extras. Run:

```bash
bun test src/lib/i18n
bun run build
```

- [ ] **Step 6: Enable all four locales**

Set:

```ts
export const ENABLED_LOCALES = SUPPORTED_LOCALES;
```

Update request-resolution tests for enabled Japanese/Chinese cookies and browser languages. Confirm Daily Challenge's guest response already varies on `Cookie, Accept-Language` from Task 3.

- [ ] **Step 7: Add the one browser activation E2E**

`e2e/i18n-activation.spec.ts` starts without locale cookie using a supported non-English browser language, verifies first-response locale, changes language through the picker, verifies `arcturus_locale`, navigates/reloads, and asserts persisted `<html lang>` / `data-locale` plus representative shell, game, and progression labels.

Do not duplicate every E2E suite four times.

- [ ] **Step 8: Final four-locale visual QA**

Inspect in all four locales at desktop/narrow widths:

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

Check clipping, wrapping, controls/tables, font fallback, accessibility labels, chip phrasing, and dynamic status/results. Add a CJK font only if this exposes a real defect not solved by layout/system fallback.

- [ ] **Step 9: Final verification**

```bash
bun run test
bun run lint
bun run format:check
bun run build
bun run test:e2e:ci
bun run test:e2e:mp
```

Suggested commits: `fix: close i18n completeness gaps`, `chore: enforce shared locale formatting`, `feat: enable four-language localization`.

---

## Rollout Summary

| Ticket / PR | Surface | Production locales after merge |
| --- | --- | --- |
| 1 | Foundation, game names, chip convention, shell, glossary | English only |
| 2 | Home, auth, profile, statistics, achievements, achievement JSON boundaries | English only |
| 3 | Missions, leaderboard, Daily Challenge, cache variation | English only |
| 4 | Blackjack + ranked Blackjack | English only |
| 5 | Slots, Sic Bo, Pai Gow, Three-Card, Video Poker | English only |
| 6 | Baccarat, Roulette, Keno | English only |
| 7 | Craps | English only |
| 8 | Poker + multiplayer Poker | English only |
| 9 | Completeness, permanent lint guard, activation | English + Traditional Chinese + Simplified Chinese + Japanese |

The sequence establishes shared reuse points before copy migration, closes finite domain keys before removing embedded display text, isolates the largest game PR before implementation begins, and makes formatting enforcement permanent only after legacy call sites have been migrated. Do not add another i18n abstraction unless an actual translation requirement cannot be expressed by these primitives.