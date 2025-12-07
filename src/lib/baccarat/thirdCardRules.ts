/**
 * Third card drawing rules for Punto Banco Baccarat
 * Implements the standard casino third-card rules
 */

import type { Card } from './types';
import { getCardValue } from './handEvaluator';

/**
 * Determine if Player should draw a third card
 * Player draws on 0-5, stands on 6-7
 * (8-9 is natural and handled separately)
 */
export function shouldPlayerDraw(playerValue: number): boolean {
	// Player draws on 0-5
	// Player stands on 6-7
	// 8-9 is natural (no draw, handled before this is called)
	return playerValue <= 5;
}

/**
 * Determine if Banker should draw a third card
 * Rules depend on whether Player drew and what card they drew
 *
 * @param bankerValue - Banker's current hand value (0-9)
 * @param playerThirdCard - The Player's third card (null if Player stood)
 * @param playerStood - Whether the Player stood (didn't draw)
 */
export function shouldBankerDraw(
	bankerValue: number,
	playerThirdCard: Card | null,
	playerStood: boolean,
): boolean {
	// Banker always stands on 7 (8-9 is natural, handled separately)
	if (bankerValue >= 7) {
		return false;
	}

	// If Player stood (6-7), Banker follows simpler rules
	if (playerStood) {
		// Banker draws on 0-5, stands on 6-7
		return bankerValue <= 5;
	}

	// Player drew a third card - use the complex third-card table
	if (!playerThirdCard) {
		throw new Error('Player third card required when player did not stand');
	}

	const playerThirdValue = getCardValue(playerThirdCard);
	return shouldBankerDrawAfterPlayerDrew(bankerValue, playerThirdValue);
}

/**
 * Complex Banker third-card rules when Player drew
 * Based on standard Punto Banco rules
 */
export function shouldBankerDrawAfterPlayerDrew(
	bankerValue: number,
	playerThirdCardValue: number,
): boolean {
	switch (bankerValue) {
		case 0:
		case 1:
		case 2:
			// Banker always draws on 0-2
			return true;

		case 3:
			// Banker draws unless Player's third card was 8
			return playerThirdCardValue !== 8;

		case 4:
			// Banker draws if Player's third card was 2-7
			return playerThirdCardValue >= 2 && playerThirdCardValue <= 7;

		case 5:
			// Banker draws if Player's third card was 4-7
			return playerThirdCardValue >= 4 && playerThirdCardValue <= 7;

		case 6:
			// Banker draws if Player's third card was 6 or 7
			return playerThirdCardValue === 6 || playerThirdCardValue === 7;

		case 7:
			// Banker always stands on 7
			return false;

		default:
			// 8-9 is natural, no draw (should be handled before calling this)
			return false;
	}
}

/**
 * Get the Banker's third-card decision table for reference
 * Returns human-readable rules
 */
export function getBankerRulesDescription(): string {
	return `
Banker Third-Card Rules:
- 0-2: Always draw
- 3: Draw unless Player's third card was 8
- 4: Draw if Player's third card was 2-7
- 5: Draw if Player's third card was 4-7  
- 6: Draw if Player's third card was 6-7
- 7: Always stand
- 8-9: Natural (no draw)

If Player stood (6-7): Banker draws on 0-5, stands on 6-7
`.trim();
}

/**
 * Get detailed explanation of why Banker drew or stood
 */
export function explainBankerDecision(
	bankerValue: number,
	playerThirdCard: Card | null,
	playerStood: boolean,
	bankerDrew: boolean,
): string {
	if (bankerValue >= 8) {
		return `Banker has natural ${bankerValue} - no draw`;
	}

	if (bankerValue === 7) {
		return 'Banker stands on 7';
	}

	if (playerStood) {
		if (bankerDrew) {
			return `Player stood. Banker draws on ${bankerValue}`;
		}
		return `Player stood. Banker stands on ${bankerValue}`;
	}

	if (!playerThirdCard) {
		return 'Invalid state: Player drew but no third card provided';
	}

	const ptv = getCardValue(playerThirdCard);
	const action = bankerDrew ? 'draws' : 'stands';

	switch (bankerValue) {
		case 0:
		case 1:
		case 2:
			return `Banker ${action} on ${bankerValue} (always draws on 0-2)`;
		case 3:
			return `Banker ${action} on ${bankerValue} (Player's third was ${ptv}, ${ptv === 8 ? 'stands on 8' : 'draws otherwise'})`;
		case 4:
			return `Banker ${action} on ${bankerValue} (Player's third was ${ptv}, ${ptv >= 2 && ptv <= 7 ? 'draws on 2-7' : 'stands otherwise'})`;
		case 5:
			return `Banker ${action} on ${bankerValue} (Player's third was ${ptv}, ${ptv >= 4 && ptv <= 7 ? 'draws on 4-7' : 'stands otherwise'})`;
		case 6:
			return `Banker ${action} on ${bankerValue} (Player's third was ${ptv}, ${ptv === 6 || ptv === 7 ? 'draws on 6-7' : 'stands otherwise'})`;
		default:
			return `Banker ${action} on ${bankerValue}`;
	}
}
