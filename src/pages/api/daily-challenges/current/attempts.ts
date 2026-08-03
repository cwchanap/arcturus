import type { APIRoute } from 'astro';
import { dailyChallengeHttpHandlers } from '../../../../server/daily-challenge/http';

export const POST: APIRoute = dailyChallengeHttpHandlers.start;
