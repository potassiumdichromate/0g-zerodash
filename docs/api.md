# API Reference

Base URL (local dev): `http://localhost:3001`

---

## Authentication

Protected endpoints require a wallet identity. Send one of these:

**Option A — Browser JWT** (what the game uses)
```
POST body:
{
  "jwt": "<signed JWT token>",
  "source": "browser"
}
```

**Option B — Bearer token** (for direct integrations / testing)
```
Authorization: Bearer 0x1234...abcd
```

The wallet address is extracted from the token server-side and set as `req.walletAddress`. Never send `X-Wallet-Address` as an identity header — it's ignored.

---

## 0G Endpoints

### POST /player/save/binary

Upload a binary player save to 0G Storage.

**Auth:** required  
**Rate limit:** 10 requests/minute  
**Content-Type:** `application/octet-stream`  
**Body size limit:** 5 MB

The server returns 201 immediately after uploading to 0G Storage. The on-chain anchor, DA proof, and compute validation all happen asynchronously after the response.

You can optionally send `X-Save-Index` as a request header. If you do, the server validates that it's strictly greater than the current saveIndex and returns 409 if not. If you omit it, the server just auto-increments.

**Request:**
```
POST /player/save/binary
Authorization: Bearer 0xabc...
Content-Type: application/octet-stream
X-Save-Index: 5

<raw binary data>
```

**Response 201:**
```json
{
  "success": true,
  "rootHash": "0x3f4a2b...",
  "saveIndex": 5,
  "txHash": "0x7e91cc...",
  "checksum": "a3f2b1...",
  "fileSize": 2048
}
```

**Response 409 — anti-rollback:**
```json
{
  "error": "Anti-rollback: saveIndex must be strictly greater than current",
  "currentSaveIndex": 7,
  "rejectedSaveIndex": 5
}
```

**Response 400 — empty body:**
```json
{
  "error": "Empty or invalid binary payload"
}
```

---

### GET /player/load/binary

Download the latest binary save for the authenticated wallet.

**Auth:** required  
**Rate limit:** 30 requests/minute

**Request:**
```
GET /player/load/binary
Authorization: Bearer 0xabc...
```

**Response 200:**
```
Content-Type: application/octet-stream
X-Root-Hash: 0x3f4a2b...
X-Save-Index: 5
X-Da-Status: finalized
X-Checksum-Sha256: a3f2b1...

<raw binary data>
```

The `X-Da-Status` header tells you the DA finality state of the save being returned. Possible values: `pending`, `finalized`, `failed`, `skipped`. A `finalized` save has a BLS-signed proof from the 0G DA network.

**Response 404:**
```json
{
  "error": "No save found for this wallet"
}
```

---

### GET /player/save/metadata

Returns the save history and on-chain anchor info for any wallet. Public endpoint.

**Auth:** none  
**Rate limit:** 60 requests/minute

**Request:**
```
GET /player/save/metadata?wallet=0xabc...
```

**Response 200:**
```json
{
  "wallet": "0xabc...",
  "saves": [
    {
      "_id": "...",
      "walletAddress": "0xabc...",
      "rootHash": "0x3f4a2b...",
      "txHash": "0x7e91cc...",
      "fileSize": 2048,
      "checksum": "a3f2b1...",
      "saveIndex": 5,
      "coinSnapshot": 1340,
      "anchorTxHash": "0x9d11...",
      "anchorBlock": 18204,
      "daStatus": "finalized",
      "daCommitment": {
        "requestId": "...",
        "batchId": "42",
        "blobIndex": 3,
        "batchHeaderHash": "0xf3...",
        "referenceBlockNumber": 18199,
        "finalizedAt": "2024-12-01T14:22:03.000Z"
      },
      "computeStatus": "validated",
      "computeValidation": {
        "valid": true,
        "confidence": 0.97,
        "flags": [],
        "verdict": "CLEAN",
        "rootHash": "0x3f4a2b...",
        "teeVerified": true,
        "providerAddress": "0x...",
        "validatedAt": "2024-12-01T14:22:05.000Z"
      },
      "source": "game_save",
      "createdAt": "2024-12-01T14:21:58.000Z"
    }
  ],
  "onChain": {
    "rootHash": "0x3f4a2b...",
    "saveIndex": 5,
    "timestamp": 1733060518,
    "exists": true
  }
}
```

`saves` returns the 10 most recent saves, newest first. `onChain` is the result of calling `getLatestSave(wallet)` on the `PlayerSaveAnchor` contract — it's the on-chain ground truth. If the contract isn't configured (`ZG_ANCHOR_CONTRACT_ADDRESS` not set), `onChain` will be `null`.

---

### GET /player/verify

Runs a 4-layer integrity check on a wallet's latest save. Public endpoint.

**Auth:** none  
**Rate limit:** 20 requests/minute

**Request:**
```
GET /player/verify?wallet=0xabc...
```

**Response 200 — all layers passing:**
```json
{
  "wallet": "0xabc...",
  "saveIndex": 5,
  "layers": {
    "dbRecord": true,
    "daFinalized": true,
    "checksumMatch": true,
    "computeValidated": true
  },
  "allPassed": true
}
```

