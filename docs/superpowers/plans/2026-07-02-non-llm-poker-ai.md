# Non-LLM Poker AI Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add per-opponent Easy/Medium/Hard non-LLM poker AI for the single-player Texas Hold'em game while preserving existing personality controls and LLM fallback behavior.

**Architecture:** Keep `src/lib/poker/aiStrategy.ts` as the public compatibility entry point, but split the improved local AI into focused pure modules for difficulty profiles, board texture, visible-information equity, and bet sizing. `PokerGame.ts` only wires per-opponent difficulty through settings and continues to be the final authority for legal action execution.

**Tech Stack:** Astro SSR on Cloudflare Workers, Bun test runner, TypeScript, existing poker modules in `src/lib/poker/`, Playwright for E2E smoke coverage.

---

## File Structure

| Status | Path                                        | Responsibility                                                              |
| ------ | ------------------------------------------- | --------------------------------------------------------------------------- |
| Create | `src/lib/poker/aiDifficulty.ts`             | Difficulty type, base profiles, personality-adjusted tuning                 |
| Create | `src/lib/poker/aiDifficulty.test.ts`        | Unit tests for profile values and personality modifiers                     |
| Create | `src/lib/poker/aiBoardTexture.ts`           | Pure board texture classification                                           |
| Create | `src/lib/poker/aiBoardTexture.test.ts`      | Unit tests for dry/wet/paired/flush/straight pressure boards                |
| Create | `src/lib/poker/aiEquity.ts`                 | Visible-information equity estimate and abstract unknown-card pool          |
| Create | `src/lib/poker/aiEquity.test.ts`            | Unit tests for known-card exclusion, premium hands, draws, and pressure     |
| Create | `src/lib/poker/aiBetSizing.ts`              | Stack-aware raise sizing helper                                             |
| Create | `src/lib/poker/aiBetSizing.test.ts`         | Unit tests for legal and difficulty-sensitive raise amounts                 |
| Modify | `src/lib/poker/aiStrategy.ts`               | Orchestrate difficulty, equity, texture, bet sizing, and fallback decisions |
| Modify | `src/lib/poker/aiStrategy.test.ts`          | Add deterministic tests showing difficulty changes decisions                |
| Modify | `src/lib/poker/types.ts`                    | Add `aiDifficulty1` and `aiDifficulty2` to game settings                    |
| Modify | `src/lib/poker/index.ts`                    | Export new AI difficulty helpers                                            |
| Modify | `src/lib/poker/GameSettingsManager.test.ts` | Verify difficulty defaults, persistence, reset, and legacy-setting merge    |
| Modify | `src/lib/poker/PokerGame.ts`                | Load, save, render, and pass per-opponent difficulty                        |
| Modify | `src/lib/poker/PokerGame.test.ts`           | Verify per-opponent AI configs include saved difficulty                     |
| Modify | `src/lib/poker/llmAIStrategy.ts`            | Pass difficulty into non-LLM fallback                                       |
| Modify | `src/lib/poker/llmAIStrategy.test.ts`       | Verify fallback reasoning/config still works with difficulty                |
| Modify | `src/pages/games/poker.astro`               | Add Player 2/3 difficulty selects                                           |
| Modify | `e2e/poker-turn-flow.spec.ts`               | Keep turn-flow smoke test and assert difficulty controls exist              |

---

## Task 1: Difficulty Profiles And Settings Types

**Files:**

- Create: `src/lib/poker/aiDifficulty.ts`
- Create: `src/lib/poker/aiDifficulty.test.ts`
- Modify: `src/lib/poker/types.ts`
- Modify: `src/lib/poker/index.ts`
- Modify: `src/lib/poker/GameSettingsManager.test.ts`

- [ ] **Step 1: Write failing difficulty profile tests**

Create `src/lib/poker/aiDifficulty.test.ts`:

```typescript
import { describe, expect, test } from 'bun:test';
import {
	DEFAULT_AI_DIFFICULTY,
	applyPersonalityToDifficulty,
	getDifficultyProfile,
	type AIDifficulty,
} from './aiDifficulty';

describe('aiDifficulty', () => {
	test('defaults to medium difficulty', () => {
		expect(DEFAULT_AI_DIFFICULTY).toBe('medium');
		expect(getDifficultyProfile().difficulty).toBe('medium');
	});

	test('exposes easy, medium, and hard profiles with increasing sophistication', () => {
		const easy = getDifficultyProfile('easy');
		const medium = getDifficultyProfile('medium');
		const hard = getDifficultyProfile('hard');

		expect(easy.mistakeRate).toBeGreaterThan(medium.mistakeRate);
		expect(medium.mistakeRate).toBeGreaterThan(hard.mistakeRate);
		expect(easy.textureSensitivity).toBeLessThan(medium.textureSensitivity);
		expect(medium.textureSensitivity).toBeLessThan(hard.textureSensitivity);
		expect(easy.drawSensitivity).toBeLessThan(medium.drawSensitivity);
		expect(medium.drawSensitivity).toBeLessThan(hard.drawSensitivity);
	});

	test('returns a copy so callers cannot mutate base profiles', () => {
		const profile = getDifficultyProfile('hard');
		profile.mistakeRate = 0.99;

		expect(getDifficultyProfile('hard').mistakeRate).not.toBe(0.99);
	});

	test('tight personality narrows continuing range', () => {
		const base = getDifficultyProfile('medium');
		const adjusted = applyPersonalityToDifficulty(base, 'tight-aggressive');

		expect(adjusted.continueThreshold).toBeGreaterThan(base.continueThreshold);
		expect(adjusted.bluffFrequency).toBeLessThanOrEqual(base.bluffFrequency);
	});

	test('loose personality widens continuing range', () => {
		const base = getDifficultyProfile('medium');
		const adjusted = applyPersonalityToDifficulty(base, 'loose-passive');

		expect(adjusted.continueThreshold).toBeLessThan(base.continueThreshold);
	});

	test('aggressive personality raises and bluffs more than passive personality', () => {
		const base = getDifficultyProfile('hard');
		const aggressive = applyPersonalityToDifficulty(base, 'loose-aggressive');
		const passive = applyPersonalityToDifficulty(base, 'loose-passive');

		expect(aggressive.raiseThreshold).toBeLessThan(passive.raiseThreshold);
		expect(aggressive.bluffFrequency).toBeGreaterThan(passive.bluffFrequency);
		expect(aggressive.aggressionMultiplier).toBeGreaterThan(passive.aggressionMultiplier);
	});

	test('rejects unknown difficulty at compile-time through AIDifficulty union', () => {
		const difficulties: AIDifficulty[] = ['easy', 'medium', 'hard'];
		expect(difficulties.map((difficulty) => getDifficultyProfile(difficulty).difficulty)).toEqual(
			difficulties,
		);
	});
});
```

- [ ] **Step 2: Update settings tests before implementation**

In `src/lib/poker/GameSettingsManager.test.ts`, update the partial-settings test in `Constructor and Initialization` to include difficulty defaults:

```typescript
expect(settings.aiDifficulty1).toBe(DEFAULT_SETTINGS.aiDifficulty1);
expect(settings.aiDifficulty2).toBe(DEFAULT_SETTINGS.aiDifficulty2);
```

Add this test in the `updateSettings()` describe block after `updates AI personality settings`:

