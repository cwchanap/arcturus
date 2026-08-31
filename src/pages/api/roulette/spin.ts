import type { APIRoute } from 'astro';
import type { D1Database } from '@cloudflare/workers-types';
import { evaluateBets } from '../../../lib/roulette/betEvaluator';
import {
	MAX_BET_PER_POSITION,
	MAX_BETS,
	MAX_TOTAL_BET,
	MIN_BET,
} from '../../../lib/roulette/constants';
import type { BetType, RouletteBet } from '../../../lib/roulette/types';
import {
	settleWalletRound,
	WalletSettlementDomainError,
	type SettleRoundResult,
	type WalletSettlementErrorCode,
} from '../../../lib/wallet/settle';

const VALID_OUTSIDE_BET_TYPES = new Set<BetType>(['red', 'black', 'odd', 'even', 'low', 'high']);
const VALID_TARGET_BET_TYPES = new Set<BetType>(['straight', 'dozen', 'column']);
const SYNC_ID_RE = /^[A-Za-z0-9_-]{1,128}$/;
const BET_ID_RE = /^[A-Za-z0-9_-]{1,128}$/;

export function isValidBet(b: unknown): b is RouletteBet {
	if (!b || typeof b !== 'object') return false;
	const bet = b as Record<string, unknown>;
	if (typeof bet.id !== 'string' || !BET_ID_RE.test(bet.id)) return false;
	if (typeof bet.type !== 'string') return false;
	const type = bet.type as BetType;
	if (!VALID_OUTSIDE_BET_TYPES.has(type) && !VALID_TARGET_BET_TYPES.has(type)) return false;
	if (typeof bet.amount !== 'number' || !Number.isInteger(bet.amount) || bet.amount < MIN_BET) {
		return false;
	}
	if (VALID_OUTSIDE_BET_TYPES.has(type) && bet.target !== undefined) return false;
	if (type === 'straight') {
		if (
			typeof bet.target !== 'number' ||
			!Number.isInteger(bet.target) ||
			bet.target < 0 ||
			bet.target > 36
		) {
			return false;
		}
	}
	if (type === 'dozen' || type === 'column') {
		if (typeof bet.target !== 'number' || ![0, 1, 2].includes(bet.target)) return false;
	}
	return true;
}

/** Keep only fields used by the authoritative evaluator. */
export function normalizeBet(b: unknown): RouletteBet | null {
	if (!isValidBet(b)) return null;
	const bet = b as Record<string, unknown>;
	const normalized: RouletteBet = {
		id: bet.id as string,
		type: bet.type as BetType,
		amount: bet.amount as number,
	};
	if (bet.target !== undefined) normalized.target = bet.target as number;
	return normalized;
}

export function generateWinningNumber(): number {
	const buf = new Uint8Array(1);
	const LIMIT = 222;
	do {
		crypto.getRandomValues(buf);
	} while (buf[0] >= LIMIT);
	return buf[0] % 37;
}

type SettleWalletRound = typeof settleWalletRound;

type PostHandlerDeps = {
	settleWalletRound: SettleWalletRound;
	evaluateBets: typeof evaluateBets;
	generateWinningNumber: () => number;
};

function statusForSettlementError(code: WalletSettlementErrorCode): number {
	switch (code) {
		case 'INVALID_COMMAND':
		case 'INSUFFICIENT_BALANCE':
			return 400;
		case 'SETTLEMENT_CONFLICT':
			return 409;
		case 'USER_NOT_FOUND':
			return 500;
	}
}

export function createPostHandler(overrides: Partial<PostHandlerDeps> = {}): APIRoute {
	const {
		settleWalletRound: settleWalletRoundImpl = settleWalletRound,
		evaluateBets: evaluateBetsImpl = evaluateBets,
		generateWinningNumber: generateWinningNumberImpl = generateWinningNumber,
	} = overrides;

	return (async ({ request, locals }) => {
		try {
			return await handleSpinRequest(request, locals, {
				settleWalletRoundImpl,
				evaluateBetsImpl,
				generateWinningNumberImpl,
			});
		} catch (error) {
			console.error('[ROULETTE] Unhandled spin error:', error);
			return Response.json({ error: 'INTERNAL_ERROR' }, { status: 500 });
		}
	}) as APIRoute;
}

