export function getDailyPeriodKey(date = new Date()): string {
	return date.toISOString().slice(0, 10);
}

export function getWeeklyPeriodKey(date = new Date()): string {
	const tmp = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
	const dayNum = (tmp.getUTCDay() + 6) % 7;
	tmp.setUTCDate(tmp.getUTCDate() - dayNum + 3);
	const weekNum =
		1 + Math.round((tmp.getTime() - Date.UTC(tmp.getUTCFullYear(), 0, 4)) / 604800000);
	return `${tmp.getUTCFullYear()}-W${String(weekNum).padStart(2, '0')}`;
}

export function getDailyPeriodKeyForYesterday(date = new Date()): string {
	const d = new Date(date);
	d.setUTCDate(d.getUTCDate() - 1);
	return getDailyPeriodKey(d);
}

export function getNextDailyReset(date = new Date()): Date {
	const next = new Date(date);
	next.setUTCDate(next.getUTCDate() + 1);
	next.setUTCHours(0, 0, 0, 0);
	return next;
}

export function getNextWeeklyReset(date = new Date()): Date {
	const next = new Date(date);
	const dayNum = (next.getUTCDay() + 6) % 7;
	const daysUntilMonday = dayNum === 0 ? 7 : 7 - dayNum;
	next.setUTCDate(next.getUTCDate() + daysUntilMonday);
	next.setUTCHours(0, 0, 0, 0);
	return next;
}
