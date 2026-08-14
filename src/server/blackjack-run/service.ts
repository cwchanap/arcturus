import type { D1Database } from '@cloudflare/workers-types';
import {
	replayBlackjackRound,
	projectBlackjackRoundReplay,
	type BlackjackRoundOutcome,
	type BlackjackRoundReplay,
} from '../../lib/blackjack-run/engine';
import {
	getDailyPeriodKey,
	getDailyWindow,
	replayDailyRun,
	DAILY_RUN_CONFIG,
	type DailyRunReplay,
} from '../../lib/blackjack-run/daily';
import {
	RANKED_RUN_TTL_SECONDS,
	additionalWagerFor,
	buildExpiryOutcome,
	buildRankedSettlementCommand,
} from '../../lib/blackjack-run/ranked';
import {
	blackjackRunCommandSchema,
	blackjackRunStartSchema,
	BlackjackRunError,
	type BlackjackRunCommand,
	type BlackjackRunPublicState,
	type BlackjackRunStart,
} from '../../lib/blackjack-run/protocol';
import { settleWalletRound, WalletSettlementDomainError } from '../../lib/wallet/settle';
import { readWalletBalance } from '../../lib/wallet/repository';
import type { SettleRoundCommand, SettleRoundResult } from '../../lib/wallet/types';
import {
	type BlackjackRunRecord,
	type BlackjackRunRepository,
	type DailyLeaderboardRead,
} from './repository';

export type BlackjackRunServiceErrorCode =
	| 'RUN_NOT_FOUND'
	| 'ACTIVE_RUN_EXISTS'
	| 'IDENTIFIER_REUSE_MISMATCH'
	| 'INSUFFICIENT_BALANCE'
	| 'INVALID_REQUEST'
	| 'SETTLEMENT_CONFLICT'
	| 'INTERNAL_ERROR'
	| 'UNAUTHORIZED';

export class BlackjackRunServiceError extends Error {
	readonly code: BlackjackRunServiceErrorCode;
	readonly retryable: boolean;

	constructor(code: BlackjackRunServiceErrorCode, message?: string) {
		super(message ?? code);
		this.name = 'BlackjackRunServiceError';
		this.code = code;
		this.retryable = code === 'SETTLEMENT_CONFLICT';
	}
}

export interface BlackjackRunServiceDeps {
	repository: BlackjackRunRepository;
	db: D1Database;
	/** Wall clock in unix seconds. */
	now: () => number;
	/** Seed/id source; must return exactly `length` bytes. */
	randomBytes: (length: number) => Uint8Array;
	settleWallet?: (
		db: D1Database,
		userId: string,
		command: SettleRoundCommand,
	) => Promise<SettleRoundResult>;
	readBalance?: (db: D1Database, userId: string) => Promise<number | null>;
}

export interface BlackjackRunService {
	start(userId: string, input: BlackjackRunStart): Promise<BlackjackRunPublicState>;
	current(userId: string, mode: 'ranked' | 'daily'): Promise<BlackjackRunPublicState>;
	get(userId: string, runId: string): Promise<BlackjackRunPublicState>;
	command(
		userId: string,
		runId: string,
		command: BlackjackRunCommand,
	): Promise<BlackjackRunPublicState>;
	expire(runId: string): Promise<BlackjackRunPublicState>;
	currentDaily(userId: string | null): Promise<BlackjackRunPublicState>;
	leaderboard(
		periodKey: string,
		userId: string | null,
		limit: number,
	): Promise<DailyLeaderboardRead>;
}

// Base64url helpers for run ids and seeds (the module is self-contained and
// defines its own encoding helpers).
const BASE64URL_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';
const BASE64URL_PATTERN = /^(?:[A-Za-z0-9_-]{4})*(?:[A-Za-z0-9_-]{2}|[A-Za-z0-9_-]{3})?$/;
const SEED_LENGTH = 32;
const SNAPSHOT_ATTEMPTS = 3;

function encodeBase64Url(bytes: Uint8Array): string {
	let encoded = '';
	for (let offset = 0; offset < bytes.length; offset += 3) {
		const remaining = bytes.length - offset;
		const first = bytes[offset];
		const second = remaining > 1 ? bytes[offset + 1] : 0;
		const third = remaining > 2 ? bytes[offset + 2] : 0;
		const value = first * 0x1_0000 + second * 0x100 + third;
		encoded += BASE64URL_ALPHABET[Math.floor(value / 0x4_0000) & 0x3f];
		encoded += BASE64URL_ALPHABET[Math.floor(value / 0x1000) & 0x3f];
		if (remaining > 1) encoded += BASE64URL_ALPHABET[Math.floor(value / 0x40) & 0x3f];
		if (remaining > 2) encoded += BASE64URL_ALPHABET[value & 0x3f];
	}
	return encoded;
}

