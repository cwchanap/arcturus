/**
 * API endpoint for updating user chip balance after game round
 */

import type { APIRoute } from 'astro';
import { createDb } from '../../../lib/db';
import { user } from '../../../db/schema';
import { eq } from 'drizzle-orm';

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

	try {
		// Parse request body
		const body = (await request.json()) as {
			newBalance: number;
			delta: number;
			gameType: string;
		};
		const { newBalance, delta, gameType } = body;

		// Validate inputs
		if (typeof newBalance !== 'number' || newBalance < 0) {
			return new Response(
				JSON.stringify({
					success: false,
					error: 'INVALID_BALANCE',
					message: 'New balance must be a non-negative number',
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

		// Get database connection
		const db = createDb(locals.runtime.env.DB);

		// Get current balance for response
		const previousBalance = locals.user.chipBalance;

		// Update user chip balance
		await db
			.update(user)
			.set({
				chipBalance: newBalance,
			})
			.where(eq(user.id, locals.user.id));

		// Return success response
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
