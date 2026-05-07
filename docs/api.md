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

---

## UX / Display endpoints

These endpoints are designed to be called directly from the game UI to surface 0G infrastructure status to players. Every response comes pre-formatted with labels, descriptions, explorer links, and display-ready data — no transformation needed on the client.

All UX endpoints live under the `/0g` prefix.

---

### GET /0g/dashboard

Returns everything you need for a player's personal 0G dashboard in a single call — summary stats, trust score, latest save pipeline, and a short activity feed.

**Auth:** required
**Rate limit:** 30 requests/minute

**Request:**
```
GET /0g/dashboard
Authorization: Bearer 0xabc...
```

**Response 200:**
```json
{
  "wallet": "0xabc...",
  "summary": {
    "totalSaves": 14,
    "finalizedSaves": 12,
    "pendingSaves": 1,
    "failedSaves": 1,
    "anchoredSaves": 11,
    "totalDataStored": "28.4 KB",
    "totalDataStoredBytes": 29081
  },
  "trustScore": {
    "score": 82,
    "label": "PLATINUM",
    "description": "Maximum trust. Saves are anchored, DA-finalized, and TEE-validated.",
    "breakdown": {
      "totalSaves": 14,
      "finalizedSaves": 12,
      "anchoredSaves": 11,
      "computeValidated": 3,
      "finalizedPercent": 85,
      "anchoredPercent": 78
    }
  },
  "latestSave": {
    "saveIndex": 14,
    "rootHash": "0x3f4a2b...",
    "coinSnapshot": 1840,
    "fileSize": "2.1 KB",
    "checksum": "a3f2b1...",
    "source": "game_save",
    "createdAt": "2024-12-01T14:21:58.000Z",
    "pipeline": {
      "stored": {
        "done": true,
        "label": "Uploaded to 0G Storage",
        "description": "Your save is stored on the 0G decentralized storage network.",
        "rootHash": "0x3f4a2b...",
        "txHash": "0x7e91cc...",
        "fileSize": "2.1 KB",
        "explorerUrl": "https://chainscan.0g.ai/tx/0x7e91cc..."
      },
      "anchored": {
        "done": true,
        "label": "Root hash anchored on-chain",
        "description": "A permanent on-chain record links your wallet to this save.",
        "txHash": "0x9d11...",
        "block": 18204,
        "explorerUrl": "https://chainscan.0g.ai/tx/0x9d11...",
        "contractUrl": "https://chainscan.0g.ai/address/0x..."
      },
      "finalized": {
        "done": true,
        "label": "BLS-signed by 0G DA network",
        "description": "A quorum of DA nodes signed off on this save's availability.",
        "status": "finalized",
        "batchId": "42",
        "blobIndex": 3,
        "batchHeaderHash": "0xf3...",
        "referenceBlock": 18199,
        "finalizedAt": "2024-12-01T14:22:03.000Z"
      },
      "validated": {
        "done": true,
        "label": "TEE anti-cheat verified",
        "description": "A Trusted Execution Environment confirmed this save is legitimate.",
        "status": "validated",
        "verdict": "CLEAN",
        "confidence": 0.97,
        "teeVerified": true,
        "flags": []
      }
    }
  },
  "recentActivity": [
    {
      "id": "14-da",
      "type": "DA_FINALIZED",
      "saveIndex": 14,
      "timestamp": "2024-12-01T14:22:03.000Z",
      "title": "Save #14 finalized by 0G DA",
      "description": "BLS-signed finality proof generated. Batch #42, blob #3.",
      "status": "success",
      "data": { "batchId": "42", "blobIndex": 3, "batchHeaderHash": "0xf3..." },
      "explorerUrl": null
    }
  ],
  "contracts": {
    "playerSaveAnchor": {
      "address": "0x4f91ab...",
      "explorerUrl": "https://chainscan.0g.ai/address/0x4f91ab..."
    }
  }
}
```

The `pipeline` object inside `latestSave` is the main thing to render. Four stages in order: `stored → anchored → finalized → validated`. Each has `done: bool` so you can show checkmarks, spinners, or empty circles.

---

### GET /0g/activity

Paginated timeline of all 0G events for the authenticated wallet. Each save generates multiple events (upload, anchor, DA finalization, compute verdict) that are flattened and sorted newest-first.

**Auth:** required
**Rate limit:** 30 requests/minute

```
GET /0g/activity?page=1&limit=20
```