function decodeBase64Url(encoded: string): Uint8Array {
	if (!BASE64URL_PATTERN.test(encoded)) {
		throw new BlackjackRunServiceError('INTERNAL_ERROR', 'Corrupt blackjack run seed encoding');
	}
	const output = new Uint8Array(Math.floor((encoded.length * 6) / 8));
	let bits = 0;
	let bitCount = 0;
	let offset = 0;
	for (const char of encoded) {
		const value = BASE64URL_ALPHABET.indexOf(char);
		if (value === -1) {
			throw new BlackjackRunServiceError('INTERNAL_ERROR', 'Corrupt blackjack run seed encoding');
		}
		bits = (bits << 6) | value;
		bitCount += 6;
		if (bitCount >= 8) {
			bitCount -= 8;
			output[offset] = (bits >> bitCount) & 0xff;
			offset += 1;
		}
	}
	return output;
}

type RankedStartInput = Extract<BlackjackRunStart, { mode: 'ranked' }>;
type DailyStartInput = Extract<BlackjackRunStart, { mode: 'daily' }>;
type RankedCommand = Extract<
	BlackjackRunCommand,
	{ command: 'hit' | 'stand' | 'double-down' | 'split' }
>;

class BlackjackRunServiceImpl implements BlackjackRunService {
	private readonly repository: BlackjackRunRepository;
	private readonly db: D1Database;
	private readonly now: () => number;
	private readonly randomBytes: (length: number) => Uint8Array;
	private readonly settleWallet: (
		db: D1Database,
		userId: string,
		command: SettleRoundCommand,
	) => Promise<SettleRoundResult>;
	private readonly readBalance: (db: D1Database, userId: string) => Promise<number | null>;

	constructor(deps: BlackjackRunServiceDeps) {
		this.repository = deps.repository;
		this.db = deps.db;
		this.now = deps.now;
		this.randomBytes = deps.randomBytes;
		this.settleWallet = deps.settleWallet ?? settleWalletRound;
		this.readBalance = deps.readBalance ?? readWalletBalance;
	}

	// --- public surface ---

	async start(userId: string, input: BlackjackRunStart): Promise<BlackjackRunPublicState> {
		const parsed = blackjackRunStartSchema.safeParse(input);
		if (!parsed.success) {
			const wagerIssue = parsed.error.issues.some((issue) => issue.path[0] === 'wager');
			if (wagerIssue) throw new BlackjackRunError('INVALID_WAGER');
			throw new BlackjackRunServiceError('INVALID_REQUEST');
		}
		const start = parsed.data;
		if (start.mode === 'ranked') return this.startRanked(userId, start);
		return this.startDaily(userId, start);
	}

	async current(userId: string, mode: 'ranked' | 'daily'): Promise<BlackjackRunPublicState> {
		if (mode === 'ranked') {
			// findActiveRun is Ranked-only by construction (daily rows keep
			// activeUserId NULL), so the Ranked current lookup is the active
			// ownership scan.
			const run = await this.repository.findActiveRun(userId, 'ranked');
			if (!run) throw new BlackjackRunServiceError('RUN_NOT_FOUND');
			return this.renderRunState(userId, run);
		}
		// Daily current is keyed off the current UTC period.
		const periodKey = getDailyPeriodKey(new Date(this.nowSeconds() * 1000));
		const run = await this.repository.findDailyRun(userId, periodKey);
		if (!run) throw new BlackjackRunServiceError('RUN_NOT_FOUND');
		return this.renderRunState(userId, run);
	}

	async get(userId: string, runId: string): Promise<BlackjackRunPublicState> {
		const run = await this.repository.findOwnedRun(userId, runId);
		if (!run) throw new BlackjackRunServiceError('RUN_NOT_FOUND');
		return this.renderRunState(userId, run);
	}

	async command(
		userId: string,
		runId: string,
		command: BlackjackRunCommand,
	): Promise<BlackjackRunPublicState> {
		const parsed = blackjackRunCommandSchema.safeParse(command);
		if (!parsed.success) throw new BlackjackRunError('INVALID_COMMAND');
		const run = await this.repository.findOwnedRun(userId, runId);
		if (!run) throw new BlackjackRunServiceError('RUN_NOT_FOUND');
		if (run.mode === 'daily') return this.dailyCommand(userId, run, parsed.data);
		return this.rankedCommand(userId, run, parsed.data);
	}

