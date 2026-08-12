# Browser-local BYOK AI + Blackjack Explanation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace duplicated/server-backed AI provider plumbing with one browser-local BYOK module, make Blackjack advice always available and deterministic, and remove obsolete credential/server paths only after every live caller has migrated.

**Architecture:** Add `src/lib/ai` beside the existing `src/lib/wallet` boundary. Move provider/model validation there, store one local provider/model/key record, and centralize only OpenAI/Gemini HTTP mapping through the existing body-timeout JSON helper. Games keep prompts, parsers, caches, legality rules, and fallbacks. Blackjack removes its redundant `useLLM` toggle: every Ask AI click returns local advice, while a configured provider may rewrite only the reasoning for signed-in players.

**Tech Stack:** TypeScript, Astro 5, Bun, Vitest, Playwright, browser `localStorage`, `fetchJsonWithTimeout`, Drizzle Kit, Cloudflare D1 for unrelated application state.

## Global Constraints

- Keep the existing `src/lib/<domain>` modular-monolith layout; do not create a parallel `src/modules` tree.
- No provider SDK, provider hierarchy, plugin registry, server proxy, streaming, agents, tools, prompt registry, provider fallback router, usage service, credential vault, audit trail, or compatibility layer.
- Store exactly one active `{ provider, model, apiKey }` record under `arcturus-ai-settings`.
- Move existing provider/model constants and validators from `src/lib/llm-settings.ts`; do not fork them.
- Preserve model choices: OpenAI `gpt-4o`; Gemini `gemini-2.5-flash` and `gemini-2.5-flash-lite`.
- Use one provider timeout: `5_000` ms.
- Shared AI code owns provider HTTP mapping only. Games own prompts and game-domain validation.
- Blackjack Ask AI must work with default settings and for guests without any provider request.
- Remove Blackjack `useLLM`, its settings UI/test contract, configuration overlay, and automatic post-round commentary.
- Poker keeps its existing `DecisionCache`, rule-based fallback, and guest/key policy.
- Baccarat gets transport migration only; do not add UI.
- Keep legacy `/api/profile/llm-settings` alive until Blackjack and Poker have migrated away from it.
- Remove `llm_settings` through a forward generated migration; do not rewrite historical migration files.
- Do not log API-key values.

## Implementation Risks

1. **Blackjack gate survives refactor:** deleting only provider transport would leave `useLLM: false` and guest button disabling in front of the new local advice. Task 3 removes the property/UI/gate and updates `e2e/blackjack-settings.spec.ts` in the same commit.
2. **Deleted endpoint gap:** Profile can move to localStorage while Poker/Blackjack still fetch `/api/profile/llm-settings`. Task 6 owns legacy deletion only after Tasks 3-5 migrate the last callers.
3. **Stalled provider body:** `fetchWithTimeout` clears its timer after headers. Task 1 uses `fetchJsonWithTimeout`, which keeps the timeout armed through `response.json()`.

---

## File Structure

### Create

- `src/lib/ai/types.ts`
- `src/lib/ai/settings.ts`
- `src/lib/ai/client.ts`
- `src/lib/ai/index.ts`
- `src/lib/ai/settings.test.ts`
- `src/lib/ai/client.test.ts`
- `src/lib/baccarat/llmBaccaratStrategy.test.ts`
- `drizzle/0017_drop_llm_settings.sql` via Drizzle Kit generation after Task 6 removes the schema table.

### Modify

- `src/lib/llm-settings.ts` temporarily in Task 1 to import/re-export moved constants/validators; delete it in Task 6.
- `src/lib/llm-settings.test.ts` temporarily continues passing in Task 1; delete it in Task 6.
- `src/pages/profile.astro`
- `src/lib/profile-form-handlers.ts`
- `integration/profile-page.test.ts`
- `e2e/profile.spec.ts`
- `src/lib/blackjack/types.ts`
- `src/lib/blackjack/constants.ts`
- `src/lib/blackjack/GameSettingsManager.ts`
- `src/lib/blackjack/GameSettingsManager.test.ts`
- `src/lib/blackjack/llmBlackjackStrategy.ts`
- `src/lib/blackjack/llmBlackjackStrategy.test.ts`
- `src/lib/blackjack/index.ts`
- `src/lib/blackjack/blackjackClient.ts`
- `src/lib/blackjack/blackjackClient.init.test.ts`
- `src/pages/games/blackjack.astro`
- `e2e/blackjack-settings.spec.ts`
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
- `src/db/schema.ts`
- `e2e/public-single-player-games.spec.ts` if its old settings-endpoint interception remains after caller migration.

### Delete

- `src/lib/profile-ui-state.ts`
- `src/lib/llm-settings.ts`
- `src/lib/llm-settings.test.ts`
- `src/lib/profile-api.ts`
- `src/pages/api/profile/llm-settings.ts`
- `src/pages/api/profile/reveal-api-key.ts`
- `src/pages/api/craps-advice.ts`
- `src/lib/craps/craps-advice-validation.test.ts`

Historical migration files such as `drizzle/0000_powerful_wrecking_crew.sql` and `drizzle/0002_jittery_firebrand.ts` remain untouched.

