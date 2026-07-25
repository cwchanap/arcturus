import type { APIRoute } from 'astro';
import { rankedHttpHandlers } from '../../../../../server/ranked/http';

export const POST: APIRoute = rankedHttpHandlers.action;
