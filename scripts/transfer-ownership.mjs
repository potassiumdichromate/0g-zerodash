/**
 * transfer-ownership.mjs
 *
 * Securely transfers ownership of an OpenZeppelin Ownable contract on 0G Mainnet.
 *
 * Usage:
 *   npm run transfer-ownership
 *
 * Required .env vars:
 *   OLD_PRIVATE_KEY    — private key of the CURRENT owner (compromised wallet)
 *   NEW_OWNER          — address of the new safe wallet that will own the contract
 *   CONTRACT_ADDRESS   — the contract to transfer (must implement owner() + transferOwnership())
 *
 * Safety guards:
 *   ✗ Aborts if contract does not have owner() — e.g. PlayerSaveAnchor (immutable backendOperator)
 *   ✗ Aborts if signer is not the current on-chain owner
 *   ✗ Aborts if NEW_OWNER is zero address
 *   ✗ Aborts if already the new owner (no-op)
 *   ✗ Aborts on wrong chain ID
 *   ✗ Aborts if gas estimation fails
 *   ✗ Verifies new owner on-chain after 2 confirmations
 *
 * Chain: 0G Mainnet — chainId 16661
 * Explorer: https://chainscan.0g.ai
 */

import 'dotenv/config';
import { ethers } from 'ethers';

// ── Constants ─────────────────────────────────────────────────────────────────

const EXPLORER          = 'https://chainscan.0g.ai';
const RPC_URL           = process.env.OG_MAINNET_RPC || 'https://evmrpc.0g.ai';
const EXPECTED_CHAIN_ID = 16661;

// Minimal Ownable ABI — only what we need
const OWNABLE_ABI = [
  'function owner() view returns (address)',
  'function transferOwnership(address newOwner)',
];

// ── Helpers ───────────────────────────────────────────────────────────────────

function fatal(msg) {
  console.error(`\n[FATAL] ${msg}\n`);
  process.exit(1);
}

function ok(msg) {
  console.log(`  ✔  ${msg}`);
}

function info(label, value) {
  console.log(`  ${label.padEnd(18)} ${value}`);
}

