# Browser-local BYOK AI + Blackjack Explanation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace duplicated/server-backed AI provider plumbing with one browser-local BYOK AI module and make Blackjack advice deterministic, legal, explicit, and useful without a provider.

**Architecture:** Add a narrow `src/lib/ai` public module for one local settings record plus OpenAI/Gemini HTTP mapping. Keep prompts, legal-action logic, response validation, and fallback policy in each game; delete D1 credential persistence and server proxy paths instead of adapting them. Blackjack computes the action deterministically first and invokes a provider only to rewrite that explanation after the user clicks Ask AI.

**Tech Stack:** TypeScript, Astro 5, Bun test, Vitest, Playwright, browser `localStorage`, existing `fetchWithTimeout`, Cloudflare/D1 only for unrelated application data.

## Global Constraints

- Keep one Astro + Cloudflare Worker + D1 modular monolith; do not introduce a second `src/modules` hierarchy.
- Follow YAGNI/KISS: no provider plugin framework, SDK dependency, server proxy, streaming, agents, tools, prompt registry, routing/fallback provider, usage service, audit trail, or credential vault.
- Store exactly one active `{ provider, model, apiKey }` record under `arcturus-ai-settings` in browser `localStorage`.
- Preserve the current provider/model choices: OpenAI `gpt-4o`; Gemini `gemini-2.5-flash` and `gemini-2.5-flash-lite`.
- Use a single AI request timeout of 5,000 ms.
- Do not migrate D1 API keys, old local-storage formats, or compatibility APIs; users re-enter a key after the breaking change.
- The shared AI module owns provider HTTP mapping only; every game continues to own prompts, legal/domain validation, and fallbacks.
- Blackjack’s deterministic recommendation is authoritative and must always be one of the game’s `availableActions`.
- A Blackjack provider request occurs only after an explicit Ask AI action and may change explanation text only, never the recommended action.
- Remove automatic Blackjack post-round LLM commentary.
- Do not log API-key values.

---

## File map

**Create**

- `src/lib/ai/types.ts` — stable settings/request/result types.
- `src/lib/ai/settings.ts` — provider/model constants and one-record browser persistence.
- `src/lib/ai/client.ts` — OpenAI/Gemini request mapping, timeout, text extraction, JSON extraction, normalized errors.
- `src/lib/ai/index.ts` — the only public import surface for shared AI concerns.
- `src/lib/ai/settings.test.ts` — local settings contract.
- `src/lib/ai/client.test.ts` — provider transport contract.

**Modify**

- `src/pages/profile.astro` — remove server AI read; initialize/save/reveal/copy/clear browser-local settings.
- `src/lib/profile-ui-state.ts` — represent one active local provider/key rather than two server-stored key flags.
- `src/lib/profile-form-handlers.ts` — save the local `AiSettings` record rather than POSTing profile APIs.
- `integration/profile-page.test.ts` — profile no longer queries D1 AI settings.
- `e2e/profile.spec.ts` — assert local save/show/copy/clear behavior without AI settings endpoints.
- `src/db/schema.ts` — remove `llmSettings`.
- `drizzle/0000_powerful_wrecking_crew.sql` — remove fresh-schema creation of `llm_settings`.
- `src/lib/blackjack/llmBlackjackStrategy.ts` — deterministic action plus optional explanation rewrite using shared AI client.
- `src/lib/blackjack/llmBlackjackStrategy.test.ts` — authoritative deterministic behavior and provider fallback tests.
- `src/lib/blackjack/blackjackClient.ts` — local settings lookup and explicit advice rendering; remove round commentary request.
- `src/pages/games/blackjack.astro` — remove commentary-only markup/copy if no longer used.
- `src/lib/blackjack/blackjackClient.init.test.ts` — initialization/advice-state expectations.
- `e2e/blackjack-llm.spec.ts` — representative no-provider advice flow and no automatic provider call.
- `src/lib/craps/llmCrapsStrategy.ts` — shared provider client, game-owned prompt/parser.
- `src/pages/games/craps.astro` — direct browser-local settings/advice call.
- `src/lib/craps/craps-advice.test.ts` — game prompt/parser/fallback behavior without server route.
- `src/lib/baccarat/llmBaccaratStrategy.ts` — shared provider client only.
- `src/lib/poker/llmAIStrategy.ts` — shared provider client while retaining cache/rule-based fallback.
- `src/lib/poker/AIRivalAssistant.ts` — local settings + shared provider client.
- `src/lib/poker/PokerGame.ts` — replace profile API settings fetch with `loadAiSettings()`.
- Existing corresponding Poker/Baccarat tests that currently stub provider/profile HTTP.