```typescript
test('updates AI difficulty settings', () => {
	manager.updateSettings({
		aiDifficulty1: 'easy',
		aiDifficulty2: 'hard',
	});

	const settings = manager.getSettings();
	expect(settings.aiDifficulty1).toBe('easy');
	expect(settings.aiDifficulty2).toBe('hard');
});
```

Update the `resetToDefaults()` test object to include non-default difficulty values:

```typescript
aiDifficulty1: 'easy',
aiDifficulty2: 'hard',
```

Add this test in `Edge cases and validation`:

```typescript
test('legacy settings without difficulty merge in medium defaults', () => {
	mockLocalStorage.store['poker_game_settings'] = JSON.stringify({
		startingChips: 1000,
		aiPersonality1: 'tight-passive',
		aiPersonality2: 'loose-aggressive',
		useLLMAI: false,
	});

	const manager2 = new GameSettingsManager();
	const settings = manager2.getSettings();

	expect(settings.startingChips).toBe(1000);
	expect(settings.aiPersonality1).toBe('tight-passive');
	expect(settings.aiDifficulty1).toBe('medium');
	expect(settings.aiDifficulty2).toBe('medium');
});
```

- [ ] **Step 3: Run tests to verify failure**

Run:

```bash
bun test src/lib/poker/aiDifficulty.test.ts src/lib/poker/GameSettingsManager.test.ts
```

Expected: FAIL because `./aiDifficulty`, `aiDifficulty1`, and `aiDifficulty2` do not exist yet.

- [ ] **Step 4: Implement difficulty profiles**

Create `src/lib/poker/aiDifficulty.ts`:

```typescript
type AIPersonality = 'tight-passive' | 'tight-aggressive' | 'loose-passive' | 'loose-aggressive';

export type AIDifficulty = 'easy' | 'medium' | 'hard';

export interface AIDifficultyProfile {
	difficulty: AIDifficulty;
	continueThreshold: number;
	raiseThreshold: number;
	bluffFrequency: number;
	semiBluffFrequency: number;
	mistakeRate: number;
	aggressionMultiplier: number;
	callLooseness: number;
	textureSensitivity: number;
	drawSensitivity: number;
	maxPotRaiseFraction: number;
	minRaiseMultiplier: number;
	maxRaiseMultiplier: number;
}

export const DEFAULT_AI_DIFFICULTY: AIDifficulty = 'medium';

const BASE_PROFILES: Record<AIDifficulty, AIDifficultyProfile> = {
	easy: {
		difficulty: 'easy',
		continueThreshold: 0.48,
		raiseThreshold: 0.74,
		bluffFrequency: 0.03,
		semiBluffFrequency: 0.04,
		mistakeRate: 0.18,
		aggressionMultiplier: 0.8,
		callLooseness: 0.85,
		textureSensitivity: 0.25,
		drawSensitivity: 0.35,
		maxPotRaiseFraction: 0.45,
		minRaiseMultiplier: 2,
		maxRaiseMultiplier: 3,
	},
	medium: {
		difficulty: 'medium',
		continueThreshold: 0.4,
		raiseThreshold: 0.66,
		bluffFrequency: 0.08,
		semiBluffFrequency: 0.1,
		mistakeRate: 0.1,
		aggressionMultiplier: 1,
		callLooseness: 1,
		textureSensitivity: 0.55,
		drawSensitivity: 0.65,
		maxPotRaiseFraction: 0.65,
		minRaiseMultiplier: 2.25,
		maxRaiseMultiplier: 4,
	},
	hard: {
		difficulty: 'hard',
		continueThreshold: 0.34,
		raiseThreshold: 0.6,
		bluffFrequency: 0.12,
		semiBluffFrequency: 0.18,
		mistakeRate: 0.05,
		aggressionMultiplier: 1.15,
		callLooseness: 1.08,
		textureSensitivity: 0.85,
		drawSensitivity: 0.9,
		maxPotRaiseFraction: 0.8,
		minRaiseMultiplier: 2.5,
		maxRaiseMultiplier: 5,
	},
};

function clamp(value: number, min: number, max: number): number {
	return Math.min(max, Math.max(min, value));
}

export function getDifficultyProfile(
	difficulty: AIDifficulty = DEFAULT_AI_DIFFICULTY,
): AIDifficultyProfile {
	return { ...BASE_PROFILES[difficulty] };
}

export function applyPersonalityToDifficulty(
	profile: AIDifficultyProfile,
	personality: AIPersonality,
): AIDifficultyProfile {
	const adjusted = { ...profile };

	if (personality.startsWith('tight')) {
		adjusted.continueThreshold += 0.05;
		adjusted.raiseThreshold += 0.03;
		adjusted.bluffFrequency *= 0.75;
		adjusted.callLooseness *= 0.9;
	}

	if (personality.startsWith('loose')) {
		adjusted.continueThreshold -= 0.05;
		adjusted.raiseThreshold -= 0.02;
		adjusted.callLooseness *= 1.12;
	}

	if (personality.endsWith('aggressive')) {
		adjusted.raiseThreshold -= 0.06;
		adjusted.bluffFrequency *= 1.45;
		adjusted.semiBluffFrequency *= 1.35;
		adjusted.aggressionMultiplier *= 1.2;
		adjusted.maxPotRaiseFraction += 0.08;
	}

	if (personality.endsWith('passive')) {
		adjusted.raiseThreshold += 0.08;
		adjusted.bluffFrequency *= 0.45;
		adjusted.semiBluffFrequency *= 0.55;
		adjusted.aggressionMultiplier *= 0.75;
		adjusted.maxPotRaiseFraction -= 0.12;
	}

	adjusted.continueThreshold = clamp(adjusted.continueThreshold, 0.18, 0.72);
	adjusted.raiseThreshold = clamp(adjusted.raiseThreshold, 0.38, 0.9);
	adjusted.bluffFrequency = clamp(adjusted.bluffFrequency, 0, 0.35);
	adjusted.semiBluffFrequency = clamp(adjusted.semiBluffFrequency, 0, 0.4);
	adjusted.maxPotRaiseFraction = clamp(adjusted.maxPotRaiseFraction, 0.25, 0.95);

	return adjusted;
}
```

- [ ] **Step 5: Add difficulty fields to settings types**

In `src/lib/poker/types.ts`, add a type-only import at the top:

```typescript
import type { AIDifficulty } from './aiDifficulty';
```

Add these fields to `GameSettings` after `aiPersonality2`:

```typescript
aiDifficulty1: AIDifficulty;
aiDifficulty2: AIDifficulty;
```

Add these defaults to `DEFAULT_SETTINGS` after the personality defaults:

```typescript
aiDifficulty1: 'medium',
aiDifficulty2: 'medium',
```

- [ ] **Step 6: Export difficulty helpers**

In `src/lib/poker/index.ts`, add:

```typescript
export type { AIDifficulty, AIDifficultyProfile } from './aiDifficulty';
export {
	DEFAULT_AI_DIFFICULTY,
	getDifficultyProfile,
	applyPersonalityToDifficulty,
} from './aiDifficulty';
```

- [ ] **Step 7: Run focused tests**

Run:

