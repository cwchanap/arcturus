# Browser-local BYOK AI + Blackjack Explanation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace duplicated/server-backed AI provider plumbing with one browser-local BYOK AI module and make Blackjack advice deterministic, legal, explicit, and useful without a provider.

**Architecture:** Add a narrow `src/lib/ai` module for one local settings record plus OpenAI/Gemini HTTP mapping. Keep prompts, legal-action rules, result validation, and fallbacks inside each game; delete D1 credential persistence and server proxy paths instead of adapting them. Blackjack computes the action deterministically first and invokes a provider only to rewrite that explanation after the user clicks Ask AI.

**Tech Stack:** TypeScript, Astro 5, Bun test, Vitest, Playwright, browser `localStorage`, existing `fetchWithTimeout`, Cloudflare/D1 only for unrelated application data.

## Global Constraints

- Keep the existing Astro + Cloudflare Worker + D1 modular monolith and `src/lib/<domain>` layout; do not introduce a second `src/modules` hierarchy.
- Follow YAGNI/KISS: no provider plugin framework, provider SDK dependency, server proxy, streaming, agents, tools, prompt registry, provider routing/fallback, usage service, audit trail, or credential vault.
- Store exactly one active `{ provider, model, apiKey }` record under `arcturus-ai-settings` in browser `localStorage`.
- Preserve the current model choices: OpenAI `gpt-4o`; Gemini `gemini-2.5-flash` and `gemini-2.5-flash-lite`.
- Use one provider timeout: `5_000` ms.
- Do not migrate D1 API keys, previous browser formats, or compatibility APIs; users re-enter a key after the breaking change.
- The shared AI module owns provider URL/header/request/response mapping only. Games continue to own prompts and game-domain validation.
- Blackjack’s deterministic recommendation is authoritative and must always be one of `availableActions` excluding `ask-ai`.
- A Blackjack provider request occurs only after an explicit Ask AI click and may change explanation text only, never the recommended action.
- Remove automatic Blackjack post-round LLM commentary.
- Do not log API-key values.

---

## File Structure

**Create**
- `src/lib/ai/types.ts`
- `src/lib/ai/settings.ts`
- `src/lib/ai/client.ts`
- `src/lib/ai/index.ts`
- `src/lib/ai/settings.test.ts`
- `src/lib/ai/client.test.ts`
- `src/lib/baccarat/llmBaccaratStrategy.test.ts`

**Modify**
- `src/pages/profile.astro`
- `src/lib/profile-ui-state.ts`
- `src/lib/profile-form-handlers.ts`
- `integration/profile-page.test.ts`
- `e2e/profile.spec.ts`
- `src/db/schema.ts`
- `drizzle/0000_powerful_wrecking_crew.sql`
- `src/lib/blackjack/llmBlackjackStrategy.ts`
- `src/lib/blackjack/llmBlackjackStrategy.test.ts`
- `src/lib/blackjack/blackjackClient.ts`
- `src/lib/blackjack/blackjackClient.init.test.ts`
- `src/pages/games/blackjack.astro`
- `e2e/blackjack-llm.spec.ts`
- `src/lib/craps/llmCrapsStrategy.ts`
- `src/pages/games/craps.astro`
- `src/lib/craps/craps-advice.test.ts`
- `src/lib/baccarat/llmBaccaratStrategy.ts`
- `src/lib/poker/llmAIStrategy.ts`
- `src/lib/poker/llmAIStrategy.test.ts`
- `src/lib/poker/AIRivalAssistant.ts`
- `src/lib/poker/AIRivalAssistant.test.ts`
- `src/lib/poker/PokerGame.ts`
- `src/lib/poker/PokerGame.test.ts`
- `e2e/public-single-player-games.spec.ts` only to remove an existing interception if its current `/api/profile/llm-settings` reference remains after Task 5.

**Delete**
- `src/lib/llm-settings.ts`
- `src/lib/profile-api.ts`
- `src/pages/api/profile/llm-settings.ts`
- `src/pages/api/profile/reveal-api-key.ts`
- `src/pages/api/craps-advice.ts`
- `src/lib/craps/craps-advice-validation.test.ts`
- `drizzle/0002_jittery_firebrand.ts`

---

### Task 1: Add the shared AI settings and provider client

**Files:**
- Create: `src/lib/ai/types.ts`
- Create: `src/lib/ai/settings.ts`
- Create: `src/lib/ai/client.ts`
- Create: `src/lib/ai/index.ts`
- Create: `src/lib/ai/settings.test.ts`
- Create: `src/lib/ai/client.test.ts`
- Reuse: `src/lib/fetch-with-timeout.ts`

**Interfaces:**
- Consumes: `fetchWithTimeout(url: string, init: RequestInit, timeoutMs: number): Promise<Response>`.
- Produces: `AiProvider`, `AiSettings`, `AiGenerateRequest`, `AiErrorCode`, `AiResult<T>`, `AI_PROVIDERS`, `AI_MODELS`, `AI_SETTINGS_STORAGE_KEY`, `AI_REQUEST_TIMEOUT_MS`, `loadAiSettings()`, `saveAiSettings()`, `clearAiSettings()`, `generateAiText()`, and `generateAiJson()`.

- [ ] **Step 1: Write the failing settings contract tests**

