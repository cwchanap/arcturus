import { describe, expect, test } from 'bun:test';
import { E2E_BOOTSTRAP_SECRET_HEADER as workerHeader } from './e2e-auth-bootstrap';
import { E2E_BOOTSTRAP_SECRET_HEADER as nodeHeader } from '../../e2e/bootstrap-auth';

// The bootstrap secret header is intentionally duplicated across two runtime
// contexts (Cloudflare Workers plugin vs Node Playwright helper) that cannot
// share imports. This test pins the two copies equal so silent drift surfaces
// as a failing test instead of an opaque whole-suite 403.
describe('e2e bootstrap secret header constant', () => {
	test('worker-side and node-side copies are identical', () => {
		expect(workerHeader).toBe('x-e2e-auth-bootstrap-secret');
		expect(nodeHeader).toBe('x-e2e-auth-bootstrap-secret');
		expect(workerHeader).toBe(nodeHeader);
	});
});