```bash
bun test src/lib/poker/aiDifficulty.test.ts src/lib/poker/GameSettingsManager.test.ts
```

Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add src/lib/poker/aiDifficulty.ts src/lib/poker/aiDifficulty.test.ts src/lib/poker/types.ts src/lib/poker/index.ts src/lib/poker/GameSettingsManager.test.ts
git commit -m "feat(poker): add ai difficulty profiles"
```

---

## Task 2: Board Texture Classification

**Files:**

- Create: `src/lib/poker/aiBoardTexture.ts`
- Create: `src/lib/poker/aiBoardTexture.test.ts`
- Modify: `src/lib/poker/index.ts`

- [ ] **Step 1: Write failing board texture tests**

Create `src/lib/poker/aiBoardTexture.test.ts`:

```typescript
import { describe, expect, test } from 'bun:test';
import type { Card } from './types';
import { classifyBoardTexture } from './aiBoardTexture';

function card(value: string, suit: Card['suit'], rank: number): Card {
	return { value, suit, rank };
}

describe('classifyBoardTexture', () => {
	test('classifies preflop as none with no pressure', () => {
		const texture = classifyBoardTexture([]);

		expect(texture.kind).toBe('none');
		expect(texture.pressure).toBe(0);
		expect(texture.tags).toContain('preflop');
	});

	test('classifies disconnected rainbow flop as dry', () => {
		const texture = classifyBoardTexture([
			card('K', 'spades', 13),
			card('7', 'diamonds', 7),
			card('2', 'clubs', 2),
		]);

		expect(texture.kind).toBe('dry');
		expect(texture.flushDrawPossible).toBe(false);
		expect(texture.straightDrawPossible).toBe(false);
		expect(texture.pressure).toBeLessThan(0.35);
	});

	test('detects two-tone connected board as wet', () => {
		const texture = classifyBoardTexture([
			card('J', 'hearts', 11),
			card('10', 'hearts', 10),
			card('9', 'clubs', 9),
		]);

		expect(texture.kind).toBe('wet');
		expect(texture.flushDrawPossible).toBe(true);
		expect(texture.straightDrawPossible).toBe(true);
		expect(texture.tags).toContain('two-tone');
		expect(texture.pressure).toBeGreaterThan(0.55);
	});

	test('detects paired boards', () => {
		const texture = classifyBoardTexture([
			card('Q', 'spades', 12),
			card('Q', 'diamonds', 12),
			card('4', 'clubs', 4),
		]);

		expect(texture.paired).toBe(true);
		expect(texture.tags).toContain('paired');
	});

	test('detects monotone boards as high flush pressure', () => {
		const texture = classifyBoardTexture([
			card('A', 'spades', 14),
			card('8', 'spades', 8),
			card('3', 'spades', 3),
		]);

		expect(texture.monotone).toBe(true);
		expect(texture.flushDrawPossible).toBe(true);
		expect(texture.tags).toContain('monotone');
		expect(texture.pressure).toBeGreaterThan(0.5);
	});
});
```

- [ ] **Step 2: Run test to verify failure**

Run:

```bash
bun test src/lib/poker/aiBoardTexture.test.ts
```

Expected: FAIL with "Cannot find module './aiBoardTexture'".

- [ ] **Step 3: Implement board texture helper**

Create `src/lib/poker/aiBoardTexture.ts`:

```typescript
import type { Card } from './types';

export type BoardTextureKind = 'none' | 'dry' | 'semi-wet' | 'wet';

export interface BoardTexture {
	kind: BoardTextureKind;
	paired: boolean;
	monotone: boolean;
	twoTone: boolean;
	flushDrawPossible: boolean;
	straightDrawPossible: boolean;
	highCardCount: number;
	connectedness: number;
	pressure: number;
	tags: string[];
}

function clamp(value: number, min: number, max: number): number {
	return Math.min(max, Math.max(min, value));
}

function hasStraightPressure(ranks: number[]): boolean {
	const uniqueRanks = [...new Set(ranks.flatMap((rank) => (rank === 14 ? [14, 1] : [rank])))].sort(
		(a, b) => a - b,
	);

	for (let i = 0; i < uniqueRanks.length; i++) {
		const window = uniqueRanks.slice(i, i + 4);
		if (window.length >= 3 && window[window.length - 1] - window[0] <= 4) {
			return true;
		}
	}

	return false;
}

export function classifyBoardTexture(communityCards: Card[]): BoardTexture {
	if (communityCards.length < 3) {
		return {
			kind: 'none',
			paired: false,
			monotone: false,
			twoTone: false,
			flushDrawPossible: false,
			straightDrawPossible: false,
			highCardCount: 0,
			connectedness: 0,
			pressure: 0,
			tags: ['preflop'],
		};
	}

	const ranks = communityCards.map((card) => card.rank);
	const rankCounts = new Map<number, number>();
	const suitCounts = new Map<Card['suit'], number>();

	for (const card of communityCards) {
		rankCounts.set(card.rank, (rankCounts.get(card.rank) ?? 0) + 1);
		suitCounts.set(card.suit, (suitCounts.get(card.suit) ?? 0) + 1);
	}

	const maxSuitCount = Math.max(...suitCounts.values());
	const paired = [...rankCounts.values()].some((count) => count >= 2);
	const monotone = maxSuitCount >= 3;
	const twoTone = maxSuitCount === 2;
	const flushDrawPossible = maxSuitCount >= 2;
	const straightDrawPossible = hasStraightPressure(ranks);
	const highCardCount = ranks.filter((rank) => rank >= 11).length;
	const sortedRanks = [...new Set(ranks)].sort((a, b) => a - b);
	const connectedness =
		sortedRanks.length < 2
			? 0
			: clamp(1 - (sortedRanks[sortedRanks.length - 1] - sortedRanks[0]) / 12, 0, 1);

	const tags: string[] = [];
	if (paired) tags.push('paired');
	if (monotone) tags.push('monotone');
	if (!monotone && twoTone) tags.push('two-tone');
	if (straightDrawPossible) tags.push('straight-pressure');
	if (highCardCount >= 2) tags.push('high-card-heavy');

	let pressure = 0.12;
	if (paired) pressure += 0.12;
	if (twoTone) pressure += 0.18;
	if (monotone) pressure += 0.38;
	if (straightDrawPossible) pressure += 0.25;
	if (highCardCount >= 2) pressure += 0.08;
	pressure += connectedness * 0.15;
	pressure = clamp(pressure, 0, 1);

	const kind: BoardTextureKind = pressure >= 0.55 ? 'wet' : pressure >= 0.35 ? 'semi-wet' : 'dry';

	return {
		kind,
		paired,
		monotone,
		twoTone,
		flushDrawPossible,
		straightDrawPossible,
		highCardCount,
		connectedness,
		pressure,
		tags,
	};
}
```

- [ ] **Step 4: Export board texture helper**

In `src/lib/poker/index.ts`, add:

```typescript
export type { BoardTexture, BoardTextureKind } from './aiBoardTexture';
export { classifyBoardTexture } from './aiBoardTexture';
```

- [ ] **Step 5: Run focused tests**

Run:

```bash
bun test src/lib/poker/aiBoardTexture.test.ts
```

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/lib/poker/aiBoardTexture.ts src/lib/poker/aiBoardTexture.test.ts src/lib/poker/index.ts
git commit -m "feat(poker): classify ai board texture"
```