```ts
import { afterEach, describe, expect, test } from 'bun:test';
import {
  AI_SETTINGS_STORAGE_KEY,
  clearAiSettings,
  loadAiSettings,
  saveAiSettings,
} from './settings';

const memory = new Map<string, string>();
Object.defineProperty(globalThis, 'localStorage', {
  configurable: true,
  value: {
    getItem: (key: string) => memory.get(key) ?? null,
    setItem: (key: string, value: string) => void memory.set(key, value),
    removeItem: (key: string) => void memory.delete(key),
  },
});

afterEach(() => memory.clear());

test('round-trips and replaces the one active provider record', () => {
  saveAiSettings({ provider: 'openai', model: 'gpt-4o', apiKey: 'sk-test' });
  expect(loadAiSettings()).toEqual({ provider: 'openai', model: 'gpt-4o', apiKey: 'sk-test' });

  saveAiSettings({ provider: 'gemini', model: 'gemini-2.5-flash', apiKey: 'AIza-test' });
  expect(loadAiSettings()).toEqual({
    provider: 'gemini',
    model: 'gemini-2.5-flash',
    apiKey: 'AIza-test',
  });
});

test('malformed and unsupported records load as unconfigured', () => {
  localStorage.setItem(AI_SETTINGS_STORAGE_KEY, '{broken');
  expect(loadAiSettings()).toBeNull();
  localStorage.setItem(
    AI_SETTINGS_STORAGE_KEY,
    JSON.stringify({ provider: 'other', model: 'x', apiKey: 'secret' }),
  );
  expect(loadAiSettings()).toBeNull();
});

test('clear removes the current record', () => {
  saveAiSettings({ provider: 'openai', model: 'gpt-4o', apiKey: 'sk-test' });
  clearAiSettings();
  expect(loadAiSettings()).toBeNull();
});
```

- [ ] **Step 2: Run the settings tests and verify they fail**

Run: `bun test src/lib/ai/settings.test.ts`

Expected: FAIL because `./settings` does not exist.

- [ ] **Step 3: Implement the shared types and browser persistence**

```ts
// src/lib/ai/types.ts
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

export type AiErrorCode = 'missing-key' | 'timeout' | 'provider-error' | 'invalid-response';
export type AiResult<T> =
  | { ok: true; value: T }
  | { ok: false; code: AiErrorCode; message: string };
```

```ts
// src/lib/ai/settings.ts
import type { AiProvider, AiSettings } from './types';

export const AI_SETTINGS_STORAGE_KEY = 'arcturus-ai-settings';
export const AI_PROVIDERS = ['openai', 'gemini'] as const;
export const AI_MODELS: Record<AiProvider, readonly string[]> = {
  openai: ['gpt-4o'],
  gemini: ['gemini-2.5-flash', 'gemini-2.5-flash-lite'],
};

function isAiSettings(value: unknown): value is AiSettings {
  if (!value || typeof value !== 'object') return false;
  const candidate = value as Partial<AiSettings>;
  if (candidate.provider !== 'openai' && candidate.provider !== 'gemini') return false;
  return (
    typeof candidate.model === 'string' &&
    AI_MODELS[candidate.provider].includes(candidate.model) &&
    typeof candidate.apiKey === 'string' &&
    candidate.apiKey.trim().length > 0
  );
}

export function loadAiSettings(): AiSettings | null {
  if (typeof localStorage === 'undefined') return null;
  try {
    const raw = localStorage.getItem(AI_SETTINGS_STORAGE_KEY);
    if (!raw) return null;
    const parsed: unknown = JSON.parse(raw);
    return isAiSettings(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

export function saveAiSettings(settings: AiSettings): void {
  localStorage.setItem(
    AI_SETTINGS_STORAGE_KEY,
    JSON.stringify({ ...settings, apiKey: settings.apiKey.trim() }),
  );
}

export function clearAiSettings(): void {
  localStorage.removeItem(AI_SETTINGS_STORAGE_KEY);
}
```

- [ ] **Step 4: Run the settings tests and verify they pass**

Run: `bun test src/lib/ai/settings.test.ts`

Expected: PASS.

- [ ] **Step 5: Write failing provider-client tests for both mappings and normalized failures**

```ts
import { afterEach, expect, mock, test } from 'bun:test';
import { generateAiJson, generateAiText } from './client';

const originalFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = originalFetch; });

test('OpenAI request maps chat-completions and extracts text', async () => {
  globalThis.fetch = mock(async (_url, init) => {
    const body = JSON.parse(String(init?.body)) as { model: string; messages: Array<{ content: string }> };
    expect(body.model).toBe('gpt-4o');
    expect(body.messages.at(-1)?.content).toBe('Explain this move');
    return new Response(JSON.stringify({ choices: [{ message: { content: 'Stand here.' } }] }));
  }) as typeof fetch;

  expect(await generateAiText(
    { provider: 'openai', model: 'gpt-4o', apiKey: 'sk-test' },
    { system: 'Be concise', prompt: 'Explain this move' },
  )).toEqual({ ok: true, value: 'Stand here.' });
});

test('Gemini request extracts and parses one JSON object', async () => {
  globalThis.fetch = mock(async () => new Response(JSON.stringify({
    candidates: [{ content: { parts: [{ text: '```json\n{"reasoning":"Dealer is weak"}\n```' }] } }],
  }))) as typeof fetch;

  expect(await generateAiJson(
    { provider: 'gemini', model: 'gemini-2.5-flash', apiKey: 'AIza-test' },
    { prompt: 'Explain' },
  )).toEqual({ ok: true, value: { reasoning: 'Dealer is weak' } });
});

test('non-2xx, abort, and malformed JSON use normalized error codes', async () => {
  globalThis.fetch = mock(async () => new Response('rate limited', { status: 429 })) as typeof fetch;
  const non2xx = await generateAiText(
    { provider: 'openai', model: 'gpt-4o', apiKey: 'sk-test' },
    { prompt: 'x' },
  );
  expect(non2xx.ok).toBe(false);
  if (!non2xx.ok) expect(non2xx.code).toBe('provider-error');

  globalThis.fetch = mock(async () => { throw new DOMException('Aborted', 'AbortError'); }) as typeof fetch;
  const timeout = await generateAiText(
    { provider: 'openai', model: 'gpt-4o', apiKey: 'sk-test' },
    { prompt: 'x' },
  );
  expect(timeout.ok).toBe(false);
  if (!timeout.ok) expect(timeout.code).toBe('timeout');

  globalThis.fetch = mock(async () => new Response('{not-json')) as typeof fetch;
  const malformed = await generateAiText(
    { provider: 'openai', model: 'gpt-4o', apiKey: 'sk-test' },
    { prompt: 'x' },
  );
  expect(malformed.ok).toBe(false);
  if (!malformed.ok) expect(malformed.code).toBe('invalid-response');
});
```

