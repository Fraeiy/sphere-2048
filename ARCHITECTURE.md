# Per-Player Wallet Architecture

## Problem Solved
- ❌ Old: Single hardcoded `@sphere2048` address that doesn't exist
- ✅ New: Unique deposit address per player (e.g., `@a1b2c3_2048_r4x7`)

## Key Components

### 1. **Sphere.js (Backend)**
New functions:
- `generatePlayerHandle(playerAddress)` - Creates unique handle like `@a1b2c3_2048_r4x7`
- `publishPlayerIdentity(playerAddress, playerHandle)` - Publishes to relay
- `generateDepositAddress(playerAddress)` - Wrapper that creates and publishes identity

### 2. **Index.js (API)**
New endpoint:
- `POST /api/create-wallet` - Creates unique game wallet per player
  - Input: `{ playerAddress: string }` (from Sphere wallet)
  - Output: `{ depositAddress: "@a1b2c3...", handle: "..." }`
  - Storage: `playerWallets` Map tracks each player's wallet

### 3. **UI.js (Frontend)**
New state:
- `walletReady` - Boolean flag set to true after wallet creation completes
- `GAME_DEPOSIT_ADDRESS` - Player's unique deposit address

New function:
- `createPlayerGameWallet(playerAddress)` - Called after wallet connection
  - Calls `/api/create-wallet`
  - Sets `walletReady = true`
  - Enables deposit button

## Flow (Correct Order)

```
1. Player clicks "Connect Wallet"
   ↓
2. Sphere wallet popup opens
   ↓
3. Player approves connection
   ↓ [walletIdentity received]
4. Frontend calls createPlayerGameWallet(walletIdentity.address)
   ↓
5. Backend creates unique handle: @a1b2c3_2048_xyz
   ↓
6. Backend publishes identity to relay
   ↓ [walletReady = true]
7. Deposit button ENABLED
   ↓
8. Player clicks "Deposit"
   ↓
9. Sends UTC to GAME_DEPOSIT_ADDRESS (@a1b2c3_2048_xyz)
   ↓
10. Deposit successful!
   ↓
11. Player can play game
```

## State Locks

### Deposit Button
- Disabled until `walletReady = true`
- Text shows: "⏳ Initializing wallet…" during setup
- Text shows: "💰 Deposit (100 UTC)" when ready

### Wallet Creation
- Prevents users from depositing before identity is published
- Ensures each player has a unique, discoverable address

## Handle Format

```javascript
@{first6chars}_2048_{random4chars}

Examples:
@a1b2c3_2048_r4x7
@vitalik_2048_k9m2
@account_2048_p1q8
```

## Status Responses

### Before Wallet Creation
```json
{
  "success": false,
  "error": "Sphere SDK not initialised"
}
```

### During Wallet Creation
Button shows: "⏳ Initializing wallet…"
Message: "🔧 Setting up game wallet…"

### After Wallet Creation
```json
{
  "success": true,
  "depositAddress": "@a1b2c3_2048_r4x7",
  "handle": "@a1b2c3_2048_r4x7"
}
```

Message: "💰 Deposit to: @a1b2c3_2048_r4x7"