---

## Task 3: Visible-Information Equity Estimates

**Files:**

- Create: `src/lib/poker/aiEquity.ts`
- Create: `src/lib/poker/aiEquity.test.ts`
- Modify: `src/lib/poker/index.ts`

- [ ] **Step 1: Write failing equity tests**

Create `src/lib/poker/aiEquity.test.ts`:

```typescript
import { describe, expect, test } from 'bun:test';
import type { Card, GameContext, Player } from './types';
import { buildUnknownDeck, estimateVisibleEquity } from './aiEquity';

function card(value: string, suit: Card['suit'], rank: number): Card {
	return { value, suit, rank };
}

function player(id: number, chips: number, currentBet: number, hand: Card[] = []): Player {
	return {
		id,
		name: `Player ${id}`,
		chips,
		hand,
		currentBet,
		totalBet: currentBet,
		folded: false,
		isAllIn: false,
		isDealer: false,
		isAI: id !== 0,
		hasActed: false,
	};
}

function context(aiPlayer: Player, players: Player[], communityCards: Card[] = []): GameContext {
	return {
		player: aiPlayer,
		players,
		communityCards,
		pot: 100,
		minimumBet: 10,
		phase: communityCards.length === 0 ? 'preflop' : 'flop',
		bettingRound: communityCards.length === 0 ? 'preflop' : 'flop',
		position: 'middle',
	};
}

describe('buildUnknownDeck', () => {
	test('excludes visible hole and community cards from a standard deck', () => {
		const known = [card('A', 'spades', 14), card('K', 'hearts', 13), card('Q', 'diamonds', 12)];

		const unknown = buildUnknownDeck(known);

		expect(unknown).toHaveLength(49);
		expect(unknown).not.toContainEqual(card('A', 'spades', 14));
		expect(unknown).not.toContainEqual(card('K', 'hearts', 13));
		expect(unknown).not.toContainEqual(card('Q', 'diamonds', 12));
	});
});

describe('estimateVisibleEquity', () => {
	test('rates pocket aces above weak offsuit preflop', () => {
		const aces = player(1, 500, 0, [card('A', 'spades', 14), card('A', 'hearts', 14)]);
		const weak = player(1, 500, 0, [card('7', 'clubs', 7), card('2', 'diamonds', 2)]);

		const acesEstimate = estimateVisibleEquity(context(aces, [aces, player(2, 500, 0)]));
		const weakEstimate = estimateVisibleEquity(context(weak, [weak, player(2, 500, 0)]));

		expect(acesEstimate.equity).toBeGreaterThan(weakEstimate.equity);
		expect(acesEstimate.madeStrength).toBeGreaterThan(0.85);
		expect(weakEstimate.madeStrength).toBeLessThan(0.35);
	});

	test('adds draw potential for a flush draw', () => {
		const ai = player(1, 500, 0, [card('A', 'hearts', 14), card('K', 'hearts', 13)]);
		const estimate = estimateVisibleEquity(
			context(
				ai,
				[ai, player(2, 500, 0)],
				[card('9', 'hearts', 9), card('5', 'hearts', 5), card('2', 'clubs', 2)],
			),
		);

		expect(estimate.outs).toBeGreaterThanOrEqual(9);
		expect(estimate.drawPotential).toBeGreaterThan(0.12);
		expect(estimate.equity).toBeGreaterThan(estimate.madeStrength);
	});

	test('reduces equity on threatening paired boards', () => {
		const ai = player(1, 500, 0, [card('A', 'clubs', 14), card('J', 'diamonds', 11)]);
		const dryEstimate = estimateVisibleEquity(
			context(
				ai,
				[ai, player(2, 500, 0)],
				[card('K', 'spades', 13), card('7', 'diamonds', 7), card('2', 'clubs', 2)],
			),
		);
		const scaryEstimate = estimateVisibleEquity(
			context(
				ai,
				[ai, player(2, 500, 0)],
				[card('K', 'spades', 13), card('K', 'hearts', 13), card('Q', 'spades', 12)],
			),
		);

		expect(scaryEstimate.texturePressure).toBeGreaterThan(dryEstimate.texturePressure);
		expect(scaryEstimate.equity).toBeLessThan(dryEstimate.equity);
	});

	test('calculates pot odds from current public bets', () => {
		const ai = player(1, 500, 10, [card('9', 'clubs', 9), card('9', 'hearts', 9)]);
		const estimate = estimateVisibleEquity(context(ai, [ai, player(2, 500, 60)]));

		expect(estimate.callAmount).toBe(50);
		expect(estimate.potOdds).toBeCloseTo(50 / 150);
	});
});
```

- [ ] **Step 2: Run test to verify failure**

Run:

```bash
bun test src/lib/poker/aiEquity.test.ts
```

Expected: FAIL with "Cannot find module './aiEquity'".

- [ ] **Step 3: Implement visible equity helper**

Create `src/lib/poker/aiEquity.ts`:

```typescript
import type { Card, GameContext } from './types';
import {
	calculatePotOdds,
	estimateDrawingOuts,
	evaluatePostflopHand,
	evaluatePreflopHand,
} from './handEvaluator';
import { classifyBoardTexture } from './aiBoardTexture';

export interface VisibleEquityEstimate {
	equity: number;
	madeStrength: number;
	drawPotential: number;
	potOdds: number;
	callAmount: number;
	outs: number;
	texturePressure: number;
	activeOpponents: number;
	unknownCards: number;
}

const SUITS: Card['suit'][] = ['hearts', 'diamonds', 'clubs', 'spades'];
const VALUES = ['2', '3', '4', '5', '6', '7', '8', '9', '10', 'J', 'Q', 'K', 'A'];

function cardKey(card: Card): string {
	return `${card.rank}:${card.suit}`;
}

function clamp(value: number, min: number, max: number): number {
	return Math.min(max, Math.max(min, value));
}

export function buildUnknownDeck(knownCards: Card[]): Card[] {
	const known = new Set(knownCards.map(cardKey));
	const deck: Card[] = [];

	for (const suit of SUITS) {
		for (let i = 0; i < VALUES.length; i++) {
			const card = { value: VALUES[i], suit, rank: i + 2 };
			if (!known.has(cardKey(card))) {
				deck.push(card);
			}
		}
	}

	return deck;
}

export function estimateVisibleEquity(context: GameContext): VisibleEquityEstimate {
	const highestBet = Math.max(...context.players.map((player) => player.currentBet), 0);
	const callAmount = Math.max(0, highestBet - context.player.currentBet);
	const potOdds = calculatePotOdds(callAmount, context.pot);
	const madeStrength =
		context.communityCards.length === 0
			? evaluatePreflopHand(context.player.hand[0], context.player.hand[1])
			: evaluatePostflopHand(context.player.hand, context.communityCards);
	const outs = estimateDrawingOuts(context.player.hand, context.communityCards);
	const texture = classifyBoardTexture(context.communityCards);
	const activeOpponents = Math.max(
		0,
		context.players.filter((player) => player.id !== context.player.id && !player.folded).length,
	);
	const unknownCards = buildUnknownDeck([...context.player.hand, ...context.communityCards]).length;

	const streetMultiplier =
		context.bettingRound === 'flop' ? 2 : context.bettingRound === 'turn' ? 1 : 0.7;
	const drawPotential = clamp(outs * 0.018 * streetMultiplier, 0, 0.34);
	const opponentPenalty = clamp(activeOpponents * 0.045, 0, 0.18);
	const texturePenalty = context.communityCards.length === 0 ? 0 : texture.pressure * 0.12;
	const positionBonus =
		context.position === 'late' ? 0.03 : context.position === 'early' ? -0.025 : 0;

	const equity = clamp(
		madeStrength + drawPotential - opponentPenalty - texturePenalty + positionBonus,
		0,
		1,
	);

	return {
		equity,
		madeStrength,
		drawPotential,
		potOdds,
		callAmount,
		outs,
		texturePressure: texture.pressure,
		activeOpponents,
		unknownCards,
	};
}
```

