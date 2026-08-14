import type { APIRoute } from 'astro';
import { blackjackRunHttpHandlers } from '../../../../server/blackjack-run/http';

export const POST: APIRoute = blackjackRunHttpHandlers.command;
