import fs from 'fs';
import path from 'path';
import type { BrowserContext, Page } from '@playwright/test';

const E2E_BOOTSTRAP_SECRET_HEADER = 'x-e2e-auth-bootstrap-secret';

export type E2eUserCredentials = {
	email: string;
	name: string;
};

function readDevVars(): Record<string, string> {
	const filePath = path.join(process.cwd(), '.dev.vars');
	if (!fs.existsSync(filePath)) return {};

	return Object.fromEntries(
		fs
			.readFileSync(filePath, 'utf8')
			.split(/\r?\n/)
			.map((line) => line.trim())
			.filter((line) => line.length > 0 && !line.startsWith('#'))
			.map((line) => {
				const separatorIndex = line.indexOf('=');
				if (separatorIndex === -1) return [line, ''];
				return [line.slice(0, separatorIndex), line.slice(separatorIndex + 1)];
			}),
	);
}

export function getE2eBootstrapSecret(): string {
	const secret = process.env.E2E_AUTH_BOOTSTRAP_SECRET ?? readDevVars().E2E_AUTH_BOOTSTRAP_SECRET;
	if (!secret) {
		throw new Error(
			'E2E_AUTH_BOOTSTRAP_SECRET must be set in the environment or .dev.vars for Playwright auth bootstrap',
		);
	}
	return secret;
}

export async function bootstrapTestUser(
	context: BrowserContext,
	baseURL: string,
	credentials: E2eUserCredentials,
): Promise<void> {
	const response = await context.request.post(`${baseURL}/api/auth/e2e/bootstrap`, {
		data: credentials,
		headers: {
			[E2E_BOOTSTRAP_SECRET_HEADER]: getE2eBootstrapSecret(),
		},
	});

	if (!response.ok()) {
		const body = await response.text().catch(() => '');
		throw new Error(`E2E auth bootstrap failed: ${response.status()} ${body}`);
	}
}

export async function bootstrapPage(
	page: Page,
	baseURL: string,
	credentials: E2eUserCredentials,
): Promise<void> {
	await bootstrapTestUser(page.context(), baseURL, credentials);
	await page.goto(baseURL, { waitUntil: 'domcontentloaded' });
}