---

### Task 1: Add the shared AI settings and provider client

**Files:**
- Create: `src/lib/ai/types.ts`
- Create: `src/lib/ai/settings.ts`
- Create: `src/lib/ai/client.ts`
- Create: `src/lib/ai/index.ts`
- Create: `src/lib/ai/settings.test.ts`
- Create: `src/lib/ai/client.test.ts`
- Modify: `src/lib/llm-settings.ts`
- Test: `src/lib/llm-settings.test.ts`
- Reuse: `src/lib/fetch-with-timeout.ts`

**Interfaces:**
- Consumes: `fetchJsonWithTimeout<T>(url: string, init: RequestInit, timeoutMs: number): Promise<{ response: Response; data: T }>`.
- Produces: `AiProvider`, `AiSettings`, `AiGenerateRequest`, `AiErrorCode`, `AiResult<T>`, `AI_PROVIDERS`, `AI_MODELS`, `AI_SETTINGS_STORAGE_KEY`, `AI_REQUEST_TIMEOUT_MS`, `isValidProvider()`, `isValidModel()`, `loadAiSettings()`, `saveAiSettings()`, `clearAiSettings()`, `generateAiText()`, `generateAiJson()`.

- [ ] **Step 1: Write failing settings tests for moved validation and one-record persistence**

```ts
import { afterEach, expect, test } from 'bun:test';
import {
  AI_SETTINGS_STORAGE_KEY,
  clearAiSettings,
  isValidModel,
  isValidProvider,
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

test('moves the existing provider/model validation contract', () => {
  expect(isValidProvider('openai')).toBe(true);
  expect(isValidProvider('other')).toBe(false);
  expect(isValidModel('openai', 'gpt-4o')).toBe(true);
  expect(isValidModel('openai', 'gemini-2.5-flash')).toBe(false);
});

test('save replaces the single active settings record', () => {
  saveAiSettings({ provider: 'openai', model: 'gpt-4o', apiKey: ' sk-test ' });
  expect(loadAiSettings()).toEqual({ provider: 'openai', model: 'gpt-4o', apiKey: 'sk-test' });

  saveAiSettings({ provider: 'gemini', model: 'gemini-2.5-flash', apiKey: 'AIza-test' });
  expect(loadAiSettings()).toEqual({
    provider: 'gemini',
    model: 'gemini-2.5-flash',
    apiKey: 'AIza-test',
  });
});

test('load ignores garbage but save rejects invalid settings loudly', () => {
  localStorage.setItem(AI_SETTINGS_STORAGE_KEY, '{broken');
  expect(loadAiSettings()).toBeNull();
  expect(() => saveAiSettings({ provider: 'openai', model: 'bad-model', apiKey: 'x' })).toThrow();
  expect(() => saveAiSettings({ provider: 'openai', model: 'gpt-4o', apiKey: '   ' })).toThrow();
});

test('clear removes the current record', () => {
  saveAiSettings({ provider: 'openai', model: 'gpt-4o', apiKey: 'sk-test' });
  clearAiSettings();
  expect(loadAiSettings()).toBeNull();
});
```

- [ ] **Step 2: Run the settings test and verify it fails before the module exists**

Run: `bun test src/lib/ai/settings.test.ts`

Expected: FAIL resolving `./settings`.

- [ ] **Step 3: Move provider/model constants and validators into `src/lib/ai/settings.ts`**

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

export function isValidProvider(value: string): value is AiProvider {
  return AI_PROVIDERS.includes(value as AiProvider);
}

export function isValidModel(provider: AiProvider, model: string): boolean {
  return AI_MODELS[provider].includes(model);
}

function isAiSettings(value: unknown): value is AiSettings {
  if (!value || typeof value !== 'object') return false;
  const candidate = value as Partial<AiSettings>;
  return (
    typeof candidate.provider === 'string' &&
    isValidProvider(candidate.provider) &&
    typeof candidate.model === 'string' &&
    isValidModel(candidate.provider, candidate.model) &&
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
  if (!isValidProvider(settings.provider) || !isValidModel(settings.provider, settings.model)) {
    throw new Error('Unsupported AI provider or model');
  }
  const apiKey = settings.apiKey.trim();
  if (!apiKey) throw new Error('API key is required');
  localStorage.setItem(AI_SETTINGS_STORAGE_KEY, JSON.stringify({ ...settings, apiKey }));
}

export function clearAiSettings(): void {
  localStorage.removeItem(AI_SETTINGS_STORAGE_KEY);
}
```

In `src/lib/llm-settings.ts`, remove its local `AI_PROVIDERS`, `AI_MODELS`, `isValidProvider`, and `isValidModel` definitions. Import them from `./ai/settings` and re-export them temporarily so the still-live profile API continues using one source of truth.

- [ ] **Step 4: Run both new and legacy settings tests**

Run: `bun test src/lib/ai/settings.test.ts src/lib/llm-settings.test.ts`

Expected: PASS. The legacy DB test remains green through the temporary re-export.

- [ ] **Step 5: Write failing provider-client tests**

```ts
import { afterEach, expect, mock, test } from 'bun:test';
import { generateAiJson, generateAiText } from './client';

const originalFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = originalFetch; });

