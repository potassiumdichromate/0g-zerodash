/**
 * verify-helper.mjs
 *
 * Prints everything you need to verify PlayerSaveAnchor on chainscan.0g.ai.
 * Run this AFTER deploying the new contract.
 *
 * Usage:
 *   node scripts/verify-helper.mjs <deployerAddress> [contractAddress]
 *
 * Or set in .env:
 *   ZG_PRIVATE_KEY        — script derives the deployer address from this
 *   ZG_ANCHOR_CONTRACT_ADDRESS — the newly deployed contract address
 *
 * Example:
 *   node scripts/verify-helper.mjs 0xABC...123 0xDEF...456
 */

import 'dotenv/config';
import { ethers } from 'ethers';

const [,, argDeployer, argContract] = process.argv;

// Resolve deployer address — CLI arg > derived from ZG_PRIVATE_KEY env
let deployerAddress = argDeployer;
if (!deployerAddress) {
  const key = process.env.ZG_PRIVATE_KEY;
  if (!key || key.startsWith('0x_')) {
    console.error('[ERROR] Provide deployer address as first arg, or set ZG_PRIVATE_KEY in .env');
    process.exit(1);
  }
  try {
    deployerAddress = new ethers.Wallet(key).address;
  } catch {
    console.error('[ERROR] ZG_PRIVATE_KEY is not a valid private key');
    process.exit(1);
  }
}

if (!ethers.isAddress(deployerAddress)) {
  console.error(`[ERROR] "${deployerAddress}" is not a valid address`);
  process.exit(1);
}

const deployer     = ethers.getAddress(deployerAddress);
const contractAddr = argContract || process.env.ZG_ANCHOR_CONTRACT_ADDRESS || '(not set — check ZG_ANCHOR_CONTRACT_ADDRESS in .env)';

// ABI-encode the constructor arg: address _backendOperator
// This is what the explorer expects in the "Constructor Arguments" field
const encodedArg = ethers.AbiCoder.defaultAbiCoder()
  .encode(['address'], [deployer])
  .slice(2); // strip 0x prefix — explorer wants raw hex

console.log(`
╔═══════════════════════════════════════════════════════════════════════╗
║       PlayerSaveAnchor — Verification Inputs for chainscan.0g.ai     ║
╚═══════════════════════════════════════════════════════════════════════╝

  Contract address : ${contractAddr}
  Explorer URL     : https://chainscan.0g.ai/address/${contractAddr}

─── Compiler settings ──────────────────────────────────────────────────
  Compiler version : v0.8.20
  Optimization     : YES
  Optimization runs: 200
  EVM version      : default (paris)
  License          : MIT

─── Constructor argument (ABI-encoded) ─────────────────────────────────
  backendOperator  : ${deployer}
  Encoded (hex)    : ${encodedArg}

  ⚠  Paste ONLY the hex above (no 0x prefix) into the
     "Constructor Arguments ABI-encoded" field on the explorer.

─── Source code ────────────────────────────────────────────────────────
  File  : contracts/PlayerSaveAnchor.sol
  Action: Copy the full file contents and paste into the
          "Enter the Solidity Contract Code" field.

─── Step-by-step on chainscan.0g.ai ────────────────────────────────────
  1. Open: https://chainscan.0g.ai/address/${contractAddr}
  2. Click the "Contract" tab
  3. Click "Verify & Publish"
  4. Select:
       Compiler Type         → Solidity (Single file)
       Compiler Version      → v0.8.20+commit...  (pick the 0.8.20 entry)
       Open Source License   → MIT License (MIT)
  5. Click "Continue"
  6. Paste the full contents of contracts/PlayerSaveAnchor.sol
  7. Optimization → Yes  |  Runs → 200
  8. Constructor Arguments → paste the encoded hex above
  9. Click "Verify and Publish"
 10. If successful the "Contract" tab will show a green checkmark ✅
     and the source + ABI will be publicly readable.
`);