- [ ] **Step 6: Run the client tests and verify they fail**

Run: `bun test src/lib/ai/client.test.ts`

Expected: FAIL because `./client` does not exist.

- [ ] **Step 7: Implement one concrete two-provider switch and JSON helper**

```ts
// src/lib/ai/client.ts
import { fetchWithTimeout } from '../fetch-with-timeout';
import type { AiGenerateRequest, AiResult, AiSettings } from './types';

export const AI_REQUEST_TIMEOUT_MS = 5_000;

type OpenAiPayload = { choices?: Array<{ message?: { content?: string } }> };
type GeminiPayload = { candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }> };

async function requestProvider(settings: AiSettings, request: AiGenerateRequest): Promise<Response> {
  const temperature = request.temperature ?? 0.3;
  const maxOutputTokens = request.maxOutputTokens ?? 200;
  if (settings.provider === 'openai') {
    return fetchWithTimeout('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${settings.apiKey}` },
      body: JSON.stringify({
        model: settings.model,
        messages: [
          ...(request.system ? [{ role: 'system', content: request.system }] : []),
          { role: 'user', content: request.prompt },
        ],
        temperature,
        max_tokens: maxOutputTokens,
      }),
    }, AI_REQUEST_TIMEOUT_MS);
  }

  return fetchWithTimeout(
    `https://generativelanguage.googleapis.com/v1beta/models/${settings.model}:generateContent?key=${settings.apiKey}`,
    {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        contents: [{ role: 'user', parts: [{ text: `${request.system ? `${request.system}\n\n` : ''}${request.prompt}` }] }],
        generationConfig: { temperature, maxOutputTokens },
      }),
    },
    AI_REQUEST_TIMEOUT_MS,
  );
}

export async function generateAiText(
  settings: AiSettings,
  request: AiGenerateRequest,
): Promise<AiResult<string>> {
  if (!settings.apiKey.trim()) return { ok: false, code: 'missing-key', message: 'API key not configured' };

  let response: Response;
  try {
    response = await requestProvider(settings, request);
  } catch (error) {
    return error instanceof Error && error.name === 'AbortError'
      ? { ok: false, code: 'timeout', message: 'AI request timed out' }
      : { ok: false, code: 'provider-error', message: 'AI request failed' };
  }

  if (!response.ok) {
    return { ok: false, code: 'provider-error', message: `Provider request failed (${response.status})` };
  }

  let data: OpenAiPayload | GeminiPayload;
  try {
    data = await response.json() as OpenAiPayload | GeminiPayload;
  } catch {
    return { ok: false, code: 'invalid-response', message: 'Provider returned invalid JSON' };
  }

  const value = settings.provider === 'openai'
    ? (data as OpenAiPayload).choices?.[0]?.message?.content
    : (data as GeminiPayload).candidates?.[0]?.content?.parts?.map((part) => part.text ?? '').join('');
  return typeof value === 'string' && value.trim()
    ? { ok: true, value: value.trim() }
    : { ok: false, code: 'invalid-response', message: 'Provider returned no text' };
}

export async function generateAiJson(
  settings: AiSettings,
  request: AiGenerateRequest,
): Promise<AiResult<Record<string, unknown>>> {
  const text = await generateAiText(settings, request);
  if (!text.ok) return text;
  const match = text.value.match(/\{[\s\S]*\}/);
  if (!match) return { ok: false, code: 'invalid-response', message: 'Provider returned no JSON object' };
  try {
    return { ok: true, value: JSON.parse(match[0]) as Record<string, unknown> };
  } catch {
    return { ok: false, code: 'invalid-response', message: 'Provider returned invalid JSON object' };
  }
}
```

```ts
// src/lib/ai/index.ts
export type { AiProvider, AiSettings, AiGenerateRequest, AiErrorCode, AiResult } from './types';
export { AI_PROVIDERS, AI_MODELS, AI_SETTINGS_STORAGE_KEY, loadAiSettings, saveAiSettings, clearAiSettings } from './settings';
export { AI_REQUEST_TIMEOUT_MS, generateAiText, generateAiJson } from './client';
```

- [ ] **Step 8: Run the new module tests, lint it, and commit**

Run: `bun test src/lib/ai/settings.test.ts src/lib/ai/client.test.ts && bunx eslint src/lib/ai`

Expected: PASS with zero lint warnings.

```bash
git add src/lib/ai
git commit -m "feat: add browser-local AI module"
```

---

### Task 2: Move Profile AI settings to the browser and delete D1 credential storage

**Files:**
- Modify: `src/pages/profile.astro`
- Modify: `src/lib/profile-ui-state.ts`
- Modify: `src/lib/profile-form-handlers.ts`
- Modify: `integration/profile-page.test.ts`
- Modify: `e2e/profile.spec.ts`
- Modify: `src/db/schema.ts`
- Modify: `drizzle/0000_powerful_wrecking_crew.sql`
- Delete: `src/lib/llm-settings.ts`
- Delete: `src/lib/profile-api.ts`
- Delete: `src/pages/api/profile/llm-settings.ts`
- Delete: `src/pages/api/profile/reveal-api-key.ts`
- Delete: `drizzle/0002_jittery_firebrand.ts`

**Interfaces:**
- Consumes: `AI_MODELS`, `AI_PROVIDERS`, `loadAiSettings()`, `saveAiSettings()`, `clearAiSettings()`.
- Produces: profile UI state `AiState = { provider, model, apiKey }` and no server-side AI credential contract.

- [ ] **Step 1: Change profile tests to require local persistence and zero settings API calls**

```ts
// e2e/profile.spec.ts representative case
await page.goto('/profile');
await page.selectOption('#ai-provider', 'openai');
await page.selectOption('#ai-model', 'gpt-4o');
await page.fill('#api-key', 'sk-e2e-local');
await page.click('#ai-settings-form button[type="submit"]');

