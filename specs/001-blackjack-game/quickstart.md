# Quickstart Guide: Blackjack Game Development

**Feature**: Blackjack Game with LLM Rival  
**Branch**: `001-blackjack-game`  
**Target Audience**: Developers implementing this feature

## Prerequisites

- Existing Arcturus development environment set up
- Bun installed as package manager
- Local D1 database configured (`bun run setup:db`)
- Dev server running on port 2000 (`bun run dev`)

## Development Workflow

### 1. Create Game Logic Modules (Day 1-2)

Start with pure functions - easiest to test and foundational for everything else.

```bash
# Create module directory
mkdir -p src/lib/blackjack

# Copy DeckManager from poker (reuse proven code)
cp src/lib/poker/DeckManager.ts src/lib/blackjack/DeckManager.ts
cp src/lib/poker/DeckManager.test.ts src/lib/blackjack/DeckManager.test.ts

# Modify for Blackjack-specific behavior (reshuffle at 15 cards)
# Then create new modules in this order:
```

**Priority order** (most to least critical):

1. **types.ts** - TypeScript interfaces (30 min)
   - Define Card, Hand, BlackjackGameState, BlackjackAction types
   - Run: `bun run lint` to verify syntax

2. **constants.ts** - Game constants (15 min)
   - DEFAULT_MIN_BET, DEFAULT_MAX_BET, BLACKJACK_PAYOUT, etc.

3. **handEvaluator.ts** + tests - Core game logic (3-4 hours)
   - `calculateHandValue(cards)` - Ace soft/hard logic
   - `isBlackjack(hand)`, `isBust(hand)`, `canSplit(hand)`
   - **Test thoroughly** - this is critical for fair gameplay
   - Run: `bun test handEvaluator.test.ts`

4. **dealerStrategy.ts** + tests - Dealer AI (1 hour)
   - `shouldDealerHit(dealerHand)` - hits on ≤16, stands on ≥17
   - Simple logic but must be correct
   - Run: `bun test dealerStrategy.test.ts`

5. **BlackjackGame.ts** + tests - State manager (4-6 hours)
   - Main game class orchestrating all logic
   - Methods: `placeBet()`, `deal()`, `hit()`, `stand()`, `doubleDown()`, `split()`
   - State machine for phase transitions
   - Run: `bun test BlackjackGame.test.ts`

6. **GameSettingsManager.ts** + tests - Settings persistence (2 hours)
   - Load/save to localStorage
   - Validation logic
   - Run: `bun test GameSettingsManager.test.ts`

### 2. Create UI Components (Day 3)

Build the game page using existing components.

```bash
# Create game page
touch src/pages/games/blackjack.astro
```

**Page structure** (reference `src/pages/games/poker.astro`):

```astro
---
import CasinoLayout from '../../layouts/casino.astro';
import PlayingCard from '../../components/PlayingCard.astro';
import PokerChip from '../../components/PokerChip.astro';

const user = Astro.locals.user;
if (!user) return Astro.redirect('/signin');
---

<CasinoLayout title="Blackjack - Arcturus Casino">
	<!-- Betting area -->
	<!-- Player hand display -->
	<!-- Dealer hand display -->
	<!-- Action buttons (Hit/Stand/Double/Split) -->
	<!-- Game status messages -->
	<!-- Settings panel -->
</CasinoLayout>

<script>
	import { BlackjackGame } from '../../lib/blackjack/BlackjackGame';
	new BlackjackGame(); // Initialize on page load
</script>
```

**UI development tips**:

- Use existing Tailwind classes from poker page
- Reuse PlayingCard component for all cards
- Reuse PokerChip component for betting UI
- Test in browser: `http://localhost:2000/games/blackjack`

### 3. Add to Game Lobby (30 min)

Edit `src/pages/games/index.astro`:

```astro
<GameCard
	title="Blackjack"
	description="Beat the dealer to 21"
	href="/games/blackjack"
	icon="🃏"
	players="1 Player"
/>
```

### 4. Create API Endpoint (Day 4)

Implement chip balance update endpoint.

```bash
mkdir -p src/pages/api/chips
touch src/pages/api/chips/update.ts
```

**Endpoint implementation**:

```typescript
import type { APIRoute } from 'astro';
import { createDb } from '../../../lib/db';
import { user } from '../../../db/schema';
import { eq } from 'drizzle-orm';

export const POST: APIRoute = async ({ request, locals }) => {
	// Validate authentication
	if (!locals.user) {
		return new Response(JSON.stringify({ error: 'UNAUTHORIZED' }), {
			status: 401,
			headers: { 'Content-Type': 'application/json' },
		});
	}

	// Parse request
	const body = await request.json();
	const { newBalance, delta } = body;

	// Validate balance
	if (newBalance < 0) {
		return new Response(JSON.stringify({ error: 'INVALID_BALANCE' }), {
			status: 400,
		});
	}

	// Update database
	const db = createDb(locals.runtime.env.DB);
	await db.update(user).set({ chipBalance: newBalance }).where(eq(user.id, locals.user.id));

	return new Response(JSON.stringify({ success: true, balance: newBalance }), {
		status: 200,
		headers: { 'Content-Type': 'application/json' },
	});
};
```