- [ ] **Step 4: Export equity helper**

In `src/lib/poker/index.ts`, add:

```typescript
export type { VisibleEquityEstimate } from './aiEquity';
export { buildUnknownDeck, estimateVisibleEquity } from './aiEquity';
```

- [ ] **Step 5: Run focused tests**

Run:

```bash
bun test src/lib/poker/aiEquity.test.ts
```

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/lib/poker/aiEquity.ts src/lib/poker/aiEquity.test.ts src/lib/poker/index.ts
git commit -m "feat(poker): estimate visible ai equity"
```

---

## Task 4: Stack-Aware AI Bet Sizing

**Files:**

- Create: `src/lib/poker/aiBetSizing.ts`
- Create: `src/lib/poker/aiBetSizing.test.ts`
- Modify: `src/lib/poker/index.ts`

- [ ] **Step 1: Write failing bet sizing tests**

Create `src/lib/poker/aiBetSizing.test.ts`:

```typescript
import { describe, expect, test } from 'bun:test';
import type { Card, GameContext, Player } from './types';
import { getDifficultyProfile } from './aiDifficulty';
import { chooseRaiseAmount } from './aiBetSizing';

function card(value: string, suit: Card['suit'], rank: number): Card {
	return { value, suit, rank };
}

function player(id: number, chips: number, currentBet: number, hand: Card[] = []): Player {
	return {
		id,
		name: `Player ${id}`,
		chips,
		hand,
		currentBet,
		totalBet: currentBet,
		folded: false,
		isAllIn: false,
		isDealer: false,
		isAI: id !== 0,
		hasActed: false,
	};
}

function context(aiPlayer: Player, players: Player[], pot = 100): GameContext {
	return {
		player: aiPlayer,
		players,
		communityCards: [],
		pot,
		minimumBet: 10,
		phase: 'preflop',
		bettingRound: 'preflop',
		position: 'late',
	};
}

describe('chooseRaiseAmount', () => {
	test('returns a legal raise amount at least the minimum bet', () => {
		const ai = player(1, 500, 0, [card('A', 'spades', 14), card('A', 'hearts', 14)]);
		const amount = chooseRaiseAmount({
			context: context(ai, [ai, player(2, 500, 0)]),
			profile: getDifficultyProfile('medium'),
			equity: 0.82,
			texturePressure: 0.1,
		});

		expect(amount).toBeGreaterThanOrEqual(10);
		expect(amount! % 10).toBe(0);
	});

	test('caps raise amount by chips remaining after a call', () => {
		const ai = player(1, 35, 0, [card('A', 'spades', 14), card('K', 'spades', 13)]);
		const amount = chooseRaiseAmount({
			context: context(ai, [ai, player(2, 500, 20)], 100),
			profile: getDifficultyProfile('hard'),
			equity: 0.9,
			texturePressure: 0.2,
		});

		expect(amount).toBeLessThanOrEqual(15);
	});

	test('hard profile sizes larger than easy profile for strong value hands', () => {
		const ai = player(1, 500, 0, [card('A', 'spades', 14), card('A', 'hearts', 14)]);
		const gameContext = context(ai, [ai, player(2, 500, 0)], 120);

		const easyAmount = chooseRaiseAmount({
			context: gameContext,
			profile: getDifficultyProfile('easy'),
			equity: 0.9,
			texturePressure: 0.1,
		});
		const hardAmount = chooseRaiseAmount({
			context: gameContext,
			profile: getDifficultyProfile('hard'),
			equity: 0.9,
			texturePressure: 0.1,
		});

		expect(hardAmount).toBeGreaterThanOrEqual(easyAmount!);
	});

	test('returns null when no minimum raise is affordable after calling', () => {
		const ai = player(1, 12, 0, [card('Q', 'spades', 12), card('Q', 'hearts', 12)]);
		const amount = chooseRaiseAmount({
			context: context(ai, [ai, player(2, 500, 10)], 100),
			profile: getDifficultyProfile('medium'),
			equity: 0.8,
			texturePressure: 0.1,
		});

		expect(amount).toBeNull();
	});
});
```

- [ ] **Step 2: Run test to verify failure**

Run:

```bash
bun test src/lib/poker/aiBetSizing.test.ts
```

Expected: FAIL with "Cannot find module './aiBetSizing'".

- [ ] **Step 3: Implement bet sizing helper**

Create `src/lib/poker/aiBetSizing.ts`:

```typescript
import type { GameContext } from './types';
import type { AIDifficultyProfile } from './aiDifficulty';

export interface BetSizingInput {
	context: GameContext;
	profile: AIDifficultyProfile;
	equity: number;
	texturePressure: number;
}

function roundToStep(value: number, step: number): number {
	return Math.max(step, Math.round(value / step) * step);
}

function clamp(value: number, min: number, max: number): number {
	return Math.min(max, Math.max(min, value));
}

export function chooseRaiseAmount(input: BetSizingInput): number | null {
	const { context, profile, equity, texturePressure } = input;
	const highestBet = Math.max(...context.players.map((player) => player.currentBet), 0);
	const callAmount = Math.max(0, highestBet - context.player.currentBet);
	const affordableRaise = context.player.chips - callAmount;

	if (affordableRaise < context.minimumBet) {
		return null;
	}

	const equityPressure = clamp((equity - profile.raiseThreshold) / 0.35, 0, 1);
	const textureDiscount = clamp(texturePressure * 0.25, 0, 0.2);
	const multiplier =
		profile.minRaiseMultiplier +
		(profile.maxRaiseMultiplier - profile.minRaiseMultiplier) * equityPressure;
	const blindBased = context.minimumBet * multiplier * profile.aggressionMultiplier;
	const potBase = Math.max(context.pot + callAmount, context.minimumBet);
	const potBased = potBase * clamp(profile.maxPotRaiseFraction - textureDiscount, 0.25, 0.95);
	const rawRaise = Math.max(context.minimumBet, Math.min(blindBased, potBased));
	const rounded = roundToStep(rawRaise, context.minimumBet);

	return Math.min(rounded, affordableRaise);
}
```

- [ ] **Step 4: Export bet sizing helper**

In `src/lib/poker/index.ts`, add:

```typescript
export type { BetSizingInput } from './aiBetSizing';
export { chooseRaiseAmount } from './aiBetSizing';
```

- [ ] **Step 5: Run focused tests**

Run:

```bash
bun test src/lib/poker/aiBetSizing.test.ts
```

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/lib/poker/aiBetSizing.ts src/lib/poker/aiBetSizing.test.ts src/lib/poker/index.ts
git commit -m "feat(poker): add ai bet sizing"
```

