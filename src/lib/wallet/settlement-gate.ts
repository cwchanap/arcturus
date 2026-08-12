import { submitWalletSettlement } from './client';
import type { SettleRoundCommand, SettleRoundResult } from './types';

export class WalletSettlementError extends Error {
	constructor(message: string) {
		super(message);
		this.name = 'WalletSettlementError';
	}
}

export interface SettlementGate {
	readonly pending: SettleRoundCommand | null;
	readonly isBlocked: boolean;
	settle(command: SettleRoundCommand): Promise<SettleRoundResult>;
	retry(): Promise<SettleRoundResult | null>;
	reset(): void;
}

export function createSettlementGate({
	submit = submitWalletSettlement,
}: {
	submit?: typeof submitWalletSettlement;
} = {}): SettlementGate {
	let pending: SettleRoundCommand | null = null;
	let inFlight = false;

	const run = async (command: SettleRoundCommand): Promise<SettleRoundResult> => {
		if (inFlight) throw new WalletSettlementError('Settlement already in progress');
		inFlight = true;
		pending = command;
		try {
			const result = await submit(command);
			pending = null;
			return result;
		} finally {
			inFlight = false;
		}
	};

	return {
		get pending() {
			return pending;
		},
		get isBlocked() {
			return pending !== null || inFlight;
		},
		settle(command) {
			if (pending !== null) throw new WalletSettlementError('Settlement pending');
			return run(command);
		},
		retry() {
			const command = pending;
			return command ? run(command) : Promise.resolve(null);
		},
		reset() {
			pending = null;
		},
	};
}