**Test endpoint**:

```bash
curl -X POST http://localhost:2000/api/chips/update \
  -H "Content-Type: application/json" \
  -b "better-auth.session_token=<your-token>" \
  -d '{"newBalance": 1150, "delta": 150, "gameType": "blackjack"}'
```

### 5. Add LLM Integration (Day 5)

Create LLM strategy module for AI advice.

```bash
touch src/lib/blackjack/llmBlackjackStrategy.ts
touch src/lib/blackjack/llmBlackjackStrategy.test.ts
```

**Implementation pattern** (reference `src/lib/poker/llmAIStrategy.ts`):

```typescript
import { getLlmSettings } from '../llm-settings';

export async function getBlackjackAdvice(
	playerHand: Card[],
	dealerCard: Card,
	availableActions: BlackjackAction[],
): Promise<string> {
	const settings = await getLlmSettings(db, userId);

	if (!settings.openaiApiKey && !settings.geminiApiKey) {
		throw new Error('No API key configured');
	}

	const prompt = `You are a Blackjack advisor. 
    Player hand: ${formatHand(playerHand)}
    Dealer showing: ${dealerCard.rank}${dealerCard.suit}
    Available actions: ${availableActions.join(', ')}
    
    Provide brief strategic advice (1-2 sentences).`;

	// Call OpenAI/Gemini API based on settings
	// Return advice string
}
```

**Testing LLM integration**:

- Mock API calls in unit tests
- Test error handling (no API key, API failure, timeout)
- Manual test with real API key in profile settings

### 6. UI Rendering Logic (Day 6)

Create UI renderer for game state updates.

```bash
touch src/lib/blackjack/BlackjackUIRenderer.ts
touch src/lib/blackjack/BlackjackUIRenderer.test.ts
```

**Responsibilities**:

- Update card displays (player/dealer hands)
- Update pot and balance displays
- Enable/disable action buttons based on game state
- Show/hide game status messages
- Trigger animations for card dealing

**Pattern** (reference `src/lib/poker/PokerUIRenderer.ts`):

```typescript
export class BlackjackUIRenderer {
	constructor(private gameState: BlackjackGameState) {}

	renderPlayerHand(hand: Hand) {
		const container = document.getElementById('player-cards');
		container.innerHTML = hand.cards.map((card) => this.renderCard(card)).join('');
	}

	updateActions(availableActions: BlackjackAction[]) {
		['hit', 'stand', 'double-down', 'split'].forEach((action) => {
			const button = document.getElementById(`btn-${action}`);
			button.disabled = !availableActions.includes(action);
		});
	}

	// More render methods...
}
```

### 7. Write E2E Tests (Day 7)

Create Playwright tests for critical user flows.

```bash
touch e2e/blackjack-gameplay.spec.ts
touch e2e/blackjack-split.spec.ts
touch e2e/blackjack-llm.spec.ts
```

**Test structure**:

```typescript
import { test, expect } from '@playwright/test';

test.describe('Blackjack Basic Gameplay', () => {
	test.use({ storageState: 'e2e/.auth/user.json' });

	test('complete round with win', async ({ page }) => {
		await page.goto('http://localhost:2000/games/blackjack');

		// Place bet
		await page.fill('#bet-amount', '50');
		await page.click('#btn-deal');

		// Verify initial cards dealt
		await expect(page.locator('#player-cards .card')).toHaveCount(2);
		await expect(page.locator('#dealer-cards .card')).toHaveCount(2);

		// Play hand
		await page.click('#btn-stand');

		// Verify round complete
		await expect(page.locator('#game-status')).toContainText(/Win|Loss|Push/);
	});
});
```

**Run tests**:

```bash
bun run test:e2e                 # Headless
bun run test:e2e:ui              # UI mode (recommended for debugging)
bun run test:e2e:headed          # Watch browser
```

---

## Common Development Commands

```bash
# Development
bun run dev                      # Start dev server (port 2000)
bun run build                    # Build for production
bun run preview                  # Preview production build

# Testing
bun test                         # Run unit tests
bun test --watch                 # Watch mode
bun test handEvaluator          # Test specific file
bun run test:e2e                 # Run E2E tests
bun run test:coverage            # Generate coverage report

# Code Quality
bun run lint                     # Check for errors
bun run lint:fix                 # Auto-fix issues
bun run format                   # Format code
bun run format:check             # Check formatting

# Database (if needed)
bun run db:studio                # Open Drizzle Studio
```