type SpinHandlerDeps = {
	settleWalletRoundImpl: SettleWalletRound;
	evaluateBetsImpl: typeof evaluateBets;
	generateWinningNumberImpl: () => number;
};

async function handleSpinRequest(
	request: Request,
	locals: App.Locals,
	{ settleWalletRoundImpl, evaluateBetsImpl, generateWinningNumberImpl }: SpinHandlerDeps,
): Promise<Response> {
	if (!locals.user) return Response.json({ error: 'UNAUTHORIZED' }, { status: 401 });

	let body: { syncId?: unknown; bets?: unknown; totalBet?: unknown };
	try {
		body = await request.json();
	} catch {
		return Response.json({ error: 'INVALID_JSON' }, { status: 400 });
	}

	if (!body || typeof body !== 'object' || Array.isArray(body)) {
		return Response.json({ error: 'INVALID_REQUEST_BODY' }, { status: 400 });
	}

	const { syncId, bets: rawBets } = body;
	if (typeof syncId !== 'string' || !SYNC_ID_RE.test(syncId)) {
		return Response.json({ error: 'INVALID_SYNC_ID' }, { status: 400 });
	}
	if (!Array.isArray(rawBets) || rawBets.length === 0) {
		return Response.json({ error: 'INVALID_BETS' }, { status: 400 });
	}
	if (rawBets.length > MAX_BETS) {
		return Response.json({ error: 'TOO_MANY_BETS' }, { status: 400 });
	}

	const normalized = rawBets.map(normalizeBet);
	if (normalized.some((bet) => bet === null)) {
		return Response.json({ error: 'INVALID_BETS' }, { status: 400 });
	}
	const bets = normalized as RouletteBet[];

	const totalBet = bets.reduce((sum, bet) => sum + bet.amount, 0);
	if (totalBet < MIN_BET || totalBet > MAX_TOTAL_BET) {
		return Response.json({ error: 'INVALID_TOTAL_BET' }, { status: 400 });
	}

	const positionTotals = new Map<string, number>();
	for (const bet of bets) {
		const key = `${bet.type}:${bet.target ?? 'none'}`;
		positionTotals.set(key, (positionTotals.get(key) ?? 0) + bet.amount);
	}
	for (const total of positionTotals.values()) {
		if (total > MAX_BET_PER_POSITION) {
			return Response.json({ error: 'POSITION_LIMIT_EXCEEDED' }, { status: 400 });
		}
	}

	const dbBinding = locals.runtime?.env?.DB as D1Database | undefined;
	if (!dbBinding) return Response.json({ error: 'DATABASE_UNAVAILABLE' }, { status: 500 });

	// Roulette owns the random number, bet evaluation, and result shape. The
	// wallet use case owns every balance, receipt, stats, and mission write.
	const winningNumber = generateWinningNumberImpl();
	const results = evaluateBetsImpl(bets, winningNumber);
	const totalPayout = results.reduce((sum, result) => sum + result.payout, 0);
	const netDelta = totalPayout - totalBet;

	let walletResult;
	try {
		walletResult = await settleWalletRoundImpl(
			dbBinding,
			locals.user.id,
			{
				settlementId: syncId,
				game: 'roulette',
				delta: netDelta,
				stats: {
					rounds: 1,
					wins: netDelta > 0 ? 1 : 0,
					losses: netDelta < 0 ? 1 : 0,
					biggestWin: Math.max(netDelta, 0),
				},
			},
			totalBet,
		);
	} catch (error) {
		if (error instanceof WalletSettlementDomainError) {
			return Response.json({ error: error.code }, { status: statusForSettlementError(error.code) });
		}
		throw error;
	}

	if (walletResult.duplicate) {
		return Response.json({ duplicate: true, newBalance: walletResult.balance });
	}

	// The success payload must carry the wallet's language-neutral achievement
	// shape ({ id, icon }); names resolve client-side from the document locale.
	const newAchievements: SettleRoundResult['newAchievements'] = walletResult.newAchievements?.length
		? walletResult.newAchievements
		: undefined;

	return Response.json({
		winningNumber,
		newBalance: walletResult.balance,
		previousBalance: walletResult.balance - netDelta,
		netDelta,
		results,
		syncId,
		...(newAchievements ? { newAchievements } : {}),
	});
}

export const POST: APIRoute = createPostHandler();