**Response 200 — partial failure:**
```json
{
  "wallet": "0xabc...",
  "saveIndex": 5,
  "layers": {
    "dbRecord": true,
    "daFinalized": true,
    "checksumMatch": false,
    "computeValidated": true
  },
  "allPassed": false
}
```

The four layers:

| Layer | What it checks |
|---|---|
| `dbRecord` | A `PlayerSaveRecord` exists for this wallet in MongoDB |
| `daFinalized` | `daStatus === "finalized"` — the save has a BLS-signed DA proof |
| `checksumMatch` | Re-downloads the file from 0G Storage and computes SHA-256, compares against stored checksum |
| `computeValidated` | `computeStatus === "validated"` — TEE anti-cheat returned CLEAN |

`checksumMatch` does a live network download on every call. Don't hammer this endpoint.

A save with `computeStatus: "skipped"` will have `computeValidated: false`, so `allPassed` will be false even if the save is completely legitimate. The compute layer only fires when `coinDelta > 100` or `saveIndexDelta > 1`, so most routine saves will always fail this layer. Factor that into how you use this endpoint.

---

### GET /player/leaderboard/decentralized

Returns the top 100 wallets sorted by their highest coin snapshot across all saves. Public endpoint.

**Auth:** none  
**Rate limit:** 30 requests/minute

**Request:**
```
GET /player/leaderboard/decentralized
```

**Response 200:**
```json
{
  "total": 87,
  "leaderboard": [
    {
      "rank": 1,
      "walletAddress": "0x3f4a2b8c1d...",
      "displayName": "Warrior_3f4a2b",
      "coinSnapshot": 18420,
      "saveIndex": 14,
      "daStatus": "finalized"
    },
    {
      "rank": 2,
      "walletAddress": "0x9c71e0f3a2...",
      "displayName": "Warrior_9c71e0",
      "coinSnapshot": 15900,
      "saveIndex": 9,
      "daStatus": "pending"
    }
  ]
}
```

Display names are derived deterministically as `Warrior_` + the first 6 hex characters after the `0x` prefix. This is stable — the same wallet always gets the same name.

The aggregate groups by wallet, takes the highest saveIndex per wallet (which corresponds to the highest coinSnapshot), and sorts descending. It does not cross-reference with the Player collection.

---

## Legacy endpoints (unchanged)

These routes work exactly as before. They're documented here for reference.

### GET /player/profile
### POST /player/profile

Returns the player profile. Creates one if it doesn't exist. Saves a session to the 0G Mainnet (chainId 16661) session contract.

**Auth:** required

**Response:**
```json
{
  "walletAddress": "0xabc...",
  "coins": 1340,
  "highScore": 8820,
  "nftPass": false,
  "characters": {
    "unlocked": ["char_01", "char_03"],
    "currentIndex": 1
  },
  "dailyReward": {
    "nextRewardAt": "2024-12-02T00:00:00.000Z"
  },
  "blockchain": {
    "success": true,
    "txHash": "0x...",
    "blockNumber": 18204
  }
}
```

---

### POST /player/save

Save player state. After responding, triggers a background dual-write to 0G Storage.

**Auth:** required

**Request body:**
```json
{
  "coins": 1340,
  "highScore": 8820,
  "characters": {
    "unlocked": ["char_01"],
    "currentIndex": 0
  }
}
```

**Response:**
```json
{
  "success": true,
  "savedToBlockchain": true,
  "blockchain": {
    "success": true,
    "txHash": "0x...",
    "blockNumber": 18204,
    "gasUsed": "82341"
  }
}
```

---

### GET /player/leaderboard

Top players by highScore from MongoDB.

**Auth:** none (wallet optional via query param for personal standing)

```
GET /player/leaderboard?limit=50&wallet=0xabc...
```

---

### POST /player/nft-pass

Activate the NFT pass flag on a player account.

**Auth:** required

```json
{ "nftPass": true }
```

---

### GET /player/sessions
### GET /player/latest-session
### GET /player/blockchain-stats
### GET /player/leaderboard-snapshot/:snapshotId
### GET /player/leaderboard-history

All require auth. These pull data from the 0G Mainnet (chainId 16661) contracts.

---

## Utility endpoints

### GET /

```
ZeroDash 0G Backend Running
```

### GET /stats

```json
{
  "totalPlayers": 412,
  "totalSessions": 3891,
  "totalLeaderboardSnapshots": 204,
  "totalDecentralizedSaves": 1847,
  "contracts": {
    "sessions": "0x9D8090...",
    "leaderboard": "0x...",
    "playerSaveAnchor": "0x..."
  }
}
```

### GET /blockchain-info

Returns readiness state of both blockchain services and network info.

### GET /contracts

Lists all deployed contracts with addresses and chain info.

---

## Error reference

| Code | Meaning |
|---|---|
| 400 | Bad request — missing required field or invalid payload |
| 401 | Missing or invalid auth token |
| 404 | Resource not found (no save for wallet, etc.) |
| 409 | Anti-rollback conflict — incoming saveIndex not strictly greater |
| 429 | Rate limit exceeded |
| 500 | Server error — check logs for `[0G]` prefixed messages |

Rate limit responses include `Retry-After` in the headers via the `express-rate-limit` standard headers mode.
