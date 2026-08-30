# Arcturus i18n Localization Design

## Summary

Add full player-facing localization for English, Traditional Chinese, Simplified Chinese, and Japanese while keeping the existing route structure unchanged.

The design intentionally avoids a translation framework, locale-prefixed routes, database-backed language settings, or a translation CMS. Arcturus only needs four in-repo locales today, so a small typed TypeScript translation layer is sufficient and easier to maintain.

## Goals

- Support `en`, `zh-Hant`, `zh-Hans`, and `ja`.
- Fully localize player-facing UI, including game names and casino terminology.
- Support both server-rendered Astro markup and browser-side game/controller messages.
- Keep domain state and persistence language-neutral.
- Persist the selected locale without changing URLs.
- Avoid exposing partially translated locales.
- Keep the rollout incremental, with one PR per implementation ticket.

## Non-goals

- Locale-prefixed routes such as `/ja/games/blackjack`.
- SEO-oriented per-locale page trees.
- Database or account-level locale synchronization.
- Translation management SaaS/CMS integration.
- ICU MessageFormat, plural-rule frameworks, or runtime i18n dependencies unless future requirements justify them.
- Automatic machine translation at runtime.
- Adding CJK webfonts before visual testing shows system font fallback is insufficient.

## Locale Model

Canonical locales:

- `en` — English
- `zh-Hant` — Traditional Chinese
- `zh-Hans` — Simplified Chinese
- `ja` — Japanese

The language picker uses native labels:

- English
- 繁體中文
- 简体中文
- 日本語

`Arcturus` remains unchanged as a product/proper name. Normal UI text, game names, game rules, casino terminology, status text, missions, leaderboards, profile/auth copy, accessibility text, and achievement presentation are localized.

## Locale Resolution

URLs remain unchanged.

The locale resolution order is:

1. `arcturus_locale` cookie when it contains a supported locale.
2. Browser `Accept-Language` on first visit.
3. English fallback.

Browser-language normalization stays deliberately small:

- `zh-TW`, `zh-HK`, `zh-MO`, and `zh-Hant*` → `zh-Hant`
- `zh-CN`, `zh-SG`, `zh-Hans*`, and bare `zh` → `zh-Hans`
- `ja*` → `ja`
- `en*` → `en`
- everything else → `en`

Middleware resolves the locale once per request and exposes it through `Astro.locals.locale`. `AppLayout` uses that locale for `<html lang>` and locale-aware formatting.

The language picker writes the locale cookie and reloads the current URL. No redirect or route rewriting is required.

## Translation Architecture

Use a small in-repo TypeScript translation layer.

Suggested structure:

```text
src/i18n/
  locale.ts
  translate.ts
  messages/
    common.ts
    home.ts
    profile.ts
    missions.ts
    leaderboard.ts
    blackjack.ts
    roulette.ts
    ...
```

Messages are grouped by feature rather than by locale. Each feature module contains the same message keys for all four locales.

This keeps feature ownership clear and allows browser-side game code to import only the messages it needs instead of shipping the full casino translation catalog.

A lightweight `defineMessages()` helper validates that all locale variants in a feature expose the same keys. A small `t()` helper performs lookup and simple named interpolation such as `{value}`.

Do not add ICU parsing or a general message-expression language. Complete sentence templates should be preferred over assembling fragments so Chinese and Japanese word order remains natural.

## Server and Browser Usage

The translation primitive must be plain TypeScript so it can be used from both Astro templates and client-side controllers.

Server-rendered pages obtain the locale from `Astro.locals.locale` and resolve messages during SSR.

Browser-side game controllers receive or read the selected locale and use the same feature dictionaries for dynamic messages such as:

- round outcomes
- recovery/error messages
- game status updates
- action labels
- settings feedback
- AI advisor status/reasoning presentation

No client-only translation pass should be required after initial rendering, avoiding language flash.

## Domain and Persistence Boundary

Domain state remains language-neutral.

Do not persist translated text in D1, local game state, or game result payloads when a stable identifier or value can be stored instead.

Examples:

- game type remains `blackjack`, not a localized game name
- blackjack actions remain enums such as `hit`, `stand`, `double-down`, `split`
- achievement identity remains the achievement ID
- mission identity remains the mission ID/key
- leaderboard/game statistics remain numeric/domain values

Presentation resolves localized names, descriptions, and sentences from those identifiers.

### Achievements

Achievement rules should continue to own IDs, categories, icons, thresholds, and unlock logic. Player-facing achievement names/descriptions should come from i18n messages such as `achievement.rising_star.name` and `achievement.rising_star.description`.

Numeric thresholds are interpolated and formatted using the active locale instead of hard-coded `en-US` formatting.

### AI Advisor Text

The authoritative game decision remains language-neutral. For deterministic advice, reasoning templates are localized locally.

When an optional AI provider rewrites/explains an already-selected action, the prompt should request the active locale. The provider must not be allowed to change the authoritative action merely because localization is enabled.

## Formatting

Replace hard-coded locale formatting such as `Intl.NumberFormat('en-US')` with locale-aware helpers based on the selected canonical locale.

Use `Intl` for:

- numbers
- percentages
- dates/times where displayed

Keep language-neutral symbols/identifiers unchanged where appropriate, including:

- card rank symbols `A`, `K`, `Q`, `J`
- payout ratios such as `3:2`
- room codes
- usernames
- API/provider/model names
- chip numeric values

## Fonts

Do not add a bundled CJK font initially.

The existing display/body fonts can fall back to system CJK fonts. Validate the four locales visually on supported platforms. Add a CJK font only if readability, weight matching, or layout quality is materially poor.

## Locale Availability and Fallback

English is the source/authoring locale.

During migration, missing non-English messages may fall back to English internally so development builds remain usable. However, a locale must not become selectable in production until completeness checks prove that its required key set matches English for all migrated player-facing surfaces.

Use a simple `ENABLED_LOCALES` list for picker visibility. Initially only `en` is enabled. `zh-Hant`, `zh-Hans`, and `ja` are enabled together after the final completeness pass.

Do not add environment flags, database flags, or a feature-flag service for locale activation.

## Rollout

Implement incrementally. Every rollout ticket maps to one PR.

Recommended sequence:

1. i18n foundation + global shell
   - locale parsing/resolution
   - `Astro.locals.locale`
   - translation helpers and message typing/completeness checks
   - language picker
   - layout/nav/footer
   - locale-aware formatting helpers

2. Home, auth, profile, and achievements

3. Missions, leaderboard, and daily challenge

4. Core games batch A

5. Core games batch B

6. Remaining games and multiplayer surfaces

7. Final completeness/visual pass and enable `zh-Hant`, `zh-Hans`, and `ja`

Exact game batching should be chosen from current file size and coupling when implementation tickets are created. Do not force one game per PR when a small coherent batch is easier to review and maintain.

## Testing

Keep testing focused on behavior rather than duplicating every existing E2E case four times.

### Foundation tests

Unit-test:

- cookie precedence
- supported/unsupported cookie parsing
- `Accept-Language` normalization
- English fallback
- interpolation
- locale-aware formatting helpers
- translation key completeness

Add one focused Playwright flow that:

- changes language
- verifies the locale cookie
- reloads/navigates
- verifies persistence
- verifies `<html lang>`
- verifies at least one global shell label changes

### Surface migration tests

For each migrated feature:

- preserve existing behavioral tests
- replace fragile English-text selectors with stable test IDs where needed
- add a small locale-specific assertion proving the migrated surface resolves localized text

Do not create four copies of every game E2E suite.

## Error Handling

Unsupported or malformed locale values fall back to English.

Missing development-time translations may fall back to English, but completeness validation must prevent incomplete locales from being enabled for players.

Translation lookup should stay deterministic and local; localization must never block game logic, wallet settlement, authentication, or persistence.

## Design Constraints

- No schema changes.
- No route changes.
- No runtime i18n dependency unless a future requirement exceeds the small translation layer.
- No translated values in core domain state.
- No partially translated locale exposed in the production picker.
- Prefer feature-local dictionaries and small helpers over a generic localization subsystem.