---

## Task 5: Improved Non-LLM Strategy Orchestration

**Files:**

- Modify: `src/lib/poker/aiStrategy.ts`
- Modify: `src/lib/poker/aiStrategy.test.ts`

- [ ] **Step 1: Add deterministic strategy tests**

In `src/lib/poker/aiStrategy.test.ts`, add these tests near `makeAIDecision() - decision consistency`:

```typescript
describe('makeAIDecision() - difficulty ladder', () => {
	test('createAIConfig defaults to medium difficulty for compatibility', () => {
		const config = createAIConfig('tight-aggressive');

		expect(config.personality).toBe('tight-aggressive');
		expect(config.difficulty).toBe('medium');
	});

	test('createAIConfig accepts explicit difficulty', () => {
		const config = createAIConfig('loose-passive', 'hard');

		expect(config.personality).toBe('loose-passive');
		expect(config.difficulty).toBe('hard');
	});

	test('hard difficulty continues with a strong draw that easy difficulty folds to pressure', () => {
		const aiPlayer = player(1, 500, 0, [card('A', 'hearts', 14), card('K', 'hearts', 13)]);
		const context: GameContext = {
			player: aiPlayer,
			players: [aiPlayer, player(2, 500, 180), player(3, 500, 0)],
			communityCards: [card('9', 'hearts', 9), card('5', 'hearts', 5), card('2', 'clubs', 2)],
			pot: 220,
			minimumBet: 10,
			phase: 'flop',
			bettingRound: 'flop',
			position: 'late',
		};

		const easyDecision = makeAIDecision(context, {
			...createAIConfig('tight-passive', 'easy'),
			random: () => 0.99,
		});
		const hardDecision = makeAIDecision(context, {
			...createAIConfig('tight-passive', 'hard'),
			random: () => 0.99,
		});

		expect(easyDecision.action).toBe('fold');
		expect(['call', 'raise']).toContain(hardDecision.action);
		expect(hardDecision.reasoning).toContain('hard');
	});

	test('hard aggressive bot can semi-bluff a strong draw when random roll allows it', () => {
		const aiPlayer = player(1, 500, 0, [card('Q', 'spades', 12), card('J', 'spades', 11)]);
		const context: GameContext = {
			player: aiPlayer,
			players: [aiPlayer, player(2, 500, 0), player(3, 500, 0)],
			communityCards: [card('10', 'spades', 10), card('9', 'clubs', 9), card('2', 'spades', 2)],
			pot: 80,
			minimumBet: 10,
			phase: 'flop',
			bettingRound: 'flop',
			position: 'late',
		};

		const decision = makeAIDecision(context, {
			...createAIConfig('loose-aggressive', 'hard'),
			random: () => 0.01,
		});

		expect(decision.action).toBe('raise');
		expect(decision.amount).toBeGreaterThanOrEqual(10);
		expect(decision.reasoning).toContain('semi-bluff');
	});
});
```

- [ ] **Step 2: Run tests to verify failure**

Run:

```bash
bun test src/lib/poker/aiStrategy.test.ts
```

Expected: FAIL because `AIConfig` does not expose `difficulty` or `random`, and strategy decisions do not include difficulty-aware behavior.

- [ ] **Step 3: Replace strategy implementation**

Replace `src/lib/poker/aiStrategy.ts` with:

```typescript
/**
 * AI strategy for poker opponents.
 * Local non-LLM decision making with difficulty and personality tuning.
 */

import type { AIDecision, GameContext, Player } from './types';
import {
	DEFAULT_AI_DIFFICULTY,
	applyPersonalityToDifficulty,
	getDifficultyProfile,
	type AIDifficulty,
} from './aiDifficulty';
import { classifyBoardTexture } from './aiBoardTexture';
import { chooseRaiseAmount } from './aiBetSizing';
import { estimateVisibleEquity } from './aiEquity';

export type AIPersonality =
	| 'tight-passive'
	| 'tight-aggressive'
	| 'loose-passive'
	| 'loose-aggressive';

export interface AIConfig {
	personality: AIPersonality;
	difficulty: AIDifficulty;
	bluffFrequency: number;
	aggressionLevel: number;
	random?: () => number;
}

function clamp(value: number, min: number, max: number): number {
	return Math.min(max, Math.max(min, value));
}

function basePersonalityTuning(personality: AIPersonality): {
	bluffFrequency: number;
	aggressionLevel: number;
} {
	switch (personality) {
		case 'tight-aggressive':
			return { bluffFrequency: 0.15, aggressionLevel: 0.75 };
		case 'tight-passive':
			return { bluffFrequency: 0.05, aggressionLevel: 0.25 };
		case 'loose-aggressive':
			return { bluffFrequency: 0.25, aggressionLevel: 0.85 };
		case 'loose-passive':
			return { bluffFrequency: 0.1, aggressionLevel: 0.35 };
	}
}

export function createAIConfig(
	personality: AIPersonality,
	difficulty: AIDifficulty = DEFAULT_AI_DIFFICULTY,
): AIConfig {
	return {
		personality,
		difficulty,
		...basePersonalityTuning(personality),
	};
}

export function makeAIDecision(context: GameContext, config: AIConfig): AIDecision {
	const random = config.random ?? Math.random;
	const profile = applyPersonalityToDifficulty(
		getDifficultyProfile(config.difficulty),
		config.personality,
	);
	const equityEstimate = estimateVisibleEquity(context);
	const texture = classifyBoardTexture(context.communityCards);
	const highestBet = Math.max(...context.players.map((player) => player.currentBet), 0);
	const callAmount = Math.max(0, highestBet - context.player.currentBet);
	const canCheck = callAmount === 0;
	const position = context.position ?? getPosition(context.player, context.players);
	const positionRaiseAdjustment = position === 'late' ? -0.03 : position === 'early' ? 0.03 : 0;
	const pressureAdjustment = equityEstimate.potOdds > 0.35 ? 0.04 : 0;
	const continueThreshold = clamp(
		profile.continueThreshold +
			pressureAdjustment +
			texture.pressure * 0.06 * profile.textureSensitivity,
		0.12,
		0.9,
	);
	const raiseThreshold = clamp(profile.raiseThreshold + positionRaiseAdjustment, 0.3, 0.92);
	const mistakeOffset = random() < profile.mistakeRate ? (random() < 0.5 ? -0.1 : 0.1) : 0;
	const effectiveEquity = clamp(equityEstimate.equity + mistakeOffset, 0, 1);
	const drawIsRelevant =
		equityEstimate.drawPotential * profile.drawSensitivity > equityEstimate.potOdds * 0.75;
	const shouldSemiBluff =
		drawIsRelevant && equityEstimate.drawPotential >= 0.14 && random() < profile.semiBluffFrequency;
	const shouldPureBluff =
		canCheck &&
		position === 'late' &&
		effectiveEquity < raiseThreshold &&
		random() < profile.bluffFrequency;
	const reasonBase = `${config.difficulty} equity=${equityEstimate.equity.toFixed(2)} potOdds=${equityEstimate.potOdds.toFixed(2)} texture=${texture.kind}`;

	if (canCheck) {
		if (effectiveEquity >= raiseThreshold || shouldSemiBluff || shouldPureBluff) {
			const amount = chooseRaiseAmount({
				context,
				profile,
				equity: effectiveEquity,
				texturePressure: texture.pressure,
			});

			if (amount != null) {
				return {
					action: 'raise',
					amount,
					confidence: effectiveEquity,
					reasoning: `${reasonBase} ${
						shouldSemiBluff ? 'semi-bluff' : shouldPureBluff ? 'bluff' : 'value-raise'
					}`,
				};
			}
		}

		return {
			action: 'check',
			confidence: effectiveEquity,
			reasoning: `${reasonBase} check`,
		};
	}

	if (effectiveEquity >= raiseThreshold || shouldSemiBluff) {
		const amount = chooseRaiseAmount({
			context,
			profile,
			equity: effectiveEquity,
			texturePressure: texture.pressure,
		});

		if (amount != null) {
			return {
				action: 'raise',
				amount,
				confidence: effectiveEquity,
				reasoning: `${reasonBase} ${shouldSemiBluff ? 'semi-bluff' : 'value-raise'}`,
			};
		}
	}

	if (
		callAmount <= context.player.chips &&
		(effectiveEquity >= continueThreshold ||
			equityEstimate.potOdds < 0.22 * profile.callLooseness ||
			drawIsRelevant)
	) {
		return {
			action: 'call',
			confidence: effectiveEquity,
			reasoning: `${reasonBase} continue`,
		};
	}

	return {
		action: 'fold',
		confidence: effectiveEquity,
		reasoning: `${reasonBase} fold`,
	};
}

function getPosition(player: Player, players: Player[]): 'early' | 'middle' | 'late' {
	const dealerIndex = players.findIndex((p) => p.isDealer);
	const playerIndex = players.findIndex((p) => p.id === player.id);

	const positionFromDealer = (playerIndex - dealerIndex + players.length) % players.length;

	if (positionFromDealer <= 1) {
		return 'early';
	}
	if (positionFromDealer <= 2) {
		return 'middle';
	}
	return 'late';
}
```