**Delete**

- `src/lib/llm-settings.ts`
- `src/lib/profile-api.ts`
- `src/pages/api/profile/llm-settings.ts`
- `src/pages/api/profile/reveal-api-key.ts`
- `src/pages/api/craps-advice.ts`
- `drizzle/0002_jittery_firebrand.ts`
- `src/lib/craps/craps-advice-validation.test.ts`
- Server-route-only assertions in `src/lib/craps/craps-advice.test.ts` if they cannot be reused as game-domain assertions.

---

### Task 1: Add the narrow shared AI module

**Files:**
- Create: `src/lib/ai/types.ts`
- Create: `src/lib/ai/settings.ts`
- Create: `src/lib/ai/client.ts`
- Create: `src/lib/ai/index.ts`
- Create: `src/lib/ai/settings.test.ts`
- Create: `src/lib/ai/client.test.ts`
- Reuse: `src/lib/fetch-with-timeout.ts`

**Interfaces:**
- Consumes: existing `fetchWithTimeout(input: RequestInfo | URL, init?: RequestInit, timeoutMs?: number)` behavior.
- Produces: `AiProvider`, `AiSettings`, `AiGenerateRequest`, `AiErrorCode`, `AiResult<T>`, `AI_SETTINGS_STORAGE_KEY`, `AI_PROVIDERS`, `AI_MODELS`, `AI_REQUEST_TIMEOUT_MS`, `loadAiSettings()`, `saveAiSettings()`, `clearAiSettings()`, `generateAiText()`, `generateAiJson()`.

- [ ] **Step 1: Write failing settings contract tests**

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

describe('AI settings', () => {
  test('round-trips exactly one active provider record', () => {
    saveAiSettings({ provider: 'openai', model: 'gpt-4o', apiKey: 'sk-test' });
    expect(loadAiSettings()).toEqual({ provider: 'openai', model: 'gpt-4o', apiKey: 'sk-test' });

    saveAiSettings({ provider: 'gemini', model: 'gemini-2.5-flash', apiKey: 'AIza-test' });
    expect(loadAiSettings()).toEqual({
      provider: 'gemini',
      model: 'gemini-2.5-flash',
      apiKey: 'AIza-test',
    });
  });

  test('returns null for malformed or unsupported records', () => {
    localStorage.setItem(AI_SETTINGS_STORAGE_KEY, '{broken');
    expect(loadAiSettings()).toBeNull();
    localStorage.setItem(
      AI_SETTINGS_STORAGE_KEY,
      JSON.stringify({ provider: 'other', model: 'x', apiKey: 'secret' }),
    );
    expect(loadAiSettings()).toBeNull();
  });

  test('clears the current record', () => {
    saveAiSettings({ provider: 'openai', model: 'gpt-4o', apiKey: 'sk-test' });
    clearAiSettings();
    expect(loadAiSettings()).toBeNull();
  });
});
```

- [ ] **Step 2: Run the settings tests and verify they fail because the module does not exist**

Run: `bun test src/lib/ai/settings.test.ts`

Expected: FAIL with module-resolution errors for `./settings`.

- [ ] **Step 3: Implement the types and one-record settings API**

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
  if (typeof candidate.model !== 'string' || !AI_MODELS[candidate.provider].includes(candidate.model)) {
    return false;
  }
  return typeof candidate.apiKey === 'string' && candidate.apiKey.trim().length > 0;
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
  localStorage.setItem(AI_SETTINGS_STORAGE_KEY, JSON.stringify({
    ...settings,
    apiKey: settings.apiKey.trim(),
  }));
}

export function clearAiSettings(): void {
  localStorage.removeItem(AI_SETTINGS_STORAGE_KEY);
}
```

- [ ] **Step 4: Run the settings tests and verify they pass**

Run: `bun test src/lib/ai/settings.test.ts`

Expected: PASS.

- [ ] **Step 5: Write failing provider-client tests**