const stored = await page.evaluate(() => localStorage.getItem('arcturus-ai-settings'));
expect(JSON.parse(stored!)).toEqual({ provider: 'openai', model: 'gpt-4o', apiKey: 'sk-e2e-local' });
await page.reload();
await expect(page.locator('#api-key-status')).toContainText('Saved');
```

In `integration/profile-page.test.ts`, remove `getLlmSettings` setup and assert that rendering the profile no longer performs an AI-settings D1 read.

- [ ] **Step 2: Run focused profile tests and verify they fail**

Run: `vitest run integration/profile-page.test.ts`

Expected: FAIL because `profile.astro` still imports/executes `getLlmSettings`.

- [ ] **Step 3: Simplify profile state and form persistence to one active key**

```ts
// src/lib/profile-ui-state.ts
export interface AiState {
  provider: 'openai' | 'gemini';
  model: string;
  apiKey: string;
}
```

```ts
// src/lib/profile-form-handlers.ts
import { saveAiSettings, type AiSettings } from './ai';

export function buildAiSettingsFromForm(
  provider: AiSettings['provider'],
  model: string,
  inputValue: string,
  current: AiSettings | null,
): AiSettings | null {
  const masked = /^•+$/.test(inputValue);
  const apiKey = masked && current?.provider === provider ? current.apiKey : inputValue.trim();
  return apiKey ? { provider, model, apiKey } : null;
}
```

The submit handler calls `saveAiSettings()` only for a non-null result and uses existing profile feedback for success/failure. Show/copy read `aiState.apiKey` directly; clear calls `clearAiSettings()` and resets `apiKey` to `''`.

- [ ] **Step 4: Remove the server AI read and initialize Profile from local storage**

```ts
// profile.astro client script
import { AI_MODELS, loadAiSettings } from '../lib/ai';

const stored = loadAiSettings();
let aiState: AiState = stored ?? {
  provider: 'openai',
  model: AI_MODELS.openai[0],
  apiKey: '',
};
```

Remove `getLlmSettings()` from the server `Promise.all` and remove `aiSettingsPayload`. Keep model/provider constants for rendering dropdown options. Change help copy to `Stored in this browser only. Switching provider replaces the current provider and API key.`

- [ ] **Step 5: Delete D1/API credential code and fresh-schema creation**

Delete the listed API/helper files and `drizzle/0002_jittery_firebrand.ts`. Delete the `llmSettings` export from `src/db/schema.ts` and the complete `CREATE TABLE IF NOT EXISTS "llm_settings" (...)` block from `drizzle/0000_powerful_wrecking_crew.sql`.

Do not add a drop/backfill migration. Reset/recreate local development D1 before manual verification instead of preserving old keys.

- [ ] **Step 6: Prove the old contract is gone and run Profile/build verification**

Run:

```bash
rg "llm-settings|reveal-api-key|getLlmSettings|upsertLlmSettings|llm_settings" src integration e2e drizzle
vitest run integration/profile-page.test.ts
bun run build
```

Expected: source/test/migration scan has zero active matches; integration test and build PASS.

- [ ] **Step 7: Commit**

```bash
git add src/pages/profile.astro src/lib/profile-ui-state.ts src/lib/profile-form-handlers.ts integration/profile-page.test.ts e2e/profile.spec.ts src/db/schema.ts drizzle
git add -u src/lib/llm-settings.ts src/lib/profile-api.ts src/pages/api/profile/llm-settings.ts src/pages/api/profile/reveal-api-key.ts
git commit -m "refactor: keep BYOK AI settings in browser"
```

---

### Task 3: Make Blackjack advice deterministic and provider-optional

**Files:**
- Modify: `src/lib/blackjack/llmBlackjackStrategy.ts`
- Modify: `src/lib/blackjack/llmBlackjackStrategy.test.ts`
- Modify: `src/lib/blackjack/blackjackClient.ts`
- Modify: `src/lib/blackjack/blackjackClient.init.test.ts`
- Modify: `src/pages/games/blackjack.astro`

**Interfaces:**
- Consumes: `AiSettings`, `generateAiJson()`, `loadAiSettings()`.
- Produces: `getBlackjackStrategyAdvice(context): BlackjackAdvice` and `getBlackjackAdvice(context, settings): Promise<BlackjackAdvice>` with deterministic legal `recommendedAction`.

- [ ] **Step 1: Write failing deterministic-authority tests**

```ts
test('hard 16 against dealer 10 recommends a legal hit', () => {
  const context = makeContext({ playerRanks: ['10', '6'], dealerRank: '10', availableActions: ['hit', 'stand'] });
  const advice = getBlackjackStrategyAdvice(context);
  expect(advice.recommendedAction).toBe('hit');
  expect(context.availableActions).toContain(advice.recommendedAction);
});