	async expire(runId: string): Promise<BlackjackRunPublicState> {
		const run = await this.repository.findRunById(runId);
		if (!run) throw new BlackjackRunServiceError('RUN_NOT_FOUND');
		const nowSeconds = this.nowSeconds();
		if (run.status !== 'active' || nowSeconds < run.expiresAt) {
			return this.renderRunState(run.userId, run);
		}
		if (run.mode === 'daily') return this.finalizeDailyExpired(run, nowSeconds);
		const replay = this.replayRanked(run);
		if (replay.state.phase === 'complete') {
			return this.finalizeRankedTerminal(
				run.userId,
				run,
				replay,
				this.requireOutcome(replay),
				'settled',
				nowSeconds,
			);
		}
		return this.finalizeRankedTerminal(
			run.userId,
			run,
			replay,
			buildExpiryOutcome(replay.state),
			'expired',
			nowSeconds,
		);
	}

	async currentDaily(userId: string | null): Promise<BlackjackRunPublicState> {
		if (userId === null) throw new BlackjackRunServiceError('RUN_NOT_FOUND');
		return this.current(userId, 'daily');
	}

	async leaderboard(
		periodKey: string,
		userId: string | null,
		limit: number,
	): Promise<DailyLeaderboardRead> {
		return this.repository.listDailyLeaderboard(periodKey, limit, userId);
	}

	// --- ranked lifecycle ---

	private async startRanked(
		userId: string,
		input: RankedStartInput,
	): Promise<BlackjackRunPublicState> {
		// 1. Resolve a request-id replay first: the same request ID must
		// return the same run without a second debit.
		const existing = await this.repository.findByStartRequest(userId, input.requestId);
		if (existing) {
			if (existing.mode !== 'ranked' || existing.initialWager !== input.wager) {
				throw new BlackjackRunServiceError('IDENTIFIER_REUSE_MISMATCH');
			}
			return this.renderRunState(userId, existing);
		}

		// 2. Read the wallet for user-facing validation. The atomic create
		// re-checks the balance, so a race still lands on 'insufficient'.
		if ((await this.readBalanceOrFail(userId)) < input.wager) {
			throw new BlackjackRunServiceError('INSUFFICIENT_BALANCE');
		}

		// 3. Atomic create; converge terminal/expired blocking runs between
		// attempts.
		for (let attempt = 0; attempt < SNAPSHOT_ATTEMPTS; attempt += 1) {
			const attemptNow = this.nowSeconds();
			const id = encodeBase64Url(this.requireRandomBytes(16));
			const result = await this.repository.createRankedRunWithStake({
				userId,
				id,
				startRequestId: input.requestId,
				initialWager: input.wager,
				seed: encodeBase64Url(this.requireRandomBytes(32)),
				expiresAt: attemptNow + RANKED_RUN_TTL_SECONDS,
				createdAt: attemptNow,
				updatedAt: attemptNow,
			});
			if (result.kind === 'applied') {
				const run = await this.repository.findOwnedRun(userId, id);
				if (!run) {
					throw new BlackjackRunServiceError('INTERNAL_ERROR', 'Ranked run start did not persist');
				}
				return this.renderRunState(userId, run);
			}
			if (result.kind === 'duplicate-request') {
				const winner = await this.repository.findByStartRequest(userId, input.requestId);
				if (!winner) {
					throw new BlackjackRunServiceError(
						'INTERNAL_ERROR',
						'Ranked start conflict lost its winner',
					);
				}
				if (winner.mode !== 'ranked' || winner.initialWager !== input.wager) {
					throw new BlackjackRunServiceError('IDENTIFIER_REUSE_MISMATCH');
				}
				return this.renderRunState(userId, winner);
			}
			if (result.kind === 'active-exists') {
				const blocking = await this.repository.findActiveRun(userId, 'ranked');
				if (!blocking) {
					throw new BlackjackRunServiceError(
						'INTERNAL_ERROR',
						'Ranked start conflict lost its active run',
					);
				}
				const replay = this.replayRanked(blocking);
				if (replay.state.phase === 'complete') {
					await this.finalizeRankedTerminal(
						userId,
						blocking,
						replay,
						this.requireOutcome(replay),
						'settled',
						attemptNow,
					);
				} else if (attemptNow >= blocking.expiresAt) {
					await this.finalizeRankedTerminal(
						userId,
						blocking,
						replay,
						buildExpiryOutcome(replay.state),
						'expired',
						attemptNow,
					);
				} else {
					throw new BlackjackRunServiceError('ACTIVE_RUN_EXISTS');
				}
				continue;
			}
			throw new BlackjackRunServiceError('INSUFFICIENT_BALANCE');
		}
		throw new BlackjackRunServiceError('INTERNAL_ERROR', 'Ranked run start did not converge');
	}