```ts
import { afterEach, describe, expect, mock, test } from 'bun:test';
import { generateAiJson, generateAiText } from './client';

const originalFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = originalFetch; });

describe('AI provider client', () => {
  test('maps OpenAI chat completions and extracts text', async () => {
    const fetchMock = mock(async (_input: RequestInfo | URL, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body));
      expect(body.model).toBe('gpt-4o');
      expect(body.messages.at(-1).content).toBe('Explain this move');
      return new Response(JSON.stringify({ choices: [{ message: { content: 'Stand here.' } }] }));
    });
    globalThis.fetch = fetchMock as typeof fetch;

    const result = await generateAiText(
      { provider: 'openai', model: 'gpt-4o', apiKey: 'sk-test' },
      { system: 'Be concise', prompt: 'Explain this move' },
    );
    expect(result).toEqual({ ok: true, value: 'Stand here.' });
  });

  test('maps Gemini generateContent and parses one JSON object', async () => {
    globalThis.fetch = mock(async () =>
      new Response(JSON.stringify({
        candidates: [{ content: { parts: [{ text: '```json\n{"reasoning":"Dealer is weak"}\n```' }] } }],
      })),
    ) as typeof fetch;

    const result = await generateAiJson(
      { provider: 'gemini', model: 'gemini-2.5-flash', apiKey: 'AIza-test' },
      { prompt: 'Explain' },
    );
    expect(result).toEqual({ ok: true, value: { reasoning: 'Dealer is weak' } });
  });

  test('normalizes non-2xx and malformed responses', async () => {
    globalThis.fetch = mock(async () => new Response('rate limited', { status: 429 })) as typeof fetch;
    const providerError = await generateAiText(
      { provider: 'openai', model: 'gpt-4o', apiKey: 'sk-test' },
      { prompt: 'x' },
    );
    expect(providerError.ok).toBeFalse();
    if (!providerError.ok) expect(providerError.code).toBe('provider-error');
  });
});
```

- [ ] **Step 6: Run the client tests and verify they fail because the client is not implemented**

Run: `bun test src/lib/ai/client.test.ts`

Expected: FAIL with missing `generateAiText` / `generateAiJson` exports.

- [ ] **Step 7: Implement the provider switch, 5-second timeout, extraction, and public barrel**

```ts
// src/lib/ai/client.ts
import { fetchWithTimeout } from '../fetch-with-timeout';
import type { AiGenerateRequest, AiResult, AiSettings } from './types';

export const AI_REQUEST_TIMEOUT_MS = 5_000;

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
  try {
    const response = await requestProvider(settings, request);
    if (!response.ok) return { ok: false, code: 'provider-error', message: `Provider request failed (${response.status})` };
    const data = await response.json() as Record<string, any>;
    const value = settings.provider === 'openai'
      ? data.choices?.[0]?.message?.content
      : data.candidates?.[0]?.content?.parts?.map((part: { text?: string }) => part.text ?? '').join('');
    return typeof value === 'string' && value.trim()
      ? { ok: true, value: value.trim() }
      : { ok: false, code: 'invalid-response', message: 'Provider returned no text' };
  } catch (error) {
    return error instanceof Error && error.name === 'AbortError'
      ? { ok: false, code: 'timeout', message: 'AI request timed out' }
      : { ok: false, code: 'provider-error', message: 'AI request failed' };
  }
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
    return { ok: false, code: 'invalid-response', message: 'Provider returned invalid JSON' };
  }
}
```

```ts
// src/lib/ai/index.ts
export type { AiProvider, AiSettings, AiGenerateRequest, AiErrorCode, AiResult } from './types';
export { AI_PROVIDERS, AI_MODELS, AI_SETTINGS_STORAGE_KEY, loadAiSettings, saveAiSettings, clearAiSettings } from './settings';
export { AI_REQUEST_TIMEOUT_MS, generateAiText, generateAiJson } from './client';
```

- [ ] **Step 8: Run both AI-module tests, lint the module, and commit**

Run: `bun test src/lib/ai/settings.test.ts src/lib/ai/client.test.ts && bunx eslint src/lib/ai`

Expected: PASS with zero lint warnings.

```bash
git add src/lib/ai
git commit -m "feat: add browser-local AI module"
```

---

### Task 2: Move profile AI settings to the browser and delete D1 credential persistence

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
- Consumes: `AI_MODELS`, `AI_PROVIDERS`, `loadAiSettings()`, `saveAiSettings()`, `clearAiSettings()` from `src/lib/ai`.
- Produces: profile UI whose state is `{ provider, model, apiKey }` in the browser and no server-side AI persistence/API contract.

- [ ] **Step 1: Change the profile tests first to assert no server AI-settings dependency**

In `integration/profile-page.test.ts`, make the AI section expectation depend only on server-rendered provider options, not a mocked `getLlmSettings` call. In `e2e/profile.spec.ts`, replace endpoint assertions with local-storage behavior:

