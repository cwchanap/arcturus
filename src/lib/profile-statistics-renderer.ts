import { GAME_TYPES, GAME_TYPE_ICONS, GAME_TYPE_LABELS } from './game-stats/constants';
import type {
	PlayerGameStatistics,
	PlayerStatisticsDashboard,
} from './game-stats/player-statistics-types';
import { formatPercentage, formatSignedChipResult, formatWholeNumber } from './formatting';

type GameType = (typeof GAME_TYPES)[number];

function element<K extends keyof HTMLElementTagNameMap>(
	tagName: K,
	className?: string,
): HTMLElementTagNameMap[K] {
	const node = document.createElement(tagName);
	if (className) node.setAttribute('class', className);
	return node;
}

function textElement<K extends keyof HTMLElementTagNameMap>(
	tagName: K,
	text: string,
	className?: string,
): HTMLElementTagNameMap[K] {
	const node = element(tagName, className);
	node.textContent = text;
	return node;
}

function appendMetric(
	list: HTMLDListElement,
	label: string,
	value: string,
	options: { primary?: boolean; valueAttribute?: string } = {},
): HTMLElement {
	const item = element(
		'div',
		options.primary ? 'min-w-0' : 'min-w-0 border-t border-white/10 pt-3',
	);
	const term = textElement('dt', label, 'deco-eyebrow-sm');
	const description = textElement(
		'dd',
		value,
		options.primary
			? 'deco-stat-value mt-1 break-words tabular-nums'
			: 'mt-1 text-base font-semibold text-[var(--deco-ivory)] break-words tabular-nums',
	);
	if (options.valueAttribute) description.setAttribute(options.valueAttribute, '');
	item.append(term, description);
	list.append(item);
	return description;
}

function renderSummary(container: HTMLElement, dashboard: PlayerStatisticsDashboard): void {
	const list = element('dl', 'grid grid-cols-2 gap-4 lg:grid-cols-4');
	const mostPlayed = dashboard.summary.mostPlayedGame
		? GAME_TYPE_LABELS[dashboard.summary.mostPlayedGame]
		: 'No games played yet';

	appendMetric(list, 'Total Hands', formatWholeNumber(dashboard.summary.totalHands), {
		primary: true,
	});
	appendMetric(list, 'Most Played', mostPlayed, { primary: true });
	appendMetric(list, 'Overall Win Rate', formatPercentage(dashboard.summary.overallWinRate), {
		primary: true,
	});
	appendMetric(list, 'Net Profit', formatSignedChipResult(dashboard.summary.totalNetProfit), {
		primary: true,
	});
	container.replaceChildren(list);
}

function profitResult(value: number): 'positive' | 'negative' | 'neutral' {
	if (value > 0) return 'positive';
	if (value < 0) return 'negative';
	return 'neutral';
}

function renderGameCard(game: PlayerGameStatistics): HTMLElement {
	const gameType: GameType = game.gameType;
	const label = GAME_TYPE_LABELS[gameType];
	const card = element('article', 'deco-panel flex min-h-full flex-col p-5 sm:p-6');
	card.setAttribute('data-testid', `statistics-card-${gameType}`);

	const header = element('header', 'flex min-w-0 items-start justify-between gap-4');
	const identity = element('div', 'flex min-w-0 items-center gap-3');
	const icon = textElement('span', GAME_TYPE_ICONS[gameType], 'text-3xl leading-none');
	icon.setAttribute('aria-hidden', 'true');
	const titleGroup = element('div', 'min-w-0');
	const title = textElement('h2', label, 'deco-section-title text-xl break-words');
	const status = textElement(
		'p',
		game.handsPlayed > 0 ? 'Played' : 'Not played yet',
		'mt-1 text-sm text-[var(--deco-ivory-dim)]',
	);
	status.setAttribute('data-statistics-status', '');
	titleGroup.append(title, status);
	identity.append(icon, titleGroup);
	header.append(identity);

	const primary = element('dl', 'mt-6 grid grid-cols-3 gap-3');
	appendMetric(primary, 'Hands Played', formatWholeNumber(game.handsPlayed), { primary: true });
	appendMetric(primary, 'Win Rate', formatPercentage(game.winRate), { primary: true });
	const netProfitValue = appendMetric(
		primary,
		'Net Profit',
		formatSignedChipResult(game.netProfit),
		{
			primary: true,
		},
	);
	netProfitValue.setAttribute('data-profit-result', profitResult(game.netProfit));

	const secondary = element('dl', 'mt-5 grid grid-cols-2 gap-x-4 gap-y-3');
	appendMetric(secondary, 'Wins', formatWholeNumber(game.totalWins));
	appendMetric(secondary, 'Losses', formatWholeNumber(game.totalLosses));
	appendMetric(secondary, 'Biggest Win', `${formatWholeNumber(game.biggestWin)} chips`);
	appendMetric(secondary, 'Wins Rank', game.winsRank === null ? 'Unranked' : `#${game.winsRank}`, {
		valueAttribute: 'data-statistics-wins-rank',
	});

	const actions = element(
		'div',
		'mt-auto flex min-w-0 flex-wrap items-center gap-x-5 gap-y-3 pt-6',
	);
	const leaderboard = textElement('a', 'View Wins leaderboard', 'deco-link');
	leaderboard.setAttribute('href', `/games/leaderboard?game=${gameType}&metric=wins`);
	leaderboard.setAttribute('data-statistics-leaderboard', '');
	const play = textElement('a', `Play ${label}`, 'deco-btn deco-btn-outline');
	play.setAttribute('href', `/games/${gameType}`);
	play.setAttribute('data-statistics-play', '');
	actions.append(leaderboard, play);

	card.append(header, primary, secondary, actions);
	return card;
}

export function renderPlayerStatisticsDashboard(
	root: HTMLElement,
	dashboard: PlayerStatisticsDashboard,
): void {
	const summary = root.querySelector<HTMLElement>('[data-statistics-summary]');
	const games = root.querySelector<HTMLElement>('[data-statistics-games]');
	const empty = root.querySelector<HTMLElement>('[data-statistics-empty]');
	if (!summary || !games || !empty) {
		throw new Error('Player statistics render targets are incomplete');
	}

	renderSummary(summary, dashboard);
	games.replaceChildren(...dashboard.games.map(renderGameCard));
	empty.hidden = dashboard.summary.totalHands !== 0;
}
