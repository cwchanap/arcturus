/**
 * API endpoint for updating user chip balance after game round
 */

import type { APIRoute } from 'astro';
import { createDb } from '../../../lib/db';
import { user } from '../../../db/schema';
import { and, eq } from 'drizzle-orm';

// Server-enforced absolute maximum bet limit (prevents abuse via manipulated client settings)
// Players can configure up to this limit in their settings
const ABSOLUTE_MAX_BET_LIMIT = 10000;

// Multiplier for max delta calculation (accounts for splits with doubles: 2 hands x 2x bet each)
const MAX_BET_MULTIPLIER = 4;

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

	// Maximum allowed delta magnitude - server-side only, not influenced by client
	// Uses ABSOLUTE_MAX_BET_LIMIT (not client-provided maxBet) to prevent chip minting
	// Accounts for splits with doubles (2 hands x 2x bet each = 4x max bet)
	const maxAllowedDeltaMagnitude = ABSOLUTE_MAX_BET_LIMIT * MAX_BET_MULTIPLIER;

	// Validate delta magnitude to prevent chip minting attacks
	// Server doesn't have full game state, but can enforce reasonable bounds
	// based on betting limits (max win = 4x max bet for split+double scenarios)
	if (Math.abs(delta) > maxAllowedDeltaMagnitude) {
		return new Response(
			JSON.stringify({
				success: false,
				error: 'DELTA_EXCEEDS_LIMIT',
				message: `Delta magnitude exceeds maximum allowed (${maxAllowedDeltaMagnitude})`,
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
