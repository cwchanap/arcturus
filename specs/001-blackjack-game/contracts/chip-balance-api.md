# API Contract: Chip Balance Update

**Feature**: Blackjack Game - Chip Balance Synchronization  
**Endpoint**: `/api/chips/update` (NEW)  
**Method**: `POST`

## Overview

API endpoint for updating user chip balance after Blackjack round completion. Provides atomic balance updates with validation and error handling.

## Request

### Endpoint

```
POST /api/chips/update
```

### Headers

```http
Content-Type: application/json
Cookie: better-auth.session_token=<session-token>
```

### Authentication

- **Required**: Yes - Session must be valid via Better Auth
- **Authorization**: User can only update their own chip balance
- **Session Source**: `Astro.locals.session` (middleware-injected)

### Request Body

```typescript
interface ChipBalanceUpdateRequest {
	previousBalance: number; // Client's expected current balance (used for optimistic locking)
	delta: number; // Change amount (positive for win, negative for loss)
	gameType: 'blackjack'; // Game identifier for audit
	roundDetails?: {
		// Optional round metadata
		bet: number;
		outcome: 'win' | 'loss' | 'push' | 'blackjack';
	};
}
```

**Example**:

```json
{
	"previousBalance": 1000,
	"delta": 150,
	"gameType": "blackjack",
	"roundDetails": {
		"bet": 100,
		"outcome": "blackjack"
	}
}
```

### Validation Rules

- `previousBalance` must be >= 0 and match the stored balance (server compares and rejects if mismatch)
- `delta` must be a finite number (positive or negative)
- **Server computes `newBalance`** from `previousBalance + delta` - this prevents chip minting attacks
- Computed `newBalance` must be >= 0 (cannot go negative)
- `gameType` must be `'blackjack'`
- User must be authenticated

### Optimistic Locking

The server compares `previousBalance` with the stored chip balance. If they differ (indicating a concurrent modification), the server rejects the update with a 409 Conflict response containing the current balance. The client must refresh and retry.

---

## Response

### Success (200 OK)

```typescript
interface ChipBalanceUpdateResponse {
	success: true;
	balance: number; // Confirmed new balance from database
	previousBalance: number; // Balance before update
	message: string; // Success message
}
```

**Example**:

```json
{
	"success": true,
	"balance": 1150,
	"previousBalance": 1000,
	"message": "Chip balance updated successfully"
}
```

### Error Responses

#### 401 Unauthorized

```json
{
	"success": false,
	"error": "UNAUTHORIZED",
	"message": "Authentication required"
}
```

#### 400 Bad Request - Invalid Delta

```json
{
	"success": false,
	"error": "INVALID_DELTA",
	"message": "Delta must be a finite number"
}
```

#### 400 Bad Request - Insufficient Balance

```json
{
	"success": false,
	"error": "INSUFFICIENT_BALANCE",
	"message": "Insufficient chip balance for this operation",
	"currentBalance": 100
}
```

#### 409 Conflict - Concurrent Update

```json
{
	"success": false,
	"error": "BALANCE_MISMATCH",
	"message": "Balance was modified by another session. Please refresh.",
	"currentBalance": 1200
}
```

#### 500 Internal Server Error

```json
{
	"success": false,
	"error": "DATABASE_ERROR",
	"message": "Failed to update chip balance. Please try again."
}
```

---

## Implementation Notes

### Database Transaction

```typescript
// Atomic update with optimistic locking
await db
	.update(user)
	.set({
		chipBalance: newBalance,
		updatedAt: new Date(),
	})
	.where(
		and(
			eq(user.id, userId),
			eq(user.chipBalance, previousBalance), // Optimistic lock
		),
	);
```

### Concurrency Handling

- Use optimistic locking: verify previous balance before update
- If balance changed, return 409 Conflict with current balance
- Client must refresh and retry with correct balance

### Audit Trail (Future Enhancement)

- Consider logging transactions to separate `chip_transactions` table
- Would include: userId, gameType, delta, timestamp, roundDetails
- Not required for MVP but valuable for analytics

---

## Client Usage

```typescript
async function updateChipBalance(
	previousBalance: number,
	delta: number,
	roundDetails: RoundDetails,
): Promise<ChipBalanceUpdateResponse> {
	const response = await fetch('/api/chips/update', {
		method: 'POST',
		headers: { 'Content-Type': 'application/json' },
		body: JSON.stringify({
			previousBalance, // For optimistic locking validation
			delta, // Server computes newBalance from previousBalance + delta
			gameType: 'blackjack',
			roundDetails,
		}),
	});

	if (!response.ok) {
		const error = await response.json();
		throw new Error(error.message);
	}

	return response.json();
}
```

### Error Handling Flow

```typescript
try {
	const result = await updateChipBalance(newBalance, delta, roundDetails);
	console.log('Balance updated:', result.balance);
} catch (error) {
	if (error.message.includes('BALANCE_MISMATCH')) {
		// Refresh balance from server and retry
		const currentBalance = await fetchCurrentBalance();
		showErrorMessage('Balance changed. Please start a new round.');
	} else {
		// Show generic error, allow retry
		showErrorMessage('Failed to update balance. Try again?');
	}
}
```

---

## Testing

### Unit Tests

- ✅ Validate request body schema
- ✅ Verify authentication requirement
- ✅ Test negative balance rejection
- ✅ Test optimistic lock behavior

### Integration Tests

- ✅ Test successful balance update
- ✅ Test concurrent update conflict
- ✅ Test unauthenticated request rejection

### E2E Tests

- ✅ Complete Blackjack round and verify balance updated
- ✅ Test retry flow on network failure
- ✅ Test balance refresh after conflict

---

## Alternatives Considered

### Alternative 1: Pass newBalance from Client

**Rejected**: Client passes computed newBalance, server trusts it

- **Pro**: Simpler server logic
- **Con**: Security vulnerability - allows chip minting attacks
- **Decision**: Server must compute newBalance from delta to prevent manipulation

### Alternative 2: Optimistic UI Only

**Rejected**: Update UI optimistically, sync in background

- **Pro**: Faster perceived performance
- **Con**: User could see incorrect balance if sync fails silently

### Alternative 3: WebSocket for Real-time Sync

**Rejected**: Use WebSocket connection for balance updates

- **Pro**: Real-time synchronization
- **Con**: Over-engineered for single-player game; adds complexity

---

## Migration Notes

**No database migrations required** - Uses existing `user.chipBalance` column.

Endpoint implementation location: `/src/pages/api/chips/update.ts` (NEW FILE)