**Response 200:**
```json
{
  "wallet": "0xabc...",
  "page": 1,
  "totalPages": 3,
  "totalEvents": 47,
  "hasMore": true,
  "events": [
    {
      "id": "14-da",
      "type": "DA_FINALIZED",
      "saveIndex": 14,
      "timestamp": "2024-12-01T14:22:03.000Z",
      "title": "Save #14 finalized by 0G DA",
      "description": "BLS-signed finality proof generated. Batch #42, blob #3.",
      "status": "success",
      "data": { "batchId": "42", "blobIndex": 3 },
      "explorerUrl": null
    },
    {
      "id": "14-anchored",
      "type": "SAVE_ANCHORED",
      "saveIndex": 14,
      "timestamp": "2024-12-01T14:22:01.000Z",
      "title": "Save #14 anchored on-chain",
      "description": "Root hash recorded permanently on the 0G EVM blockchain at block 18204.",
      "status": "success",
      "data": { "txHash": "0x9d11...", "block": 18204 },
      "explorerUrl": "https://chainscan.0g.ai/tx/0x9d11..."
    }
  ]
}
```

Event types and their `status` values:

| type | status | when it fires |
|---|---|---|
| `SAVE_STORED` | success | rootHash exists (every save) |
| `SAVE_ANCHORED` | success | anchorTxHash written by background pipeline |
| `DA_FINALIZED` | success | daStatus becomes "finalized" |
| `DA_FAILED` | error | DA timeout after 120s |
| `COMPUTE_VALIDATED` | success | computeStatus becomes "validated" |
| `COMPUTE_REJECTED` | warning | computeStatus becomes "rejected" |

Events with `explorerUrl` can be linked directly — anchor events always have one, storage/DA/compute events may not.

---

### GET /0g/badge

Returns the wallet's trust badge level and score, with a breakdown of how the score was computed and what's needed for the next level.

**Auth:** required
**Rate limit:** 30 requests/minute

**Response 200:**
```json
{
  "wallet": "0xabc...",
  "badge": "GOLD",
  "score": 74,
  "description": "Strong verification coverage. Saves are anchored and DA-finalized.",
  "breakdown": {
    "totalSaves": 8,
    "finalizedSaves": 7,
    "anchoredSaves": 6,
    "computeValidated": 0,
    "finalizedPercent": 87,
    "anchoredPercent": 75
  },
  "nextLevel": {
    "label": "PLATINUM",
    "hint": "Accumulate TEE-validated saves and reach 10+ total saves."
  }
}
```

Badge levels and score ranges:

| Badge | Score | What it means |
|---|---|---|
| BRONZE | 1–30 | Saves uploading, anchoring/DA in progress |
| SILVER | 31–55 | Most saves anchored and DA-pending |
| GOLD | 56–80 | High DA finalization rate, strong anchoring |
| PLATINUM | 81–100 | DA-finalized, anchored, and TEE-validated |

Score breakdown:
- 10 pts — has at least one save
- Up to 40 pts — finalization rate (finalized ÷ total × 40)
- Up to 25 pts — anchor rate (anchored ÷ total × 25)
- 15 pts — has at least one TEE-validated save
- 5–10 pts — volume (5+ saves = 5, 10+ saves = 10)

---

### GET /0g/network

Live health check of all four 0G infrastructure services. Storage and chain are actively probed; DA and compute report config state.

**Auth:** none
**Rate limit:** 20 requests/minute

**Response 200:**
```json
{
  "timestamp": "2024-12-01T14:25:00.000Z",
  "overall": "healthy",
  "services": {
    "storage": {
      "status": "online",
      "latencyMs": 142,
      "endpoint": "https://indexer-storage-turbo.0g.ai",
      "label": "0G Storage Indexer"
    },
    "chain": {
      "status": "online",
      "latencyMs": 89,
      "blockNumber": 18204,
      "chainId": 16600,
      "endpoint": "https://evmrpc.0g.ai",
      "explorerUrl": "https://chainscan.0g.ai",
      "label": "0G Newton EVM"
    },
    "da": {
      "status": "configured",
      "endpoint": "disperser-testnet.0g.ai:51001",
      "protocol": "gRPC",
      "label": "0G DA Disperser"
    },
    "compute": {
      "status": "configured",
      "endpoint": "https://router-api.0g.ai",
      "label": "0G Compute (TEE anti-cheat)",
      "note": null
    }
  },
  "contracts": {
    "playerSaveAnchor": "0x4f91ab...",
    "explorerUrl": "https://chainscan.0g.ai/address/0x4f91ab..."
  }
}
```

`overall` is `"healthy"` when all services report `"online"` or `"configured"`. It becomes `"degraded"` if the storage indexer or EVM RPC is unreachable.

---

### GET /0g/leaderboard/verified

Top 100 wallets by coin snapshot, filtered by verification level. Includes a `verificationBadge` per entry so the frontend can show verification icons.

**Auth:** none
**Rate limit:** 30 requests/minute

```
GET /0g/leaderboard/verified?filter=finalized
```

The `filter` query param controls which saves are included:

| filter | what qualifies |
|---|---|
| `finalized` (default) | `daStatus === "finalized"` |
| `anchored` | has an `anchorTxHash` |
| `validated` | `computeStatus === "validated"` |
| `any` | any save with a rootHash |

