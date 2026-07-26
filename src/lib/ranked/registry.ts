import { blackjackRankedV1Adapter } from './blackjack/adapter';
import { RankedServiceError, type RankedBlackjackActionLogEntryV1 } from './protocol';
import type {
	RankedBlackjackConfigV1,
	RankedBlackjackOutcomeV1,
	RankedBlackjackReplay,
} from './blackjack/types';
import type { RankedBlackjackPublicStateV1 } from './blackjack/adapter';

export type RankedGameType = 'blackjack';

export interface RankedGameAdapter<C, A, R, P, O> {
	readonly gameType: RankedGameType;
	readonly rulesetVersion: string;
	issue(input: { wager: number }): Promise<{ config: C; configJson: string; configHash: string }>;
	replay(seed: Uint8Array, config: C, actions: readonly A[]): Promise<R>;
	project(replay: R, accountBalance: number): P;
	/**
	 * Forces a terminal projection: reveals the dealer hole card and sets
	 * `phase` to `'complete'` even when the replay did not reach a natural
	 * terminal state. Used to render expired/forfeited sessions.
	 *
	 * Contract caveat: the returned state's `outcome` field reflects the
	 * replay's own outcome, which is `null` for replays that did not
	 * complete naturally. Callers rendering an expired/forfeited session
	 * MUST override `outcome` with the authoritative stored result. See
	 * `projectReplay` in `blackjack/adapter.ts` for the full rationale.
	 */
	projectTerminal(replay: R, accountBalance: number): P;
	terminalOutcome(replay: R): O | null;
}

type BlackjackRankedAdapter = RankedGameAdapter<
	RankedBlackjackConfigV1,
	RankedBlackjackActionLogEntryV1,
	RankedBlackjackReplay,
	RankedBlackjackPublicStateV1,
	RankedBlackjackOutcomeV1
>;

const ADAPTERS: ReadonlyMap<string, BlackjackRankedAdapter> = new Map([
	['blackjack:blackjack-ranked-v1', blackjackRankedV1Adapter],
]);

export function getRankedAdapter(gameType: string, rulesetVersion: string): BlackjackRankedAdapter {
	const adapter = ADAPTERS.get(`${gameType}:${rulesetVersion}`);
	if (!adapter) throw new RankedServiceError('INVALID_REQUEST');
	return adapter;
}