	private async rankedCommand(
		userId: string,
		run: BlackjackRunRecord,
		command: BlackjackRunCommand,
	): Promise<BlackjackRunPublicState> {
		if (command.command === 'start-round' || command.command === 'forfeit') {
			throw new BlackjackRunError('INVALID_COMMAND');
		}
		const actionCommand: RankedCommand = command;
		const nowSeconds = this.nowSeconds();
		if (run.status !== 'active') return this.renderRunState(userId, run);
		if (nowSeconds >= run.expiresAt) {
			const replay = this.replayRanked(run);
			return this.finalizeRankedTerminal(
				userId,
				run,
				replay,
				buildExpiryOutcome(replay.state),
				'expired',
				nowSeconds,
			);
		}
		const replay = this.replayRanked(run);
		if (replay.state.phase === 'complete') {
			return this.finalizeRankedTerminal(
				userId,
				run,
				replay,
				this.requireOutcome(replay),
				'settled',
				nowSeconds,
			);
		}
		if (actionCommand.sequence < run.nextSequence) {
			const stored = run.commands[actionCommand.sequence];
			if (stored && stored.command === actionCommand.command) {
				return this.renderRunState(userId, run);
			}
			throw new BlackjackRunServiceError('IDENTIFIER_REUSE_MISMATCH');
		}
		if (actionCommand.sequence > run.nextSequence) {
			throw new BlackjackRunError('SEQUENCE_MISMATCH', {
				expectedSequence: run.nextSequence,
			});
		}
		const legal = replay.legalActions.find(({ action }) => action === actionCommand.command);
		if (!legal) throw new BlackjackRunError('INVALID_ACTION');
		const activeHandWager = replay.state.playerHands[replay.state.activeHandIndex].wager;
		const additionalWager = additionalWagerFor(actionCommand.command, activeHandWager);

		const nextCommands = [...run.commands, actionCommand];
		for (let attempt = 0; attempt < SNAPSHOT_ATTEMPTS; attempt += 1) {
			const attemptNow = this.nowSeconds();
			const result = await this.repository.appendRankedCommandWithStake({
				userId,
				runId: run.id,
				expectedSequence: actionCommand.sequence,
				commandsJson: JSON.stringify(nextCommands),
				additionalWager,
				nowSeconds: attemptNow,
			});
			if (result.kind === 'applied') {
				const current = await this.repository.findOwnedRun(userId, run.id);
				if (!current) {
					throw new BlackjackRunServiceError(
						'INTERNAL_ERROR',
						'Ranked command append did not persist',
					);
				}
				return this.renderRunState(userId, current);
			}
			if (result.kind === 'insufficient') {
				throw new BlackjackRunServiceError('INSUFFICIENT_BALANCE');
			}
			const current = await this.repository.findOwnedRun(userId, run.id);
			if (!current) {
				throw new BlackjackRunServiceError('INTERNAL_ERROR', 'Ranked command append lost its run');
			}
			if (current.status !== 'active') return this.renderRunState(userId, current);
			if (this.nowSeconds() >= current.expiresAt) return this.renderRunState(userId, current);
			if (current.nextSequence > actionCommand.sequence) {
				const stored = current.commands[actionCommand.sequence];
				if (stored && stored.command === actionCommand.command) {
					return this.renderRunState(userId, current);
				}
				throw new BlackjackRunServiceError('IDENTIFIER_REUSE_MISMATCH');
			}
			if (current.nextSequence < actionCommand.sequence) {
				throw new BlackjackRunError('SEQUENCE_MISMATCH', {
					expectedSequence: current.nextSequence,
				});
			}
			run = current;
		}
		throw new BlackjackRunServiceError('INTERNAL_ERROR', 'Ranked command append did not converge');
	}

	// --- daily lifecycle ---