```ts
test('AI preferences are stored only in this browser', async ({ page }) => {
  await page.goto('/profile');
  await page.selectOption('#ai-provider', 'openai');
  await page.selectOption('#ai-model', 'gpt-4o');
  await page.fill('#api-key', 'sk-e2e-local');
  await page.click('#ai-settings-form button[type="submit"]');

  const stored = await page.evaluate(() => localStorage.getItem('arcturus-ai-settings'));
  expect(JSON.parse(stored!)).toEqual({ provider: 'openai', model: 'gpt-4o', apiKey: 'sk-e2e-local' });

  await page.reload();
  await expect(page.locator('#api-key-status')).toContainText('Saved');
});
```

- [ ] **Step 2: Run focused profile tests and verify they fail against the server-backed implementation**

Run: `vitest run integration/profile-page.test.ts && bunx playwright test e2e/profile.spec.ts --grep "AI preferences are stored only in this browser"`

Expected: FAIL because saving still POSTs `/api/profile/llm-settings` and the page does not initialize from `localStorage`.

- [ ] **Step 3: Simplify profile state and submit handling around one current key**

Use this state shape in `profile-ui-state.ts`:

```ts
export interface AiState {
  provider: 'openai' | 'gemini';
  model: string;
  apiKey: string;
}
```

Make show/hide/copy work from `aiState.apiKey` directly rather than a fetch callback. In `profile-form-handlers.ts`, save the complete selected record:

```ts
import { saveAiSettings, type AiSettings } from './ai';

export function buildAiSettingsFromForm(
  provider: AiSettings['provider'],
  model: string,
  inputValue: string,
  current: AiSettings | null,
): AiSettings {
  const masked = /^•+$/.test(inputValue);
  const apiKey = masked && current?.provider === provider ? current.apiKey : inputValue.trim();
  return { provider, model, apiKey };
}
```

The submit handler must reject an empty key with the existing error feedback instead of storing an invalid record.

- [ ] **Step 4: Remove the profile server read and initialize the form client-side**

In `profile.astro`, keep `AI_PROVIDERS`/`AI_MODELS` as rendering constants but remove `getLlmSettings()` from the server `Promise.all`. Initialize the form script from local settings:

```ts
import { AI_MODELS, loadAiSettings, clearAiSettings } from '../lib/ai';

const stored = loadAiSettings();
let aiState = stored ?? { provider: 'openai' as const, model: AI_MODELS.openai[0], apiKey: '' };
providerSelect!.value = aiState.provider;
populateModels(modelSelect, aiState.provider, aiState.model, modelOptions, modelLabels);
uiState.updateAiState(aiState);
uiState.updateApiKeyUI(aiState.provider);
```

Change the help copy to: `Stored in this browser only. Switching provider replaces the current provider and API key.`

- [ ] **Step 5: Remove D1/API credential code and fresh-schema creation**

Delete the listed API/helper files and `drizzle/0002_jittery_firebrand.ts`. Remove this table from `src/db/schema.ts` and the corresponding `CREATE TABLE IF NOT EXISTS "llm_settings" ...` block from `drizzle/0000_powerful_wrecking_crew.sql`:

```ts
// Delete this export entirely from src/db/schema.ts.
export const llmSettings = sqliteTable('llm_settings', { /* existing columns */ });
```

Do not add a drop/backfill migration. Before manually testing an existing local database, reset/recreate it rather than preserving stored keys.

- [ ] **Step 6: Prove the old contract is gone**

Run:

```bash
rg "llm-settings|reveal-api-key|getLlmSettings|upsertLlmSettings|llm_settings" src integration e2e drizzle
```

Expected: no active source/test references. Historical planning docs may still mention the old names and do not need editing.

- [ ] **Step 7: Run profile/schema validation and commit**

Run: `bun test src/lib/profile-*.test.ts 2>/dev/null || true; vitest run integration/profile-page.test.ts; bun run build`

Expected: focused integration and build pass. Then run the profile E2E in the normal configured E2E environment.

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
- Consumes: `AiSettings`, `generateAiJson()`, `loadAiSettings()` from `src/lib/ai`.
- Produces: `getBlackjackStrategyAdvice(context): BlackjackAdvice` and `getBlackjackAdvice(context, settings): Promise<BlackjackAdvice>` where `recommendedAction` is always deterministic and legal.

- [ ] **Step 1: Write failing authority/fallback tests**

Add cases like these to `llmBlackjackStrategy.test.ts`:

```ts
test('deterministic recommendation is always one of the legal actions', () => {
  const context = makeContext({ playerRanks: ['10', '6'], dealerRank: '10', availableActions: ['hit', 'stand'] });
  const advice = getBlackjackStrategyAdvice(context);
  expect(context.availableActions).toContain(advice.recommendedAction);
});

test('AI can rewrite reasoning but cannot change the deterministic action', async () => {
  const context = makeContext({ playerRanks: ['10', '6'], dealerRank: '10', availableActions: ['hit', 'stand'] });
  mockGenerateAiJson.mockResolvedValue({ ok: true, value: { action: 'stand', reasoning: 'A concise explanation.' } });
  const advice = await getBlackjackAdvice(context, AI_SETTINGS);
  expect(advice.recommendedAction).toBe('hit');
  expect(advice.reasoning).toBe('A concise explanation.');
});

test('provider failure keeps the same deterministic recommendation and explanation', async () => {
  const context = makeContext({ playerRanks: ['10', '6'], dealerRank: '10', availableActions: ['hit', 'stand'] });
  const local = getBlackjackStrategyAdvice(context);
  mockGenerateAiJson.mockResolvedValue({ ok: false, code: 'timeout', message: 'AI request timed out' });
  await expect(getBlackjackAdvice(context, AI_SETTINGS)).resolves.toEqual(local);
});
```

Also retain explicit hit/stand/double-down/split tests using the game’s existing hand fixtures.

- [ ] **Step 2: Run the Blackjack strategy tests and verify they fail under model-selected actions**

Run: `bun test src/lib/blackjack/llmBlackjackStrategy.test.ts`

Expected: FAIL because `getBlackjackStrategyAdvice` does not exist and current model responses can determine the action.

- [ ] **Step 3: Refactor the current basic fallback into the authoritative pure function**

```ts
export function getBlackjackStrategyAdvice(context: BlackjackAdviceContext): BlackjackAdvice {
  // Move the existing basic-strategy branch logic here.
  // Compute the preferred deterministic action first, then enforce legality.
  const preferred = chooseBasicStrategyAction(context);
  const legal = context.availableActions.includes(preferred)
    ? preferred
    : context.availableActions.includes('hit')
      ? 'hit'
      : context.availableActions.includes('stand')
        ? 'stand'
        : context.availableActions.find((action) => action !== 'ask-ai') ?? null;

  return {
    recommendedAction: legal,
    reasoning: explainBasicStrategyChoice(context, legal),
    confidence: 1,
    raw: '',
  };
}
```

Keep the actual existing branch rules in small private helpers inside this same file unless the file becomes materially harder to read; do not create a generic strategy engine.

- [ ] **Step 4: Change the provider prompt to request explanation only**

```ts
export async function getBlackjackAdvice(
  context: BlackjackAdviceContext,
  settings: AiSettings | null,
): Promise<BlackjackAdvice> {
  const deterministic = getBlackjackStrategyAdvice(context);
  if (!settings || !deterministic.recommendedAction) return deterministic;

  const result = await generateAiJson(settings, {
    system: 'You explain an already-chosen Blackjack basic-strategy move. Do not choose another move.',
    prompt: buildExplanationPrompt(context, deterministic.recommendedAction, deterministic.reasoning),
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

Delete the private OpenAI/Gemini request functions from this file. Ignore any unexpected `action` property in the provider JSON by never reading it.

- [ ] **Step 5: Remove automatic post-round commentary**

Delete `getRoundCommentary()` from `llmBlackjackStrategy.ts`, its import/call/timeout UI flow in `blackjackClient.ts`, and commentary-only markup in `src/pages/games/blackjack.astro`.

Replace the API settings load with:

```ts
const llmSettings = loadAiSettings();
const llmConfigured = Boolean(llmSettings);
```

When Ask AI is clicked, always render the returned deterministic advice. Do not classify fallback reasoning as “Unable to get advice.”

- [ ] **Step 6: Update client initialization tests for local settings and explicit-only calls**

```ts
test('does not call an AI provider during initialization or round completion', async () => {
  initBlackjackClient();
  await finishOneRound();
  expect(mockGenerateAiJson).not.toHaveBeenCalled();
});