- [ ] **Step 4: Run strategy tests**

Run:

```bash
bun test src/lib/poker/aiStrategy.test.ts
```

Expected: PASS. If an older randomness-sensitive expectation fails, update that test to pass `random: () => 0.99` into `createAIConfig(...)` rather than weakening the behavior assertion.

- [ ] **Step 5: Run focused AI module tests**

Run:

```bash
bun test src/lib/poker/aiDifficulty.test.ts src/lib/poker/aiBoardTexture.test.ts src/lib/poker/aiEquity.test.ts src/lib/poker/aiBetSizing.test.ts src/lib/poker/aiStrategy.test.ts
```

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/lib/poker/aiStrategy.ts src/lib/poker/aiStrategy.test.ts
git commit -m "feat(poker): use difficulty-aware ai decisions"
```

---

## Task 6: Settings, UI, And LLM Fallback Wiring

**Files:**

- Modify: `src/pages/games/poker.astro`
- Modify: `src/lib/poker/PokerGame.ts`
- Modify: `src/lib/poker/PokerGame.test.ts`
- Modify: `src/lib/poker/llmAIStrategy.ts`
- Modify: `src/lib/poker/llmAIStrategy.test.ts`
- Modify: `e2e/poker-turn-flow.spec.ts`

- [ ] **Step 1: Add failing integration tests for saved difficulty config**

In `src/lib/poker/PokerGame.test.ts`, add this test in `PokerGame bankroll and auto-deal guards`:

```typescript
test('initializes AI configs with persisted per-opponent difficulties', () => {
	const elements = mockPokerGameDOM();
	elements['player-balance'] = {
		addEventListener: () => {},
		dataset: { balance: '500' },
		innerHTML: '',
		textContent: '$500',
		classList: { add: () => {}, remove: () => {}, toggle: () => {} },
		value: '0',
	};

	(globalThis as typeof globalThis & { localStorage: Storage }).localStorage = {
		getItem: (key: string) =>
			key === 'poker_game_settings'
				? JSON.stringify({
						...DEFAULT_SETTINGS,
						aiPersonality1: 'tight-passive',
						aiPersonality2: 'loose-aggressive',
						aiDifficulty1: 'easy',
						aiDifficulty2: 'hard',
					})
				: null,
		setItem: () => {},
		removeItem: () => {},
		clear: () => {},
		key: () => null,
		length: 0,
	};

	const game = new PokerGame() as unknown as {
		aiConfigs: Map<number, { personality: string; difficulty: string }>;
	};

	expect(game.aiConfigs.get(1)).toMatchObject({
		personality: 'tight-passive',
		difficulty: 'easy',
	});
	expect(game.aiConfigs.get(2)).toMatchObject({
		personality: 'loose-aggressive',
		difficulty: 'hard',
	});
});
```

If `DEFAULT_SETTINGS` is not imported in this file, update the import block:

```typescript
import { DEFAULT_SETTINGS } from './types';
```

- [ ] **Step 2: Add failing LLM fallback test**

In `src/lib/poker/llmAIStrategy.test.ts`, add this test in `Fallback behavior`:

```typescript
test('falls back to rule-based hard difficulty when requested', async () => {
	const context = createContext(
		player(1, 1000, 0, [card('A', 'hearts', 14), card('K', 'hearts', 13)]),
		[player(0, 1000, 0), player(1, 1000, 0, [card('A', 'hearts', 14), card('K', 'hearts', 13)])],
	);

	const decision = await makeLLMDecision(context, 'tight-aggressive', null, 'hard');

	expect(decision.action).toBeDefined();
	expect(decision.reasoning).toContain('hard');
	expect(decision.reasoning).toContain('rule-based fallback');
});
```

- [ ] **Step 3: Add failing E2E settings assertions**

In `e2e/poker-turn-flow.spec.ts`, after `await page.goto('/games/poker', { waitUntil: 'networkidle' });`, add:

```typescript
await page.getByRole('button', { name: /configure/i }).click();
await expect(page.locator('#setting-ai-difficulty-1')).toBeVisible();
await expect(page.locator('#setting-ai-difficulty-2')).toBeVisible();
await expect(page.locator('#setting-ai-difficulty-1')).toHaveValue('medium');
await expect(page.locator('#setting-ai-difficulty-2')).toHaveValue('medium');
await page.getByRole('button', { name: /configure/i }).click();
```

- [ ] **Step 4: Run tests to verify failure**

Run:

```bash
bun test src/lib/poker/PokerGame.test.ts src/lib/poker/llmAIStrategy.test.ts
```

Expected: FAIL because difficulty is not wired through `PokerGame` or `makeLLMDecision`.

- [ ] **Step 5: Add difficulty selects to poker settings UI**

In `src/pages/games/poker.astro`, add these two setting blocks between AI speed and Player 2 Style:

```astro
<!-- AI Player 2 Difficulty -->
<div>
	<label class="block text-xs text-[var(--deco-muted)] mb-1">Player 2 Difficulty</label>
	<select
		id="setting-ai-difficulty-1"
		class="w-full bg-[var(--deco-obsidian-2)] text-[var(--deco-ivory)] px-3 py-2 rounded border border-[var(--deco-line)] focus:border-[var(--deco-brass)] focus:outline-none"
	>
		<option value="easy">Easy</option>
		<option value="medium">Medium</option>
		<option value="hard">Hard</option>
	</select>