test('provider reasoning cannot replace the deterministic action', async () => {
  const context = makeContext({ playerRanks: ['10', '6'], dealerRank: '10', availableActions: ['hit', 'stand'] });
  mockGenerateAiJson.mockResolvedValue({ ok: true, value: { action: 'stand', reasoning: 'Dealer pressure favors taking a card.' } });
  const advice = await getBlackjackAdvice(context, AI_SETTINGS);
  expect(advice.recommendedAction).toBe('hit');
  expect(advice.reasoning).toContain('Dealer pressure');
});

test('provider failure returns exactly the deterministic advice', async () => {
  const context = makeContext({ playerRanks: ['10', '6'], dealerRank: '10', availableActions: ['hit', 'stand'] });
  const local = getBlackjackStrategyAdvice(context);
  mockGenerateAiJson.mockResolvedValue({ ok: false, code: 'timeout', message: 'AI request timed out' });
  expect(await getBlackjackAdvice(context, AI_SETTINGS)).toEqual(local);
});
```

Keep/add explicit fixtures for stand, double-down, split, and the fallback where the preferred move is absent from `availableActions`.

- [ ] **Step 2: Run the strategy tests and verify they fail**

Run: `bun test src/lib/blackjack/llmBlackjackStrategy.test.ts`

Expected: FAIL because `getBlackjackStrategyAdvice` does not exist and current provider output can select the action.

- [ ] **Step 3: Export the current basic-strategy logic as the authoritative function and enforce legality**

```ts
export function getBlackjackStrategyAdvice(context: BlackjackAdviceContext): BlackjackAdvice {
  const { playerHand, dealerUpCard, availableActions } = context;
  const handValue = calculateHandValue(playerHand.cards);
  const dealerValue = ['J', 'Q', 'K'].includes(dealerUpCard.rank)
    ? 10
    : dealerUpCard.rank === 'A'
      ? 11
      : Number.parseInt(dealerUpCard.rank, 10);

  let action: BlackjackAction = 'stand';
  let reasoning = '';

  if (handValue.value <= 11) {
    action = 'hit';
    reasoning = `With ${handValue.value}, take a card because this total cannot bust on one hit.`;
  } else if (handValue.value >= 17) {
    action = 'stand';
    reasoning = `With ${handValue.value}, stand rather than take unnecessary bust risk.`;
  } else if (dealerValue >= 7) {
    action = 'hit';
    reasoning = `With ${handValue.value} against dealer ${dealerValue}, improve the hand against a strong up-card.`;
  } else {
    action = 'stand';
    reasoning = `With ${handValue.value} against dealer ${dealerValue}, let the dealer take the bust risk.`;
  }

  if (availableActions.includes('double-down') && (handValue.value === 10 || handValue.value === 11)) {
    action = 'double-down';
    reasoning = `With ${handValue.value}, double down while the one-card upside is strong.`;
  }

  if (availableActions.includes('split') && playerHand.cards.length === 2) {
    const [first, second] = playerHand.cards;
    if (first.rank === second.rank && (first.rank === 'A' || first.rank === '8')) {
      action = 'split';
      reasoning = `Split ${first.rank}s according to the current basic-strategy rule.`;
    }
  }

  const legalActions = availableActions.filter((candidate) => candidate !== 'ask-ai');
  if (!legalActions.includes(action)) {
    action = legalActions.includes('hit')
      ? 'hit'
      : legalActions.includes('stand')
        ? 'stand'
        : legalActions[0];
  }

  return {
    recommendedAction: action ?? null,
    reasoning: `${reasoning} (basic strategy)`,
    confidence: 1,
    raw: '',
  };
}
```

- [ ] **Step 4: Ask the provider only to rewrite the fixed explanation**

```ts
export async function getBlackjackAdvice(
  context: BlackjackAdviceContext,
  settings: AiSettings | null,
): Promise<BlackjackAdvice> {
  const deterministic = getBlackjackStrategyAdvice(context);
  if (!settings || !deterministic.recommendedAction) return deterministic;

  const result = await generateAiJson(settings, {
    system: 'Explain the already-selected Blackjack move. Do not choose a different move.',
    prompt: `Move: ${deterministic.recommendedAction}\nBase explanation: ${deterministic.reasoning}\nReturn {"reasoning":"one concise explanation"}.`,
    temperature: 0.3,
    maxOutputTokens: 120,
  });
  if (!result.ok) return deterministic;

  const reasoning = result.value.reasoning;
  return typeof reasoning === 'string' && reasoning.trim()
    ? { ...deterministic, reasoning: reasoning.trim(), raw: JSON.stringify(result.value) }
    : deterministic;
}
```

Delete Blackjack’s private provider functions and provider-action parser.

- [ ] **Step 5: Remove automatic commentary and load settings locally**

Delete `getRoundCommentary()`, its import/call in `blackjackClient.ts`, and commentary-only DOM from `src/pages/games/blackjack.astro`. Replace `/api/profile/llm-settings` loading with `loadAiSettings()`.

When Ask AI is clicked, call `getBlackjackAdvice(context, loadAiSettings())` and always render the returned recommendation/reasoning. Missing settings no longer opens the configuration overlay instead of advice; deterministic advice is still useful.

- [ ] **Step 6: Add client tests proving no automatic provider invocation**

```ts
test('initialization and round completion do not invoke AI generation', async () => {
  initBlackjackClient();
  await finishOneRound();
  expect(mockGenerateAiJson).not.toHaveBeenCalled();
});