	private async startDaily(
		userId: string,
		input: DailyStartInput,
	): Promise<BlackjackRunPublicState> {
		// Resolve request-id replays before checking the entry window: an
		// already-created attempt remains idempotently readable after close.
		const existing = await this.repository.findByStartRequest(userId, input.requestId);
		if (existing) {
			if (existing.mode !== 'daily' || existing.periodKey !== input.periodKey) {
				throw new BlackjackRunServiceError('IDENTIFIER_REUSE_MISMATCH');
			}
			return this.renderRunState(userId, existing);
		}

		const nowSeconds = this.nowSeconds();
		const window = getDailyWindow(nowSeconds);
		if (input.periodKey !== window.periodKey || nowSeconds >= window.rankedEntryClosesAt) {
			throw new BlackjackRunServiceError('INVALID_REQUEST');
		}

		const prior = await this.repository.findDailyRun(userId, input.periodKey);
		if (prior) return this.renderRunState(userId, prior);

		const id = encodeBase64Url(this.requireRandomBytes(16));
		const daily = await this.repository.getOrCreateDaily(
			input.periodKey,
			() => encodeBase64Url(this.requireRandomBytes(32)),
			nowSeconds,
		);
		const result = await this.repository.createDailyRun({
			userId,
			id,
			periodKey: input.periodKey,
			startRequestId: input.requestId,
			seed: daily.seed,
			expiresAt: nowSeconds + DAILY_RUN_CONFIG.attemptTtlSeconds,
			createdAt: nowSeconds,
			updatedAt: nowSeconds,
		});
		if (result.kind === 'existing') {
			const winner = await this.repository.findDailyRun(userId, input.periodKey);
			if (!winner) {
				throw new BlackjackRunServiceError(
					'INTERNAL_ERROR',
					'Daily run start conflict lost its run',
				);
			}
			return this.renderRunState(userId, winner);
		}
		const run = await this.repository.findOwnedRun(userId, id);
		if (!run) {
			throw new BlackjackRunServiceError('INTERNAL_ERROR', 'Daily run start did not persist');
		}
		return this.renderRunState(userId, run);
	}

	private async dailyCommand(
		userId: string,
		run: BlackjackRunRecord,
		command: BlackjackRunCommand,
	): Promise<BlackjackRunPublicState> {
		const nowSeconds = this.nowSeconds();
		if (run.status !== 'active') return this.renderRunState(userId, run);
		if (nowSeconds >= run.expiresAt) return this.finalizeDailyExpired(run, nowSeconds);
		if (command.sequence < run.nextSequence) {
			const stored = run.commands[command.sequence];
			if (stored && stored.command === command.command && stored.wager === command.wager) {
				return this.renderRunState(userId, run);
			}
			throw new BlackjackRunServiceError('IDENTIFIER_REUSE_MISMATCH');
		}
		if (command.sequence > run.nextSequence) {
			throw new BlackjackRunError('SEQUENCE_MISMATCH', {
				expectedSequence: run.nextSequence,
			});
		}
		// Validate by replaying the would-be log; the pure core rejects
		// illegal commands (ATTEMPT_COMPLETE / INVALID_COMMAND / INVALID_WAGER
		// / INSUFFICIENT_CHALLENGE_BANKROLL) before anything is persisted.
		const nextCommands = [...run.commands, command];
		replayDailyRun(this.decodeSeed(run), nextCommands);

		for (let attempt = 0; attempt < SNAPSHOT_ATTEMPTS; attempt += 1) {
			const attemptNow = this.nowSeconds();
			const result = await this.repository.appendDailyCommand({
				userId,
				runId: run.id,
				expectedSequence: command.sequence,
				commandsJson: JSON.stringify(nextCommands),
				nowSeconds: attemptNow,
			});
			if (result.kind === 'applied') {
				const current = await this.repository.findOwnedRun(userId, run.id);
				if (!current) {
					throw new BlackjackRunServiceError(
						'INTERNAL_ERROR',
						'Daily command append did not persist',
					);
				}
				return this.renderRunState(userId, current);
			}
			const current = await this.repository.findOwnedRun(userId, run.id);
			if (!current) {
				throw new BlackjackRunServiceError('INTERNAL_ERROR', 'Daily command append lost its run');
			}
			if (current.status !== 'active') return this.renderRunState(userId, current);
			if (this.nowSeconds() >= current.expiresAt) return this.renderRunState(userId, current);
			if (current.nextSequence > command.sequence) {
				const stored = current.commands[command.sequence];
				if (stored && stored.command === command.command && stored.wager === command.wager) {
					return this.renderRunState(userId, current);
				}
				throw new BlackjackRunServiceError('IDENTIFIER_REUSE_MISMATCH');
			}
			if (current.nextSequence < command.sequence) {
				throw new BlackjackRunError('SEQUENCE_MISMATCH', {
					expectedSequence: current.nextSequence,
				});
			}
			run = current;
		}
		throw new BlackjackRunServiceError('INTERNAL_ERROR', 'Daily command append did not converge');
	}

