/**
 * Deploy PlayerSaveAnchor to 0G EVM (chainId 16600).
 *
 * Steps:
 *   1. Compile PlayerSaveAnchor.sol in Remix IDE (remix.ethereum.org)
 *      Solidity compiler: 0.8.20 — Optimization: ON (200 runs)
 *   2. Copy the bytecode from the Remix "Compilation Details" panel
 *   3. Run:
 *        ANCHOR_BYTECODE=0x<bytecode> node scripts/deployAnchor.js
 *   4. Copy the printed contract address into .env as ZG_ANCHOR_CONTRACT_ADDRESS
 *
 * The deployer wallet (ZG_PRIVATE_KEY) becomes the immutable backendOperator.
 */

require("dotenv").config();
const { ethers } = require("ethers-v6");

// Minimal ABI for the constructor — full ABI lives in ZeroGChain.js
const CONSTRUCTOR_ABI = ["constructor(address _backendOperator)"];

async function main() {
  const bytecode = process.env.ANCHOR_BYTECODE;
  if (!bytecode) {
    console.error("❌ Set ANCHOR_BYTECODE=0x<bytecode> from Remix compile output");
    process.exit(1);
  }

  const privateKey = process.env.ZG_PRIVATE_KEY;
  if (!privateKey) {
    console.error("❌ Set ZG_PRIVATE_KEY in .env");
    process.exit(1);
  }

  const rpcUrl  = process.env.ZG_RPC_URL  || "https://evmrpc.0g.ai";
  const chainId = parseInt(process.env.ZG_CHAIN_ID || "16600");

  const provider = new ethers.JsonRpcProvider(rpcUrl, { chainId, name: "0g-newton" });
  const signer   = new ethers.Wallet(privateKey, provider);

  const balance = await provider.getBalance(signer.address);
  console.log("");
  console.log("┌─────────────────────────────────────────────────────┐");
  console.log("│        PlayerSaveAnchor Deployment                  │");
  console.log("└─────────────────────────────────────────────────────┘");
  console.log(`   Network:            0G Newton (chainId ${chainId})`);
  console.log(`   RPC:                ${rpcUrl}`);
  console.log(`   Deployer / Operator: ${signer.address}`);
  console.log(`   Balance:            ${ethers.formatEther(balance)} A0GI`);
  console.log("");

  if (balance === 0n) {
    console.error("❌ Deployer wallet has no balance. Fund it before deploying.");
    process.exit(1);
  }

  const factory  = new ethers.ContractFactory(CONSTRUCTOR_ABI, bytecode, signer);
  const contract = await factory.deploy(signer.address);

  console.log(`⏳ Transaction sent: ${contract.deploymentTransaction()?.hash}`);
  console.log("   Waiting for confirmation...");

  await contract.waitForDeployment();

  const address = await contract.getAddress();

  console.log("");
  console.log("✅ PlayerSaveAnchor deployed successfully!");
  console.log(`   Address:     ${address}`);
  console.log(`   Explorer:    https://chainscan.0g.ai/address/${address}`);
  console.log("");
  console.log("Add to .env:");
  console.log(`   ZG_ANCHOR_CONTRACT_ADDRESS=${address}`);
  console.log("");
}

main().catch(err => {
  console.error("Deploy failed:", err);
  process.exit(1);
});
