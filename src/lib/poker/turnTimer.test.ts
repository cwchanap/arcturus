import { describe, expect, test } from 'bun:test';
import { TURN_TIMER_MS, TURN_WARN_SECONDS, TurnTimer } from './turnTimer';

function harness(durationMs = TURN_TIMER_MS) {
	let now = 1_000;
	let active: (() => void) | null = null;
	const ticks: Array<[number, number]> = [];
	const warnings: number[] = [];
	let expired = 0;
	const timer = new TurnTimer({
		durationMs,
		now: () => now,
		setInterval: (callback) => {
			active = callback;
			return 1;
		},
		clearInterval: () => {
			active = null;
		},
		onTick: (fraction, seconds) => ticks.push([fraction, seconds]),
		onWarn: (seconds) => warnings.push(seconds),
		onExpire: () => expired++,
	});
	return {
		timer,
		ticks,
		warnings,
		expired: () => expired,
		advance(ms: number) {
			now += ms;
			active?.();
		},
		scheduled: () => active !== null,
	};
}

describe('TurnTimer', () => {
	test('starts full and counts down to expiry once', () => {
		const h = harness();
		h.timer.start();
		expect(h.ticks[0]).toEqual([1, TURN_TIMER_MS / 1000]);
		h.advance(TURN_TIMER_MS / 2);
		expect(h.ticks.at(-1)).toEqual([0.5, TURN_TIMER_MS / 2000]);
		h.advance(TURN_TIMER_MS);
		expect(h.expired()).toBe(1);
		expect(h.timer.running).toBe(false);
		expect(h.scheduled()).toBe(false);
		h.advance(1000);
		expect(h.expired()).toBe(1);
	});

	test('warns once per second through the last seconds', () => {
		const h = harness();
		h.timer.start();
		for (let elapsed = 0; elapsed < TURN_TIMER_MS - 250; elapsed += 250) h.advance(250);
		expect(h.warnings).toEqual(
			Array.from({ length: TURN_WARN_SECONDS }, (_, i) => TURN_WARN_SECONDS - i),
		);
		expect(h.expired()).toBe(0);
	});

	test('stop cancels expiry and start restarts the full clock', () => {
		const h = harness();
		h.timer.start();
		h.advance(TURN_TIMER_MS - 1000);
		h.timer.stop();
		h.advance(5000);
		expect(h.expired()).toBe(0);
		h.timer.start();
		expect(h.ticks.at(-1)).toEqual([1, TURN_TIMER_MS / 1000]);
		h.advance(TURN_TIMER_MS - 1000);
		expect(h.expired()).toBe(0);
		expect(h.warnings.at(-1)).toBe(1);
	});
});