function requireEnv(name) {
  const v = process.env[name];
  if (!v || v.startsWith('0x_') || v.startsWith('0xyour') || v.trim() === '') {
    fatal(`${name} is not set or is still a placeholder.\n        Set a real value in .env before running.`);
  }
  return v.trim();
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main() {
  console.log('\n╔══════════════════════════════════════════════════════╗');
  console.log('║    Ownership Transfer Script — 0G Mainnet (16661)   ║');
  console.log('╚══════════════════════════════════════════════════════╝\n');

  // ── Step 1: Load env — never print key material ────────────────────────────

  const privateKey      = requireEnv('OLD_PRIVATE_KEY');
  const newOwnerRaw     = requireEnv('NEW_OWNER');
  const contractAddrRaw = requireEnv('CONTRACT_ADDRESS');

  // Validate addresses (ethers throws on bad input)
  if (!ethers.isAddress(newOwnerRaw)) {
    fatal(`NEW_OWNER="${newOwnerRaw}" is not a valid checksummed address.`);
  }
  if (!ethers.isAddress(contractAddrRaw)) {
    fatal(`CONTRACT_ADDRESS="${contractAddrRaw}" is not a valid checksummed address.`);
  }

  const newOwner     = ethers.getAddress(newOwnerRaw);
  const contractAddr = ethers.getAddress(contractAddrRaw);

  if (newOwner === ethers.ZeroAddress) {
    fatal('NEW_OWNER cannot be the zero address (0x000...000).\n        That would permanently brick the contract.');
  }

  // ── Step 2: Connect provider ───────────────────────────────────────────────

  const provider = new ethers.JsonRpcProvider(RPC_URL, {
    chainId: EXPECTED_CHAIN_ID,
    name:    '0g-mainnet',
  });

  let signer;
  try {
    signer = new ethers.Wallet(privateKey, provider);
  } catch {
    fatal('OLD_PRIVATE_KEY could not be parsed as a valid private key.\n        Check it is a 0x-prefixed 32-byte hex string.');
  }

  console.log('  Pre-flight checks:');
  info('RPC:', RPC_URL);
  info('Signer:', signer.address);
  info('Contract:', contractAddr);
  info('New owner:', newOwner);
  info('Explorer:', `${EXPLORER}/address/${contractAddr}`);
  console.log('');

  // ── Step 3: Verify we are on 0G Mainnet ────────────────────────────────────

  let network;
  try {
    network = await provider.getNetwork();
  } catch (err) {
    fatal(`Cannot reach RPC "${RPC_URL}":\n        ${err.message}`);
  }

  if (Number(network.chainId) !== EXPECTED_CHAIN_ID) {
    fatal(
      `Wrong chain ID ${network.chainId} — expected ${EXPECTED_CHAIN_ID} (0G Mainnet).\n` +
      `        Check OG_MAINNET_RPC in .env.`
    );
  }
  ok(`Chain ID: ${network.chainId} (0G Mainnet)`);

  // ── Step 4: Check contract has owner() ─────────────────────────────────────
  //
  // PlayerSaveAnchor uses an *immutable* backendOperator — NOT Ownable.
  // Calling owner() on it will revert. We catch that here and give clear
  // guidance on what to do instead (redeploy).

  const contract = new ethers.Contract(contractAddr, OWNABLE_ABI, signer);
  let currentOwner;

  try {
    currentOwner = await contract.owner();
  } catch {
    // Could not call owner() — almost certainly an immutable-backendOperator contract.
    console.error('\n[FATAL] owner() reverted on this contract.');
    console.error('        This contract does NOT use the Ownable pattern.');
    console.error('');
    console.error('        If this is PlayerSaveAnchor (ZG_ANCHOR_CONTRACT_ADDRESS),');
    console.error('        it stores the backend wallet as an *immutable* backendOperator');
    console.error('        set at construction time and permanently baked into the bytecode.');
    console.error('        There is no transferOwnership() — it cannot be changed.');
    console.error('');
    console.error('  ── How to rotate the PlayerSaveAnchor operator ────────────────────');
    console.error('  1. Prepare your new wallet and fund it with A0GI on 0G Mainnet.');
    console.error('  2. Set the new key in .env:');
    console.error('       ZG_PRIVATE_KEY=0x<new_safe_key>');
    console.error('  3. Redeploy the contract (it will use ZG_PRIVATE_KEY as new operator):');
    console.error('       npm run deploy:anchor');
    console.error('  4. Copy the printed address into .env:');
    console.error('       ZG_ANCHOR_CONTRACT_ADDRESS=0x<new_address>');
    console.error('  5. Restart the backend — it will anchor all future saves to the new contract.');
    console.error('');
    console.error('  ── The other contracts that DO have transferOwnership ──────────────');
    console.error(`  SESSION_CONTRACT    ${process.env.SESSION_CONTRACT_ADDRESS || '(not set in .env)'}`);
    console.error(`  LEADERBOARD_CONTRACT ${process.env.LEADERBOARD_CONTRACT_ADDRESS || '(not set in .env)'}`);
    console.error('  → Set CONTRACT_ADDRESS to each of these in turn and re-run this script.');
    console.error('');
    process.exit(1);
  }

  currentOwner = ethers.getAddress(currentOwner);
  info('On-chain owner:', currentOwner);

  // ── Step 5: Signer must be the current owner ───────────────────────────────

  if (signer.address.toLowerCase() !== currentOwner.toLowerCase()) {
    fatal(
      `Signer mismatch.\n` +
      `        Signer (OLD_PRIVATE_KEY): ${signer.address}\n` +
      `        On-chain owner:           ${currentOwner}\n` +
      `        OLD_PRIVATE_KEY must be the private key of the wallet that currently owns this contract.`
    );
  }
  ok('Signer matches on-chain owner');

  // ── Step 6: No-op guard ────────────────────────────────────────────────────

  if (newOwner.toLowerCase() === currentOwner.toLowerCase()) {
    fatal(
      `NEW_OWNER (${newOwner}) is already the current owner.\n` +
      `        Nothing to do. The contract is already under the new wallet's control.`
    );
  }
  ok(`New owner is different from current — transfer is not a no-op`);

  // ── Step 7: Estimate gas ───────────────────────────────────────────────────

  let gasEstimate;
  try {
    gasEstimate = await contract.transferOwnership.estimateGas(newOwner);
  } catch (err) {
    fatal(
      `Gas estimation failed.\n` +
      `        The contract at ${contractAddr} may not implement transferOwnership(address),\n` +
      `        or the call is reverting for another reason:\n` +
      `        ${err.message}`
    );
  }

  const gasLimit = (gasEstimate * 130n) / 100n; // +30 % safety buffer
  ok(`Gas estimate: ${gasEstimate.toLocaleString()} units  (limit: ${gasLimit.toLocaleString()} with 30 % buffer)`);

  // ── Step 8: Signer balance check ──────────────────────────────────────────

  const balance = await provider.getBalance(signer.address);
  const feeData = await provider.getFeeData();
  const minNeeded = gasLimit * (feeData.gasPrice ?? 1000000000n);
  if (balance < minNeeded) {
    fatal(
      `Signer balance too low.\n` +
      `        Balance:  ${ethers.formatEther(balance)} A0GI\n` +
      `        Needed:   ~${ethers.formatEther(minNeeded)} A0GI\n` +
      `        Fund ${signer.address} on 0G Mainnet (chainId 16661) before retrying.`
    );
  }
  ok(`Signer balance: ${ethers.formatEther(balance)} A0GI — sufficient`);

  // ── Step 9: Send transferOwnership() ──────────────────────────────────────

  console.log('\n  Sending transferOwnership()...');
  let tx;
  try {
    tx = await contract.transferOwnership(newOwner, { gasLimit });
  } catch (err) {
    fatal(`Transaction failed before broadcast:\n        ${err.message}`);
  }

  info('Tx hash:', tx.hash);
  info('Explorer:', `${EXPLORER}/tx/${tx.hash}`);
  console.log('\n  Waiting for 2 confirmations...');

  // ── Step 10: Wait for 2 confirmations ─────────────────────────────────────

  let receipt;
  try {
    receipt = await tx.wait(2);
  } catch (err) {
    fatal(
      `Transaction may have reverted or network timed out.\n` +
      `        Check: ${EXPLORER}/tx/${tx.hash}\n` +
      `        Error: ${err.message}`
    );
  }

  if (!receipt || receipt.status !== 1) {
    fatal(
      `Transaction mined but status = 0 (REVERTED).\n` +
      `        Check: ${EXPLORER}/tx/${tx.hash}`
    );
  }
  ok(`Confirmed — block ${receipt.blockNumber}  (${receipt.confirmations} confirmations)`);

  // ── Step 11: Re-read and assert new owner on-chain ────────────────────────

  console.log('\n  Verifying new owner on-chain...');
  const verifiedOwner = ethers.getAddress(await contract.owner());

  if (verifiedOwner.toLowerCase() !== newOwner.toLowerCase()) {
    fatal(
      `Post-transfer verification FAILED.\n` +
      `        Expected: ${newOwner}\n` +
      `        Got:      ${verifiedOwner}\n` +
      `        The transfer may not have taken effect. Check: ${EXPLORER}/tx/${tx.hash}`
    );
  }
  ok(`On-chain owner is now: ${verifiedOwner}`);

  // ── Done ───────────────────────────────────────────────────────────────────

  console.log('\n╔══════════════════════════════════════════════════════╗');
  console.log('║        ✅  Ownership transferred successfully!       ║');
  console.log('╚══════════════════════════════════════════════════════╝');
  console.log('');
  info('Contract:', contractAddr);
  info('Old owner:', signer.address);
  info('New owner:', verifiedOwner);
  info('Tx hash:', tx.hash);
  info('Explorer:', `${EXPLORER}/tx/${tx.hash}`);

  console.log(`
  ── Mandatory next steps ────────────────────────────────────────────────
  1. Update PRIVATE_KEY in .env (and any hosting env vars / CI secrets)
     to the NEW wallet's private key.
  2. Restart the backend server so it signs txs with the new key.
  3. REVOKE the compromised key everywhere immediately:
       • Render / Railway / Fly.io env vars
       • GitHub / CI secrets
       • Any other services that held the old key
  ── Other contracts that also need rotation ─────────────────────────────
  SESSION_CONTRACT     ${(process.env.SESSION_CONTRACT_ADDRESS || '(SESSION_CONTRACT_ADDRESS not set)').padEnd(44)} uses PRIVATE_KEY
  LEADERBOARD_CONTRACT ${(process.env.LEADERBOARD_CONTRACT_ADDRESS || '(LEADERBOARD_CONTRACT_ADDRESS not set)').padEnd(44)} uses PRIVATE_KEY
  ZG_ANCHOR_CONTRACT   ${(process.env.ZG_ANCHOR_CONTRACT_ADDRESS || '(ZG_ANCHOR_CONTRACT_ADDRESS not set)').padEnd(44)} uses ZG_PRIVATE_KEY (immutable — must REDEPLOY)
  ──────────────────────────────────────────────────────────────────────────
  For the Session + Leaderboard contracts:
    Set CONTRACT_ADDRESS=<address> in .env and run:  npm run transfer-ownership
  For ZG_ANCHOR_CONTRACT (PlayerSaveAnchor):
    Set ZG_PRIVATE_KEY=<new_key> in .env and run:    npm run deploy:anchor
    Then update ZG_ANCHOR_CONTRACT_ADDRESS with the new address.
  ──────────────────────────────────────────────────────────────────────────
`);
}

main().catch(err => {
  console.error(`\n[FATAL] Unexpected error: ${err.message}`);
  if (process.env.NODE_ENV === 'development') console.error(err.stack);
  process.exit(1);
});
