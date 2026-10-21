/**
 * Countdown for the human's turn. The table shows the time left as a ring,
 * ticks through the last few seconds, and acts for the player when it runs
 * out. Pure timing only: the caller decides what "acting" means.
 */

/** How long the human has to act. */
export const TURN_TIMER_MS = 20_000;
/** Seconds left when the warning ticks start. */
export const TURN_WARN_SECONDS = 5;
export const TURN_TIMER_STORAGE_KEY = 'poker_turn_timer';

const FRAME_MS = 250;

export interface TurnTimerOptions {
	durationMs?: number;
	/** Called each frame with the fraction of time left (1 → 0) and whole seconds left. */
	onTick(fraction: number, secondsLeft: number): void;
	/** Called once per second during the last `TURN_WARN_SECONDS`. */
	onWarn(secondsLeft: number): void;
	onExpire(): void;
	now?: () => number;
	setInterval?: (callback: () => void, ms: number) => unknown;
	clearInterval?: (handle: unknown) => void;
}

export class TurnTimer {
	private readonly durationMs: number;
	private readonly now: () => number;
	private readonly schedule: (callback: () => void, ms: number) => unknown;
	private readonly cancel: (handle: unknown) => void;
	private handle: unknown = null;
	private startedAt = 0;
	private lastWarned = Number.POSITIVE_INFINITY;

	constructor(private readonly options: TurnTimerOptions) {
		this.durationMs = options.durationMs ?? TURN_TIMER_MS;
		this.now = options.now ?? (() => Date.now());
		this.schedule = options.setInterval ?? ((callback, ms) => globalThis.setInterval(callback, ms));
		this.cancel =
			options.clearInterval ??
			((handle) => globalThis.clearInterval(handle as ReturnType<typeof setInterval>));
	}

	get running(): boolean {
		return this.handle !== null;
	}

	/** (Re)start the full countdown. */
	start(): void {
		this.stop();
		this.startedAt = this.now();
		this.lastWarned = Number.POSITIVE_INFINITY;
		this.handle = this.schedule(() => this.tick(), FRAME_MS);
		this.tick();
	}

	stop(): void {
		if (this.handle === null) return;
		this.cancel(this.handle);
		this.handle = null;
	}

	/** Advance to the current time; exposed so tests can drive the clock. */
	tick(): void {
		if (this.handle === null) return;
		const left = Math.max(0, this.durationMs - (this.now() - this.startedAt));
		const secondsLeft = Math.ceil(left / 1000);
		this.options.onTick(left / this.durationMs, secondsLeft);
		if (left <= 0) {
			this.stop();
			this.options.onExpire();
			return;
		}
		if (secondsLeft <= TURN_WARN_SECONDS && secondsLeft < this.lastWarned) {
			this.lastWarned = secondsLeft;
			this.options.onWarn(secondsLeft);
		}
	}
}
