/**
 * Poker table sound effects, synthesized with Web Audio so no audio files
 * ship. Each effect is a short recipe of tones and noise bursts; the mute
 * choice persists in localStorage. Everything degrades to silence when Web
 * Audio is unavailable (tests, old browsers) or the browser blocks playback.
 */

export type PokerSfx =
	| 'deal'
	| 'flip'
	| 'check'
	| 'chips'
	| 'raise'
	| 'allIn'
	| 'fold'
	| 'turn'
	| 'tick'
	| 'win'
	| 'bigWin'
	| 'lose'
	| 'callout'
	| 'missionReady'
	| 'claim';

export const SOUND_MUTED_STORAGE_KEY = 'poker_sound_muted';

interface Tone {
	kind: 'tone';
	wave: OscillatorType;
	freq: number;
	/** Glide target; the pitch slides there over the note. */
	toFreq?: number;
	at: number;
	dur: number;
	gain: number;
}

interface Noise {
	kind: 'noise';
	/** Band-pass centre; sweeps to `toFreq` when given. */
	freq: number;
	toFreq?: number;
	q: number;
	at: number;
	dur: number;
	gain: number;
}

type Voice = Tone | Noise;

const tone = (
	freq: number,
	at: number,
	dur: number,
	gain: number,
	wave: OscillatorType = 'sine',
	toFreq?: number,
): Tone => ({ kind: 'tone', wave, freq, toFreq, at, dur, gain });

const noise = (
	freq: number,
	at: number,
	dur: number,
	gain: number,
	q = 1,
	toFreq?: number,
): Noise => ({ kind: 'noise', freq, toFreq, q, at, dur, gain });

/** A card snapping onto felt: a short bright noise flick. */
const flick = (at: number, gain = 0.5) => noise(3200, at, 0.06, gain, 0.8, 1800);
/** One clay chip landing on another. */
const clack = (at: number, gain = 0.35) => [
	tone(2350, at, 0.05, gain, 'triangle', 1900),
	noise(5200, at, 0.03, gain * 0.6, 2),
];

// Notes for the melodic cues (C major around C5).
const C5 = 523.25;
const E5 = 659.25;
const G5 = 783.99;
const C6 = 1046.5;
const E6 = 1318.5;

export const SFX_RECIPES: Record<PokerSfx, Voice[]> = {
	deal: [flick(0), flick(0.09), flick(0.18, 0.4)],
	flip: [flick(0, 0.45), noise(1400, 0.02, 0.08, 0.2, 0.7)],
	check: [tone(180, 0, 0.07, 0.6, 'sine', 120), tone(180, 0.11, 0.07, 0.5, 'sine', 120)],
	chips: [...clack(0), ...clack(0.07, 0.28), ...clack(0.13, 0.22)],
	raise: [...clack(0), ...clack(0.05, 0.3), ...clack(0.1, 0.3), ...clack(0.16, 0.25)],
	allIn: [
		...clack(0),
		...clack(0.04, 0.3),
		...clack(0.08, 0.3),
		...clack(0.12, 0.3),
		...clack(0.17, 0.28),
		tone(98, 0.05, 0.4, 0.35, 'triangle', 82),
	],
	fold: [noise(900, 0, 0.22, 0.35, 0.6, 2600)],
	turn: [tone(E6, 0, 0.35, 0.18), tone(C6, 0.12, 0.45, 0.16)],
	tick: [tone(1600, 0, 0.04, 0.22, 'square')],
	win: [
		tone(C5, 0, 0.16, 0.22, 'triangle'),
		tone(E5, 0.1, 0.16, 0.22, 'triangle'),
		tone(G5, 0.2, 0.16, 0.22, 'triangle'),
		tone(C6, 0.3, 0.5, 0.26, 'triangle'),
		...clack(0.32, 0.25),
		...clack(0.4, 0.2),
	],
	bigWin: [
		tone(C5, 0, 0.14, 0.22, 'triangle'),
		tone(E5, 0.08, 0.14, 0.22, 'triangle'),
		tone(G5, 0.16, 0.14, 0.22, 'triangle'),
		tone(C6, 0.24, 0.14, 0.24, 'triangle'),
		tone(E6, 0.32, 0.7, 0.24, 'triangle'),
		tone(G5, 0.32, 0.7, 0.16, 'sine'),
		...clack(0.36, 0.3),
		...clack(0.42, 0.25),
		...clack(0.48, 0.25),
		...clack(0.55, 0.2),
	],
	lose: [tone(G5 / 2, 0, 0.25, 0.2, 'triangle'), tone(E5 / 2, 0.18, 0.45, 0.18, 'triangle', 300)],
	callout: [tone(G5, 0, 0.12, 0.16), tone(C6, 0.07, 0.12, 0.16), tone(E6, 0.14, 0.4, 0.18)],
	missionReady: [
		tone(E6, 0, 0.18, 0.14),
		tone(G5 * 2, 0.08, 0.18, 0.12),
		tone(C6 * 2, 0.16, 0.4, 0.12),
	],
	claim: [tone(1975, 0, 0.08, 0.2, 'square'), tone(2637, 0.07, 0.35, 0.2, 'square')],
};

