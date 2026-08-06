import type { Room } from './engine';

export const TURN_TIMEOUT_MS = 60_000;
export const RECONNECT_TIMEOUT_MS = 30_000;
export const EMPTY_ROOM_TIMEOUT_MS = 5 * 60_000;

function earlierDeadline(current: number | null, candidate: number): number {
	return current === null ? candidate : Math.min(current, candidate);
}

export function getNextAlarmAt(
	room: Room,
	turnDeadline: number | null,
	emptyDeadline: number | null,
	now: number,
): number | null {
	let next: number | null = null;
	if (room.phase === 'in-hand' && room.hand && turnDeadline !== null) {
		next = earlierDeadline(next, turnDeadline);
	}

	for (const seat of room.seats) {
		if (seat.userId === null || seat.disconnectedAt === null) continue;
		const reconnectDeadline = seat.disconnectedAt + RECONNECT_TIMEOUT_MS;
		const protectedByHand =
			room.phase === 'in-hand' &&
			room.hand !== null &&
			room.hand.holeCards[seat.userId] !== undefined &&
			!room.hand.folded.has(seat.userId);
		if (reconnectDeadline <= now && protectedByHand) continue;
		next = earlierDeadline(next, reconnectDeadline);
	}

	if (emptyDeadline !== null) next = earlierDeadline(next, emptyDeadline);
	return next;
}
