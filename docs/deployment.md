# Developer Guide & Deployment

## Before you start

You need:
- Node.js 18 or later (the `@0gfoundation/0g-storage-ts-sdk` uses ESM dynamic imports that require it)
- MongoDB — local or Atlas, doesn't matter
- A funded wallet on 0G Newton Testnet (chainId 16600) for the `ZG_PRIVATE_KEY`
- A funded wallet on 0G Mainnet (chainId 16661) for the `PRIVATE_KEY` (only needed for session/leaderboard contracts, which are already deployed)

If you're just running locally and don't want to touch any 0G infrastructure, set `ZG_ENABLED=false` in your `.env` and skip the contract deploy entirely. The server will run fine — 0G operations will be stubbed.

Get testnet tokens: https://faucet.0g.ai

---

## Install

```bash
cd zerodash-0g-backend
npm install
```

The `ethers-v6` entry in `package.json` is an npm alias: `"ethers-v6": "npm:ethers@^6.13.0"`. This installs ethers v6 under the name `ethers-v6` so the 0G services can explicitly require it without ambiguity. You'll see it under `node_modules/ethers-v6`.

---

## Environment setup

Copy the example file and fill it in:

```bash
cp .env.example .env
```

Here's what each variable does:

```
PORT=3001
NODE_ENV=development
MONGO_URI=mongodb://localhost:27017/zerodash-0g
```
Standard stuff. Use a different DB name than your existing backend so they don't share collections.

```
BROWSER_JWT_SECRET=...
```
Must match whatever the game client uses to sign its JWTs. If you're running both backends side-by-side, they share this secret.

```
ZG_RPC_URL=https://evmrpc.0g.ai
ZG_CHAIN_ID=16600
```
Newton testnet. Don't change these unless 0G spins up a different testnet endpoint.

```
ZG_INDEXER_RPC=https://indexer-storage-turbo.0g.ai
```
The 0G Storage indexer. This is what the storage SDK connects to when uploading/downloading files.

```
ZG_DA_DISPERSER=disperser-testnet.0g.ai:51001
```
gRPC endpoint for the DA disperser. Port 51001, plaintext (no TLS on testnet).

```
ZG_PRIVATE_KEY=0x...
```
The backend operator wallet. This wallet signs storage uploads and calls `anchorSave` on the contract. It's also the address set as `backendOperator` in the contract at deploy time — that relationship is permanent.

```
ZG_ANCHOR_CONTRACT_ADDRESS=0x...
```
Set this after running the deploy script. See the contract deployment section below.

```
ZG_COMPUTE_API_KEY=
```
Optional. If blank, the compute anti-cheat layer is skipped entirely. Get a key from https://dashboard.0g.ai — you'll need to fund a compute account.

```
ZG_ENABLED=true
```
The master switch. `false` disables all 0G operations without breaking anything else.

```
OG_MAINNET_RPC=https://evmrpc.0g.ai
PRIVATE_KEY=0x...
SESSION_CONTRACT_ADDRESS=0x9D8090A0D65370A9c653f71e605718F397D1B69C
LEADERBOARD_CONTRACT_ADDRESS=0x...
```
These are for the existing session and leaderboard contracts on chainId 16661. The session contract address is already in the code as a default fallback, but set it explicitly in `.env` to be safe.

---

## Deploying the PlayerSaveAnchor contract

This only needs to happen once per environment (dev/staging/prod). The address is then hardcoded via `ZG_ANCHOR_CONTRACT_ADDRESS`.

**Step 1 — Compile the contract**

Go to https://remix.ethereum.org and create a new file. Paste the contents of `contracts/PlayerSaveAnchor.sol`.

Compiler settings:
- Solidity: `0.8.20`
- Optimization: ON, 200 runs
- EVM version: default (paris or later)

Click compile. In the "Compilation Details" panel, find the `BYTECODE` section and copy the `object` field value (the long hex string). It starts with `6080604052...` or similar.

**Step 2 — Run the deploy script**

```bash
ANCHOR_BYTECODE=0x6080604052... npm run deploy:anchor
```

