# Quickstart Guide: Baccarat Game Integration

**Feature**: 002-baccarat-game | **Date**: 2025-12-06

## Overview

This guide covers integration scenarios for the Baccarat game within the Arcturus casino platform.

---

## 1. Basic Game Setup

### Page Template

```astro
---
// src/pages/games/baccarat.astro
import CasinoLayout from '../../layouts/casino.astro';

const user = Astro.locals.user;
if (!user) return Astro.redirect('/signin');
---

<CasinoLayout title="Baccarat - Arcturus Casino">
	<div id="baccarat-game" data-initial-balance={user.chipBalance}>
		<!-- Game UI rendered here -->
	</div>
</CasinoLayout>

<script>
	import { BaccaratClient } from '../../lib/baccarat/baccaratClient';

	const container = document.getElementById('baccarat-game');
	const initialBalance = Number(container?.dataset.initialBalance ?? 1000);

	const game = new BaccaratClient(container!, initialBalance);
	game.initialize();
</script>
```

---

## 2. Game Logic Integration

### Initialize Game State

```typescript
import { BaccaratGame } from '../lib/baccarat';
import { GameSettingsManager } from '../lib/baccarat/GameSettingsManager';

// Load persisted settings or use defaults
const settingsManager = new GameSettingsManager();
const settings = settingsManager.getSettings();

// Create game instance
const game = new BaccaratGame({
	initialBalance: user.chipBalance,
	settings,
});
```

### Place Bets

```typescript
// Place main bet
const result = game.placeBet('player', 100);
if (result instanceof Error) {
	console.error(result.message);
}

// Place side bet
game.placeBet('playerPair', 25);

// Check if can deal
if (game.canDeal()) {
	game.deal();
}
```

### Handle Round Resolution

```typescript
game.on('roundComplete', (outcome) => {
	// Update UI with results
	console.log(`Winner: ${outcome.winner}`);
	console.log(`Player hand: ${outcome.playerValue}`);
	console.log(`Banker hand: ${outcome.bankerValue}`);

	// Process payouts
	for (const result of outcome.betResults) {
		console.log(`${result.bet.type}: ${result.outcome} (${result.payout})`);
	}

	// Sync balance with server
	syncBalanceToServer(game.getState().chipBalance);
});
```

---

## 3. Chip Balance Sync

### Update Server Balance

```typescript
async function syncBalanceToServer(newBalance: number): Promise<void> {
	try {
		const response = await fetch('/api/profile/update-balance', {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({ chipBalance: newBalance }),
		});

		if (!response.ok) {
			throw new Error('Failed to sync balance');
		}
	} catch (error) {
		console.error('Balance sync failed:', error);
		// Queue for retry or show error to user
	}
}
```

---

## 4. LLM Integration

### Request AI Advice

```typescript
import { LLMBaccaratStrategy } from '../lib/baccarat/llmBaccaratStrategy';
import { getLLMSettings } from '../lib/llm-settings';

async function getAIAdvice(gameState: BaccaratGameState): Promise<string> {
	const llmSettings = await getLLMSettings();

	if (!llmSettings.apiKey) {
		throw new Error('LLM not configured');
	}

	const strategy = new LLMBaccaratStrategy(llmSettings);

	const response = await strategy.analyze({
		roundHistory: gameState.roundHistory,
		currentBets: gameState.activeBets,
		chipBalance: gameState.chipBalance,
		shoeCardsRemaining: gameState.shoeCardsRemaining,
	});

	return response.advice;
}
```

### UI Integration

```typescript
const askAIButton = document.getElementById('ask-ai');
askAIButton?.addEventListener('click', async () => {
	try {
		askAIButton.disabled = true;
		askAIButton.textContent = 'Thinking...';

		const advice = await getAIAdvice(game.getState());
		showAIResponse(advice);
	} catch (error) {
		if (error.message === 'LLM not configured') {
			showLLMConfigOverlay();
		} else {
			showError('AI assistant unavailable');
		}
	} finally {
		askAIButton.disabled = false;
		askAIButton.textContent = 'Ask AI Rival';
	}
});
```

---

## 5. Settings Management

### Load and Save Settings

```typescript
import { GameSettingsManager } from '../lib/baccarat/GameSettingsManager';

const settingsManager = new GameSettingsManager();

// Get current settings
const settings = settingsManager.getSettings();

// Update settings
settingsManager.updateSettings({
	minBet: 25,
	maxBet: 10000,
	animationSpeed: 'fast',
});

// Reset to defaults
settingsManager.resetToDefaults();
```

