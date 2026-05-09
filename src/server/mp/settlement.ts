export interface SettleEntry {
	userId: string;
	delta: number;
	syncId: string;
	gameType: 'poker_mp';
}

export interface SettlePayload {
	entries: SettleEntry[];
}

export function buildSettlePayload(args: {
	roomCode: string;
	handId: string;
	committed: Record<string, number>;
	winners: { userId: string; amount: number }[];
}): SettlePayload {
	const winById = new Map(args.winners.map((w) => [w.userId, w.amount]));
	const entries: SettleEntry[] = [];
	for (const [userId, paid] of Object.entries(args.committed)) {
		const won = winById.get(userId) ?? 0;
		const delta = won - paid;
		if (delta === 0) continue;
		entries.push({
			userId,
			delta,
			syncId: `mp-poker:${args.roomCode}:${args.handId}:${userId}`,
			gameType: 'poker_mp',
		});
	}
	return { entries };
}
