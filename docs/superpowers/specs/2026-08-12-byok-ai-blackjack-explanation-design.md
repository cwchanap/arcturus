# HPA-185: Browser-local BYOK AI + Blackjack Explanation Design

## Status

Planning specification for HPA-185. This is a design-only change; feature implementation belongs in a follow-up PR.

## Why this is next

The architecture roadmap in HPA-167 orders the work as HPA-542 → HPA-545 → HPA-185 → HPA-195 → HPA-553. HPA-545 merged into `main` in PR #30, so HPA-185 is now the next unblocked roadmap item.

## Problem

Arcturus already supports OpenAI and Gemini in several single-player AI features, but the provider boundary is duplicated instead of modular:

- `src/lib/blackjack/llmBlackjackStrategy.ts`, `src/lib/craps/llmCrapsStrategy.ts`, `src/lib/baccarat/llmBaccaratStrategy.ts`, `src/lib/poker/llmAIStrategy.ts`, and `src/lib/poker/AIRivalAssistant.ts` each know provider URLs, headers, request shapes, response extraction, and timeout behavior.
- API keys are stored in D1 through `src/lib/llm-settings.ts`, exposed through `/api/profile/llm-settings` and `/api/profile/reveal-api-key`, and then shipped back to browser callers.
- `/api/craps-advice` exists largely because Craps needs the server to retrieve that stored key before calling the provider.
- Blackjack currently lets the model choose the recommended action, even though a legal deterministic strategy can decide the action without an LLM.
- Blackjack also makes automatic post-round commentary requests, which adds cost without helping the core “what should I do and why?” experience.

The result is more code and infrastructure than this hobby project needs, while adding friction to future single-player AI features.

## Goals

1. Create one small browser-side `src/lib/ai` module that owns BYOK settings and OpenAI/Gemini HTTP mapping.
2. Store one active provider/model/API-key record in browser `localStorage`; remove D1 AI credential persistence and its API endpoints.
3. Migrate active OpenAI/Gemini callers to the shared AI client while keeping game prompts and game response validation inside each game module.
4. Make Blackjack recommendation selection deterministic and legal; use the configured model only to rewrite the deterministic explanation after an explicit “Ask AI Rival” click.
5. Remove automatic Blackjack post-round AI commentary.
6. Prefer deletion over adapters, compatibility paths, provider frameworks, or a repository-wide module reorganization.

## Non-goals

- No server-side provider proxy.
- No encrypted credential vault or cross-device settings sync.
- No migration of D1 keys or existing browser keys. Users re-enter a key after the breaking change.
- No provider SDK dependency; keep the existing `fetch`-based approach.
- No provider plugin system, model router, fallback provider, streaming, agents, tools, prompt registry, conversation memory, vector storage, usage metering, audit trail, or rate-limit service.
- No broad rewrite of game AI strategy. Poker, Baccarat, and Craps retain their current prompt semantics and game-specific parsers.
- No restructuring from `src/lib/<domain>` to a new repository-wide `src/modules` hierarchy.

## Approaches considered

### A. Small `src/lib/ai` module + browser-local settings — selected

Add a focused AI module alongside the already-established `src/lib/wallet` and per-game directories. It owns only stable shared concepts: the current BYOK settings record and the two provider HTTP mappings. Game modules continue to own prompts, legal-action rules, and result interpretation.

This actually removes the duplicated boundary while matching the current repository layout.

### B. Extract provider HTTP but keep D1-backed key storage — rejected

This would reduce some duplicated request code but preserve the settings repository, profile APIs, reveal endpoint, server/client serialization, and Craps server proxy. The ticket is specifically an opportunity to remove that machinery, and there is no cross-device requirement justifying it.

### C. Start a new `src/modules` hierarchy and migrate game packages — rejected

The roadmap describes modular-monolith boundaries, not a mandatory directory rename. Creating a second module root while most code remains under `src/lib` would increase concepts and PR size without improving HPA-185.

## Proposed module boundary

```text
src/lib/ai/
  types.ts
  settings.ts
  client.ts
  index.ts
```

Do not split OpenAI and Gemini into a provider-interface hierarchy. There are only two concrete providers; a switch inside `client.ts` is easier to read and change.