test('OpenAI mapping extracts text', async () => {
  globalThis.fetch = mock(async (_url, init) => {
    const body = JSON.parse(String(init?.body)) as { model: string };
    expect(body.model).toBe('gpt-4o');
    return new Response(JSON.stringify({ choices: [{ message: { content: 'Stand here.' } }] }));
  }) as typeof fetch;

  expect(await generateAiText(
    { provider: 'openai', model: 'gpt-4o', apiKey: 'sk-test' },
    { system: 'Be concise', prompt: 'Explain this move' },
  )).toEqual({ ok: true, value: 'Stand here.' });
});

test('Gemini mapping extracts JSON text', async () => {
  globalThis.fetch = mock(async () => new Response(JSON.stringify({
    candidates: [{ content: { parts: [{ text: '{"reasoning":"Dealer is weak"}' }] } }],
  }))) as typeof fetch;

  expect(await generateAiJson(
    { provider: 'gemini', model: 'gemini-2.5-flash', apiKey: 'AIza-test' },
    { prompt: 'Explain' },
  )).toEqual({ ok: true, value: { reasoning: 'Dealer is weak' } });
});

test('HTTP, abort, and malformed-body failures normalize to four codes', async () => {
  globalThis.fetch = mock(async () => new Response(JSON.stringify({ error: 'rate limited' }), { status: 429 })) as typeof fetch;
  const http = await generateAiText(
    { provider: 'openai', model: 'gpt-4o', apiKey: 'sk-test' },
    { prompt: 'x' },
  );
  expect(http.ok).toBe(false);
  if (!http.ok) expect(http.code).toBe('provider-error');

  globalThis.fetch = mock(async () => { throw new DOMException('Aborted', 'AbortError'); }) as typeof fetch;
  const timeout = await generateAiText(
    { provider: 'openai', model: 'gpt-4o', apiKey: 'sk-test' },
    { prompt: 'x' },
  );
  expect(timeout.ok).toBe(false);
  if (!timeout.ok) expect(timeout.code).toBe('timeout');

  globalThis.fetch = mock(async () => new Response('not-json')) as typeof fetch;
  const malformed = await generateAiText(
    { provider: 'openai', model: 'gpt-4o', apiKey: 'sk-test' },
    { prompt: 'x' },
  );
  expect(malformed.ok).toBe(false);
  if (!malformed.ok) expect(malformed.code).toBe('invalid-response');
});
```

- [ ] **Step 6: Implement the two-provider switch on `fetchJsonWithTimeout`**

```ts
// src/lib/ai/client.ts
import { fetchJsonWithTimeout } from '../fetch-with-timeout';
import type { AiGenerateRequest, AiResult, AiSettings } from './types';

export const AI_REQUEST_TIMEOUT_MS = 5_000;

type OpenAiPayload = { choices?: Array<{ message?: { content?: string } }> };
type GeminiPayload = { candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }> };

function providerRequest(settings: AiSettings, request: AiGenerateRequest): { url: string; init: RequestInit } {
  const temperature = request.temperature ?? 0.3;
  const maxOutputTokens = request.maxOutputTokens ?? 200;

  if (settings.provider === 'openai') {
    return {
      url: 'https://api.openai.com/v1/chat/completions',
      init: {
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
      },
    };
  }

  return {
    url: `https://generativelanguage.googleapis.com/v1beta/models/${settings.model}:generateContent?key=${settings.apiKey}`,
    init: {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        contents: [{ role: 'user', parts: [{ text: `${request.system ? `${request.system}\n\n` : ''}${request.prompt}` }] }],
        generationConfig: { temperature, maxOutputTokens },
      }),
    },
  };
}