	// --- read finalization: reads converge terminal/expired active rows ---

	private async renderRunState(
		userId: string,
		run: BlackjackRunRecord,
	): Promise<BlackjackRunPublicState> {
		if (run.status !== 'active') {
			if (run.mode === 'daily') return this.renderDailyState(userId, run);
			return this.renderRankedState(userId, run);
		}
		const nowSeconds = this.nowSeconds();
		const replay = this.replayRun(run);
		if (run.mode === 'daily') {
			const daily = replay as DailyRunReplay;
			if (daily.status !== 'active') {
				return this.finalizeDailyTerminal(userId, run, nowSeconds);
			}
			if (nowSeconds >= run.expiresAt) return this.finalizeDailyExpired(run, nowSeconds);
			return this.renderDailyState(userId, run, daily);
		}
		return this.renderRankedState(userId, run, replay as BlackjackRoundReplay);
	}

	private async renderRankedState(
		userId: string,
		run: BlackjackRunRecord,
		replay: BlackjackRoundReplay = this.replayRanked(run),
	): Promise<BlackjackRunPublicState> {
		if (run.status === 'active') {
			const nowSeconds = this.nowSeconds();
			if (replay.state.phase === 'complete') {
				return this.finalizeRankedTerminal(
					userId,
					run,
					replay,
					this.requireOutcome(replay),
					'settled',
					nowSeconds,
				);
			}
			if (nowSeconds >= run.expiresAt) {
				return this.finalizeRankedTerminal(
					userId,
					run,
					replay,
					buildExpiryOutcome(replay.state),
					'expired',
					nowSeconds,
				);
			}
			return this.projectRankedState(
				run,
				replay,
				null,
				await this.readBalanceOrFail(userId),
				'active',
			);
		}
		// Stored terminal row: gameplay outcome is authoritative; expired runs
		// carry their forced-loss outcome in resultJson.
		let storedOutcome: BlackjackRoundOutcome | null = null;
		if (run.resultJson !== null) {
			try {
				storedOutcome = JSON.parse(run.resultJson) as BlackjackRoundOutcome;
			} catch {
				throw new BlackjackRunServiceError('INTERNAL_ERROR', 'Corrupt ranked run result');
			}
		}
		const outcome = replay.outcome ?? storedOutcome;
		if (!outcome) {
			throw new BlackjackRunServiceError('INTERNAL_ERROR', 'Ranked terminal run has no outcome');
		}
		return this.projectRankedState(
			run,
			replay,
			outcome,
			await this.readBalanceOrFail(userId),
			run.status === 'expired' ? 'expired' : 'settled',
		);
	}

	private async renderDailyState(
		userId: string,
		run: BlackjackRunRecord,
		replay: DailyRunReplay = this.replayDaily(run),
	): Promise<BlackjackRunPublicState> {
		const expired = run.status === 'expired';
		let rank: number | null = null;
		let percentile: number | null = null;
		if (run.status === 'completed') {
			if (!run.periodKey) {
				throw new BlackjackRunServiceError('INTERNAL_ERROR', 'Daily run missing its period key');
			}
			const standing = await this.repository.listDailyLeaderboard(run.periodKey, 1, userId);
			rank = standing.currentUser?.rank ?? null;
			percentile = standing.currentUser?.percentile ?? null;
		}
		return {
			mode: 'daily',
			runId: run.id,
			status: run.status,
			terminalReason: expired ? 'expired' : replay.terminalReason,
			eligible: expired ? null : replay.eligible,
			expiresAt: run.expiresAt,
			nextCommandSequence: replay.nextCommandSequence,
			availableBankroll: replay.availableBankroll,
			roundsCompleted: replay.roundsCompleted,
			activeRound: expired ? null : replay.activeRoundPublic,
			rank,
			percentile,
		};
	}

	// --- terminal finalizers ---