### Public types

```ts
export type AiProvider = 'openai' | 'gemini';

export interface AiSettings {
  provider: AiProvider;
  model: string;
  apiKey: string;
}

export interface AiGenerateRequest {
  system?: string;
  prompt: string;
  temperature?: number;
  maxOutputTokens?: number;
}

export type AiErrorCode =
  | 'missing-key'
  | 'timeout'
  | 'provider-error'
  | 'invalid-response';

export type AiResult<T> =
  | { ok: true; value: T }
  | { ok: false; code: AiErrorCode; message: string };
```

`AiResult` exists so every game does not repeat HTTP/timeout detection. It deliberately stops at four caller-relevant outcomes; it is not a provider error taxonomy.

### Settings API

```ts
export const AI_SETTINGS_STORAGE_KEY = 'arcturus-ai-settings';
export const AI_PROVIDERS = ['openai', 'gemini'] as const;
export const AI_MODELS = {
  openai: ['gpt-4o'],
  gemini: ['gemini-2.5-flash', 'gemini-2.5-flash-lite'],
} as const;

export function loadAiSettings(): AiSettings | null;
export function saveAiSettings(settings: AiSettings): void;
export function clearAiSettings(): void;
```

One browser stores one current provider/model/key record. Switching provider replaces the record; it does not retain a second hidden provider key. Invalid/missing local data loads as `null`. There is no version key and no migration logic.

The model list intentionally stays the same as today. Updating available models is a separate product decision, not part of this architecture ticket.

### Provider client API

```ts
export const AI_REQUEST_TIMEOUT_MS = 5_000;

export function generateAiText(
  settings: AiSettings,
  request: AiGenerateRequest,
): Promise<AiResult<string>>;

export function generateAiJson(
  settings: AiSettings,
  request: AiGenerateRequest,
): Promise<AiResult<Record<string, unknown>>>;
```

`client.ts` uses the existing `fetchWithTimeout` helper. It owns:

- OpenAI `/v1/chat/completions` URL, authorization header, messages request shape, and text extraction.
- Gemini `generateContent` URL, API-key query parameter, contents request shape, and text extraction.
- One 5-second timeout.
- Non-2xx normalization.
- Extraction/parsing of one JSON object for `generateAiJson`.

It does not validate fields such as `action`, `move`, `suggestedBets`, or `reasoning`; those are game-domain concerns.

## Profile settings flow

`/profile` remains the existing place where a signed-in player configures AI, but its AI panel becomes entirely client-side:

1. Server rendering no longer reads AI settings from D1.
2. On script initialization, the page calls `loadAiSettings()`.
3. The form displays the active provider/model and a masked local key.
4. Save writes the full current record through `saveAiSettings()`.
5. Show/copy reads the already-local key; no reveal API call exists.
6. Clear calls `clearAiSettings()`.
7. Copy explains that the key is stored in this browser only and that switching provider replaces the current provider/key.

Keep the profile page authenticated as it is today. The `ai` module itself has no authentication concept; games may keep their current guest UX policy without putting auth logic into the shared module.

## Persistence deletion

Remove the `llm_settings` table from `src/db/schema.ts` and from the fresh-database migration sources that create it. Delete `src/lib/llm-settings.ts`, `/api/profile/llm-settings`, `/api/profile/reveal-api-key`, and the now-unused profile API wrapper.

Do not add a compatibility read, key migration, dual-write path, or D1-to-localStorage export. Existing development databases may be reset when implementing this change, consistent with HPA-167’s no-backward-compatibility rule.

## Blackjack behavior

### Deterministic recommendation is authoritative

Refactor the current basic-strategy fallback into a pure function, for example:

```ts
export function getBlackjackStrategyAdvice(
  context: BlackjackAdviceContext,
): BlackjackAdvice;
```

It receives the current hand, dealer up-card, and `availableActions`. It always returns an action contained in `availableActions` plus a concise deterministic explanation.

The existing basic-strategy rules are the starting point, but the implementation tests must cover the important legal branches already exposed by the game: hit, stand, double-down, split, and unavailable-action fallback. HPA-185 is not a full casino-strategy-table research project.