**Response 200:**
```json
{
  "filter": "finalized",
  "total": 67,
  "leaderboard": [
    {
      "rank": 1,
      "walletAddress": "0x3f4a2b8c1d...",
      "displayName": "Warrior_3f4a2b",
      "coinSnapshot": 18420,
      "saveIndex": 14,
      "verificationBadge": "FULLY_VERIFIED",
      "daStatus": "finalized",
      "computeStatus": "validated",
      "anchorTxHash": "0x9d11...",
      "anchorBlock": 18204,
      "explorerUrl": "https://chainscan.0g.ai/tx/0x9d11..."
    }
  ]
}
```

Verification badge values:

| badge | meaning |
|---|---|
| `FULLY_VERIFIED` | DA finalized + compute validated |
| `DA_VERIFIED` | DA finalized |
| `ANCHORED` | has on-chain anchor tx |
| `STORED` | uploaded to 0G Storage only |

---

### GET /0g/proof/:wallet/:saveIndex

Shareable certificate for a specific save. Returns all cryptographic proof data — storage rootHash, on-chain anchor tx, DA commitment, and compute verdict — formatted for display.

**Auth:** none (public, shareable URL)
**Rate limit:** 20 requests/minute

```
GET /0g/proof/0xabc.../5
```

**Response 200:**
```json
{
  "certificate": {
    "wallet": "0xabc...",
    "saveIndex": 5,
    "rootHash": "0x3f4a2b...",
    "issuedAt": "2024-12-01T14:21:58.000Z",
    "verified": true,
    "badge": "FULLY_VERIFIED"
  },
  "storage": {
    "rootHash": "0x3f4a2b...",
    "txHash": "0x7e91cc...",
    "explorerUrl": "https://chainscan.0g.ai/tx/0x7e91cc...",
    "fileSize": "2.1 KB",
    "fileSizeBytes": 2150,
    "checksum": "a3f2b1...",
    "network": "0G Storage",
    "indexerUrl": "https://indexer-storage-turbo.0g.ai"
  },
  "onChain": {
    "contractAddress": "0x4f91ab...",
    "contractUrl": "https://chainscan.0g.ai/address/0x4f91ab...",
    "txHash": "0x9d11...",
    "txUrl": "https://chainscan.0g.ai/tx/0x9d11...",
    "block": 18204,
    "chainId": 16600,
    "network": "0G Newton Testnet"
  },
  "da": {
    "status": "finalized",
    "finalized": true,
    "commitment": {
      "batchId": "42",
      "blobIndex": 3,
      "batchHeaderHash": "0xf3...",
      "referenceBlockNumber": 18199,
      "finalizedAt": "2024-12-01T14:22:03.000Z"
    },
    "network": "0G DA Testnet",
    "endpoint": "disperser-testnet.0g.ai:51001"
  },
  "compute": {
    "status": "validated",
    "verdict": "CLEAN",
    "details": {
      "valid": true,
      "confidence": 0.97,
      "flags": [],
      "teeVerified": true,
      "providerAddress": "0x...",
      "validatedAt": "2024-12-01T14:22:05.000Z"
    }
  }
}
```

`certificate.verified` is `true` when both `onChain` is non-null and `da.status === "finalized"`. This is the field to check for a "verified" badge UI.

`onChain` will be `null` if the background pipeline hasn't anchored yet.

---

### GET /0g/explorer/:wallet

Public 0G profile for any wallet — all saves with pipeline status, trust score, and on-chain anchor state. Useful for a player's public profile page.

**Auth:** none
**Rate limit:** 30 requests/minute

```
GET /0g/explorer/0xabc...
```

**Response 200:**
```json
{
  "wallet": "0xabc...",
  "displayName": "Warrior_abc123",
  "trustBadge": "GOLD",
  "trustScore": 74,
  "totalSaves": 8,
  "totalDataStored": "16.2 KB",
  "onChainAnchor": {
    "rootHash": "0x3f4a2b...",
    "saveIndex": 8,
    "timestamp": 1733060518,
    "exists": true
  },
  "saves": [
    {
      "saveIndex": 8,
      "rootHash": "0x3f4a2b...",
      "coinSnapshot": 1840,
      "fileSize": "2.1 KB",
      "daStatus": "finalized",
      "computeStatus": "skipped",
      "badge": "DA_VERIFIED",
      "anchorTxHash": "0x9d11...",
      "explorerUrl": "https://chainscan.0g.ai/tx/0x9d11...",
      "pipeline": { ... },
      "createdAt": "2024-12-01T14:21:58.000Z"
    }
  ],
  "contractUrl": "https://chainscan.0g.ai/address/0x4f91ab..."
}
```

Returns the 20 most recent saves. Each save includes the full `pipeline` object (same shape as in `/0g/dashboard`) so you can render stage checkmarks inline.

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