test('Ask AI renders deterministic advice when settings are absent', async () => {
  mockLoadAiSettings.mockReturnValue(null);
  initBlackjackClient();
  await reachPlayerTurn();
  clickAskAi();
  expect(document.getElementById('ai-advice-action')?.textContent).toContain('Recommended:');
});
```

- [ ] **Step 7: Run focused tests and commit**

Run: `bun test src/lib/blackjack/llmBlackjackStrategy.test.ts src/lib/blackjack/blackjackClient.init.test.ts`

Expected: PASS.

```bash
git add src/lib/blackjack src/pages/games/blackjack.astro
git commit -m "feat: make blackjack advice deterministic"
```

---

### Task 4: Move Craps advice from the server proxy to the browser

**Files:**
- Modify: `src/lib/craps/llmCrapsStrategy.ts`
- Modify: `src/pages/games/craps.astro`
- Rewrite: `src/lib/craps/craps-advice.test.ts`
- Delete: `src/pages/api/craps-advice.ts`
- Delete: `src/lib/craps/craps-advice-validation.test.ts`

**Interfaces:**
- Consumes: `AiSettings`, `generateAiJson()`, `loadAiSettings()`.
- Produces: existing `getCrapsAdvice(context, settings): Promise<CrapsAdvice>` without an Astro API route.

- [ ] **Step 1: Replace route tests with a failing Craps-domain strategy test**

```ts
mockGenerateAiJson.mockResolvedValue({
  ok: true,
  value: { advice: 'Take odds behind the pass line.', suggestedBets: ['passLine'], confidence: 'high' },
});
const result = await getCrapsAdvice({
  phase: 'come-out',
  point: null,
  chipBalance: 1000,
  activeBets: [{ id: 'bet-1', type: 'passLine', amount: 25 }],
  rollHistory: [{ die1: 3, die2: 4, total: 7 }],
}, AI_SETTINGS);
expect(result.suggestedBets).toEqual(['passLine']);
expect(result.confidence).toBe('high');
```

Delete route auth/DB/request-body cases from `craps-advice.test.ts`; that server boundary will no longer exist.

- [ ] **Step 2: Run the Craps advice test and verify it fails**

Run: `bun test src/lib/craps/craps-advice.test.ts`

Expected: FAIL until `llmCrapsStrategy.ts` uses the shared client mock.

- [ ] **Step 3: Keep Craps validation local and replace provider HTTP**

```ts
function parsePayload(payload: Record<string, unknown>): CrapsAdvice {
  const suggestedBets = Array.isArray(payload.suggestedBets)
    ? payload.suggestedBets.filter(
        (value): value is BetType => typeof value === 'string' && Object.hasOwn(BET_LABELS, value),
      )
    : [];
  const confidence = payload.confidence === 'low' || payload.confidence === 'high'
    ? payload.confidence
    : 'medium';
  return {
    advice: typeof payload.advice === 'string' ? payload.advice : 'Prefer low-house-edge bets.',
    suggestedBets: suggestedBets.length ? suggestedBets : ['passLine'],
    confidence,
    raw: JSON.stringify(payload),
  };
}

export async function getCrapsAdvice(ctx: CrapsAdviceContext, settings: AiSettings): Promise<CrapsAdvice> {
  const result = await generateAiJson(settings, {
    system: buildSystemPrompt(),
    prompt: buildPrompt(ctx),
    temperature: 0.8,
    maxOutputTokens: 250,
  });
  if (!result.ok) throw new Error(result.message);
  return parsePayload(result.value);
}
```

Delete the private OpenAI/Gemini calls and local `LLMSettings` type.

- [ ] **Step 4: Call the strategy directly from the existing Craps advice button**

```ts
import { loadAiSettings } from '../../lib/ai';
import { getCrapsAdvice } from '../../lib/craps/llmCrapsStrategy';