### Model only improves the explanation

On explicit “Ask AI Rival” click:

1. Compute `deterministic = getBlackjackStrategyAdvice(context)` first.
2. Render that recommendation regardless of provider configuration.
3. If local AI settings are configured, call `generateAiJson()` once with the fixed deterministic action and context.
4. Ask the model only for a short `reasoning` rewrite. Do not ask it to choose the action.
5. If a response contains any action field anyway, ignore it.
6. If the request times out, errors, or returns invalid JSON/reasoning, keep the deterministic explanation.

This makes legality independent of provider availability and removes the current failure state where provider trouble can replace useful local advice with “Unable to get advice.”

### Remove automatic commentary

Delete `getRoundCommentary()` and the post-round call from `blackjackClient.ts`. Remove the associated commentary DOM if it becomes unused. The model is invoked only by the explicit advice button.

## Other game migrations

The transport migration is mechanical and deliberately does not centralize game behavior:

- **Poker LLM opponents:** `llmAIStrategy.ts` keeps prompt construction, decision parsing, cache, and rule-based fallback. It replaces its private OpenAI/Gemini calls with `generateAiJson()`.
- **Poker AI Rival:** `AIRivalAssistant.ts` loads the local record through `loadAiSettings()` and uses the shared provider client. It keeps poker move validation/highlighting.
- **Baccarat:** `llmBaccaratStrategy.ts` keeps session prompt, suggested-bet validation, and confidence interpretation; only provider HTTP moves out.
- **Craps:** `llmCrapsStrategy.ts` keeps prompt and `CrapsAdvice` parsing. `craps.astro` loads local settings and calls it directly. Delete `/api/craps-advice` and its server-route validation tests rather than reproducing a browser-to-server-to-provider hop with no server-owned credential.

No game imports another game’s AI code. All import only the narrow `src/lib/ai` public API.

## Testing strategy

### Shared AI module

Unit-test settings round-trip/clear/invalid data and provider request mapping with mocked `fetch`. Verify timeout/non-2xx/malformed-provider-response normalization and JSON extraction.

### Blackjack

Unit-test deterministic action legality and the important hit/stand/double/split branches. Test that configured AI can change explanation text but never the deterministic action, and that provider failure returns the same deterministic result.

### Migrated games

Update existing Poker/Baccarat/Craps strategy tests to mock `generateAiJson()` or provider fetch through the shared client. Preserve existing domain-parser/fallback assertions; do not add duplicate tests for provider request shapes to every game.

### Integration/E2E

Keep one representative Blackjack browser flow proving the no-provider path: play/deal to a player decision, click Ask AI, and see a legal recommendation without any provider request. Update profile integration/E2E assertions for browser-local settings and remove API-endpoint expectations. Delete Craps server-advice route tests and cover the client-side button path at its existing game-test level.

## Failure behavior

- Missing key: games render their existing unconfigured state or deterministic/rule-based fallback.
- Provider timeout/non-2xx: shared client returns an error result; games fall back locally.
- Malformed JSON: shared client returns `invalid-response`; games fall back locally.
- Invalid `localStorage` record: treat as unconfigured.
- `localStorage` write failure: the profile save handler reports failure; no retry subsystem is introduced.

## Security and privacy stance

The key is a user-supplied BYOK credential stored in ordinary browser `localStorage` and sent directly from the browser to the selected provider. This is intentionally not a hardened secret-storage design. The UI must state “stored in this browser only.” Do not log or render the key outside explicit show/copy controls.

## Definition of done

- `src/lib/ai` is the only active OpenAI/Gemini HTTP implementation.
- One browser-local settings record replaces D1 AI settings.
- D1 schema/table helpers and AI settings/reveal endpoints are gone.
- `/api/craps-advice` is gone.
- Blackjack always chooses a legal deterministic action and only uses AI to rewrite the explanation after explicit user action.
- Automatic Blackjack round commentary is gone.
- Poker, Baccarat, Craps, and Blackjack retain their game-specific prompt/validation behavior while sharing provider transport.
- Tests cover the AI contract, deterministic Blackjack behavior, migrated callers, profile local settings, and one representative no-provider Blackjack E2E flow.
