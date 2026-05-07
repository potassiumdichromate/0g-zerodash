# ZeroDash 0G Backend — Complete Architecture Reference

This document explains how the entire backend works: every layer, every decision, every data flow. It is written for someone who needs to understand, extend, or debug the system — not just run it.

---

## Table of Contents

1. [What this backend does](#what-this-backend-does)
2. [Repository layout](#repository-layout)
3. [Two-chain topology](#two-chain-topology)
4. [Authentication system](#authentication-system)
5. [0G Storage layer](#0g-storage-layer)
6. [0G Data Availability layer](#0g-data-availability-layer)
7. [0G Chain anchoring](#0g-chain-anchoring)
8. [0G Compute anti-cheat](#0g-compute-anti-cheat)
9. [Background pipeline](#background-pipeline)
10. [MongoDB data model](#mongodb-data-model)
11. [API surface](#api-surface)
12. [Trust score algorithm](#trust-score-algorithm)
13. [UX endpoints and what they surface](#ux-endpoints-and-what-they-surface)
14. [Retry and resilience design](#retry-and-resilience-design)
15. [Contract design and security](#contract-design-and-security)
16. [Environment configuration](#environment-configuration)
17. [Startup and request lifecycle](#startup-and-request-lifecycle)
18. [Production considerations](#production-considerations)

---

## What this backend does

ZeroDash is a browser game. Players accumulate coins and unlock things while playing. At the end of a session (or on demand), their progress gets saved.

The original backend saved that progress to MongoDB. That is fine for a centralized game, but this backend replaces and extends it. Instead of MongoDB being the source of truth, the game save data lives on 0G's decentralized network — a storage layer that is content-addressed, a data availability layer that proves the data was published, and a chain that anchors the root hash on-chain so it is tamper-evident.

MongoDB still exists here, but it holds metadata pointers, not game data. The game data itself goes to 0G Storage. The receipt that the data was published goes to 0G DA. The root hash of the save file gets written to a smart contract on 0G's EVM. An optional anti-cheat layer sends the save to 0G Compute for TEE-verified analysis.

This separation matters because:
- An operator who controls the server cannot silently modify saves. The root hash is on-chain, and anyone can download the file and verify it matches.
- A save that made it through DA finalization has a BLS signature from the DA committee — it cannot be forged or retroactively replaced.
- TEE compute validation is performed inside a hardware-attested enclave, so not even the backend operator can influence the anti-cheat verdict.

---

## Repository layout

```
zerodash-0g-backend/
│
├── contracts/
│   └── PlayerSaveAnchor.sol        The on-chain anchor contract. Stores root hashes.
│
├── docs/
│   ├── architecture.md             High-level system architecture overview
│   ├── api.md                      API reference with request/response shapes
│   ├── deployment.md               Developer setup and deployment guide
│   └── documents.md                This file — complete reference
│
├── protos/
│   └── disperser.proto             gRPC schema for the 0G DA disperser service
│
├── scripts/
│   └── deploy.js                   Hardhat deploy script for PlayerSaveAnchor
│
├── hardhat.config.js               Hardhat config pointing at 0G Newton testnet
│
├── package.json
│
└── src/
    ├── server.js                   Express entry point, CORS, route mounting
    │
    ├── config/
    │   └── db.js                   Mongoose connection
    │
    ├── middleware/
    │   └── auth.js                 JWT verification, raw-wallet rejection
    │
    ├── models/
    │   ├── Player.js               Existing player profile (coins, highScore, etc.)
    │   ├── PlayerSaveRecord.js     0G metadata index — root hashes, DA receipts, trust
    │   └── AuthNonce.js            Single-use nonces for SIWE login, auto-TTL 5 min
    │
    ├── services/
    │   ├── ZeroGStorage.js         Upload/download binary files to 0G Storage
    │   ├── ZeroGDA.js              Publish commitments to 0G DA via gRPC
    │   ├── ZeroGChain.js           Interact with PlayerSaveAnchor on-chain
    │   └── ZeroGCompute.js         Call 0G Compute API for TEE anti-cheat
    │
    ├── utils/
    │   └── retry.js                Exponential backoff wrapper used across services
    │
    ├── blockchain/
    │   ├── sessionService.js       0G Mainnet session contract (chainId 16661)
    │   └── leaderboardService.js   0G Mainnet leaderboard contract (chainId 16661)
    │
    ├── controllers/
    │   ├── player.controller.js    Legacy endpoints + dual-write to 0G Storage
    │   ├── zgController.js         Native 0G save/load endpoints and pipeline
    │   ├── authController.js       SIWE nonce generation and signature login
    │   └── zgUXController.js       Dashboard, activity feed, proof, badge, explorer
    │
    └── routes/
        ├── authRoutes.js           /auth/nonce and /auth/login
        ├── profileRoutes.js        /player/save, /player/load, /player/verify
        ├── zgUXRoutes.js           /0g/dashboard, /0g/activity, etc.
        └── player.routes.js        Legacy /player/ routes (unchanged from original)
```

---

## Two-chain topology

The backend talks to two completely separate EVM-compatible blockchains.

**0G Newton Testnet — chainId 16600**

This is where the PlayerSaveAnchor contract lives. Every time a player saves, the backend sends a transaction to this contract that records:
- The player's wallet address
- Their save index (monotonically increasing)
- The root hash of the save file (a Merkle root over the file content)
- A timestamp

This chain uses the `ethers-v6` package alias. All 0G-specific services import from `require("ethers-v6")` to make it explicit.

RPC endpoint: `https://evmrpc.0g.ai` (configured in `ZG_RPC_URL`)
The backend sends transactions signed with `ZG_PRIVATE_KEY`.

**0G Mainnet — chainId 16661**

This is where the session tracking and leaderboard contracts live. These were deployed before this backend was written, so this code only calls into them — it does not deploy or modify them. These services use the top-level `ethers` package (which is also v6, but kept distinct by convention).

The session contract records when a player starts and ends a gaming session. The leaderboard contract records periodic snapshots of top players.

Both chains are 0G infrastructure. They are EVM-compatible, so standard ethers.js works with them. They are not Ethereum — they have their own native token (A0GI), their own block times, and their own faucet at `https://faucet.0g.ai`.

**Why two separate ethers imports?**

The 0G Storage SDK (`@0gfoundation/0g-storage-ts-sdk`) is an ESM module. It bundles its own ethers-like utilities. To avoid version conflicts with that SDK and to keep the chain-16600 and chain-16661 code paths visually distinct in the source, the project uses the `ethers-v6` alias for Newton testnet interactions and the top-level `ethers` for mainnet interactions. Both resolve to ethers v6, but the explicit aliasing makes the code easier to audit.

---

## Authentication system

The original backend had an auth hole: it accepted raw Ethereum wallet addresses as Bearer tokens. Because wallet addresses are public, anyone who knew your address could pass `Authorization: Bearer 0x1234...` and get authenticated as you. This is not authentication — it is a lookup.

The current auth system is a Sign-In With Ethereum (SIWE) pattern.

### How it works

**Step 1 — Nonce request**

The client calls `GET /auth/nonce?wallet=0x...`. The server:
1. Validates the address format (must be a valid 20-byte hex address)
2. Deletes any existing nonce for that wallet (prevents nonce accumulation)
3. Generates 16 random bytes using `crypto.randomBytes(16).toString("hex")`
4. Saves the nonce to MongoDB via the `AuthNonce` model
5. Returns the nonce and the exact message the client must sign

The nonce model uses a TTL index (`expires: 300` on `createdAt`) so MongoDB automatically deletes it after 5 minutes. This limits replay windows.

**Step 2 — Client signs**

The client signs the returned message with their private key using their wallet software (MetaMask, etc.). This produces a 65-byte signature. No transaction is sent — this is an off-chain message signature.

The message is a fixed-format string:
```
Sign in to ZeroDash

Wallet: 0x...
Nonce: <random hex>
Issued At: <ISO timestamp>

Signing this message grants access to ZeroDash only.
It will not trigger a blockchain transaction or cost gas fees.
```

The last two lines exist to make the message human-readable in the wallet's signing prompt. A user who reads it can confirm they are signing into ZeroDash and not authorizing a transaction.

**Step 3 — Login**

The client calls `POST /auth/login` with `{ wallet, signature }`. The server:
1. Loads the nonce from MongoDB for that wallet
2. Immediately deletes it (the nonce is now invalid, even if this request fails)
3. Reconstructs the exact same message string using the stored `nonce` and `issuedAt`
4. Calls `ethers.verifyMessage(message, signature)` which recovers the signing address
5. Compares the recovered address to the claimed wallet address (case-insensitive)
6. If they match, issues a JWT signed with `BROWSER_JWT_SECRET`, expiring in 7 days

The JWT payload contains `{ wallet: "0x..." }`. Every protected endpoint extracts this from the token.

**Why this is secure**

The nonce is random and single-use. The signature proves the client controls the private key for the claimed wallet address. The server reconstructs the message independently — the client cannot tamper with the nonce or timestamp after the fact. `ethers.verifyMessage` does ECDSA signature recovery and returns the actual signer's address. If the signature is invalid or was made over a different message, the recovered address will not match.

### JWT verification middleware

`src/middleware/auth.js` handles all protected routes.

It checks the Authorization header for `Bearer <token>`. If the token matches the pattern of a raw Ethereum address (`/^0x[0-9a-fA-F]{40}$/`), it returns a 401 with step-by-step instructions explaining how to get a real JWT. This is both a security rejection and a helpful developer error message.

Otherwise it calls `jsonwebtoken.verify(token, process.env.BROWSER_JWT_SECRET)` and attaches `req.walletAddress` from the decoded payload.

Some endpoints accept an alternative: `{ wallet }` in the request body (for browser clients that send the wallet in the JSON body alongside a JWT). The middleware checks both paths.

---

## 0G Storage layer

`src/services/ZeroGStorage.js`

0G Storage is a decentralized file store. Files are addressed by their Merkle root hash. Once uploaded, a file can be downloaded from any storage node that has it, and the content can be verified by recomputing the Merkle tree.

### SDK constraint

The `@0gfoundation/0g-storage-ts-sdk` is an ESM-only package in a CommonJS codebase. It cannot be `require()`d directly. All calls to it go through `await import(...)` inside async functions. This is why the service file uses the pattern:

```javascript
const { ZgFile, getIndexer } = await import("@0gfoundation/0g-storage-ts-sdk");
```

This is non-negotiable. If anything tries to `require` the SDK directly, it will throw `ERR_REQUIRE_ESM`. The dynamic import resolves at runtime after the module system is ready.

### Singleton indexer

The 0G Storage SDK requires an `Indexer` object that is initialized with the storage node endpoint (`ZG_INDEXER_RPC`) and the operator wallet (`ZG_PRIVATE_KEY`). Creating this object involves connecting to the storage network.

The service holds a module-level `_indexer` variable. On first use, `getIndexer()` initializes it and caches it. Subsequent calls return the cached instance, avoiding repeated connection setup.

**Resilience design:** If any upload or download fails, `_indexer` is reset to `null` before the error is re-thrown. This forces a fresh initialization on the next attempt rather than reusing a potentially broken connection. This is the fix for the "fragile singleton" feedback — without the reset, a transient network failure would permanently break the service until the process restarted.

### Upload flow

`uploadBuffer(buffer)` takes a `Buffer` of binary data (a msgpack-encoded player profile or a Unity binary save).

1. Writes the buffer to a temp file (`os.tmpdir()` + random suffix)
2. Calls `ZgFile.fromFilePath(tmpPath)` to let the SDK compute the Merkle tree
3. Calls `indexer.upload(zgFile, storageRpc, { ...opts })` which uploads to the storage network
4. Returns `{ rootHash, size }` — the root hash is the content address; store it for future downloads
5. Always deletes the temp file in a `finally` block

The entire flow is wrapped in `withRetry` with 3 attempts and 4-second base delay.

### Download flow

`downloadToBuffer(rootHash)` retrieves a file by its Merkle root hash.

1. Creates a temp file path for the download target
2. Calls `indexer.download(rootHash, tmpPath, { withProof: true })` — the `withProof` flag causes the SDK to verify the Merkle proof during download, ensuring the content matches the root hash
3. Reads the downloaded file into a buffer
4. Returns the buffer
5. Always deletes the temp file

Also wrapped in `withRetry` with the same parameters.

### Why temp files instead of in-memory streams?

The 0G Storage SDK works with file paths, not streams or buffers. It needs to seek through the file to build the Merkle tree. Using `os.tmpdir()` is the correct approach — it is a standard, writable location on all platforms.

---

## 0G Data Availability layer

`src/services/ZeroGDA.js`

Data Availability (DA) is a different guarantee than storage. 0G Storage tells you "the file exists and has this root hash." 0G DA tells you "this data was published to the network and the DA committee signed off on it" — a BLS threshold signature from a committee of validators.

DA finality is important for trustless verification: if someone disputes that a save file was published at a particular time, the DA receipt proves it was broadcast to the network, not just held privately by the server.

### gRPC transport

0G DA exposes a gRPC service at `disperser-testnet.0g.ai:51001`. The service definition is in `protos/disperser.proto`. The backend uses `@grpc/proto-loader` to load the proto at runtime and `@grpc/grpc-js` to create the channel.

The channel uses `grpc.credentials.createInsecure()` — plaintext gRPC, no TLS. This is how the 0G testnet disperser is configured. Do not attempt to use TLS credentials here; it will fail.

### Publishing a commitment

`publishCommitment(buffer, metadata)` is the entry point.

1. Loads the proto and creates a gRPC client if not already cached
2. Calls `DisperseBlob` with the raw bytes
3. Gets back a `requestId` immediately
4. Polls `GetBlobStatus(requestId)` every 5 seconds
5. When status returns `FINALIZED` (status code 3), extracts the `BlobVerificationProof`
6. Returns a structured receipt with `requestId`, `batchId`, `blobIndex`, `batchHeaderHash`, `referenceBlockNumber`, `finalizedAt`

The timeout is 120 seconds. If finalization has not happened by then, the function throws. In production, this is handled gracefully — the save is already safe in 0G Storage and MongoDB, so a DA timeout only means `daStatus` will be `pending` rather than `finalized`. The `GET /player/verify` endpoint can retroactively check and update these.

### Why run DA at all?

A player's save is in 0G Storage. That proves the content exists. But without DA, the server could claim to have published a save and then quietly replace it later. DA finality provides a time-stamped, committee-attested proof that the data existed at a specific block height. This is what makes the save history auditable by a third party.

---

## 0G Chain anchoring

`src/services/ZeroGChain.js`

The anchor step puts the save's root hash on-chain. Once written, it cannot be changed. This is the layer that makes save tampering detectable: if a server operator modified a save, the stored file's root hash would change, and it would no longer match what is on-chain.

### PlayerSaveAnchor contract

The contract is deployed on 0G Newton Testnet (chainId 16600). Its address is in `ZG_ANCHOR_CONTRACT_ADDRESS`.

The key storage structure is:

```solidity
struct SaveRecord {
    uint256 saveIndex;
    bytes32 rootHash;
    uint256 timestamp;
    bool exists;
}
mapping(address => SaveRecord) public latestSave;
```

Only the `backendOperator` (set immutably at deploy time) can call `anchorSave`. Players can call it for their own wallet, but the backend is the expected caller.

### Anti-rollback mechanism

The contract enforces that saves are monotonically increasing:

```solidity
require(
    !current.exists || saveIndex > current.saveIndex,
    "SaveIndex must be greater than current"
);
```

The `exists` flag is critical. If the check were `saveIndex == 0` to detect a "first save," an attacker could re-submit saveIndex 0 for a wallet that already has saves, bypassing the rollback check. The `bool exists` flag makes this impossible — once a wallet has any save, all future saves must have a strictly higher index.

### The `anchorSave` call

`ZeroGChain.anchorSaveHash(wallet, saveIndex, rootHash)`:

1. Loads the contract ABI and creates an ethers-v6 `Contract` instance
2. Signs and sends the `anchorSave(wallet, saveIndex, rootHash)` transaction
3. Waits for 1 confirmation
4. Returns `{ txHash, blockNumber, gasUsed }`

This is wrapped in `withRetry` in the controller, with 3 attempts and 5-second base delay. Gas failures and nonce errors can cause transient failures — the retry handles them.

### Reading from the contract

`ZeroGChain.getLatestAnchor(wallet)` calls the `getLatestSave(address)` view function, which returns the current `SaveRecord` for that wallet. This is used in verification flows and the UX endpoints.

---

## 0G Compute anti-cheat

`src/services/ZeroGCompute.js`

0G Compute is a TEE (Trusted Execution Environment) inference service. The backend sends the player's current and previous save to an AI model running inside a hardware-attested enclave. The enclave cannot be tampered with, even by the machine operator.

The compute API is OpenAI-compatible (same request format, same response format) but adds `verify_tee: true` to the request, which instructs the service to run the inference inside a TEE and return an attestation in the response.

### When anti-cheat fires

Anti-cheat is only triggered when saves show suspicious deltas:
- `coinDelta > 100` — more than 100 coins gained in one save
- OR `saveIndexDelta > 1` — save index jumped by more than 1 (skipped a save)

Normal gameplay stays under these thresholds. This avoids burning compute budget on routine saves.

Anti-cheat also only runs if `ZG_COMPUTE_API_KEY` is set. If the key is absent, the step is skipped entirely and the save is marked `computeSkipped: true`.

### Replay attack prevention

Each compute call includes the current save's `rootHash` in the prompt. The inference response binds to this hash. If someone tries to replay an old anti-cheat validation on a new save, the rootHash in the TEE response won't match the new save's rootHash — the validation is rejected.

### TEE attestation

The response includes a `teeVerified: true` field and a `providerAddress` — the address of the TEE provider. This can be verified on-chain against the 0G Compute registry. The `chatId` returned in the response is a persistent identifier for the billing session.

### Compute verdict structure

```javascript
{
  valid: true,
  confidence: 0.94,
  flags: [],
  verdict: "PASS",
  rootHash: "<current save root hash>",
  teeVerified: true,
  providerAddress: "0x...",
  chatId: "...",
  billingCost: "0.001",
  validatedAt: "<ISO timestamp>"
}
```

`flags` is an array of strings like `["RAPID_COIN_GAIN", "IMPOSSIBLE_SCORE"]` when something looks wrong. `confidence` is the model's confidence in the verdict.

---

## Background pipeline

`src/controllers/zgController.js` — `runBackgroundPipeline()`

When a player saves, the HTTP response is sent immediately after writing to MongoDB and 0G Storage. The response includes the rootHash and saveIndex so the client has what it needs. Then, after the response, the pipeline continues.

```javascript
res.status(201).json({ rootHash, saveIndex, ... });

setImmediate(() => runBackgroundPipeline(wallet, saveIndex, rootHash, buffer, saveRecord));
```

`setImmediate` defers execution until after the current event loop iteration (and after the response is flushed). It is not `setTimeout(fn, 0)` — it runs before I/O callbacks but after the current execution context clears.

### Pipeline stages

```
1. DA publish     — submitBlob → poll until FINALIZED → store receipt
2. Chain anchor   — send anchorSave transaction → wait for confirmation
3. Anti-cheat     — if delta suspicious → call 0G Compute → store verdict
```

Each stage updates `PlayerSaveRecord` in MongoDB with its results. The `daStatus` field tracks `pending → finalized` (or `failed`). The `anchorTxHash` field is populated after the chain step. The `computeValidation` sub-document is populated after the anti-cheat step.

### Failure isolation

If DA fails, the anchor and anti-cheat steps still run. If the anchor fails, anti-cheat still runs. Each stage catches its own errors, logs them, and continues. A failure in one stage does not cancel the others. The save itself is always safe — it was written to MongoDB and 0G Storage synchronously, before the pipeline started.

### Why `setImmediate` instead of a job queue?

A proper job queue (Bull, Agenda) would survive process restarts. The current approach does not — if the server crashes mid-pipeline, the in-flight operations are lost. This is an accepted tradeoff for the current stage. The save data is safe; only the metadata (DA status, tx hash) may be incomplete. The `GET /player/verify` endpoint exists to retroactively query and update these fields.

For production at scale, these should move to a queue. But introducing a queue dependency (Redis, etc.) was out of scope for the current implementation.

---

## MongoDB data model

### Player model (`src/models/Player.js`)

This is the existing model from the original backend. It stores the player's in-game profile:
- `walletAddress` — the player's Ethereum wallet (unique, indexed)
- `coins` — current coin balance
- `highScore` — all-time high score
- `unlockedItems` — array of item IDs
- `lastSaved` — timestamp of last save

This collection is written to by both the legacy routes and the new 0G routes. Writes from both paths are additive — they do not conflict.

### PlayerSaveRecord model (`src/models/PlayerSaveRecord.js`)

This is new. It stores metadata about each decentralized save — never the actual game data.

Key fields:
```
walletAddress         — indexed, the player
saveIndex             — monotonically increasing per wallet
rootHash              — Merkle root of the save file in 0G Storage
sha256Checksum        — SHA-256 of the raw buffer, for quick integrity checks
sizeBytes             — file size
coinSnapshot          — coin balance at time of save (for leaderboard, not trust calculation)

daStatus              — "pending" | "finalized" | "failed"
daCommitment          — { requestId, batchId, blobIndex, batchHeaderHash, referenceBlockNumber, finalizedAt }

anchorTxHash          — the on-chain transaction that recorded this rootHash
anchorBlockNumber

computeValidation     — { valid, confidence, flags, verdict, rootHash, teeVerified, providerAddress, chatId, billingCost, validatedAt }
computeSkipped        — true when anti-cheat threshold not met or API key absent

savedAt
```

**Compound index:** `{ walletAddress: 1, saveIndex: -1 }` — this covers the most common queries: "get all saves for wallet X, newest first" and "get save N for wallet X."

**Leaderboard index:** `{ coinSnapshot: -1 }` — used by the verified leaderboard query which sorts by coin balance.

### AuthNonce model (`src/models/AuthNonce.js`)

Single-use login nonces.

```
wallet      — indexed, the requesting wallet
nonce       — 32-character random hex
createdAt   — TTL index, MongoDB deletes documents 300 seconds after creation
```

The TTL index means nonces expire automatically without any cron job or cleanup code. MongoDB's internal TTL monitor runs every 60 seconds, so nonces actually expire within 5–6 minutes.

---

## API surface

### Authentication

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| GET | `/auth/nonce` | None | Get a nonce + message to sign |
| POST | `/auth/login` | None | Submit signature, receive JWT |

### Save / Load

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| POST | `/player/save/binary` | JWT | Upload binary save to 0G Storage |
| GET | `/player/load/binary` | JWT | Download save from 0G Storage |
| GET | `/player/save/metadata` | None | Get save metadata for wallet |
| GET | `/player/verify` | None | Re-check DA and anchor status |
| GET | `/player/leaderboard/decentralized` | None | Top players by coinSnapshot |

### UX / Display

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| GET | `/0g/dashboard` | JWT | Full stats + trust score + pipeline summary |
| GET | `/0g/activity` | JWT | Paginated event timeline |
| GET | `/0g/proof/:wallet/:saveIndex` | None | Shareable cryptographic proof for one save |
| GET | `/0g/badge` | JWT | Trust badge with score breakdown |
| GET | `/0g/network` | None | Live health of all 0G services |
| GET | `/0g/leaderboard/verified` | None | Leaderboard with verification badges |
| GET | `/0g/explorer/:wallet` | None | Public profile with all save history |

### Legacy player routes

All existing `/player/` routes from the original backend remain unchanged. They are mounted after the new routes, so any route that exists in both is handled by the new implementation.

### Utility

| Method | Path | Description |
|--------|------|-------------|
| GET | `/` | Ping |
| GET | `/blockchain-info` | Session and leaderboard contract status |
| GET | `/stats` | Aggregate counts |
| GET | `/contracts` | Contract addresses |

---

## Trust score algorithm

Every wallet has a trust score from 0 to 100. It is computed on demand from the wallet's `PlayerSaveRecord` documents. It is not stored in the database — computing it fresh ensures it reflects the current state.

### Components

**Base presence (10 points):** The wallet has at least one save. This is the minimum bar — it proves the wallet has actually used the system.

**DA finalization ratio (40 points):** `(finalizedSaves / totalSaves) × 40`. This rewards saves that completed DA finalization. A wallet with 10 saves all finalized gets the full 40 points. One DA failure out of 10 saves gives 36 points. This is the largest component because DA finality is the strongest cryptographic guarantee.

**On-chain anchor ratio (25 points):** `(anchoredSaves / totalSaves) × 25`. Anchored saves have a rootHash recorded on-chain. DA + anchored is the gold standard — both together mean the save is verifiable without trusting the server.

**TEE validation (15 points):** `(teeValidatedSaves / totalSaves) × 15`. Saves that passed through 0G Compute's TEE anti-cheat. Note that most saves will not trigger anti-cheat (the delta threshold filters them out), so this score is expected to be partial for most wallets. Full 15 points requires suspicious-looking saves that passed validation.

**Volume bonus (up to 10 points):** `min(totalSaves / 10, 1) × 10`. A small reward for consistent saving. 10 saves or more earns the full bonus. This prevents wallets that saved once from scoring artificially high.

### Tier thresholds

| Score | Tier |
|-------|------|
| 0–24 | BRONZE |
| 25–49 | SILVER |
| 50–80 | GOLD |
| 81–100 | PLATINUM |

### Why these weights?

DA (40 points) outweighs anchoring (25 points) because DA involves network consensus — a committee of validators signed off on the data. Anchoring is just a transaction from the backend operator. Both matter, but DA is harder to fake.

TEE validation (15 points) is intentionally the smallest component because it only fires on suspicious deltas. An honest player with normal coin gains would never trigger anti-cheat, so it would be unfair to weight it heavily.

---

## UX endpoints and what they surface

The UX endpoints exist because the underlying 0G infrastructure is invisible to players by default. These endpoints translate raw metadata into human-readable data.

### Dashboard (`GET /0g/dashboard`)

Returns a complete picture of the authenticated wallet:
- Total saves, total coins, highest score
- Trust score and tier
- Status of the latest save's pipeline (did DA finalize? is it anchored?)
- Preview of the 5 most recent events

This is designed to be displayed as a "My 0G Saves" panel in the game UI.

### Activity feed (`GET /0g/activity`)

Paginated timeline of events. Each save generates multiple event types:
- `SAVE_CREATED` — when the save was first uploaded
- `DA_FINALIZED` — when the DA committee signed off
- `ANCHOR_CONFIRMED` — when the on-chain tx confirmed
- `COMPUTE_VALIDATED` — when TEE anti-cheat ran

Events include timestamps, so a player can see the timeline of their save going through the pipeline.

### Proof (`GET /0g/proof/:wallet/:saveIndex`)

A shareable certificate for a specific save. Contains all cryptographic receipts:
- The rootHash (content address in 0G Storage)
- The DA batch receipt (batchId, blobIndex, batchHeaderHash)
- The on-chain anchor tx hash
- The TEE validation chatId and verdict

This can be shared as a URL. Anyone can verify the save independently using these receipts.

### Badge (`GET /0g/badge`)

The trust badge with a score breakdown. Shows each component score individually so a player can see exactly why they scored what they scored. Includes a "next level" hint explaining what to do to reach the next tier.

### Network status (`GET /0g/network`)

Live health check across all four 0G services:
- Storage: HTTP GET to the indexer RPC endpoint
- Chain: `eth_blockNumber` JSON-RPC call
- DA: configured or not (gRPC connectivity check would require a test blob — config presence is used as a proxy)
- Compute: API key present or not

This endpoint is unauthenticated so it can be used for monitoring dashboards and status pages.

### Verified leaderboard (`GET /0g/leaderboard/verified`)

Top players by `coinSnapshot`, filtered by verification level. The `?filter=` parameter accepts:
- `finalized` — only players whose latest save has DA finality
- `anchored` — only players whose latest save is anchored on-chain
- `validated` — only players whose latest save passed TEE anti-cheat
- `any` (default) — all players

Each entry includes a `verificationBadge` string that describes the highest verification level achieved. This lets the UI show different badge icons for different levels.

### Wallet explorer (`GET /0g/explorer/:wallet`)

Public profile for any wallet. Shows the trust badge, summary stats, and a list of all saves with pipeline stages. This is designed to be linked from leaderboard entries — click a player's name to see their save history.

---

## Retry and resilience design

`src/utils/retry.js`

```javascript
async function withRetry(fn, { maxAttempts = 3, baseDelayMs = 5000, label = "op" } = {})
```

The retry wrapper uses exponential backoff:
- Attempt 1 fails → wait `baseDelayMs × 1`
- Attempt 2 fails → wait `baseDelayMs × 2`
- Attempt 3 fails → throw the last error

This pattern is used in three places:

**ZeroGStorage.uploadBuffer** — 3 attempts, 4s base. Storage uploads are the most likely to fail transiently (network, indexer load). The singleton is reset on error so the next attempt reinitializes the connection.

**ZeroGStorage.downloadToBuffer** — same parameters.

**ZeroGChain.anchorSaveHash** — 3 attempts, 5s base. Chain transactions can fail due to nonce collisions (if two saves happen simultaneously) or RPC timeouts. The retry handles both.

**ZeroGDA.publishCommitment** — 2 attempts, 10s base. DA finalization is slow (15–60 seconds normally). Retrying too aggressively would double the timeout. Two attempts with a 10-second delay before the second is the right balance.

Anti-cheat does not have retry logic. If the compute call fails, the save is marked `computeSkipped: true`. Anti-cheat failures are not blocking — the save is still valid.

---

## Contract design and security

`contracts/PlayerSaveAnchor.sol`

The contract is minimal by design. It does one thing: record that a backend operator (the game server) vouches that a specific wallet's save at a specific index has a specific root hash.

### Storage structure

```solidity
struct SaveRecord {
    uint256 saveIndex;
    bytes32 rootHash;
    uint256 timestamp;
    bool exists;
}
mapping(address => SaveRecord) public latestSave;
```

Only the latest save is stored on-chain. Storing all historical saves would be prohibitively expensive. The rootHash is sufficient — anyone can retrieve the full save from 0G Storage using it, and the Merkle proof verifies integrity.

### Access control

```solidity
modifier onlyAuthorized(address wallet) {
    require(
        msg.sender == wallet || msg.sender == backendOperator,
        "Not authorized"
    );
    _;
}
```

Either the player themselves or the backend operator can anchor a save. This prevents a malicious third party from griefing a wallet by submitting a fake save with a higher index. A griefing attack would increment the saveIndex without a corresponding real save, locking the player out of future saves.

### Immutable operator

```solidity
address public immutable backendOperator;

constructor(address _backendOperator) {
    require(_backendOperator != address(0), "Invalid operator address");
    backendOperator = _backendOperator;
}
```

The `immutable` keyword in Solidity means the value is set at deploy time and baked into the contract bytecode. It cannot be changed by any subsequent transaction, including by the deployer. If the backend wallet is ever compromised, the only recourse is to deploy a new contract. This is a feature, not a limitation — it makes the trust model explicit.

### No upgradeable proxy

The contract is not upgradeable. No OpenZeppelin `Upgradeable`, no proxy pattern. This is intentional. An upgradeable contract means the deployer can change the rules at any time, which defeats the purpose of on-chain anchoring. The immutability of the contract is what makes the anchored hashes meaningful.

### Deployment

The contract is deployed via Hardhat, not Remix. The deploy script (`scripts/deploy.js`) uses `hre.ethers.getContractFactory("PlayerSaveAnchor")` which reads from the Solidity source file, compiles it, and deploys. This eliminates the copy-paste-bytecode workflow where human error can deploy the wrong version.

```bash
npm run deploy:anchor
# runs: npx hardhat run scripts/deploy.js --network 0g-newton
```

---

## Environment configuration

All configuration comes from environment variables loaded via `dotenv` at startup.

| Variable | Required | Description |
|----------|----------|-------------|
| `PORT` | No | Server port (default: 3001) |
| `NODE_ENV` | No | `development` or `production` |
| `MONGO_URI` | Yes | MongoDB connection string |
| `BROWSER_JWT_SECRET` | Yes | Secret for signing JWTs |
| `ZG_ENABLED` | No | Set `false` to disable all 0G operations |
| `ZG_RPC_URL` | Yes | 0G Newton Testnet RPC endpoint |
| `ZG_CHAIN_ID` | Yes | Should be `16600` |
| `ZG_INDEXER_RPC` | Yes | 0G Storage indexer endpoint |
| `ZG_DA_DISPERSER` | Yes | DA gRPC endpoint (`host:port`) |
| `ZG_PRIVATE_KEY` | Yes | Backend operator private key |
| `ZG_ANCHOR_CONTRACT_ADDRESS` | Yes | Deployed PlayerSaveAnchor address |
| `ZG_COMPUTE_API_KEY` | No | 0G Compute API key (anti-cheat optional) |
| `OG_MAINNET_RPC` | No | 0G Mainnet RPC (for session/leaderboard) |
| `PRIVATE_KEY` | No | Mainnet wallet (for session/leaderboard) |
| `SESSION_CONTRACT_ADDRESS` | No | Session tracking contract (16661) |
| `LEADERBOARD_CONTRACT_ADDRESS` | No | Leaderboard contract (16661) |

The startup log prints the status of every 0G variable so missing configuration is visible immediately on boot.

If `ZG_ENABLED=false`, all 0G service calls are skipped. The save is written only to MongoDB. This is useful for local development when you do not have a funded wallet.

---

## Startup and request lifecycle

### Startup sequence

1. `dotenv.config()` loads `.env`
2. `connectDB()` establishes MongoDB connection
3. Express app is created with CORS configuration
4. Routes are mounted in order: auth → 0G UX → 0G save/load → legacy
5. `app.listen()` starts the server
6. The startup banner logs all env var status and endpoint list

### Save request lifecycle

1. Client sends `POST /player/save/binary` with JWT and binary body
2. `auth.js` middleware verifies JWT → attaches `req.walletAddress`
3. `zgController.saveBinary()` runs synchronously:
   a. Msgpack-decodes the body to extract coin balance and save index
   b. Writes to MongoDB (`Player` + `PlayerSaveRecord`)
   c. Uploads buffer to 0G Storage → gets rootHash
   d. Sends `201 response` with rootHash and saveIndex
4. `setImmediate(() => runBackgroundPipeline(...))` schedules the pipeline
5. Pipeline runs asynchronously:
   a. DA publish (with retry)
   b. Updates `PlayerSaveRecord.daStatus`
   c. Chain anchor (with retry)
   d. Updates `PlayerSaveRecord.anchorTxHash`
   e. If delta suspicious: compute anti-cheat
   f. Updates `PlayerSaveRecord.computeValidation`

The client gets a response in the time it takes to write to MongoDB and 0G Storage (typically under a second on good connectivity). The pipeline completes in the background over the next 30–120 seconds.

### Load request lifecycle

1. Client sends `GET /player/load/binary` with JWT
2. Middleware verifies JWT → `req.walletAddress`
3. `zgController.loadBinary()`:
   a. Queries `PlayerSaveRecord` for the latest save for this wallet
   b. Downloads the buffer from 0G Storage using the saved rootHash
   c. Returns the buffer as `application/octet-stream`
   d. Sets response headers: `X-Root-Hash`, `X-Save-Index`, `X-Da-Status`, `X-Checksum-Sha256`

---

## Production considerations

**Process management:** The server has no graceful shutdown handler. In-flight pipeline tasks will be lost on SIGTERM. Under PM2 or systemd, this means `daStatus` and `anchorTxHash` may be incomplete for saves that were being processed at restart time. Use `GET /player/verify` to retroactively fill these in.

**Rate limits:** The default limits are conservative (10 saves/min, 30 loads/min per IP). These are defined in `routes/profileRoutes.js` using `express-rate-limit`. Adjust based on actual player counts.

**Wallet funding:** The `ZG_PRIVATE_KEY` wallet pays gas for every `anchorSave` transaction. Monitor its balance. Each save costs a small amount of A0GI. At scale (thousands of saves per day) this can add up.

**MongoDB indexes:** The `{ walletAddress: 1, saveIndex: -1 }` and `{ coinSnapshot: -1 }` indexes are defined in the schema. They are created automatically by Mongoose on first connection. No manual index creation needed.

**Secrets:** `BROWSER_JWT_SECRET` and `ZG_PRIVATE_KEY` must be strong secrets. The JWT secret should be at least 32 random bytes. The private key controls a wallet that signs on-chain transactions — treat it like a hot wallet key.

**CORS:** The allowed origins are hardcoded in `server.js`. Add your production domain to the `allowedOrigins` array before deploying.

**The `artifacts/` and `cache/` directories** are generated by Hardhat during contract compilation. They are in `.gitignore`. Do not commit them. They are regenerated by `npm run compile:contracts`.

**Upgrading the contract:** The `PlayerSaveAnchor` contract is immutable. If you need to change the logic, deploy a new contract, update `ZG_ANCHOR_CONTRACT_ADDRESS`, and decide what to do about existing save records. You cannot migrate on-chain state — the old contract's records stay in place. New saves will go to the new contract.