export async function generateAiText(
  settings: AiSettings,
  request: AiGenerateRequest,
): Promise<AiResult<string>> {
  if (!settings.apiKey.trim()) return { ok: false, code: 'missing-key', message: 'API key not configured' };
  const { url, init } = providerRequest(settings, request);

  let response: Response;
  let data: OpenAiPayload | GeminiPayload;
  try {
    ({ response, data } = await fetchJsonWithTimeout<OpenAiPayload | GeminiPayload>(
      url,
      init,
      AI_REQUEST_TIMEOUT_MS,
    ));
  } catch (error) {
    if (error instanceof Error && error.name === 'AbortError') {
      return { ok: false, code: 'timeout', message: 'AI request timed out' };
    }
    return { ok: false, code: 'invalid-response', message: 'Provider returned invalid JSON' };
  }

  if (!response.ok) {
    return { ok: false, code: 'provider-error', message: `Provider request failed (${response.status})` };
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

`src/lib/ai/index.ts` exports the types/settings/client functions above. Do not expose `providerRequest()`.

- [ ] **Step 7: Run focused tests/lint and commit**

Run: `bun test src/lib/ai src/lib/llm-settings.test.ts && bunx eslint src/lib/ai src/lib/llm-settings.ts`

Expected: PASS.

```bash
git add src/lib/ai src/lib/llm-settings.ts src/lib/llm-settings.test.ts
git commit -m "feat: add shared browser AI module"
```

---

### Task 2: Move Profile settings to browser-local storage without deleting legacy APIs

**Files:**
- Modify: `src/pages/profile.astro`
- Modify: `src/lib/profile-form-handlers.ts`
- Modify: `integration/profile-page.test.ts`
- Modify: `e2e/profile.spec.ts`
- Delete: `src/lib/profile-ui-state.ts`
- Keep unchanged for now: `src/lib/profile-api.ts`, `src/pages/api/profile/llm-settings.ts`, `src/pages/api/profile/reveal-api-key.ts`, `src/lib/llm-settings.ts`, `src/db/schema.ts`

**Interfaces:**
- Consumes: `AI_MODELS`, `AI_PROVIDERS`, `loadAiSettings()`, `saveAiSettings()`, `clearAiSettings()`.
- Produces: Profile client state backed only by one local `AiSettings` record; legacy server APIs remain temporarily for unmigrated game callers.

- [ ] **Step 1: Change Profile integration/E2E tests to require no D1 settings read/write**

```ts
// e2e/profile.spec.ts representative flow
await page.goto('/profile');
await page.selectOption('#ai-provider', 'openai');
await page.selectOption('#ai-model', 'gpt-4o');
await page.fill('#api-key', 'sk-e2e-local');
await page.locator('#ai-settings-form').getByRole('button', { name: /save/i }).click();

expect(await page.evaluate(() => localStorage.getItem('arcturus-ai-settings'))).toBe(
  JSON.stringify({ provider: 'openai', model: 'gpt-4o', apiKey: 'sk-e2e-local' }),
);
await page.reload();
await expect(page.locator('#api-key-status')).toContainText('Saved');
```

In `integration/profile-page.test.ts`, remove the expected `getLlmSettings()` server read and assert Profile renders independently of the AI settings table.

- [ ] **Step 2: Run Profile tests and verify they fail**

Run: `vitest run integration/profile-page.test.ts`

Expected: FAIL because `profile.astro` still loads D1 AI settings.

- [ ] **Step 3: Delete the reveal-oriented `ProfileUiState` class and keep only small form helpers**

Remove `src/lib/profile-ui-state.ts`. In `profile-form-handlers.ts`, keep `populateModels`, `showToast`, and feedback helpers, and replace the server submit helper with:

```ts
import { saveAiSettings, type AiProvider, type AiSettings } from './ai';

export function saveAiSettingsFromForm(
  providerValue: string,
  model: string,
  apiKey: string,
): AiSettings {
  const settings: AiSettings = {
    provider: providerValue as AiProvider,
    model,
    apiKey,
  };
  saveAiSettings(settings);
  return settings;
}
```

Do not preserve `revealApiKey(fetchFn)`, dual `hasOpenaiKey`/`hasGeminiKey`, or server-copy semantics.

- [ ] **Step 4: Initialize, show, copy, save, and clear directly from local state in `profile.astro`**

```ts
import { AI_MODELS, clearAiSettings, loadAiSettings } from '../lib/ai';

let aiState = loadAiSettings() ?? {
  provider: 'openai' as const,
  model: AI_MODELS.openai[0],
  apiKey: '',
};

showKeyButton?.addEventListener('click', () => {
  if (apiKeyInput && aiState.apiKey) {
    apiKeyInput.type = 'text';
    apiKeyInput.value = aiState.apiKey;
  }
});

copyKeyButton?.addEventListener('click', async () => {
  if (!aiState.apiKey) return;
  await navigator.clipboard.writeText(aiState.apiKey);
  showToast(toastEl, toastMessage, 'API key copied to clipboard!');
});

clearKeyButton?.addEventListener('click', () => {
  clearAiSettings();
  aiState = { provider: aiState.provider, model: aiState.model, apiKey: '' };
  if (apiKeyInput) apiKeyInput.value = '';
});
```

Remove the server-side `getLlmSettings()` branch from Profile’s `Promise.all`, remove `aiSettingsPayload`, and update copy to “Stored in this browser only.”

Keep the old API files untouched in this task because Poker/Blackjack still use them.

- [ ] **Step 5: Run Profile tests, build, and commit**

Run: `vitest run integration/profile-page.test.ts && bunx playwright test e2e/profile.spec.ts && bun run build`

Expected: PASS.

```bash
git add src/pages/profile.astro src/lib/profile-form-handlers.ts integration/profile-page.test.ts e2e/profile.spec.ts
git add -u src/lib/profile-ui-state.ts
git commit -m "refactor: keep AI settings in browser"
```

---

### Task 3: Make Blackjack Ask AI always local-first and remove the `useLLM` setting

**Files:**
- Modify: `src/lib/blackjack/types.ts`
- Modify: `src/lib/blackjack/constants.ts`
- Modify: `src/lib/blackjack/GameSettingsManager.ts`
- Modify: `src/lib/blackjack/GameSettingsManager.test.ts`
- Modify: `src/lib/blackjack/llmBlackjackStrategy.ts`
- Modify: `src/lib/blackjack/llmBlackjackStrategy.test.ts`
- Modify: `src/lib/blackjack/index.ts`
- Modify: `src/lib/blackjack/blackjackClient.ts`
- Modify: `src/lib/blackjack/blackjackClient.init.test.ts`
- Modify: `src/pages/games/blackjack.astro`
- Modify: `e2e/blackjack-settings.spec.ts`

**Interfaces:**
- Consumes: `AiSettings`, `generateAiJson()`, `loadAiSettings()`.
- Produces: `getBlackjackStrategyAdvice(context): BlackjackAdvice`; `getBlackjackAdvice(context, settings): Promise<BlackjackAdvice>`; Ask AI available during player turn regardless of account/provider state.

- [ ] **Step 1: Add failing strategy tests for deterministic authority and legality**

```ts
test('hard 16 against dealer 10 recommends legal hit', () => {
  const context = makeContext({
    playerRanks: ['10', '6'],
    dealerRank: '10',
    availableActions: ['hit', 'stand'],
  });
  const advice = getBlackjackStrategyAdvice(context);
  expect(advice.recommendedAction).toBe('hit');
  expect(context.availableActions).toContain(advice.recommendedAction);
});

test('provider reasoning cannot replace deterministic action', async () => {
  const context = makeContext({
    playerRanks: ['10', '6'],
    dealerRank: '10',
    availableActions: ['hit', 'stand'],
  });
  mockGenerateAiJson.mockResolvedValue({
    ok: true,
    value: { action: 'stand', reasoning: 'Take a card against this strong up-card.' },
  });
  const advice = await getBlackjackAdvice(context, AI_SETTINGS);
  expect(advice.recommendedAction).toBe('hit');
  expect(advice.reasoning).toContain('strong up-card');
});

test('provider failure returns exact local advice', async () => {
  const context = makeContext({
    playerRanks: ['10', '6'],
    dealerRank: '10',
    availableActions: ['hit', 'stand'],
  });
  const local = getBlackjackStrategyAdvice(context);
  mockGenerateAiJson.mockResolvedValue({ ok: false, code: 'timeout', message: 'AI request timed out' });
  expect(await getBlackjackAdvice(context, AI_SETTINGS)).toEqual(local);
});
```

Retain/add explicit stand, double-down, split, and unavailable-preferred-action fixtures.

- [ ] **Step 2: Remove `useLLM` from Blackjack settings before wiring the click path**

Delete `useLLM` from `BlackjackSettings` in `types.ts`, from `DEFAULT_SETTINGS` in `constants.ts`, and from GameSettingsManager serialization/update behavior. Remove the Blackjack settings checkbox and related DOM wiring from `blackjackClient.ts` / `blackjack.astro`.

Update `GameSettingsManager.test.ts` to assert the remaining settings round-trip without `useLLM`.

Replace the existing `e2e/blackjack-settings.spec.ts` test “LLM toggle can disable AI Rival without overlay” with:

```ts
test('Ask AI works with default Blackjack settings', async ({ browser, baseURL }) => {
  const { context, page } = await createIsolatedBlackjackPage(browser, baseURL);
  try {
    await dealHand(page, 50);
    const aiButton = page.getByRole('button', { name: 'Ask AI Rival' });
    await expect(aiButton).toBeEnabled();
    await aiButton.click();
    await expect(page.locator('#ai-advice-action')).toContainText('Recommended:');
  } finally {
    await context.close();
  }
});
```

- [ ] **Step 3: Promote the current local fallback into the authoritative strategy function**

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
    reasoning = `With ${handValue.value}, take a card because one hit cannot bust this total.`;
  } else if (handValue.value >= 17) {
    action = 'stand';
    reasoning = `With ${handValue.value}, stand rather than take unnecessary bust risk.`;
  } else if (dealerValue >= 7) {
    action = 'hit';
    reasoning = `With ${handValue.value} against dealer ${dealerValue}, improve against the strong up-card.`;
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
      reasoning = `Split ${first.rank}s according to the current local strategy rule.`;
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

- [ ] **Step 4: Let the provider rewrite reasoning only**

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

Delete Blackjack’s private provider functions/action parser. Delete `getRoundCommentary()`.

In `src/lib/blackjack/index.ts`, export `getBlackjackStrategyAdvice` / `getBlackjackAdvice` and remove the `getRoundCommentary` export.

- [ ] **Step 5: Remove guest/settings gating from Ask AI, but keep provider rewrite signed-in only**

Delete `llmUserEnabled`, `llmConfigured`, `llmSettingsLoading`, `loadLlmSettings()`, the “AI Rival is disabled” branch, guest button disabling, and the configuration overlay flow.

The click handler should resolve settings this way:

```ts
const providerSettings = isGuestMode ? null : loadAiSettings();
const advice = await getBlackjackAdvice(context, providerSettings);
aiAdviceBox.classList.remove('hidden');
aiAdviceAction.textContent = advice.recommendedAction
  ? `Recommended: ${advice.recommendedAction.toUpperCase()}`
  : 'No legal recommendation';
aiAdviceReasoning.textContent = advice.reasoning;
highlightRecommendedAction(advice.recommendedAction);
```

Guests therefore always get local advice and never make a provider request even if stale localStorage contains a key.

Delete automatic round commentary code and commentary-only DOM from `blackjack.astro`.

- [ ] **Step 6: Add client tests for default, guest, and no-automatic-provider behavior**

```ts
test('Ask AI renders local advice without settings', async () => {
  mockLoadAiSettings.mockReturnValue(null);
  initBlackjackClient();
  await reachPlayerTurn();
  clickAskAi();
  expect(document.getElementById('ai-advice-action')?.textContent).toContain('Recommended:');
  expect(mockGenerateAiJson).not.toHaveBeenCalled();
});

test('guest Ask AI never calls provider', async () => {
  setGuestMode(true);
  mockLoadAiSettings.mockReturnValue({ provider: 'openai', model: 'gpt-4o', apiKey: 'stale-key' });
  initBlackjackClient();
  await reachPlayerTurn();
  clickAskAi();
  expect(mockGenerateAiJson).not.toHaveBeenCalled();
});

test('round completion never calls provider', async () => {
  initBlackjackClient();
  await finishOneRound();
  expect(mockGenerateAiJson).not.toHaveBeenCalled();
});
```

- [ ] **Step 7: Run focused tests/E2E and commit**

Run:

```bash
bun test src/lib/blackjack
bunx playwright test e2e/blackjack-settings.spec.ts
```

Expected: PASS.

```bash
git add src/lib/blackjack src/pages/games/blackjack.astro e2e/blackjack-settings.spec.ts
git commit -m "feat: make blackjack advice always local-first"
```

---

### Task 4: Move Craps advice off the server proxy

**Files:**
- Modify: `src/lib/craps/llmCrapsStrategy.ts`
- Modify: `src/pages/games/craps.astro`
- Rewrite: `src/lib/craps/craps-advice.test.ts`
- Delete: `src/pages/api/craps-advice.ts`
- Delete: `src/lib/craps/craps-advice-validation.test.ts`

**Interfaces:**
- Consumes: `AiSettings`, `generateAiJson()`, `loadAiSettings()`.
- Produces: existing `getCrapsAdvice(context, settings): Promise<CrapsAdvice>` with local bet aggregation and no Astro advice route.

- [ ] **Step 1: Preserve the useful pure aggregation behavior and replace route tests**

Move `aggregateBets()` from the deleted route into `llmCrapsStrategy.ts` and keep its existing same-type/same-point aggregation tests in `craps-advice.test.ts`.

Add a shared-client strategy test:

```ts
mockGenerateAiJson.mockResolvedValue({
  ok: true,
  value: {
    advice: 'Take odds behind the pass line.',
    suggestedBets: ['passLine'],
    confidence: 'high',
  },
});

const result = await getCrapsAdvice(context, AI_SETTINGS);
expect(result.suggestedBets).toEqual(['passLine']);
expect(result.confidence).toBe('high');
```

Delete route auth/DB/body-hardening assertions; the route will no longer exist.

- [ ] **Step 2: Replace Craps provider transport with `generateAiJson()`**

```ts
export async function getCrapsAdvice(
  ctx: CrapsAdviceContext,
  settings: AiSettings,
): Promise<CrapsAdvice> {
  const normalized = { ...ctx, activeBets: aggregateBets(ctx.activeBets) };
  const result = await generateAiJson(settings, {
    system: buildSystemPrompt(),
    prompt: buildPrompt(normalized),
    temperature: 0.8,
    maxOutputTokens: 250,
  });
  if (!result.ok) throw new Error(result.message);
  return parsePayload(result.value);
}
```

Keep prompt/response validation in Craps. Delete its local provider functions, `LLMSettings`, and 8-second timeout.

- [ ] **Step 3: Call Craps strategy directly from the page and then delete the proxy**

```ts
llmAdviceBtn.addEventListener('click', async () => {
  if (isGuestMode) {
    llmAdviceEl.textContent = 'Sign in and configure an AI provider in Profile to use provider advice.';
    return;
  }
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

After that caller is changed, delete `src/pages/api/craps-advice.ts` and `src/lib/craps/craps-advice-validation.test.ts` in the same task.

- [ ] **Step 4: Test/scan and commit**

Run:

```bash
bun test src/lib/craps
rg "/api/craps-advice|getLlmSettings" src/lib/craps src/pages/games/craps.astro
bun run build
```

Expected: tests/build PASS; scan has zero matches.

```bash
git add src/lib/craps src/pages/games/craps.astro
git add -u src/pages/api/craps-advice.ts
git commit -m "refactor: call craps AI from browser"
```

---

### Task 5: Migrate Baccarat and both Poker AI paths

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
- Produces: existing `BaccaratAdvice`, `AIDecision`, and `AiMove` contracts with no provider URL outside `src/lib/ai/client.ts`.

- [ ] **Step 1: Add failing shared-client seam tests**

```ts
mockGenerateAiJson.mockResolvedValue({
  ok: true,
  value: {
    advice: 'Banker has the lowest standard house edge.',
    suggestedBets: ['banker'],
    confidence: 'high',
  },
});
expect((await getBaccaratAdvice(context, AI_SETTINGS)).suggestedBets).toEqual(['banker']);
```

```ts
mockGenerateAiJson.mockResolvedValue({
  ok: false,
  code: 'provider-error',
  message: 'Provider request failed (500)',
});
const decision = await makeLLMDecision(context, 'tight-aggressive', AI_SETTINGS);
expect(['fold', 'check', 'call', 'raise']).toContain(decision.action);
expect(decision.reasoning).toContain('fallback');
```

- [ ] **Step 2: Migrate Baccarat transport only**

Keep `buildSystemPrompt`, `buildPrompt`, and Baccarat payload validation. Replace local OpenAI/Gemini methods with one `generateAiJson()` call. Do not add any page or settings behavior for Baccarat.

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
  return parseBaccaratPayload(result.value);
}
```

- [ ] **Step 3: Migrate Poker LLM opponents without touching `DecisionCache`**

Replace only provider HTTP and raw-string JSON extraction in `llmAIStrategy.ts`:

```ts
const result = await generateAiJson(llmSettings, {
  system: 'You are an expert poker AI. Respond only with valid JSON.',
  prompt: buildLLMPrompt(context, personality),
  temperature: 0.7,
  maxOutputTokens: 100,
});

if (!result.ok) {
  return ruleBasedFallback(context, personality, difficulty, 'LLM error fallback');
}

const decision = parseLLMPayload(result.value, context);
if (!decision) {
  return ruleBasedFallback(context, personality, difficulty, 'LLM parse failed');
}
decisionCache.set(context, decision);
return decision;
```

Keep the existing cache keys/TTL/clear behavior unchanged.

- [ ] **Step 4: Migrate Poker AI Rival and PokerGame settings lookup**

In `AIRivalAssistant.ts`, import the shared settings function and use a distinct class helper name:

```ts
private hydrateFromLocalSettings(): void {
  this.aiSettings = loadAiSettings();
  this.setButtonState({ disabled: !this.aiSettings });
  this.updateStatus();
}
```

Replace its private provider methods with `generateAiJson()` while keeping `parseAiMove()` and move highlighting local.

In `PokerGame.ts`, replace the async profile-settings fetch used by LLM opponents with `loadAiSettings()`. Preserve Poker’s current guest behavior: guest play stays rule-based/provider-disabled.

- [ ] **Step 5: Run focused tests and provider URL scan**

Run:

```bash
bun test src/lib/baccarat/llmBaccaratStrategy.test.ts src/lib/poker/llmAIStrategy.test.ts src/lib/poker/AIRivalAssistant.test.ts src/lib/poker/PokerGame.test.ts
rg "api.openai.com|generativelanguage.googleapis.com" src/lib src/pages
```

Expected: tests PASS; provider URLs appear only in `src/lib/ai/client.ts`.

- [ ] **Step 6: Commit**

```bash
git add src/lib/baccarat src/lib/poker
git commit -m "refactor: share AI provider transport"
```

---

### Task 6: Delete the legacy D1/profile AI path with a forward migration

**Files:**
- Modify: `src/db/schema.ts`
- Create: `drizzle/0017_drop_llm_settings.sql` via `bunx drizzle-kit generate --name=drop_llm_settings`
- Delete: `src/lib/llm-settings.ts`
- Delete: `src/lib/llm-settings.test.ts`
- Delete: `src/lib/profile-api.ts`
- Delete: `src/pages/api/profile/llm-settings.ts`
- Delete: `src/pages/api/profile/reveal-api-key.ts`
- Preserve: `drizzle/0000_powerful_wrecking_crew.sql`
- Preserve: `drizzle/0002_jittery_firebrand.ts`

**Interfaces:**
- Consumes: Tasks 1-5; by this point no active game/profile caller needs the legacy endpoint or D1 credential repository.
- Produces: no runtime `llm_settings` schema/API dependency; historical migrations remain history.

- [ ] **Step 1: Prove no active caller still uses the legacy settings API**

Run:

```bash
rg "/api/profile/llm-settings|/api/profile/reveal-api-key|getLlmSettings|upsertLlmSettings" src integration e2e
```

Expected before deletion: matches are limited to the legacy implementation files/tests being deleted in this task. If Blackjack, Poker, Profile, or Craps appears, finish that migration before continuing.

- [ ] **Step 2: Remove `llmSettings` from the active Drizzle schema**

Delete the complete `export const llmSettings = sqliteTable('llm_settings', ...)` declaration from `src/db/schema.ts`. Do not modify historical migration files.

- [ ] **Step 3: Generate the forward drop migration with a deterministic name**

Run:

```bash
bunx drizzle-kit generate --name=drop_llm_settings
```

Expected generated SQL path: `drizzle/0017_drop_llm_settings.sql`.

Inspect it:

```bash
cat drizzle/0017_drop_llm_settings.sql
```

Expected schema effect: remove `llm_settings`; no unrelated table/index changes. If Drizzle also emits its normal metadata files, include those generated files without manual editing.

- [ ] **Step 4: Delete the now-dead repository/API helpers and their tests**

```bash
rm src/lib/llm-settings.ts \
   src/lib/llm-settings.test.ts \
   src/lib/profile-api.ts \
   src/pages/api/profile/llm-settings.ts \
   src/pages/api/profile/reveal-api-key.ts
```

Do not delete `drizzle/0002_jittery_firebrand.ts`; it is historical and ignored by the current SQL migration runner.

- [ ] **Step 5: Verify source/runtime references are gone without demanding clean migration history**

Run:

```bash
rg "llm-settings|reveal-api-key|getLlmSettings|upsertLlmSettings" src integration e2e
rg "llm_settings" src
rg "llm_settings" drizzle
```

Expected: first two scans have zero matches. The `drizzle` scan may show historical creation plus the new drop migration; that is expected migration history, not an active dependency.

- [ ] **Step 6: Run schema/profile/build checks and commit**

Run:

```bash
bun run test
bun run build
```

Expected: PASS.

```bash
git add src/db/schema.ts drizzle
git add -u src/lib/llm-settings.ts src/lib/llm-settings.test.ts src/lib/profile-api.ts src/pages/api/profile/llm-settings.ts src/pages/api/profile/reveal-api-key.ts
git commit -m "refactor: remove server AI credential storage"
```

---

### Task 7: Replace old browser contracts and run full verification

**Files:**
- Modify: `e2e/blackjack-llm.spec.ts`
- Modify: `e2e/profile.spec.ts`
- Modify: `e2e/public-single-player-games.spec.ts` if it still intercepts a deleted settings endpoint.
- Modify only concrete files implicated by a failing verification command.

**Interfaces:**
- Consumes: Tasks 1-6.
- Produces: browser proof that Blackjack is local-first, provider calls are explicit-only, Profile is browser-local, and no legacy runtime AI path remains.

- [ ] **Step 1: Remove the old E2E helper that enables `useLLM`**

In `e2e/blackjack-llm.spec.ts`, `gotoBlackjack()` should navigate only; it must no longer open settings/check `#setting-use-llm`.

```ts
async function gotoBlackjack(page: Page) {
  await page.goto('/games/blackjack', { waitUntil: 'networkidle' });
}
```

- [ ] **Step 2: Cover no-provider and guest local advice with zero provider requests**

```ts
test('no provider still receives local Blackjack advice', async ({ browser, baseURL }) => {
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

Add the equivalent guest page flow using the repository’s guest navigation helper and assert Ask AI is enabled, local advice renders, and provider request count stays zero.

- [ ] **Step 3: Cover configured explicit-only provider use and provider failure**

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
    body: JSON.stringify({
      choices: [{ message: { content: '{"reasoning":"Local strategy explained."}' } }],
    }),
  });
});

await gotoBlackjack(page);
await dealHand(page, 50);
expect(calls).toBe(0);
await page.getByRole('button', { name: 'Ask AI Rival' }).click();
await expect.poll(() => calls).toBe(1);
await finishCurrentRound(page);
expect(calls).toBe(1);
```

Replace the current provider-failure assertion “Unable to get advice” with a visible deterministic recommendation/reasoning assertion. Delete the current post-round commentary E2E.

- [ ] **Step 4: Run architecture scans**

```bash
rg "api.openai.com|generativelanguage.googleapis.com" src/lib src/pages
rg "/api/profile/llm-settings|/api/profile/reveal-api-key|/api/craps-advice" src integration e2e
rg "getRoundCommentary|useLLM" src/lib/blackjack src/pages/games/blackjack.astro e2e/blackjack-*.spec.ts
```

Expected: provider URLs only in `src/lib/ai/client.ts`; other scans have zero active matches.

- [ ] **Step 5: Run unit/integration, lint, format, and build gates**

Run:

```bash
bun run test
bun run lint
bun run format:check
bun run build
```

Expected: PASS.

- [ ] **Step 6: Run representative E2E gates**

Run:

```bash
bunx playwright test \
  e2e/blackjack-settings.spec.ts \
  e2e/blackjack-llm.spec.ts \
  e2e/profile.spec.ts \
  e2e/craps.spec.ts
```

Expected: PASS.

- [ ] **Step 7: Review the final diff for deletion/KISS goals**

```bash
git diff --stat main...HEAD
git diff main...HEAD -- \
  src/lib/ai \
  src/lib/blackjack \
  src/lib/craps \
  src/lib/baccarat \
  src/lib/poker \
  src/pages/profile.astro \
  src/db/schema.ts \
  drizzle/0017_drop_llm_settings.sql
```

Verify from the diff:

- one provider transport;
- one local settings record;
- one provider/model validator source;
- no Blackjack enable toggle or guest local-advice gate;
- no automatic Blackjack provider request;
- no legacy runtime credential API/repository;
- no compatibility adapter/provider framework;
- migration history was not rewritten.

- [ ] **Step 8: Commit only concrete final verification fixes if needed**

Run: `git status --short`.

If the working tree is clean, do not create an empty commit. If verification required concrete fixes, stage only those files and commit:

```bash
git add <files changed by verification fixes>
git commit -m "fix: complete HPA-185 AI migration"
```