### Settings Panel

```typescript
function initializeSettingsPanel() {
	const panel = document.getElementById('settings-panel');
	const settings = settingsManager.getSettings();

	// Populate form
	(panel.querySelector('#min-bet') as HTMLInputElement).value = String(settings.minBet);
	(panel.querySelector('#max-bet') as HTMLInputElement).value = String(settings.maxBet);
	(panel.querySelector('#animation-speed') as HTMLSelectElement).value = settings.animationSpeed;
	(panel.querySelector('#llm-enabled') as HTMLInputElement).checked = settings.llmEnabled;

	// Save handler
	panel.querySelector('form')?.addEventListener('submit', (e) => {
		e.preventDefault();
		const formData = new FormData(e.target as HTMLFormElement);
		settingsManager.updateSettings({
			minBet: Number(formData.get('minBet')),
			maxBet: Number(formData.get('maxBet')),
			animationSpeed: formData.get('animationSpeed') as AnimationSpeed,
			llmEnabled: formData.get('llmEnabled') === 'on',
		});
	});
}
```

---

## 6. History Display (Scoreboard)

### Render Scoreboard

```typescript
function renderScoreboard(history: RoundOutcome[]): void {
	const container = document.getElementById('scoreboard');
	if (!container) return;

	container.innerHTML = history
		.map((round) => {
			const colorClass = {
				player: 'bg-blue-500',
				banker: 'bg-red-500',
				tie: 'bg-green-500',
			}[round.winner];

			const label = {
				player: 'P',
				banker: 'B',
				tie: 'T',
			}[round.winner];

			return `<span class="w-6 h-6 rounded-full ${colorClass} text-white text-xs flex items-center justify-center">${label}</span>`;
		})
		.join('');
}

// Subscribe to updates
game.on('roundComplete', (outcome) => {
	renderScoreboard(game.getState().roundHistory);
});
```

---

## 7. Error Handling

### Common Error Scenarios

```typescript
game.on('error', (error) => {
	switch (error.code) {
		case 'BET_BELOW_MIN':
			showToast(`Minimum bet is $${error.min}`);
			break;
		case 'BET_ABOVE_MAX':
			showToast(`Maximum bet is $${error.max}`);
			break;
		case 'INSUFFICIENT_BALANCE':
			showInsufficientChipsOverlay();
			break;
		case 'NO_BETS_PLACED':
			showToast('Place a bet to start');
			break;
		default:
			showToast('Something went wrong');
	}
});
```

### Insufficient Chips Overlay

```typescript
function showInsufficientChipsOverlay(): void {
	const overlay = document.getElementById('insufficient-chips-overlay');
	overlay?.classList.remove('hidden');

	overlay?.querySelector('#return-to-lobby')?.addEventListener('click', () => {
		window.location.href = '/games';
	});
}
```

---

## 8. Testing Scenarios

### Unit Test Example

```typescript
import { describe, expect, test } from 'bun:test';
import { BaccaratGame } from './BaccaratGame';

describe('BaccaratGame', () => {
	test('should place valid bet', () => {
		const game = new BaccaratGame({ initialBalance: 1000 });
		const result = game.placeBet('player', 100);

		expect(result).not.toBeInstanceOf(Error);
		expect(game.getState().activeBets).toHaveLength(1);
	});

	test('should reject bet exceeding balance', () => {
		const game = new BaccaratGame({ initialBalance: 100 });
		const result = game.placeBet('player', 500);

		expect(result).toBeInstanceOf(Error);
	});
});
```

### E2E Test Example

```typescript
import { test, expect } from '@playwright/test';

test('complete baccarat round', async ({ page }) => {
	await page.goto('/games/baccarat');

	// Place bet
	await page.click('[data-bet="player"]');
	await page.fill('#bet-amount', '100');
	await page.click('#place-bet');

	// Deal
	await page.click('#deal-button');

	// Wait for round completion
	await expect(page.locator('#round-result')).toBeVisible({ timeout: 10000 });

	// Verify balance updated
	const balance = await page.locator('#chip-balance').textContent();
	expect(Number(balance)).not.toBe(1000);
});
```

---

## 9. Games Lobby Integration

### Add to Lobby

```astro
<!-- src/pages/games/index.astro -->
<GameCard
	title="Baccarat"
	description="Classic Punto Banco with AI insights"
	href="/games/baccarat"
	icon="cards"
/>
```
