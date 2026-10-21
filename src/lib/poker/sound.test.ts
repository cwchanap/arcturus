import { describe, expect, test } from 'bun:test';
import { SFX_RECIPES, SOUND_MUTED_STORAGE_KEY, createPokerSound, type PokerSfx } from './sound';

function memoryStorage(initial: Record<string, string> = {}) {
	const data = new Map(Object.entries(initial));
	return {
		getItem: (key: string) => data.get(key) ?? null,
		setItem: (key: string, value: string) => void data.set(key, value),
		data,
	};
}

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
		const sound = createPokerSound({ storage: memoryStorage(), createContext: ctx.make });
		sound.play('win');
		sound.play('fold');
		expect(ctx.created.contexts).toBe(1);
		expect(ctx.created.oscillators).toBeGreaterThan(0);
		expect(ctx.created.noises).toBeGreaterThan(0);
	});

	test('muting persists and silences playback', () => {
		const storage = memoryStorage();
		const ctx = fakeContext();
		const sound = createPokerSound({ storage, createContext: ctx.make });
		sound.setMuted(true);
		sound.play('raise');
		expect(ctx.created.contexts).toBe(0);
		expect(storage.data.get(SOUND_MUTED_STORAGE_KEY)).toBe('true');

		const reloaded = createPokerSound({ storage, createContext: ctx.make });
		expect(reloaded.isMuted()).toBe(true);
	});

	test('resumes a suspended context from a gesture', () => {
		const ctx = fakeContext('suspended');
		const sound = createPokerSound({ storage: memoryStorage(), createContext: ctx.make });
		sound.unlock();
		expect(ctx.created.resumes).toBe(1);
	});

	test('stays silent without Web Audio', () => {
		const sound = createPokerSound({ storage: null, createContext: () => null });
		const all = Object.keys(SFX_RECIPES) as PokerSfx[];
		expect(() => all.forEach((name) => sound.play(name))).not.toThrow();
	});
});
