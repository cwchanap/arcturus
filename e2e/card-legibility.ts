import { expect } from '@playwright/test';
import type { Locator } from '@playwright/test';

/**
 * Computed-style legibility contract for CardSlot faces, shared by the
 * Video Poker / Pai Gow / Three-Card Showdown E2E specs.
 * Colors mirror the scoped styles in src/components/CardSlot.astro.
 */
export const BLACK_CARD_COLOR = 'rgb(20, 20, 20)'; // #141414 dark face text
export const RED_CARD_COLOR = 'rgb(163, 22, 28)'; // #a3161c red suits
export const CARD_FACE_TEXT_COLORS = [BLACK_CARD_COLOR, RED_CARD_COLOR] as const;
export const CARD_MIN_CONTRAST = 4.5; // WCAG AA normal text

export type VisibleCardFace = {
	rankText: string;
	suitText: string;
	textColor: string;
	backgroundColor: string;
	visible: boolean;
};

/** Collect rank/suit text plus computed colors for every visible card face under root. */
export async function readVisibleCardFaces(root: Locator): Promise<VisibleCardFace[]> {
	return root.locator('[data-card-face]:not(.hidden)').evaluateAll((faces) =>
		faces.map((node) => {
			const face = node as HTMLElement;
			const rank = face.querySelector<HTMLElement>('[data-rank]');
			const suit = face.querySelector<HTMLElement>('[data-suit-center]');
			const rankBox = rank?.getBoundingClientRect();
			return {
				rankText: (rank?.textContent ?? '').trim(),
				suitText: (suit?.textContent ?? '').trim(),
				textColor: getComputedStyle(rank ?? face).color,
				backgroundColor: getComputedStyle(face).backgroundColor,
				visible: !!rank && !!suit && !!rankBox && rankBox.width > 0 && rankBox.height > 0,
			};
		}),
	);
}

/** WCAG relative-luminance contrast ratio between two rgb()/rgba() colors. */
export function contrastRatio(a: string, b: string): number {
	const luminance = (color: string): number => {
		const match = color.match(/rgba?\((\d+), (\d+), (\d+)/);
		if (!match) return 0;
		const [r, g, bl] = match.slice(1).map((channel) => {
			const s = Number(channel) / 255;
			return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
		});
		return 0.2126 * r + 0.7152 * g + 0.0722 * bl;
	};
	const l1 = luminance(a);
	const l2 = luminance(b);
	return (Math.max(l1, l2) + 0.05) / (Math.min(l1, l2) + 0.05);
}

/** Assert every face shows a visible, non-empty, contrasting rank and suit. */
export function expectLegibleCardFaces(faces: VisibleCardFace[]): void {
	for (const face of faces) {
		expect(face.visible, 'rank and suit elements are visible').toBe(true);
		expect(face.rankText, 'rank text is non-empty').not.toBe('');
		expect(face.suitText, 'suit text is non-empty').not.toBe('');
		expect(
			CARD_FACE_TEXT_COLORS,
			`face text color must be a CardSlot contract color, got ${face.textColor}`,
		).toContain(face.textColor);
		expect(
			contrastRatio(face.textColor, face.backgroundColor),
			`contrast of ${face.textColor} on ${face.backgroundColor}`,
		).toBeGreaterThanOrEqual(CARD_MIN_CONTRAST);
	}
}
