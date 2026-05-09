import { describe, expect, test } from 'bun:test';
import { MultiplayerPokerClient } from './client';

describe('MultiplayerPokerClient', () => {
	test('construct does not throw', () => {
		expect(() => new MultiplayerPokerClient('ws://localhost')).not.toThrow();
	});

	test('send is a no-op when not connected', () => {
		const client = new MultiplayerPokerClient('ws://localhost');
		expect(() => client.send({ type: 'pong' })).not.toThrow();
	});

	test('on returns an unsubscribe function', () => {
		const client = new MultiplayerPokerClient('ws://localhost');
		const off = client.on(() => {});
		expect(typeof off).toBe('function');
		expect(() => off()).not.toThrow();
	});
});
