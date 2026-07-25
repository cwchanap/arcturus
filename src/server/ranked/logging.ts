import { sha256Hex } from '../../lib/ranked/canonical';

export const RANKED_LOG_EVENTS = Object.freeze([
	'ranked_session_started',
	'ranked_action_accepted',
	'ranked_action_rejected',
	'ranked_session_replayed',
	'ranked_session_settled',
	'ranked_session_expired',
	'ranked_rate_limited',
	'ranked_mp_escrow_orphaned',
	'ranked_invariant_violation',
] as const);

export type RankedLogEvent = (typeof RANKED_LOG_EVENTS)[number];

export interface RankedLogIdentifiers {
	userId?: string;
	sessionId?: string;
}

export interface RankedLogEntry {
	event: RankedLogEvent;
	userRef?: string;
	sessionRef?: string;
}

export function redactRankedIdentifier(identifier: string): string {
	return sha256Hex(identifier).slice(0, 12);
}

export function createRankedLogEntry(
	event: RankedLogEvent,
	{ userId, sessionId }: RankedLogIdentifiers = {},
): RankedLogEntry {
	return {
		event,
		...(userId === undefined ? {} : { userRef: redactRankedIdentifier(userId) }),
		...(sessionId === undefined ? {} : { sessionRef: redactRankedIdentifier(sessionId) }),
	};
}