llmAdviceBtn.addEventListener('click', async () => {
  const settings = loadAiSettings();
  if (!settings) {
    llmAdviceEl.textContent = 'Configure an AI provider in Profile to use advice.';
    return;
  }
  const state = game.getState();
  try {
    const advice = await getCrapsAdvice({
      phase: state.phase,
      point: state.point,
      activeBets: state.activeBets,
      rollHistory: state.rollHistory,
      chipBalance: state.chipBalance,
    }, settings);
    llmAdviceEl.textContent = advice.advice;
  } catch {
    llmAdviceEl.textContent = 'AI advice is unavailable. You can keep playing normally.';
  }
});
```

- [ ] **Step 5: Delete the proxy and route-only validation test, scan, test, and commit**

Run:

```bash
rm src/pages/api/craps-advice.ts src/lib/craps/craps-advice-validation.test.ts
rg "/api/craps-advice|getLlmSettings" src/lib/craps src/pages/games/craps.astro
bun test src/lib/craps
bun run build
```

Expected: scan has zero matches; tests/build PASS.

```bash
git add src/lib/craps src/pages/games/craps.astro
git add -u src/pages/api/craps-advice.ts
git commit -m "refactor: call craps AI from browser"
```

---

### Task 5: Migrate Baccarat and both Poker AI paths to the shared provider client

**Files:**
- Create: `src/lib/baccarat/llmBaccaratStrategy.test.ts`
- Modify: `src/lib/baccarat/llmBaccaratStrategy.ts`
- Modify: `src/lib/poker/llmAIStrategy.ts`
- Modify: `src/lib/poker/llmAIStrategy.test.ts`
- Modify: `src/lib/poker/AIRivalAssistant.ts`
- Modify: `src/lib/poker/AIRivalAssistant.test.ts`
- Modify: `src/lib/poker/PokerGame.ts`
- Modify: `src/lib/poker/PokerGame.test.ts`

**Interfaces:**
- Consumes: `AiSettings`, `generateAiJson()`, `loadAiSettings()`.
- Produces: unchanged game outputs (`BaccaratAdvice`, `AIDecision`, `AiMove`) with no direct provider HTTP outside `src/lib/ai/client.ts`.

- [ ] **Step 1: Add/adjust failing tests around the shared-client seam**

```ts
// Baccarat representative assertion
mockGenerateAiJson.mockResolvedValue({
  ok: true,
  value: { advice: 'Banker has the lowest house edge.', suggestedBets: ['banker'], confidence: 'high' },
});
expect((await getBaccaratAdvice(context, AI_SETTINGS)).suggestedBets).toEqual(['banker']);
```

```ts
// Poker opponent provider failure still uses its existing rule-based fallback
mockGenerateAiJson.mockResolvedValue({
  ok: false,
  code: 'provider-error',
  message: 'Provider request failed (500)',
});
const decision = await makeLLMDecision(context, 'tight-aggressive', AI_SETTINGS);
expect(['fold', 'check', 'call', 'raise']).toContain(decision.action);
expect(decision.reasoning).toContain('fallback');
```

```ts
// Poker AI Rival loads local settings rather than the profile endpoint
mockLoadAiSettings.mockReturnValue({ provider: 'openai', model: 'gpt-4o', apiKey: 'sk-local' });
const rival = new AIRivalAssistant();
await Promise.resolve();
expect(rival).toBeDefined();
expect(profileSettingsFetchSpy).not.toHaveBeenCalled();
```

- [ ] **Step 2: Run focused tests and verify they fail before migration**

Run: `bun test src/lib/baccarat/llmBaccaratStrategy.test.ts src/lib/poker/llmAIStrategy.test.ts src/lib/poker/AIRivalAssistant.test.ts src/lib/poker/PokerGame.test.ts`

Expected: FAIL because current files own provider fetches and Poker still requests profile settings.

- [ ] **Step 3: Refactor Baccarat transport while keeping its parser local**

```ts
function parseBaccaratPayload(payload: Record<string, unknown>): BaccaratAdvice {
  const validBet = (value: unknown): value is BetType =>
    value === 'player' || value === 'banker' || value === 'tie' || value === 'playerPair' || value === 'bankerPair';
  const suggestedBets = Array.isArray(payload.suggestedBets) ? payload.suggestedBets.filter(validBet) : [];
  const confidence = payload.confidence === 'low' || payload.confidence === 'high'
    ? payload.confidence
    : 'medium';
  return {
    advice: typeof payload.advice === 'string' ? payload.advice : 'Banker has the lowest standard house edge.',
    suggestedBets: suggestedBets.length ? suggestedBets : ['banker'],
    confidence,
    raw: JSON.stringify(payload),
  };
}

export async function getBaccaratAdvice(context: BaccaratAdviceContext, settings: AiSettings): Promise<BaccaratAdvice> {
  const result = await generateAiJson(settings, {
    system: buildSystemPrompt(),
    prompt: buildPrompt(context),
    temperature: 0.7,
    maxOutputTokens: 300,
  });
  if (!result.ok) throw new Error(result.message);
  return parseBaccaratPayload(result.value);
}
```

Delete Baccarat’s local `LLMSettings`, timeout constant, `callOpenAI`, and `callGemini`.

- [ ] **Step 4: Refactor Poker LLM opponents without changing cache/fallback policy**

```ts
function ruleBasedFallback(
  context: GameContext,
  personality: AIPersonality,
  difficulty: AIDifficulty,
  suffix: string,
): AIDecision {
  const aiConfig = createAIConfig(personality, difficulty);
  const decision = makeRuleBasedDecision(context, aiConfig);
  return { ...decision, reasoning: `${decision.reasoning} (${suffix})` };
}
```

Change `parseLLMResponse(response, context)` to `parseLLMPayload(payload: Record<string, unknown>, context)` by reading `payload.action` and `payload.amount` with the same current action validation/raise clamping. Then use:

```ts
const result = await generateAiJson(llmSettings, {
  system: 'You are an expert poker AI. Respond only with valid JSON.',
  prompt: buildLLMPrompt(context, personality),
  temperature: 0.7,
  maxOutputTokens: 100,
});
if (!result.ok) return ruleBasedFallback(context, personality, difficulty, 'LLM error fallback');
const decision = parseLLMPayload(result.value, context);
if (!decision) return ruleBasedFallback(context, personality, difficulty, 'LLM parse failed');
decisionCache.set(context, decision);
return decision;
```

Delete `callOpenAI`, `callGemini`, and the local `LLMSettings` type. Keep `DecisionCache` unchanged.

- [ ] **Step 5: Refactor Poker AI Rival and PokerGame settings lookup**

```ts
// AIRivalAssistant.ts
private loadAiSettings(): void {
  this.aiSettings = loadAiSettings();
  this.setButtonState({ disabled: !this.aiSettings });
  this.updateStatus();
}
```

Replace `AIRivalAssistant`’s provider methods with `generateAiJson()` while keeping `parseAiMove()` and highlighting local. In `PokerGame.ts`, replace the asynchronous `/api/profile/llm-settings` helper with `loadAiSettings()` wherever the LLM opponent path obtains settings. Keep current guest gameplay policy in Poker; the shared `ai` module itself must not inspect authentication.

- [ ] **Step 6: Run all affected game tests and the provider-endpoint scan**

Run:

```bash
bun test src/lib/baccarat/llmBaccaratStrategy.test.ts src/lib/poker/llmAIStrategy.test.ts src/lib/poker/AIRivalAssistant.test.ts src/lib/poker/PokerGame.test.ts
rg "api.openai.com|generativelanguage.googleapis.com" src/lib src/pages
```

Expected: tests PASS; provider URLs appear only in `src/lib/ai/client.ts`.

- [ ] **Step 7: Commit**

```bash
git add src/lib/baccarat src/lib/poker
git commit -m "refactor: share AI provider transport"
```

---

### Task 6: Replace old browser contracts with explicit-only Blackjack coverage

**Files:**
- Modify: `e2e/blackjack-llm.spec.ts`
- Modify: `e2e/profile.spec.ts`
- Modify: `e2e/public-single-player-games.spec.ts` only if the final source scan still finds its existing settings-endpoint interception.

**Interfaces:**
- Consumes: browser-local settings and deterministic Blackjack advice.
- Produces: stable browser proof without calling real providers.

- [ ] **Step 1: Replace the old no-key overlay case with deterministic no-provider advice**

Use the existing authenticated `createIsolatedBlackjackPage()` and `dealHand()` helpers:

```ts
test('player without a provider still receives local Blackjack advice', async ({ browser, baseURL }) => {
  const { context, page } = await createIsolatedBlackjackPage(browser, baseURL);
  try {
    await page.addInitScript(() => localStorage.removeItem('arcturus-ai-settings'));
    const providerRequests: string[] = [];
    page.on('request', (request) => {
      if (request.url().includes('api.openai.com') || request.url().includes('generativelanguage.googleapis.com')) {
        providerRequests.push(request.url());
      }
    });

    await gotoBlackjack(page);
    await dealHand(page, 50);
    const aiButton = page.getByRole('button', { name: 'Ask AI Rival' });
    await expect(aiButton).toBeEnabled();
    await aiButton.click();
    await expect(page.locator('#ai-advice-action')).toContainText('Recommended:');
    await expect(page.locator('#ai-advice-reasoning')).not.toBeEmpty();
    expect(providerRequests).toEqual([]);
  } finally {
    await context.close();
  }
});
```

- [ ] **Step 2: Prove a configured provider is called only by the explicit advice click**

```ts
await page.addInitScript(() => localStorage.setItem('arcturus-ai-settings', JSON.stringify({
  provider: 'openai',
  model: 'gpt-4o',
  apiKey: 'sk-fake',
})));
let calls = 0;
await page.route('https://api.openai.com/**', async (route) => {
  calls += 1;
  await route.fulfill({
    status: 200,
    contentType: 'application/json',
    body: JSON.stringify({ choices: [{ message: { content: '{"reasoning":"Local strategy explained."}' } }] }),
  });
});

