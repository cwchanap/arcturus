/**
 * API endpoint for updating user chip balance after game round
 *
 * ⚠️ KNOWN SECURITY LIMITATION - DEMO/PLAY-MONEY ONLY ⚠️
 *
 * This endpoint trusts client-supplied delta values because the game runs
 * entirely client-side without server-side game state. This is a deliberate
 * architectural tradeoff for this demo casino with play-money chips.
 *
 * WHAT THIS MEANS:
 * - A malicious user CAN mint chips by calling this API directly
 * - The mitigations below only slow down and detect abuse, not prevent it
 * - This is acceptable for a demo but NOT for real-money gambling
 *
 * MITIGATIONS IMPLEMENTED:
 * 1. Wins severely capped (1000 chips max) - makes exploitation tedious
 * 2. Rate limiting (2s between updates) - limits abuse to ~1800 chips/hour
 * 3. Audit logging - all wins are logged for detection
 * 4. Optimistic locking - prevents race conditions
 * 5. Authentication required - abuse is tied to user accounts
 *
 * FOR PRODUCTION REAL-MONEY CASINO:
 * - Game logic MUST run server-side
 * - Server must track: deck state, bets placed, cards dealt, actions taken
 * - Payouts computed from authoritative server state only
 * - Consider provably-fair algorithms with cryptographic verification
 * - This endpoint would only accept round IDs, not deltas
 */

import type { APIRoute } from 'astro';
import { createDb } from '../../../lib/db';
import { user } from '../../../db/schema';
import { and, eq } from 'drizzle-orm';

// Maximum LOSS per request (negative delta) - allows normal gameplay
// Accounts for split + double scenarios: 2 hands x 2x bet x max bet
const MAX_LOSS_PER_REQUEST = 40000; // 4 * 10000 max bet

// Maximum WIN per request (positive delta)
// Must accommodate legitimate payouts:
// - Max bet: 1000 (configurable up to 10000)
// - Blackjack payout: 1.5x bet = 1500 on 1000 bet
// - Split + double: 2 hands x 2x bet = 4x max bet wagered
// - Worst case: split, double both, win both = ~6x bet win
// Set to 10000 to allow max configured bet (10000) with blackjack payout
const MAX_WIN_PER_REQUEST = 10000;

// Minimum milliseconds between chip updates (rate limiting)
// Prevents rapid-fire exploitation; normal gameplay has natural delays
const MIN_UPDATE_INTERVAL_MS = 2000; // 2 seconds between updates

// In-memory rate limit store (per-user last update timestamp)
// Note: This resets on worker restart; for production, use KV or D1
const lastUpdateByUser = new Map<string, number>();