---

## Debugging Tips

### Game Logic Issues

- Add `console.log` in game methods
- Use `debugger;` statements
- Check browser DevTools Console for errors
- Run unit tests in isolation to narrow down bug

### UI Not Updating

- Verify DOM element IDs match renderer code
- Check browser Network tab for failed requests
- Use React DevTools (if using React-like patterns)
- Inspect state object in console: `window.blackjackGame`

### LLM Integration Issues

- Check Network tab for API call responses
- Verify API key configured in profile (`/profile`)
- Test with curl to isolate frontend vs backend issue
- Mock LLM calls in development to avoid rate limits

### Chip Balance Not Syncing

- Check API endpoint logs
- Verify session token in request cookies
- Test endpoint with curl/Postman
- Check database: `wrangler d1 execute arcturus-db --local --command="SELECT * FROM user"`

---

## Testing Checklist

Before marking feature complete, verify:

### Unit Tests

- [ ] handEvaluator: All card combinations tested (Aces, face cards, soft/hard)
- [ ] dealerStrategy: Hits on ≤16, stands on ≥17
- [ ] BlackjackGame: All actions (hit, stand, double, split) work correctly
- [ ] DeckManager: Shuffles properly, reshuffle triggers at 15 cards
- [ ] GameSettingsManager: Loads/saves settings correctly
- [ ] Coverage: At least 85% (`bun run test:coverage`)

### E2E Tests

- [ ] Basic gameplay: Place bet, play hand, see result
- [ ] Split action: Split pair, play both hands
- [ ] Double down: Double bet, receive one card, auto-stand
- [ ] LLM advice: Click "Ask AI", receive advice (with mocked API)
- [ ] Settings: Change settings, start new round, verify applied
- [ ] Chip balance: Win/loss updates balance correctly

### Manual Testing

- [ ] Play several rounds to verify game fairness
- [ ] Test all edge cases (bust, Blackjack, push, split Aces)
- [ ] Test with LLM enabled (real API key)
- [ ] Test on different screen sizes (responsive)
- [ ] Test with keyboard navigation (accessibility)

---

## Performance Optimization

### Metrics to Monitor

- **Page load**: < 2 seconds (measure with Lighthouse)
- **Card animations**: 60 fps (check in DevTools Performance tab)
- **LLM response**: < 3 seconds (measure in Network tab)
- **State updates**: < 16ms per frame (use Performance profiler)

### Optimization Techniques

- Use CSS transforms for animations (GPU-accelerated)
- Debounce UI updates during rapid state changes
- Lazy-load LLM module (code splitting)
- Cache settings in memory after first load
- Use `requestAnimationFrame` for smooth animations

---

## Deployment Checklist

Before deploying to production:

1. **Tests pass**: `bun run test && bun run test:e2e`
2. **Linting passes**: `bun run lint`
3. **Formatting passes**: `bun run format:check`
4. **Build succeeds**: `bun run build`
5. **Preview works**: `bun run preview` and test manually
6. **Secrets configured**: `wrangler secret list` shows BETTER_AUTH_SECRET
7. **Database migrated**: `bun run db:migrate:remote` (if schema changed)
8. **Documentation updated**: CLAUDE.md references Blackjack game
9. **E2E tests pass on staging**: Run against preview deployment
10. **Deploy**: `bun run deploy`

---

## Troubleshooting

### "Module not found" errors

```bash
# Clear cache and reinstall
rm -rf node_modules .astro
bun install
```

### Cloudflare Workers errors

```bash
# Check wrangler.toml is correct
cat wrangler.toml

# View production logs
wrangler tail
```

### Database issues

```bash
# Reset local database
rm -rf .wrangler
bun run setup:db
```

### Port 2000 already in use

```bash
# Kill existing process
lsof -ti:2000 | xargs kill -9
bun run dev
```

---

## Resources

- **Existing code reference**: `src/pages/games/poker.astro`, `src/lib/poker/`
- **Tailwind docs**: https://tailwindcss.com/docs
- **Astro docs**: https://docs.astro.build
- **Playwright docs**: https://playwright.dev/docs/intro
- **Blackjack rules**: https://en.wikipedia.org/wiki/Blackjack

---

## Timeline Estimate

- **Day 1-2**: Core game logic (types, handEvaluator, dealerStrategy, BlackjackGame)
- **Day 3**: UI implementation (page, components, styling)
- **Day 4**: API endpoint + chip balance integration
- **Day 5**: LLM integration + settings
- **Day 6**: UI renderer + animations
- **Day 7**: E2E tests + bug fixes

**Total**: ~7 working days for complete implementation with tests

**MVP** (P1 only): ~4 days (skip LLM and advanced actions)