type AudioContextLike = Pick<
	AudioContext,
	| 'currentTime'
	| 'state'
	| 'resume'
	| 'destination'
	| 'sampleRate'
	| 'createGain'
	| 'createOscillator'
	| 'createBufferSource'
	| 'createBiquadFilter'
	| 'createBuffer'
>;

export interface PokerSoundOptions {
	storage?: Pick<Storage, 'getItem' | 'setItem'> | null;
	createContext?: () => AudioContextLike | null;
	/** Master level, 0–1. */
	volume?: number;
}

export interface PokerSound {
	play(sfx: PokerSfx): void;
	isMuted(): boolean;
	setMuted(muted: boolean): void;
	/** Create or resume the audio context from inside a user gesture. */
	unlock(): void;
}

function defaultStorage(): Pick<Storage, 'getItem' | 'setItem'> | null {
	try {
		return typeof localStorage === 'undefined' ? null : localStorage;
	} catch {
		return null;
	}
}

function defaultContext(): AudioContextLike | null {
	const scope = globalThis as unknown as {
		AudioContext?: new () => AudioContext;
		webkitAudioContext?: new () => AudioContext;
	};
	const Ctor = scope.AudioContext ?? scope.webkitAudioContext;
	return Ctor ? new Ctor() : null;
}

export function createPokerSound(options: PokerSoundOptions = {}): PokerSound {
	const storage = options.storage === undefined ? defaultStorage() : options.storage;
	const createContext = options.createContext ?? defaultContext;
	const volume = options.volume ?? 0.6;
	let muted = false;
	try {
		muted = storage?.getItem(SOUND_MUTED_STORAGE_KEY) === 'true';
	} catch {
		muted = false;
	}
	let context: AudioContextLike | null = null;
	let contextFailed = false;
	let master: GainNode | null = null;
	let noiseBuffer: AudioBuffer | null = null;

	function ensureContext(): AudioContextLike | null {
		if (context || contextFailed) return context;
		try {
			context = createContext();
		} catch {
			context = null;
		}
		if (!context) {
			contextFailed = true;
			return null;
		}
		master = context.createGain();
		master.gain.value = volume;
		master.connect(context.destination);
		return context;
	}

	function getNoise(ctx: AudioContextLike): AudioBuffer {
		if (noiseBuffer) return noiseBuffer;
		const length = Math.floor(ctx.sampleRate * 0.5);
		noiseBuffer = ctx.createBuffer(1, length, ctx.sampleRate);
		const data = noiseBuffer.getChannelData(0);
		for (let i = 0; i < length; i++) data[i] = Math.random() * 2 - 1;
		return noiseBuffer;
	}

	function envelope(ctx: AudioContextLike, start: number, voice: Voice): GainNode {
		const gain = ctx.createGain();
		gain.gain.setValueAtTime(0.0001, start);
		gain.gain.exponentialRampToValueAtTime(voice.gain, start + Math.min(0.01, voice.dur / 4));
		gain.gain.exponentialRampToValueAtTime(0.0001, start + voice.dur);
		gain.connect(master!);
		return gain;
	}

	function playVoice(ctx: AudioContextLike, base: number, voice: Voice): void {
		const start = base + voice.at;
		const end = start + voice.dur + 0.02;
		const gain = envelope(ctx, start, voice);
		if (voice.kind === 'tone') {
			const osc = ctx.createOscillator();
			osc.type = voice.wave;
			osc.frequency.setValueAtTime(voice.freq, start);
			if (voice.toFreq) osc.frequency.exponentialRampToValueAtTime(voice.toFreq, start + voice.dur);
			osc.connect(gain);
			osc.start(start);
			osc.stop(end);
			return;
		}
		const source = ctx.createBufferSource();
		source.buffer = getNoise(ctx);
		const filter = ctx.createBiquadFilter();
		filter.type = 'bandpass';
		filter.Q.value = voice.q;
		filter.frequency.setValueAtTime(voice.freq, start);
		if (voice.toFreq)
			filter.frequency.exponentialRampToValueAtTime(voice.toFreq, start + voice.dur);
		source.connect(filter);
		filter.connect(gain);
		source.start(start);
		source.stop(end);
	}

	return {
		play(sfx) {
			if (muted) return;
			const ctx = ensureContext();
			if (!ctx) return;
			try {
				if (ctx.state === 'suspended') void ctx.resume().catch(() => {});
				const base = ctx.currentTime + 0.01;
				for (const voice of SFX_RECIPES[sfx]) playVoice(ctx, base, voice);
			} catch {
				// A sound effect is never worth breaking the game for.
			}
		},
		isMuted: () => muted,
		setMuted(next) {
			muted = next;
			try {
				storage?.setItem(SOUND_MUTED_STORAGE_KEY, String(next));
			} catch {
				// Private mode: the choice lasts for this page only.
			}
			if (!next) this.unlock();
		},
		unlock() {
			if (muted) return;
			const ctx = ensureContext();
			if (ctx?.state === 'suspended') void ctx.resume().catch(() => {});
		},
	};
}

/** The table's shared sound player. */
export const pokerSound = createPokerSound();
