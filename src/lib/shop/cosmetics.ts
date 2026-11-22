/**
 * Poker cosmetic seam: maps a user's effective shop selection onto the two CSS
 * custom properties consumed by `src/styles/poker.css`
 * (`--poker-felt-image`, `--poker-card-back-image`).
 *
 * Values are complete `url('...')` tokens — bare paths are not valid CSS
 * `background` images — assembled only from the closed catalog's server-known
 * `imagePath`s, never from request input. Free defaults produce no variable so
 * the stylesheet's original artwork fallback stays active.
 */
import {
	CATALOG,
	DEFAULT_SHOP_ITEM_ID_BY_KIND,
	type ShopItemKind,
	type ShopItemId,
} from './catalog';

export type PokerCosmeticVarName = '--poker-felt-image' | '--poker-card-back-image';

const FELT_VAR: PokerCosmeticVarName = '--poker-felt-image';
const CARD_BACK_VAR: PokerCosmeticVarName = '--poker-card-back-image';

export type PokerCosmeticVars = Partial<Record<PokerCosmeticVarName, string>>;

/** Complete CSS url token for a server-known catalog image path. */
function cssUrl(imagePath: string): string {
	return `url('${imagePath}')`;
}

/**
 * Effective per-kind selection → cosmetic CSS variables. Kinds equipped with
 * their free default are omitted so the CSS fallbacks activate.
 */
export function getPokerCosmeticVars(
	equippedByKind: Record<ShopItemKind, ShopItemId>,
): PokerCosmeticVars {
	const vars: PokerCosmeticVars = {};
	const feltId = equippedByKind.felt;
	if (feltId !== DEFAULT_SHOP_ITEM_ID_BY_KIND.felt)
		vars[FELT_VAR] = cssUrl(CATALOG[feltId].imagePath);
	const backId = equippedByKind['card-back'];
	if (backId !== DEFAULT_SHOP_ITEM_ID_BY_KIND['card-back']) {
		vars[CARD_BACK_VAR] = cssUrl(CATALOG[backId].imagePath);
	}
	return vars;
}

/** Inline style value for `#poker-root`; undefined omits the attribute entirely. */
export function pokerCosmeticStyleAttr(vars: PokerCosmeticVars): string | undefined {
	const entries = Object.entries(vars) as Array<[PokerCosmeticVarName, string]>;
	if (entries.length === 0) return undefined;
	return entries.map(([name, value]) => `${name}:${value}`).join(';');
}