test('Ask AI renders deterministic advice even with no stored settings', async () => {
  mockLoadAiSettings.mockReturnValue(null);
  initBlackjackClient();
  await reachPlayerTurn();
  clickAskAi();
  expect(document.getElementById('ai-advice-action')?.textContent).toMatch(/Recommended:/);
});
```

- [ ] **Step 7: Run focused Blackjack tests and commit**

Run: `bun test src/lib/blackjack/llmBlackjackStrategy.test.ts src/lib/blackjack/blackjackClient.init.test.ts`

Expected: PASS.

```bash
git add src/lib/blackjack src/pages/games/blackjack.astro
git commit -m "feat: make blackjack AI advice deterministic"
```

---

### Task 4: Move Craps advice off the server proxy

**Files:**
- Modify: `src/lib/craps/llmCrapsStrategy.ts`
- Modify: `src/pages/games/craps.astro`
- Modify: `src/lib/craps/craps-advice.test.ts`
- Delete: `src/pages/api/craps-advice.ts`
- Delete: `src/lib/craps/craps-advice-validation.test.ts`

**Interfaces:**
- Consumes: `AiSettings`, `generateAiJson()`, `loadAiSettings()`.
- Produces: existing `getCrapsAdvice(context, settings): Promise<CrapsAdvice>` behavior without an Astro API route.

- [ ] **Step 1: Change Craps strategy tests to mock the shared AI result rather than a provider URL**

```ts
test('keeps Craps-domain response parsing in the Craps module', async () => {
  mockGenerateAiJson.mockResolvedValue({
    ok: true,
    value: { advice: 'Take odds behind the pass line.', suggestedBets: ['passLine'], confidence: 'high' },
  });
  const result = await getCrapsAdvice(context, AI_SETTINGS);
  expect(result.advice).toContain('Take odds');
  expect(result.suggestedBets).toEqual(['passLine']);
});
```

- [ ] **Step 2: Run the focused Craps tests and verify they fail before the transport refactor**

Run: `bun test src/lib/craps/craps-advice.test.ts`

Expected: FAIL because `llmCrapsStrategy.ts` still owns provider fetch calls.

- [ ] **Step 3: Replace private provider calls with `generateAiJson()`**

```ts
export async function getCrapsAdvice(
  ctx: CrapsAdviceContext,
  settings: AiSettings,
): Promise<CrapsAdvice> {
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

Change `parseResponse(raw: string)` into a game-specific `parsePayload(payload: Record<string, unknown>)`; do not move bet validation into the shared AI module.

- [ ] **Step 4: Call Craps advice directly from the page on explicit click**

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
      chipBalance: game.getBalance(),
      activeBets: state.activeBets,
      rollHistory: state.rollHistory,
    }, settings);
    llmAdviceEl.textContent = advice.advice;
  } catch {
    llmAdviceEl.textContent = 'AI advice is unavailable. You can keep playing normally.';
  }
});
```

Use the actual `CrapsGameState` field names already present in the page; keep any existing roll-history truncation/aggregation helper that is genuinely required by the prompt, but keep it client-side and pure.

- [ ] **Step 5: Delete the server route and route-only validation test, then prove no caller remains**

Run:

```bash
rm src/pages/api/craps-advice.ts src/lib/craps/craps-advice-validation.test.ts
rg "/api/craps-advice|getLlmSettings" src/lib/craps src/pages/games/craps.astro
```

Expected: no matches.

- [ ] **Step 6: Run Craps tests and commit**

Run: `bun test src/lib/craps && bun run build`

Expected: PASS.

```bash
git add src/lib/craps src/pages/games/craps.astro
git add -u src/pages/api/craps-advice.ts
git commit -m "refactor: call craps AI from browser"
```

---

### Task 5: Migrate Baccarat and both Poker AI paths to the shared provider client

**Files:**
- Modify: `src/lib/baccarat/llmBaccaratStrategy.ts`
- Modify: existing Baccarat LLM strategy tests.
- Modify: `src/lib/poker/llmAIStrategy.ts`
- Modify: `src/lib/poker/AIRivalAssistant.ts`
- Modify: `src/lib/poker/PokerGame.ts`
- Modify: `src/lib/poker/AIRivalAssistant.test.ts`
- Modify: `src/lib/poker/PokerGame.test.ts`
- Modify: existing `llmAIStrategy` tests if present.

**Interfaces:**
- Consumes: `AiSettings`, `generateAiJson()`, `loadAiSettings()`.
- Produces: unchanged game-domain outputs (`BaccaratAdvice`, `AIDecision`, `AiMove`) with no direct OpenAI/Gemini HTTP outside `src/lib/ai`.

- [ ] **Step 1: Update Baccarat and Poker tests to assert domain parsing/fallback, not provider request construction**

Baccarat representative case:

```ts
mockGenerateAiJson.mockResolvedValue({
  ok: true,
  value: { advice: 'Banker has the lowest house edge.', suggestedBets: ['banker'], confidence: 'high' },
});
expect((await getBaccaratAdvice(context, AI_SETTINGS)).suggestedBets).toEqual(['banker']);
```

Poker opponent fallback representative case:

```ts
mockGenerateAiJson.mockResolvedValue({ ok: false, code: 'provider-error', message: 'Provider request failed (500)' });
const result = await makeLLMDecision(context, 'tight-aggressive', AI_SETTINGS);
expect(['fold', 'check', 'call', 'raise']).toContain(result.action);
expect(result.reasoning).toContain('fallback');
```

Poker rival settings representative case:

```ts
mockLoadAiSettings.mockReturnValue({ provider: 'openai', model: 'gpt-4o', apiKey: 'sk-local' });
const rival = new AIRivalAssistant();
await flushPromises();
expect(globalThis.fetch).not.toHaveBeenCalledWith('/api/profile/llm-settings', expect.anything());
```

- [ ] **Step 2: Run the focused game tests and verify the new shared-client mocks fail**

Run: `bun test src/lib/baccarat src/lib/poker/AIRivalAssistant.test.ts src/lib/poker/PokerGame.test.ts`

Expected: FAIL until the game modules import the shared API.

- [ ] **Step 3: Refactor Baccarat transport only**

```ts
export async function getBaccaratAdvice(
  context: BaccaratAdviceContext,
  settings: AiSettings,
): Promise<BaccaratAdvice> {
  const result = await generateAiJson(settings, {
    system: buildSystemPrompt(),
    prompt: buildPrompt(context),
    temperature: 0.7,
    maxOutputTokens: 300,
  });
  if (!result.ok) throw new Error(result.message);
  return parsePayload(result.value);
}
```

Delete Baccarat’s `callOpenAI`, `callGemini`, local `LLMSettings`, and timeout constant. Keep Baccarat suggested-bet/confidence validation local.

- [ ] **Step 4: Refactor Poker LLM opponents without changing cache or rule-based fallback**

```ts
export async function makeLLMDecision(
  context: GameContext,
  personality: AIPersonality,
  llmSettings: AiSettings | null,
  difficulty: AIDifficulty = DEFAULT_AI_DIFFICULTY,
): Promise<AIDecision> {
  const cached = decisionCache.get(context);
  if (cached) return { ...cached, reasoning: `${cached.reasoning} (cached)` };
  if (!llmSettings) return ruleBasedFallback(context, personality, difficulty, 'rule-based fallback');

  const result = await generateAiJson(llmSettings, {
    system: 'You are an expert poker AI. Respond only with valid JSON.',
    prompt: buildLLMPrompt(context, personality),
    temperature: 0.7,
    maxOutputTokens: 100,
  });
  if (!result.ok) return ruleBasedFallback(context, personality, difficulty, 'LLM error fallback');
  return parseLLMPayload(result.value, context) ?? ruleBasedFallback(context, personality, difficulty, 'LLM parse failed');
}
```

Preserve the existing decision-cache key/TTL and legality/clamping code; only remove duplicated HTTP.

- [ ] **Step 5: Refactor Poker AI Rival and PokerGame settings loading**

In `AIRivalAssistant.ts`, replace its two-key `AiSettings` type and `/api/profile/llm-settings` fetch with the shared record:

```ts
private loadAiSettings(): void {
  this.aiSettings = loadAiSettings();
  this.setButtonState({ disabled: !this.aiSettings });
  this.updateStatus();
}
```

Replace private provider methods with one `generateAiJson()` call while preserving `parseAiMove()` and move highlighting.

In `PokerGame.ts`, make `getLLMSettings()` a thin local lookup or remove the method and call `loadAiSettings()` where the existing LLM opponent path needs settings. Do not put `localStorage` parsing in PokerGame.

- [ ] **Step 6: Run the game tests and scan for direct provider endpoints**

Run:

```bash
bun test src/lib/baccarat src/lib/poker
rg "api.openai.com|generativelanguage.googleapis.com" src/lib src/pages
```

Expected: tests PASS; endpoint scan matches only `src/lib/ai/client.ts`.

- [ ] **Step 7: Commit the caller migration**

```bash
git add src/lib/baccarat src/lib/poker
git commit -m "refactor: share AI provider transport"
```

---

### Task 6: Update representative browser coverage and delete obsolete AI contract assertions

**Files:**
- Modify: `e2e/blackjack-llm.spec.ts`
- Modify: `e2e/public-single-player-games.spec.ts` only if it intercepts the deleted profile settings endpoint.
- Modify: `e2e/profile.spec.ts` if Task 2 left endpoint-oriented cases.
- Delete or rewrite obsolete route-specific tests discovered by the final source scan.

**Interfaces:**
- Consumes: finished browser-local settings and deterministic Blackjack advice.
- Produces: one stable E2E proof for the core HPA-185 user journey without testing provider vendors.

- [ ] **Step 1: Write the representative no-provider Blackjack E2E**

```ts
test('Ask AI gives legal local Blackjack advice without a provider request', async ({ page }) => {
  const providerRequests: string[] = [];
  page.on('request', (request) => {
    if (request.url().includes('api.openai.com') || request.url().includes('generativelanguage.googleapis.com')) {
      providerRequests.push(request.url());
    }
  });

  await page.goto('/games/blackjack');
  await page.evaluate(() => localStorage.removeItem('arcturus-ai-settings'));
  await page.reload();
  await page.fill('#bet-amount', '10');
  await page.click('#btn-deal');

  if (await page.locator('#btn-ai-rival').isEnabled()) {
    await page.click('#btn-ai-rival');
    await expect(page.locator('#ai-advice-action')).toContainText('Recommended:');
    await expect(page.locator('#ai-advice-reasoning')).not.toBeEmpty();
  }
  expect(providerRequests).toEqual([]);
});
```

Adapt only the deal/setup helper needed to make the existing deterministic E2E fixture reach a player-turn state; do not add a seeded-deck framework solely for this test.

- [ ] **Step 2: Add an explicit-provider-call boundary assertion using request interception, not a real vendor call**

```ts
await page.evaluate(() => localStorage.setItem('arcturus-ai-settings', JSON.stringify({
  provider: 'openai', model: 'gpt-4o', apiKey: 'sk-fake',
})));
await page.route('https://api.openai.com/**', async (route) => {
  await route.fulfill({
    status: 200,
    contentType: 'application/json',
    body: JSON.stringify({ choices: [{ message: { content: '{"reasoning":"Local strategy explained."}' } }] }),
  });
});
```

Assert that no provider call occurs on page load or round completion, then exactly one occurs after clicking Ask AI.

- [ ] **Step 3: Remove obsolete endpoint-interception cases**

Run:

```bash
rg "/api/profile/llm-settings|/api/profile/reveal-api-key|/api/craps-advice" e2e integration src
```

Expected after edits: zero matches.

- [ ] **Step 4: Run targeted E2E and commit**

Run: `bunx playwright test e2e/blackjack-llm.spec.ts e2e/profile.spec.ts`

Expected: PASS in the repository’s normal E2E environment.

```bash
git add e2e integration
git commit -m "test: cover browser-local AI flow"
```

---

### Task 7: Full verification and architecture guardrail

**Files:**
- Modify only files required to fix verification failures caused by Tasks 1-6.

**Interfaces:**
- Consumes: all prior tasks.
- Produces: implementation-ready HPA-185 change with no stale AI persistence/provider duplication.

- [ ] **Step 1: Run the architecture scans**

```bash
rg "api.openai.com|generativelanguage.googleapis.com" src/lib src/pages
rg "llm-settings|reveal-api-key|llm_settings|/api/craps-advice" src integration e2e drizzle
```

Expected:

- Provider endpoint URLs appear only in `src/lib/ai/client.ts`.
- Old D1/API names have no active source/test/migration matches.

- [ ] **Step 2: Run unit and integration suites**

Run: `bun run test`

Expected: PASS.

- [ ] **Step 3: Run lint, formatting check, and production build**

Run: `bun run lint && bun run format:check && bun run build`

Expected: all commands PASS with zero warnings/errors.

- [ ] **Step 4: Run representative E2E**

Run: `bun run test:e2e -- e2e/blackjack-llm.spec.ts e2e/profile.spec.ts e2e/craps.spec.ts`

Expected: PASS.

- [ ] **Step 5: Review the final diff for KISS/deletion goals**

Run:

```bash
git diff --stat main...HEAD
git diff main...HEAD -- src/lib/ai src/lib/blackjack src/lib/craps src/lib/baccarat src/lib/poker src/pages/profile.astro src/db/schema.ts
```

Verify that the final implementation has one provider transport, one local settings record, no compatibility adapter, no new provider abstraction hierarchy, and no automatic Blackjack LLM request.

- [ ] **Step 6: Commit any verification-only corrections**

If verification required corrections, commit only those concrete fixes:

```bash
git add -A
git commit -m "fix: complete HPA-185 AI migration"
```

If no files changed after verification, do not create an empty commit.
