import { fetchJsonWithTimeout } from '../fetch-with-timeout';
import type { SettleRoundCommand, SettleRoundResult } from './types';

export const WALLET_SETTLEMENT_TIMEOUT_MS = 15_000;

export async function submitWalletSettlement(
	command: SettleRoundCommand,
): Promise<SettleRoundResult> {
	const { response, data } = await fetchJsonWithTimeout<
		SettleRoundResult | { error?: string; message?: string }
	>(
		'/api/wallet/settle',
		{
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify(command),
		},
		WALLET_SETTLEMENT_TIMEOUT_MS,
	);

	if (!response.ok) {
		const message =
			typeof data === 'object' && data !== null && 'error' in data && typeof data.error === 'string'
				? data.error
				: typeof data === 'object' &&
					  data !== null &&
					  'message' in data &&
					  typeof data.message === 'string'
					? data.message
					: `Wallet settlement failed (${response.status})`;
		throw new Error(message);
	}

	return data as SettleRoundResult;
}