	/**
	 * One Ranked finalizer for both gameplay terminals and expiration. The
	 * wallet credits the gross payout (delta = payout >= 0, no requiredFunds)
	 * with the true net result in stats.netProfit; finishRun then clears
	 * active ownership. A lost finishRun race reloads the stored run — the
	 * wallet receipt is already persisted, so the stable settlementId makes a
	 * retry idempotent. A transient SETTLEMENT_CONFLICT propagates as a
	 * retryable service error and leaves the run active for a later read.
	 */
	private async finalizeRankedTerminal(
		userId: string,
		run: BlackjackRunRecord,
		replay: BlackjackRoundReplay,
		outcome: BlackjackRoundOutcome,
		status: 'settled' | 'expired',
		nowSeconds: number,
	): Promise<BlackjackRunPublicState> {
		for (let attempt = 0; attempt < SNAPSHOT_ATTEMPTS; attempt += 1) {
			const settleResult = await this.settleSafely(
				userId,
				buildRankedSettlementCommand(run.id, outcome),
			);
			const finish = await this.repository.finishRun({
				userId,
				runId: run.id,
				mode: 'ranked',
				expectedSequence: run.nextSequence,
				status,
				resultJson: JSON.stringify(outcome),
				dailyEndingBankroll: null,
				dailyRoundsCompleted: null,
				nowSeconds,
			});
			if (finish.kind === 'applied') {
				return this.projectRankedState(run, replay, outcome, settleResult.balance, status);
			}
			// finishRun lost the race: reload and converge on whatever the
			// winning writer stored.
			const current = await this.repository.findOwnedRun(userId, run.id);
			if (!current) {
				throw new BlackjackRunServiceError(
					'INTERNAL_ERROR',
					'Ranked run disappeared during finalization',
				);
			}
			if (current.status !== 'active' || current.nextSequence !== run.nextSequence) {
				return this.renderRunState(userId, current);
			}
			run = current;
		}
		throw new BlackjackRunServiceError(
			'INTERNAL_ERROR',
			'Ranked run finalization did not converge',
		);
	}

	/** Daily terminal writes are bankroll-only: no wallet call, ever. */
	private async finalizeDailyTerminal(
		userId: string,
		run: BlackjackRunRecord,
		nowSeconds: number,
	): Promise<BlackjackRunPublicState> {
		for (let attempt = 0; attempt < SNAPSHOT_ATTEMPTS; attempt += 1) {
			const replay = this.replayDaily(run);
			if (replay.status === 'active') {
				// The command log moved under us; re-derive everything.
				return this.renderRunState(userId, run);
			}
			const finish = await this.repository.finishRun({
				userId,
				runId: run.id,
				mode: 'daily',
				expectedSequence: run.nextSequence,
				status: replay.status,
				resultJson: null,
				dailyEndingBankroll: replay.status === 'completed' ? replay.availableBankroll : null,
				dailyRoundsCompleted: replay.status === 'completed' ? replay.roundsCompleted : null,
				nowSeconds,
			});
			if (finish.kind === 'applied') {
				const stored = await this.repository.findOwnedRun(userId, run.id);
				if (!stored) {
					throw new BlackjackRunServiceError('INTERNAL_ERROR', 'Daily run finish did not persist');
				}
				return this.renderRunState(userId, stored);
			}
			const current = await this.repository.findOwnedRun(userId, run.id);
			if (!current) {
				throw new BlackjackRunServiceError(
					'INTERNAL_ERROR',
					'Daily run disappeared during finalization',
				);
			}
			if (current.status !== 'active') return this.renderRunState(userId, current);
			run = current;
		}
		throw new BlackjackRunServiceError('INTERNAL_ERROR', 'Daily run finalization did not converge');
	}

	/** Daily expiration stores `expired` with null leaderboard projections. */
	private async finalizeDailyExpired(
		run: BlackjackRunRecord,
		nowSeconds: number,
	): Promise<BlackjackRunPublicState> {
		for (let attempt = 0; attempt < SNAPSHOT_ATTEMPTS; attempt += 1) {
			const finish = await this.repository.finishRun({
				userId: run.userId,
				runId: run.id,
				mode: 'daily',
				expectedSequence: run.nextSequence,
				status: 'expired',
				resultJson: null,
				dailyEndingBankroll: null,
				dailyRoundsCompleted: null,
				nowSeconds,
			});
			if (finish.kind === 'applied') {
				const stored = await this.repository.findOwnedRun(run.userId, run.id);
				if (!stored) {
					throw new BlackjackRunServiceError('INTERNAL_ERROR', 'Daily run finish did not persist');
				}
				return this.renderRunState(run.userId, stored);
			}
			const current = await this.repository.findOwnedRun(run.userId, run.id);
			if (!current) {
				throw new BlackjackRunServiceError(
					'INTERNAL_ERROR',
					'Daily run disappeared during finalization',
				);
			}
			if (current.status !== 'active') return this.renderRunState(run.userId, current);
			run = current;
		}
		throw new BlackjackRunServiceError('INTERNAL_ERROR', 'Daily run finalization did not converge');
	}