The script reads `ZG_PRIVATE_KEY` and `ZG_RPC_URL` from your `.env`. It deploys the contract with your wallet address as the `backendOperator` argument, then prints the deployed address.

Output looks like:

```
┌─────────────────────────────────────────────────────┐
│        PlayerSaveAnchor Deployment                  │
└─────────────────────────────────────────────────────┘
   Network:             0G Newton (chainId 16600)
   RPC:                 https://evmrpc.0g.ai
   Deployer / Operator: 0xYourWalletAddress
   Balance:             1.42 A0GI

⏳ Transaction sent: 0xabc123...
   Waiting for confirmation...

✅ PlayerSaveAnchor deployed successfully!
   Address:     0x4f91ab...
   Explorer:    https://chainscan.0g.ai/address/0x4f91ab...

Add to .env:
   ZG_ANCHOR_CONTRACT_ADDRESS=0x4f91ab...
```

Copy that address into your `.env`.

**What the constructor does**

```solidity
constructor(address _backendOperator) {
    require(_backendOperator != address(0), "Invalid operator address");
    backendOperator = _backendOperator;
}
```

It sets `backendOperator` to the deployer's address as an `immutable` value. This cannot be changed after deployment. If you ever rotate your backend wallet, you'd need to redeploy the contract and migrate saves.

---

## Running the server

Development (with nodemon auto-restart):
```bash
npm run dev
```

Production:
```bash
npm start
```

On startup you'll see a config summary that shows which 0G env vars are set and which aren't:

```
╔═══════════════════════════════════════════════════════╗
║        🎮  ZeroDash 0G Backend Server  🎮            ║
╚═══════════════════════════════════════════════════════╝

🚀 Server running on port 3001
🌐 Environment: development

🔗 0G Infrastructure:
   ⛓️  RPC URL:      https://evmrpc.0g.ai
   🔢 Chain ID:     16600
   📦 Storage:      https://indexer-storage-turbo.0g.ai
   📡 DA Disperser: disperser-testnet.0g.ai:51001
   📜 Anchor:       0x4f91ab...
   🔑 Operator Key: ✅ Set
   🧠 Compute:      ⚠️  Skipped (ZG_COMPUTE_API_KEY not set)
   🚦 Enabled:      ✅ true
```

If you see `❌` next to any required var, fix it before testing.

---

## Running alongside the existing backend

The original `zerodashbackend` runs on port 3000. This one defaults to 3001. They can run simultaneously without conflict — they share the same MongoDB (if you point them at the same `MONGO_URI`) or use separate databases.

If you run them against the same MongoDB, note that both write to the `players` collection via the `Player` model. This is fine — saves are additive. The new backend adds a `PlayerSaveRecord` collection that the old backend never touches.

---

## Common issues

**`Cannot find module 'ethers-v6'`**

Run `npm install` from inside `zerodash-0g-backend/`, not from the parent directory. The alias is defined in this project's `package.json` only.

**`ZG_ANCHOR_CONTRACT_ADDRESS not set` thrown from ZeroGChain.js**

The anchor service throws on first use if the contract address isn't configured. Make sure you've deployed the contract and added the address to `.env`. If you're in dev mode and don't want the anchor step, set `ZG_ENABLED=false`.

**DA finalization timing out**

The 0G DA testnet occasionally has periods of slower finalization. The timeout is 120 seconds. If you're seeing consistent timeouts, check https://grafana.0g.ai for network status. The save is still valid — it just won't have a `daStatus: "finalized"` record. You can re-trigger verification later via `GET /player/verify`.

**`Error: Merkle tree error` from ZeroGStorage**

Usually means the tmp file write failed (disk space, permissions) or the file was deleted before the SDK could process it. Check `os.tmpdir()` is writable and has space. The tmp files are cleaned up in a `finally` block, so you shouldn't accumulate them.

**gRPC connection errors on DA**

`disperser-testnet.0g.ai:51001` uses plaintext gRPC (no TLS). If you're behind a corporate proxy that requires HTTPS for all outbound connections, the gRPC call will fail. In that environment you'd need to set up a local proxy or use a VPN.

**`ERR_REQUIRE_ESM` from 0G Storage SDK**

