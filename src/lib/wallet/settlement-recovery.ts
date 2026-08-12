export interface SettlementRecoveryControls {
	container: HTMLElement | null;
	retry: HTMLButtonElement | null;
	reset: HTMLButtonElement | null;
}

export interface SettlementRecoveryOptions {
	containerId?: string;
	retryId?: string;
	resetId?: string;
	containerClass?: string;
	retryLabel?: string;
	retryClass?: string;
	resetLabel?: string;
	resetClass?: string;
	attachTo: HTMLElement | null;
}

const DEFAULTS = {
	containerId: 'settlement-recovery',
	retryId: 'btn-retry-settlement',
	resetId: 'btn-reset-settlement',
	containerClass: 'hidden',
	retryLabel: 'Retry settlement',
	retryClass: '',
	resetLabel: 'Reset round',
	resetClass: '',
} as const;

/**
 * Find or create the settlement recovery container with Retry and Reset
 * buttons. Returns existing elements if they are already in the DOM (so games
 * that ship static markup are not duplicated). Returns nulls when DOM creation
 * is unavailable (e.g. SSR or test environments without a full document).
 */
export function ensureSettlementRecoveryControls(
	opts: SettlementRecoveryOptions,
): SettlementRecoveryControls {
	if (typeof document === 'undefined') {
		return { container: null, retry: null, reset: null };
	}

	const containerId = opts.containerId ?? DEFAULTS.containerId;
	const retryId = opts.retryId ?? DEFAULTS.retryId;
	const resetId = opts.resetId ?? DEFAULTS.resetId;

	const existingContainer = document.getElementById(containerId);
	const existingRetry = document.getElementById(retryId) as HTMLButtonElement | null;
	const existingReset = document.getElementById(resetId) as HTMLButtonElement | null;
	if (existingContainer || existingRetry || existingReset) {
		return { container: existingContainer, retry: existingRetry, reset: existingReset };
	}

	if (typeof document.createElement !== 'function') {
		return { container: null, retry: null, reset: null };
	}

	const container = document.createElement('div');
	container.id = containerId;
	container.className = opts.containerClass ?? DEFAULTS.containerClass;
	const retry = document.createElement('button');
	retry.id = retryId;
	retry.type = 'button';
	retry.className = opts.retryClass ?? DEFAULTS.retryClass;
	retry.textContent = opts.retryLabel ?? DEFAULTS.retryLabel;
	const reset = document.createElement('button');
	reset.id = resetId;
	reset.type = 'button';
	reset.className = opts.resetClass ?? DEFAULTS.resetClass;
	reset.textContent = opts.resetLabel ?? DEFAULTS.resetLabel;
	container.appendChild(retry);
	container.appendChild(reset);
	opts.attachTo?.appendChild(container);
	return { container, retry, reset };
}
