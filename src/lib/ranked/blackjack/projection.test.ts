import { describe, expect, test } from 'bun:test';
import { blackjackRankedV1Adapter, issueBlackjackConfig } from './adapter';
import { projectRankedBlackjackReplay } from './projection';

const splitCapableSeed = Uint8Array.from({ length: 32 }, (_, index) => index + 30);
const incompleteSeed = Uint8Array.from({ length: 32 }, (_, index) => index);

describe('projectRankedBlackjackReplay', () => {
	test('filters split and double-down using the supplied available balance', async () => {
		const replayWithFundingActions = await blackjackRankedV1Adapter.replay(
			splitCapableSeed,
			issueBlackjackConfig(100),
			[],
		);

		const projected = projectRankedBlackjackReplay(replayWithFundingActions, 9);

		expect(projected.availableActions).toEqual(['hit', 'stand']);
		expect(projected.nextSequence).toBe(replayWithFundingActions.nextSequence);
	});

	test('force-terminal reveals the dealer and clears actions', async () => {
		const incompleteReplay = await blackjackRankedV1Adapter.replay(
			incompleteSeed,
			issueBlackjackConfig(100),
			[],
		);

		const projected = projectRankedBlackjackReplay(incompleteReplay, 1000, true);

		expect(projected.phase).toBe('complete');
		expect(projected.dealer.cards).toHaveLength(incompleteReplay.state.dealerHand.cards.length);
		expect(projected.availableActions).toEqual([]);
	});
});