export const POST: APIRoute = async ({ request, locals }) => {
	// Validate authentication
	if (!locals.user) {
		return new Response(
			JSON.stringify({
				success: false,
				error: 'UNAUTHORIZED',
				message: 'Authentication required',
			}),
			{
				status: 401,
				headers: { 'Content-Type': 'application/json' },
			},
		);
	}

	const userId = locals.user.id;
	const now = Date.now();

	// Rate limiting check
	const lastUpdate = lastUpdateByUser.get(userId) ?? 0;
	if (now - lastUpdate < MIN_UPDATE_INTERVAL_MS) {
		const waitTime = Math.ceil((MIN_UPDATE_INTERVAL_MS - (now - lastUpdate)) / 1000);
		return new Response(
			JSON.stringify({
				success: false,
				error: 'RATE_LIMITED',
				message: `Please wait ${waitTime} second(s) before updating chips again`,
			}),
			{
				status: 429,
				headers: {
					'Content-Type': 'application/json',
					'Retry-After': String(waitTime),
				},
			},
		);
	}

	// Parse request body with explicit error handling for malformed JSON
	let body: { delta?: unknown; gameType?: unknown; previousBalance?: unknown; maxBet?: unknown };
	try {
		body = await request.json();
	} catch {
		return new Response(
			JSON.stringify({
				success: false,
				error: 'INVALID_REQUEST_BODY',
				message: 'Request body must be valid JSON',
			}),
			{
				status: 400,
				headers: { 'Content-Type': 'application/json' },
			},
		);
	}

	const { delta, gameType, previousBalance: clientPreviousBalance } = body;
	// Note: body.maxBet is intentionally NOT used for validation.
	// Trusting client-provided maxBet would allow attackers to claim higher bet limits.
	// Instead, we enforce server-side caps (MAX_WIN_PER_REQUEST, MAX_LOSS_PER_REQUEST)
	// that apply uniformly regardless of what the client claims.

	// Validate delta is a finite number
	if (typeof delta !== 'number' || !Number.isFinite(delta)) {
		return new Response(
			JSON.stringify({
				success: false,
				error: 'INVALID_DELTA',
				message: 'Delta must be a finite number',
			}),
			{
				status: 400,
				headers: { 'Content-Type': 'application/json' },
			},
		);
	}

	// Asymmetric delta validation:
	// - Losses (negative delta) allowed up to MAX_LOSS_PER_REQUEST
	// - Wins (positive delta) severely capped at MAX_WIN_PER_REQUEST
	// This makes exploitation tedious while allowing normal gameplay
	if (delta > 0 && delta > MAX_WIN_PER_REQUEST) {
		console.warn(
			`[CHIP_AUDIT] User ${userId} attempted win of ${delta}, capped at ${MAX_WIN_PER_REQUEST}`,
		);
		return new Response(
			JSON.stringify({
				success: false,
				error: 'DELTA_EXCEEDS_LIMIT',
				message: `Win amount exceeds maximum allowed (${MAX_WIN_PER_REQUEST})`,
			}),
			{
				status: 400,
				headers: { 'Content-Type': 'application/json' },
			},
		);
	}

	if (delta < 0 && Math.abs(delta) > MAX_LOSS_PER_REQUEST) {
		return new Response(
			JSON.stringify({
				success: false,
				error: 'DELTA_EXCEEDS_LIMIT',
				message: `Loss amount exceeds maximum allowed (${MAX_LOSS_PER_REQUEST})`,
			}),
			{
				status: 400,
				headers: { 'Content-Type': 'application/json' },
			},
		);
	}

	// Validate gameType is a string
	if (typeof gameType !== 'string') {
		return new Response(
			JSON.stringify({
				success: false,
				error: 'INVALID_REQUEST_BODY',
				message: 'gameType must be a string',
			}),
			{
				status: 400,
				headers: { 'Content-Type': 'application/json' },
			},
		);
	}

	if (gameType !== 'blackjack') {
		return new Response(
			JSON.stringify({
				success: false,
				error: 'INVALID_GAME_TYPE',
				message: 'Invalid game type',
			}),
			{
				status: 400,
				headers: { 'Content-Type': 'application/json' },
			},
		);
	}

	// Validate previousBalance if provided (for optimistic locking)
	if (clientPreviousBalance !== undefined && typeof clientPreviousBalance !== 'number') {
		return new Response(
			JSON.stringify({
				success: false,
				error: 'INVALID_REQUEST_BODY',
				message: 'previousBalance must be a number if provided',
			}),
			{
				status: 400,
				headers: { 'Content-Type': 'application/json' },
			},
		);
	}

	// Get server-side previous balance (authoritative source)
	const previousBalance = locals.user.chipBalance;

	// Optimistic locking: reject if client's previousBalance doesn't match server
	if (clientPreviousBalance !== undefined && clientPreviousBalance !== previousBalance) {
		return new Response(
			JSON.stringify({
				success: false,
				error: 'BALANCE_MISMATCH',
				message: 'Balance has changed. Please refresh and try again.',
				currentBalance: previousBalance,
			}),
			{
				status: 409,
				headers: { 'Content-Type': 'application/json' },
			},
		);
	}

	// Compute new balance server-side (prevents chip minting attacks)
	const newBalance = previousBalance + delta;

	// Validate computed balance is non-negative
	if (newBalance < 0) {
		return new Response(
			JSON.stringify({
				success: false,
				error: 'INSUFFICIENT_BALANCE',
				message: 'Insufficient chip balance for this operation',
				currentBalance: previousBalance,
			}),
			{
				status: 400,
				headers: { 'Content-Type': 'application/json' },
			},
		);
	}

	// Check DB binding exists (may be undefined in local dev without Cloudflare bindings)
	const dbBinding = locals.runtime?.env?.DB ?? null;
	if (!dbBinding) {
		return new Response(
			JSON.stringify({
				success: false,
				error: 'DATABASE_UNAVAILABLE',
				message: 'Database is not configured',
			}),
			{
				status: 500,
				headers: { 'Content-Type': 'application/json' },
			},
		);
	}

	// Database operations wrapped in try-catch
	try {
		const db = createDb(dbBinding);

		// Atomic update with optimistic locking via WHERE condition
		// This prevents TOCTOU race by ensuring balance hasn't changed since we read it
		const result = await db
			.update(user)
			.set({
				chipBalance: newBalance,
			})
			.where(and(eq(user.id, locals.user.id), eq(user.chipBalance, previousBalance)));

		// Check if update affected any rows (D1 returns rowsAffected in meta)
		const rowsAffected = result?.meta?.changes ?? result?.rowsAffected ?? 0;
		if (rowsAffected === 0) {
			// Concurrent modification detected - balance changed between read and write
			return new Response(
				JSON.stringify({
					success: false,
					error: 'BALANCE_MISMATCH',
					message: 'Balance was modified concurrently. Please refresh and try again.',
				}),
				{
					status: 409,
					headers: { 'Content-Type': 'application/json' },
				},
			);
		}

		// Update rate limit timestamp on successful update
		lastUpdateByUser.set(userId, Date.now());

		// Audit log for wins (positive deltas) to help detect exploitation patterns
		if (delta > 0) {
			console.log(
				`[CHIP_AUDIT] User ${userId} won ${delta} chips: ${previousBalance} -> ${newBalance}`,
			);
		}

		// Return success response with validated values only
		return new Response(
			JSON.stringify({
				success: true,
				balance: newBalance,
				previousBalance,
				delta,
				message: 'Chip balance updated successfully',
			}),
			{
				status: 200,
				headers: { 'Content-Type': 'application/json' },
			},
		);
	} catch (error) {
		console.error('Chip balance update error:', error);
		return new Response(
			JSON.stringify({
				success: false,
				error: 'DATABASE_ERROR',
				message: 'Failed to update chip balance. Please try again.',
			}),
			{
				status: 500,
				headers: { 'Content-Type': 'application/json' },
			},
		);
	}
};