</div>

<!-- AI Player 3 Difficulty -->
<div>
	<label class="block text-xs text-[var(--deco-muted)] mb-1">Player 3 Difficulty</label>
	<select
		id="setting-ai-difficulty-2"
		class="w-full bg-[var(--deco-obsidian-2)] text-[var(--deco-ivory)] px-3 py-2 rounded border border-[var(--deco-line)] focus:border-[var(--deco-brass)] focus:outline-none"
	>
		<option value="easy">Easy</option>
		<option value="medium">Medium</option>
		<option value="hard">Hard</option>
	</select>
</div>
```

- [ ] **Step 6: Wire difficulty through PokerGame**

In `src/lib/poker/PokerGame.ts`, update the type import:

```typescript
import type { Card, Player, BettingRound, GameContext, GameSettings } from './types';
```

Add this helper near the top-level types:

```typescript
type AIDifficultySetting = GameSettings['aiDifficulty1'];
```

In `initPlayers()`, replace AI config setup with:

```typescript
this.aiConfigs.set(1, createAIConfig(settings.aiPersonality1, settings.aiDifficulty1));
this.aiConfigs.set(2, createAIConfig(settings.aiPersonality2, settings.aiDifficulty2));
```

In `processAITurn()`, update the LLM call:

```typescript
decision = await makeLLMDecision(context, aiConfig.personality, llmSettings, aiConfig.difficulty);
```

In `attachSettingsListeners()`, read the new elements after the personality elements:

```typescript
const aiDifficulty1El = document.getElementById(
	'setting-ai-difficulty-1',
) as HTMLSelectElement | null;
const aiDifficulty2El = document.getElementById(
	'setting-ai-difficulty-2',
) as HTMLSelectElement | null;
```

Add them to the required-element guard:

```typescript
!aiDifficulty1El ||
!aiDifficulty2El ||
```

Parse them after personalities:

```typescript
const aiDifficulty1 = (aiDifficulty1El.value || 'medium') as AIDifficultySetting;
const aiDifficulty2 = (aiDifficulty2El.value || 'medium') as AIDifficultySetting;
```

Include them in `updateSettings()`:

```typescript
aiDifficulty1,
aiDifficulty2,
```

Update saved AI configs:

```typescript
this.aiConfigs.set(1, createAIConfig(aiPersonality1, aiDifficulty1));
this.aiConfigs.set(2, createAIConfig(aiPersonality2, aiDifficulty2));
```

In reset handling, update the default config setup:

```typescript
this.aiConfigs.set(1, createAIConfig(defaults.aiPersonality1, defaults.aiDifficulty1));
this.aiConfigs.set(2, createAIConfig(defaults.aiPersonality2, defaults.aiDifficulty2));
```

In `renderSettingsPanel()`, read the select elements:

```typescript
const aiDifficulty1Select = document.getElementById(
	'setting-ai-difficulty-1',
) as HTMLSelectElement | null;
const aiDifficulty2Select = document.getElementById(
	'setting-ai-difficulty-2',
) as HTMLSelectElement | null;
```

Set their values:

```typescript
if (aiDifficulty1Select) aiDifficulty1Select.value = settings.aiDifficulty1;
if (aiDifficulty2Select) aiDifficulty2Select.value = settings.aiDifficulty2;
```

- [ ] **Step 7: Wire difficulty into LLM fallback**

In `src/lib/poker/llmAIStrategy.ts`, update imports:

```typescript
import type { AIPersonality } from './aiStrategy';
import type { AIDifficulty } from './aiDifficulty';
```

Update the function signature:

```typescript
export async function makeLLMDecision(
	context: GameContext,
	personality: AIPersonality,
	llmSettings: LLMSettings | null,
	difficulty: AIDifficulty = 'medium',
): Promise<AIDecision> {
```

Replace every fallback config creation in this function:

```typescript
const aiConfig = createAIConfig(personality, difficulty);
```

and:

```typescript
const fallbackDecision = makeRuleBasedDecision(context, aiConfig);
```

- [ ] **Step 8: Run focused tests**

Run:

```bash
bun test src/lib/poker/PokerGame.test.ts src/lib/poker/llmAIStrategy.test.ts src/lib/poker/GameSettingsManager.test.ts
```

Expected: PASS.

- [ ] **Step 9: Run E2E smoke test**

Run:

```bash
bun run test:e2e -- e2e/poker-turn-flow.spec.ts
```

Expected: PASS. If local E2E auth bootstrap fails because `.dev.vars` lacks local bootstrap values, do not change production code. Report the missing local E2E env and still run the unit test suite in Task 7.

- [ ] **Step 10: Commit**

```bash
git add src/pages/games/poker.astro src/lib/poker/PokerGame.ts src/lib/poker/PokerGame.test.ts src/lib/poker/llmAIStrategy.ts src/lib/poker/llmAIStrategy.test.ts e2e/poker-turn-flow.spec.ts
git commit -m "feat(poker): wire ai difficulty settings"
```

---

## Task 7: Full Verification And Cleanup

**Files:**

- Modify only if verification reveals focused issues from this feature.

- [ ] **Step 1: Run all poker unit tests**

Run:

```bash
bun test src/lib/poker/
```

Expected: PASS.

- [ ] **Step 2: Run all unit tests**

Run:

```bash
bun run test
```

Expected: PASS.

- [ ] **Step 3: Run lint**

Run:

```bash
bun run lint
```

Expected: PASS with 0 warnings.

- [ ] **Step 4: Run build**

Run:

```bash
bun run build
```

Expected: PASS. This verifies the Astro and Cloudflare Worker bundle still type-checks and builds.

- [ ] **Step 5: Run poker E2E smoke test if local E2E env is configured**

Run:

```bash
bun run test:e2e -- e2e/poker-turn-flow.spec.ts
```

Expected: PASS when `.dev.vars` includes the local guarded E2E bootstrap values. If the bootstrap endpoint is unavailable locally, record that environment limitation in the final handoff.

- [ ] **Step 6: Inspect final diff**

Run:

```bash
git diff --stat HEAD~6..HEAD
git diff HEAD~6..HEAD -- src/lib/poker src/pages/games/poker.astro e2e/poker-turn-flow.spec.ts
```

Expected: diff only contains the non-LLM poker AI feature, tests, and settings UI.

- [ ] **Step 7: Final commit if cleanup was needed**

If verification required small fixes, commit them:

```bash
git add src/lib/poker src/pages/games/poker.astro e2e/poker-turn-flow.spec.ts
git commit -m "fix(poker): stabilize ai difficulty verification"
```

If no cleanup was needed, skip this commit.

---

## Execution Notes

- Keep all AI helpers pure and browser-compatible. Do not introduce Node-only APIs or dependencies.
- Do not use `process.env`; this feature does not need Worker environment bindings.
- The AI may use an abstract unknown-card pool derived from a standard deck minus visible cards. It must not use the real shuffled deck order from `DeckManager`.
- `PokerGame.ts` remains responsible for executing and validating legal actions.
- The LLM path remains optional and should only change by passing difficulty into the existing non-LLM fallback.
- Prefer deterministic tests with `random: () => 0.99` or `random: () => 0.01` where asserting specific bluff or non-bluff behavior.
