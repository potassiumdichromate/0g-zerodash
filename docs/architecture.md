# System Architecture

## What this backend actually does

ZeroDash is a React Native game where players log in with their wallet address. The backend used to be a straightforward Express + MongoDB setup — save coins, load profile, done. This new backend keeps all of that working exactly as before, but adds a parallel decentralized layer on top of it powered by 0G infrastructure.

The short version: every player save gets uploaded to 0G's decentralized storage network, gets a BLS-signed finality proof from 0G DA, gets an on-chain anchor on the 0G EVM, and optionally gets scanned by a TEE-verified anti-cheat model. The game client never feels any of this — it gets a 201 response immediately and the rest happens in the background.

---

## The two chains

This backend talks to two separate 0G networks and it's important not to confuse them.

**0G Mainnet (chainId 16661)** — this is where everything lives: the `PlayerSaveAnchor` contract, 0G Storage uploads, the session contract, and the leaderboard contract. All services in `src/services/` and `src/blockchain/` target this chain. The env vars are `OG_MAINNET_RPC` and `OG_MAINNET_CHAIN_ID`.

**0G DA Testnet** — the one exception. 0G Data Availability is only available on testnet at the moment. The gRPC disperser (`disperser-testnet.0g.ai:51001`) is testnet-only. Everything else is mainnet.

Same RPC URL (`https://evmrpc.0g.ai`) serves the mainnet, and DA runs separately over gRPC on its own testnet endpoint.

---

## The 0G infrastructure stack

There are four distinct 0G components in play. Here's what each one does and why we use it.

### 1. 0G Storage

0G Storage is a decentralized file storage network with Merkle-based integrity verification. It works a bit like IPFS but is write-finalized via the 0G EVM chain.

When a player hits `POST /player/save/binary`, the raw binary save file gets uploaded here. The upload returns a `rootHash` — this is the content-addressed identifier for the file, derived from the Merkle tree of its chunks. That root hash is the single identifier that threads through everything else in the pipeline.

The SDK (`@0gfoundation/0g-storage-ts-sdk` v1.2.9) ships a CommonJS build, so `ZeroGStorage.js` uses `require()` directly — no dynamic `import()` needed. The flow is:

```
Buffer → write to /tmp → ZgFile.fromFilePath() → merkleTree() → rootHash
                                                               ↓
                                              indexer.upload(file, evmRpc, signer)
                                                               ↓
                                                    txHash  +  file.close()
```

Key API details in v1.2.9: `new Indexer(indRpc)` takes only the indexer URL — the signer is passed per-call to `upload()`. `file.close()` must be called after use. Downloads use `indexer.download(rootHash, path, true)` where the third argument is the `withProof` boolean — the storage nodes return a Merkle inclusion proof to verify the content matches the root hash.

The Indexer is a singleton (`_indexer = null` at module scope). It is reset to `null` on any error so the next call re-initialises from scratch rather than reusing a broken connection. The signer singleton (`_signer`) is reset alongside it.

### 2. 0G DA (Data Availability)

0G DA is a BLS-based data availability layer. Its job is to attest that a piece of data was published and is available, producing a `BlobVerificationProof` that includes batch metadata, a Merkle inclusion proof, and quorum signatures.

We use DA to publish a save commitment — a small JSON payload containing the wallet address, rootHash, saveIndex, coinSnapshot, and timestamp. This isn't the game data itself (that's in Storage), it's a signed record proving the save event happened and was witnessed by the DA network.

The client is a gRPC connection to `disperser-testnet.0g.ai:51001`. The proto definition is in `protos/disperser.proto`. The two RPC methods we use:

- `DisperseBlob` — send the data, get back a `request_id`
- `GetBlobStatus` — poll with that `request_id` until status hits 3 (FINALIZED)

Polling happens every 5 seconds with a 120-second hard timeout. In practice, finalization on testnet takes somewhere between 10 and 45 seconds. If it hasn't finalized by 120s, `daStatus` gets set to `"failed"` in MongoDB and we move on — the save is still valid, just without a DA proof.

Status codes from the disperser:

```
0 = UNKNOWN
1 = PROCESSING
2 = ASSOCIATED
3 = FINALIZED   ← what we wait for
4 = FAILED
5 = INSUFFICIENT_SIGNATURES
6 = DISPERSING
7 = CONFIRMED
```

### 3. 0G EVM Chain (PlayerSaveAnchor)

Once we have a rootHash from Storage, we anchor it on-chain by calling `anchorSave(wallet, rootHash, saveIndex)` on the `PlayerSaveAnchor` contract deployed on 0G Mainnet (chainId 16661). This creates a permanent, immutable record that says "wallet X had save Y with this content at this block."

The contract is designed around two security requirements:

**Anti-rollback** — the contract maintains a `SaveRecord` per wallet with a `bool exists` flag. A new save is only accepted if `!current.exists || saveIndex > current.saveIndex`. Using `exists` is deliberate — if you tried to use `saveIndex == 0` as the "first save" sentinel, you'd have a bug where an attacker could re-anchor saveIndex 0 and overwrite the initial record.

**Anti-griefing** — `anchorSave` requires `msg.sender == wallet || msg.sender == backendOperator`. Without this, anyone could anchor arbitrary data for any wallet address. The `backendOperator` is set at deploy time and can never be changed (it's `immutable`).

The contract has no owner, no `onlyOwner` modifier, no upgrade proxy. It's intentionally minimal and permanent.

### 4. 0G Compute (TEE Anti-Cheat)

0G Compute routes inference requests through TEE (Trusted Execution Environment) providers, producing attestations that the model ran in a secure enclave and wasn't tampered with. We use this for anti-cheat validation on suspicious saves.

The API is OpenAI-compatible (`https://router-api.0g.ai/v1/chat/completions`) with an extra `verify_tee: true` flag. The response includes `tee_verified`, `provider_address`, and `billing_cost` fields beyond the standard OpenAI response shape.

Anti-cheat only fires when thresholds are crossed: `coinDelta > 100` OR `saveIndexDelta > 1`. Routine saves are skipped entirely (`computeStatus: "skipped"`).

The important security detail here is the **rootHash binding check**. The system prompt instructs the model to echo back the `rootHash` field from the input. After parsing the response, we verify `parsed.rootHash === rootHash`. If they don't match, we throw and reject the result. This prevents replay attacks where an attacker submits a clean save's compute result against a dirty save's data.

---

## Request flow: binary save

This is what happens, in order, when a player saves their game state as a binary blob.

```
Game client
    │
    ▼
POST /player/save/binary
(Content-Type: application/octet-stream)
    │
    ├─ auth middleware: extract wallet from JWT → req.walletAddress
    │
    ├─ rate limiter: 10 requests/minute per IP
    │
    ├─ anti-rollback check: fetch latest saveIndex from MongoDB
    │   └─ if clientSaveIndex <= latestSaveIndex → 409, stop here
    │
    ├─ ZeroGStorage.uploadBuffer(buffer)
    │   └─ write tmp file → ZgFile → merkleTree → rootHash
    │      └─ indexer.upload() → txHash
    │
    ├─ PlayerSaveRecord.create({ rootHash, txHash, saveIndex, coinSnapshot, ... })
    │
    ├─ res.status(201).json({ rootHash, saveIndex, txHash, checksum, fileSize })
    │                                         ← client gets response here
    │
    └─ setImmediate(() => runBackgroundPipeline())
            │
            ├─ ZeroGChain.anchorSaveHash(wallet, rootHash, saveIndex)
            │   └─ PlayerSaveRecord.update({ anchorTxHash })
            │
            ├─ ZeroGDA.publishCommitment({ wallet, rootHash, saveIndex, ... })
            │   └─ DisperseBlob → poll GetBlobStatus every 5s → FINALIZED
            │      └─ PlayerSaveRecord.update({ daStatus: "finalized", daCommitment })
            │
            └─ if coinDelta > 100 || saveIndexDelta > 1:
                ZeroGCompute.validateSave(saveInput, rootHash)
                └─ TEE inference → parse JSON → verify rootHash binding
                   └─ PlayerSaveRecord.update({ computeStatus, computeValidation })
```

The client gets its response in the time it takes to do a MongoDB read + one 0G Storage upload. Everything after the `setImmediate` is invisible to the game.

---

## MongoDB role

MongoDB is a metadata index, not the data store. It never holds actual game save data — that lives in 0G Storage addressed by its rootHash. What MongoDB holds is:

- The rootHash (pointer into 0G Storage)
- The txHash (0G Storage transaction)
- File size and SHA-256 checksum
- The saveIndex
- A coin snapshot at save time
- The on-chain anchor tx hash (filled in by background pipeline)
- DA commitment details — batchId, blobIndex, batchHeaderHash, referenceBlockNumber
- Compute verdict — valid/confidence/flags/verdict/teeVerified/providerAddress

When a player loads their save (`GET /player/load/binary`), we look up the latest `PlayerSaveRecord` by wallet address (sorted by saveIndex descending), get the rootHash, and fetch the file back from 0G Storage. MongoDB is never in the critical path for data integrity — it's just a fast lookup layer.

Two indexes exist beyond the default `_id`:
- `{ walletAddress: 1, saveIndex: -1 }` — for fast "latest save" lookups
- `{ coinSnapshot: -1 }` — for the decentralized leaderboard aggregate

---

## Dual-write from legacy endpoints

The existing `POST /player/save` JSON endpoint still works exactly as before. After it writes to MongoDB and responds, it calls `persistProfileTo0G` via `setImmediate`. That function msgpack-encodes the player profile, uploads it to 0G Storage, and kicks off the same background pipeline.

This means every save — whether the client uses the new binary endpoint or the old JSON one — ends up mirrored to 0G. The game client doesn't need to change anything.

```
POST /player/save (legacy JSON)
    │
    ├─ MongoDB update
    ├─ sessionService.saveSessionOnChain()
    ├─ res.json({ success: true })    ← response out
    │
    └─ setImmediate(() =>
           persistProfileTo0G(walletAddress, player, "game_save")
       )
           │
           └─ msgpack.encode(profile) → ZeroGStorage.uploadBuffer()
              → PlayerSaveRecord.create()
              → runBackgroundPipeline()
```

---

## Authentication model

Every protected endpoint sets `req.walletAddress` from the JWT middleware before anything else runs. The middleware handles two token formats:

**Browser JWT** — sent as `{ jwt: "...", source: "browser" }` in the request body. Verified with `BROWSER_JWT_SECRET`. The wallet is extracted from `payload.walletAddress`, `payload.address`, `payload.wallet`, or `payload.sub` — whichever is present.

**Bearer token** — sent as `Authorization: Bearer <JWT>`. The JWT is obtained from `POST /auth/login` after signing a server-issued nonce. Raw wallet addresses as Bearer tokens are rejected with 401.

The `X-Wallet-Address` header is never used for identity. It exists only as an informational response header sent back to the client.

---

## Environment split

```
ZG_ENABLED=false
```

Set this and the entire 0G pipeline becomes a no-op. Storage uploads return stub values, background pipelines skip, downloads return a placeholder buffer. The legacy MongoDB + blockchain (chainId 16661) paths still function normally. This is the right setting for local development when you don't want to spend testnet gas or wait for DA finality on every save.

When `ZG_ENABLED=true` but `ZG_COMPUTE_API_KEY` is not set, the storage + DA + anchor pipeline still runs. Compute just skips (`computeStatus: "skipped"`) and logs a note. Compute is the one optional layer — everything else is required for a fully verified save.

## Network summary

| Layer | Network | Chain ID | Key env var |
|---|---|---|---|
| Storage | 0G Mainnet | 16661 | `OG_MAINNET_RPC`, `ZG_INDEXER_RPC` |
| Chain (Anchor) | 0G Mainnet | 16661 | `OG_MAINNET_RPC`, `ZG_ANCHOR_CONTRACT_ADDRESS` |
| DA | 0G Testnet | — | `ZG_DA_DISPERSER` (testnet-only, stays testnet) |
| Compute | 0G Mainnet API | — | `ZG_COMPUTE_API_KEY` |
| Sessions/Leaderboard | 0G Mainnet | 16661 | `OG_MAINNET_RPC`, `PRIVATE_KEY` |
