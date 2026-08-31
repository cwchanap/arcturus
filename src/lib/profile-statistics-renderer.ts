import { GAME_TYPES, GAME_TYPE_ICONS } from './game-stats/constants';
import type {
	PlayerGameStatistics,
	PlayerStatisticsDashboard,
} from './game-stats/player-statistics-types';
import { formatPercentage, formatWholeNumber } from './formatting';
import type { Locale } from './i18n/locale';
import { getDocumentLocale } from './i18n/locale';
import { formatChips } from './i18n/messages/common';
import { getGameName } from './i18n/messages/games';
import { formatSignedProfit, profileTranslator } from './i18n/messages/profile';

type GameType = (typeof GAME_TYPES)[number];
type ProfileTranslator = ReturnType<typeof profileTranslator>;

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

function renderSummary(
	container: HTMLElement,
	dashboard: PlayerStatisticsDashboard,
	locale: Locale,
	t: ProfileTranslator,
): void {
	const list = element('dl', 'grid grid-cols-2 gap-4 lg:grid-cols-4');
	const mostPlayed = dashboard.summary.mostPlayedGame
		? getGameName(locale, dashboard.summary.mostPlayedGame)
		: t('noGamesPlayedYet');

	appendMetric(list, t('totalHands'), formatWholeNumber(dashboard.summary.totalHands, locale), {
		primary: true,
	});
	appendMetric(list, t('mostPlayed'), mostPlayed, { primary: true });
	appendMetric(
		list,
		t('overallWinRate'),
		formatPercentage(dashboard.summary.overallWinRate, locale),
		{ primary: true },
	);
	appendMetric(list, t('netProfit'), formatSignedProfit(dashboard.summary.totalNetProfit, locale), {
		primary: true,
	});
	container.replaceChildren(list);
}

function profitResult(value: number): 'positive' | 'negative' | 'neutral' {
	if (value > 0) return 'positive';
	if (value < 0) return 'negative';
	return 'neutral';
}

function renderGameCard(
	game: PlayerGameStatistics,
	locale: Locale,
	t: ProfileTranslator,
): HTMLElement {
	const gameType: GameType = game.gameType;
	const label = getGameName(locale, gameType);
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
		game.handsPlayed > 0 ? t('played') : t('notPlayedYet'),
		'mt-1 text-sm text-[var(--deco-ivory-dim)]',
	);
	status.setAttribute('data-statistics-status', '');
	titleGroup.append(title, status);
	identity.append(icon, titleGroup);
	header.append(identity);

	const primary = element('dl', 'mt-6 grid grid-cols-3 gap-3');
	appendMetric(primary, t('handsPlayed'), formatWholeNumber(game.handsPlayed, locale), {
		primary: true,
	});
	appendMetric(primary, t('winRate'), formatPercentage(game.winRate, locale), { primary: true });
	const netProfitValue = appendMetric(
		primary,
		t('netProfit'),
		formatSignedProfit(game.netProfit, locale),
		{
			primary: true,
		},
	);
	netProfitValue.setAttribute('data-profit-result', profitResult(game.netProfit));

	const secondary = element('dl', 'mt-5 grid grid-cols-2 gap-x-4 gap-y-3');
	appendMetric(secondary, t('wins'), formatWholeNumber(game.totalWins, locale));
	appendMetric(secondary, t('losses'), formatWholeNumber(game.totalLosses, locale));
	appendMetric(secondary, t('biggestWin'), formatChips(game.biggestWin, locale));
	appendMetric(
		secondary,
		t('winsRank'),
		game.winsRank === null ? t('unranked') : `#${formatWholeNumber(game.winsRank, locale)}`,
		{
			valueAttribute: 'data-statistics-wins-rank',
		},
	);

	const actions = element(
		'div',
		'mt-auto flex min-w-0 flex-wrap items-center gap-x-5 gap-y-3 pt-6',
	);
	const leaderboard = textElement('a', t('viewWinsLeaderboard'), 'deco-link');
	leaderboard.setAttribute('href', `/games/leaderboard?game=${gameType}&metric=wins`);
	leaderboard.setAttribute('data-statistics-leaderboard', '');
	const play = textElement('a', t('playGame', { game: label }), 'deco-btn deco-btn-outline');
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

	const locale = getDocumentLocale(root.ownerDocument);
	const t = profileTranslator(locale);

	renderSummary(summary, dashboard, locale, t);
	games.replaceChildren(...dashboard.games.map((game) => renderGameCard(game, locale, t)));
	empty.hidden = dashboard.summary.totalHands !== 0;
}