	// --- helpers ---

	private async settleSafely(
		userId: string,
		command: SettleRoundCommand,
	): Promise<SettleRoundResult> {
		try {
			return await this.settleWallet(this.db, userId, command);
		} catch (error) {
			if (error instanceof WalletSettlementDomainError && error.code === 'SETTLEMENT_CONFLICT') {
				throw new BlackjackRunServiceError('SETTLEMENT_CONFLICT');
			}
			// USER_NOT_FOUND / INVALID_COMMAND / unknown wallet failures are
			// loud internal/domain failures: propagate as-is.
			throw error;
		}
	}

	private projectRankedState(
		run: BlackjackRunRecord,
		replay: BlackjackRoundReplay,
		outcome: BlackjackRoundOutcome | null,
		balance: number,
		status: 'active' | 'settled' | 'expired',
	): BlackjackRunPublicState {
		const projected = projectBlackjackRoundReplay(replay, balance, status !== 'active');
		return {
			mode: 'ranked',
			runId: run.id,
			status,
			expiresAt: run.expiresAt,
			balance,
			...projected,
			outcome: outcome ?? projected.outcome,
		};
	}

	// One concrete replay switch; no mode adapter interface.
	private replayRun(run: BlackjackRunRecord): BlackjackRoundReplay | DailyRunReplay {
		switch (run.mode) {
			case 'ranked':
				return this.replayRanked(run);
			case 'daily':
				return this.replayDaily(run);
		}
	}

	private replayRanked(run: BlackjackRunRecord): BlackjackRoundReplay {
		if (run.initialWager === null) {
			throw new BlackjackRunServiceError('INTERNAL_ERROR', 'Ranked run missing its initial wager');
		}
		return replayBlackjackRound({
			seed: this.decodeSeed(run),
			initialWager: run.initialWager,
			// The repository persists the sequenced command log; the ranked
			// engine replays plain actions.
			actions: run.commands.map(({ command }) => command),
		});
	}

	private replayDaily(
		run: BlackjackRunRecord,
		commands?: readonly BlackjackRunCommand[],
	): DailyRunReplay {
		return replayDailyRun(this.decodeSeed(run), commands ?? run.commands);
	}

	private decodeSeed(run: BlackjackRunRecord): Uint8Array {
		const seed = decodeBase64Url(run.seed);
		if (seed.length !== SEED_LENGTH) {
			throw new BlackjackRunServiceError('INTERNAL_ERROR', 'Corrupt blackjack run seed');
		}
		return seed;
	}

	private requireOutcome(replay: BlackjackRoundReplay): BlackjackRoundOutcome {
		if (!replay.outcome) {
			throw new BlackjackRunServiceError('INTERNAL_ERROR', 'Terminal ranked replay has no outcome');
		}
		return replay.outcome;
	}

	private async readBalanceOrFail(userId: string): Promise<number> {
		const balance = await this.readBalance(this.db, userId);
		if (balance === null) {
			throw new BlackjackRunServiceError('INTERNAL_ERROR', 'Blackjack run user disappeared');
		}
		return balance;
	}

	private nowSeconds(): number {
		const seconds = this.now();
		if (!Number.isSafeInteger(seconds) || seconds < 0) {
			throw new BlackjackRunServiceError('INTERNAL_ERROR', 'Invalid blackjack run clock');
		}
		return seconds;
	}

	private requireRandomBytes(length: number): Uint8Array {
		const bytes = this.randomBytes(length);
		if (!(bytes instanceof Uint8Array) || bytes.length !== length) {
			throw new BlackjackRunServiceError(
				'INTERNAL_ERROR',
				'Blackjack run random source returned an invalid byte count',
			);
		}
		return bytes.slice();
	}
}

export function createBlackjackRunService(deps: BlackjackRunServiceDeps): BlackjackRunService {
	return new BlackjackRunServiceImpl(deps);
}
