import type { APIRoute } from 'astro';
import {
	settleWalletRound,
	WalletSettlementDomainError,
	type WalletSettlementErrorCode,
} from '../../../lib/wallet/settle';

type SettleWalletRound = typeof settleWalletRound;

function statusForDomainError(code: WalletSettlementErrorCode): number {
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

export function createPostHandler({
	settle = settleWalletRound,
}: {
	settle?: SettleWalletRound;
} = {}): APIRoute {
	return async ({ locals, request }) => {
		const userId = locals.session?.user.id ?? locals.user?.id;
		if (!userId) return Response.json({ error: 'UNAUTHORIZED' }, { status: 401 });

		const d1 = locals.runtime?.env?.DB;
		if (!d1) return Response.json({ error: 'DATABASE_UNAVAILABLE' }, { status: 500 });

		let body: unknown;
		try {
			body = await request.json();
		} catch {
			return Response.json({ error: 'INVALID_JSON' }, { status: 400 });
		}

		try {
			const result = await settle(d1, userId, body as Parameters<SettleWalletRound>[2]);
			return Response.json(result);
		} catch (error) {
			if (error instanceof WalletSettlementDomainError) {
				return Response.json({ error: error.code }, { status: statusForDomainError(error.code) });
			}

			console.error('[WALLET_SETTLE] Failed to settle round:', error);
			return Response.json({ error: 'INTERNAL_ERROR' }, { status: 500 });
		}
	};
}

export const POST: APIRoute = createPostHandler();