This happens if something tries to `require('@0gfoundation/0g-storage-ts-sdk')` directly instead of using `await import()`. The SDK is ESM-only. All calls to it in `ZeroGStorage.js` go through dynamic `import()` — don't change that, and don't try to require the SDK from other files.

**Anti-rollback 409 during testing**

If you're testing saves in a loop, the saveIndex increments permanently. You can't "reset" a wallet's saveIndex without deleting its `PlayerSaveRecord` documents from MongoDB. In dev:

```javascript
// in mongo shell or Compass
db.playersaverecords.deleteMany({ walletAddress: "0xyourwallet" })
```

---

## Production checklist

Before deploying to a production environment:

- `ZG_ENABLED=true` — obvious, but worth confirming
- `ZG_PRIVATE_KEY` — funded wallet, not the same as the dev key
- `ZG_ANCHOR_CONTRACT_ADDRESS` — deployed to the correct chain, verified on explorer
- `BROWSER_JWT_SECRET` — a real secret, not the default `dev-secret-change-me`
- `MONGO_URI` — pointing at the prod database, not localhost
- `NODE_ENV=production`
- `PORT` — behind a reverse proxy (nginx/caddy), not exposed directly
- Rate limits — the defaults (10 saves/min, 30 loads/min) are conservative. Adjust in `profileRoutes.js` based on actual traffic.
- The `ZG_PRIVATE_KEY` wallet needs enough A0GI balance to cover on-chain transactions. Each `anchorSave` call costs gas. Monitor the balance.

There's no graceful shutdown handler in the current server. If you're running under PM2 or systemd, the background pipeline tasks that are in-flight when the process exits will be lost. They won't corrupt anything — the save is already in MongoDB and 0G Storage — but `daStatus` and `anchorTxHash` won't be updated. You can verify integrity retroactively via `GET /player/verify`.

---

## Contract verification on the explorer

After deployment, verify the contract source on https://chainscan.0g.ai so anyone can read the code:

1. Go to your contract address on the explorer
2. Click "Contract" → "Verify & Publish"
3. Compiler: Solidity 0.8.20, optimization ON, 200 runs
4. Paste the source from `contracts/PlayerSaveAnchor.sol`
5. Constructor argument: your deployer wallet address, ABI-encoded as a 32-byte hex value

To ABI-encode the constructor arg:
```bash
node -e "
const { ethers } = require('ethers-v6');
const addr = '0xYourWalletAddress';
console.log(ethers.AbiCoder.defaultAbiCoder().encode(['address'], [addr]).slice(2));
"
```

---

## Project structure reference

```
zerodash-0g-backend/
├── contracts/
│   └── PlayerSaveAnchor.sol      compile in Remix, deploy via scripts/
│
├── docs/
│   ├── architecture.md           this is that file
│   ├── api.md                    endpoint reference
│   └── deployment.md             you are here
│
├── protos/
│   └── disperser.proto           gRPC schema for 0G DA
│
├── scripts/
│   └── deployAnchor.js           npm run deploy:anchor
│
└── src/
    ├── server.js                 entry point, CORS, route mounting
    ├── config/db.js              mongoose connect
    │
    ├── middleware/
    │   └── auth.js               JWT → req.walletAddress
    │
    ├── models/
    │   ├── Player.js             existing player profile schema
    │   └── PlayerSaveRecord.js   0G metadata index (no game data here)
    │
    ├── services/
    │   ├── ZeroGStorage.js       0G file upload/download
    │   ├── ZeroGDA.js            gRPC → DA disperser
    │   ├── ZeroGChain.js         PlayerSaveAnchor contract calls
    │   └── ZeroGCompute.js       TEE anti-cheat inference
    │
    ├── blockchain/
    │   ├── sessionService.js     existing 0G Mainnet session contract
    │   └── leaderboardService.js existing 0G Mainnet leaderboard contract
    │
    ├── controllers/
    │   ├── player.controller.js  legacy endpoints + dual-write
    │   └── zgController.js       all 0G-native endpoints
    │
    └── routes/
        ├── profileRoutes.js      0G routes (mounted first)
        └── player.routes.js      legacy routes (unchanged)
```