await gotoBlackjack(page);
await dealHand(page, 50);
expect(calls).toBe(0);
await page.getByRole('button', { name: 'Ask AI Rival' }).click();
await expect.poll(() => calls).toBe(1);
await page.getByRole('button', { name: 'Stand' }).click();
await expect(page.getByRole('button', { name: 'New Round' })).toBeVisible({ timeout: 15000 });
expect(calls).toBe(1);
```

Delete the current “AI commentary appears after round” test. Change the current provider-failure test to assert deterministic advice remains visible instead of “Unable to get advice.”

- [ ] **Step 3: Remove obsolete endpoint interceptions and run targeted E2E**

Run:

```bash
rg "/api/profile/llm-settings|/api/profile/reveal-api-key|/api/craps-advice" e2e integration src
bunx playwright test e2e/blackjack-llm.spec.ts e2e/profile.spec.ts
```

Expected: scan has zero matches; targeted E2E PASS in the repository’s normal E2E environment.

- [ ] **Step 4: Commit**

```bash
git add e2e integration
git commit -m "test: cover browser-local AI flow"
```

---

### Task 7: Full verification and architecture guardrails

**Files:**
- Modify only concrete files implicated by a failing command from this task.

**Interfaces:**
- Consumes: Tasks 1-6.
- Produces: an implementation that satisfies HPA-185 with one provider boundary and no legacy credential path.

- [ ] **Step 1: Run architecture scans**

```bash
rg "api.openai.com|generativelanguage.googleapis.com" src/lib src/pages
rg "llm-settings|reveal-api-key|llm_settings|/api/craps-advice" src integration e2e drizzle
```

Expected: provider URLs only in `src/lib/ai/client.ts`; second scan has zero active matches.

- [ ] **Step 2: Run unit/integration suites**

Run: `bun run test`

Expected: PASS.

- [ ] **Step 3: Run lint, format check, and build**

Run: `bun run lint && bun run format:check && bun run build`

Expected: PASS with zero errors/warnings.

- [ ] **Step 4: Run representative browser coverage**

Run: `bun run test:e2e -- e2e/blackjack-llm.spec.ts e2e/profile.spec.ts e2e/craps.spec.ts`

Expected: PASS.

- [ ] **Step 5: Inspect the final diff for deletion/KISS goals**

```bash
git diff --stat main...HEAD
git diff main...HEAD -- src/lib/ai src/lib/blackjack src/lib/craps src/lib/baccarat src/lib/poker src/pages/profile.astro src/db/schema.ts
```

Verify from the diff that there is one provider transport, one local settings record, no compatibility adapter, no provider abstraction hierarchy, and no automatic Blackjack LLM request.

- [ ] **Step 6: Commit only concrete verification fixes, if the preceding commands changed files**

```bash
git status --short
git add -A
git commit -m "fix: complete HPA-185 AI migration"
```

If `git status --short` is empty, skip the commit command rather than creating an empty commit.
