import { expect, test } from '@playwright/test';
import { E2E_BOOTSTRAP_SECRET_HEADER } from './bootstrap-auth';

// These tests probe the e2e auth bootstrap endpoint's *negative* paths directly.
// The project-wide authenticated storageState is intentionally disabled so the
// requests run unauthenticated and must never receive a session cookie.
//
// Coverage gap this addresses: unit tests cover the guard predicates, but nothing
// previously asserted that a wrong/missing secret actually yields 403 at the
// HTTP layer, nor that no session is minted on rejection. A handler refactor
// that inverted a check would have passed every existing test.
test.describe('e2e auth bootstrap endpoint security', () => {
	test.use({ storageState: undefined });

	test('rejects a wrong secret with 403 and mints no session cookie', async ({
		request,
		baseURL,
	}) => {
		const response = await request.post(`${baseURL}/api/auth/e2e/bootstrap`, {
			data: { email: 'e2e-negative@example.com', name: 'Negative Test' },
			headers: { [E2E_BOOTSTRAP_SECRET_HEADER]: 'definitely-the-wrong-secret' },
		});

		expect(response.status()).toBe(403);

		// A rejected request must never authenticate the caller.
		const setCookie = response.headers()['set-cookie'] ?? '';
		expect(setCookie).not.toMatch(/session_token/);
	});

	test('rejects a missing secret header with 403', async ({ request, baseURL }) => {
		const response = await request.post(`${baseURL}/api/auth/e2e/bootstrap`, {
			data: { email: 'e2e-no-header@example.com', name: 'No Header Test' },
		});

		expect(response.status()).toBe(403);
	});
});
