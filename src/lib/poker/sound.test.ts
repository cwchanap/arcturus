import { describe, expect, test } from 'bun:test';
import { SFX_RECIPES, createPokerSound, type PokerSfx } from './sound';

function fakeContext(state: AudioContextState = 'running') {
	const param = () => ({
		value: 0,
		setValueAtTime: () => {},
		exponentialRampToValueAtTime: () => {},
	});
	const node = () => ({ connect: () => {}, start: () => {}, stop: () => {} });
	const created = { oscillators: 0, noises: 0, resumes: 0, contexts: 0 };
	const make = () => {
		created.contexts++;
		return {
			currentTime: 0,
			state,
			sampleRate: 8000,
			destination: {},
			resume: async () => {
				created.resumes++;
			},
			createGain: () => ({ ...node(), gain: param() }),
			createOscillator: () => {
				created.oscillators++;
				return { ...node(), type: 'sine', frequency: param() };
			},
			createBufferSource: () => {
				created.noises++;
				return { ...node(), buffer: null };
			},
			createBiquadFilter: () => ({ ...node(), type: 'bandpass', Q: param(), frequency: param() }),
			createBuffer: (_channels: number, length: number) => {
				const data = new Float32Array(length);
				return { getChannelData: () => data };
			},
		};
	};
	return { created, make: make as unknown as () => AudioContext };
}

describe('poker sound', () => {
	test('every effect has a recipe', () => {
		for (const [name, voices] of Object.entries(SFX_RECIPES)) {
			expect(voices.length, name).toBeGreaterThan(0);
			for (const voice of voices) expect(voice.dur, name).toBeGreaterThan(0);
		}
	});

	test('plays an effect through one shared context', () => {
		const ctx = fakeContext();
		const sound = createPokerSound({ createContext: ctx.make });
		sound.play('win');
		sound.play('fold');
		expect(ctx.created.contexts).toBe(1);
		expect(ctx.created.oscillators).toBeGreaterThan(0);
		expect(ctx.created.noises).toBeGreaterThan(0);
	});

	test('gates playback and unlock on the shared mute preference', () => {
		const ctx = fakeContext();
		let muted = true;
		const sound = createPokerSound({ createContext: ctx.make, isMuted: () => muted });
		sound.play('raise');
		sound.unlock();
		expect(ctx.created.contexts).toBe(0);
		expect(ctx.created.resumes).toBe(0);

		muted = false;
		sound.unlock();
		expect(ctx.created.contexts).toBe(1);
		sound.play('win');
		expect(ctx.created.contexts).toBe(1);
	});

	test('resumes a suspended context from a gesture', () => {
		const ctx = fakeContext('suspended');
		const sound = createPokerSound({ createContext: ctx.make });
		sound.unlock();
		expect(ctx.created.resumes).toBe(1);
	});

	test('stays silent without Web Audio', () => {
		const sound = createPokerSound({ createContext: () => null });
		const all = Object.keys(SFX_RECIPES) as PokerSfx[];
		expect(() => all.forEach((name) => sound.play(name))).not.toThrow();
	});
});
