import type { APIRoute } from 'astro';
import { blackjackRunHttpHandlers } from '../../../server/blackjack-run/http';

export const GET: APIRoute = blackjackRunHttpHandlers.weeklyLeaderboard;
