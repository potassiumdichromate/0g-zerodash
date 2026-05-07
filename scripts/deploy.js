/**
 * Hardhat deployment script for PlayerSaveAnchor.
 *
 * Replaces the old deployAnchor.js which required manually compiling in
 * Remix and copy-pasting raw bytecode. Hardhat compiles the contract
 * automatically from source before deploying.
 *
 * Usage:
 *   npx hardhat run scripts/deploy.js --network 0g-mainnet
 *
 * Prerequisites:
 *   - ZG_PRIVATE_KEY set in .env (this wallet becomes backendOperator)
 *   - OG_MAINNET_RPC set in .env (defaults to https://evmrpc.0g.ai)
 *   - Wallet funded with A0GI on 0G Mainnet (chainId 16661)
 *
 * After deploy:
 *   Copy the printed address into .env as ZG_ANCHOR_CONTRACT_ADDRESS
 */

const hre = require("hardhat");

async function main() {
  const [deployer] = await hre.ethers.getSigners();
  const balance    = await hre.ethers.provider.getBalance(deployer.address);

  console.log("");
  console.log("┌─────────────────────────────────────────────────────┐");
  console.log("│         PlayerSaveAnchor — Hardhat Deploy           │");
  console.log("└─────────────────────────────────────────────────────┘");
  console.log(`  Network:             ${hre.network.name}`);
  console.log(`  Deployer/Operator:   ${deployer.address}`);
  console.log(`  Balance:             ${hre.ethers.formatEther(balance)} A0GI`);
  console.log("");

  if (balance === 0n) {
    throw new Error(
      `Deployer wallet ${deployer.address} has no balance on 0G Mainnet.\n` +
      "Fund this wallet with A0GI on chainId 16661 before deploying."
    );
  }

  console.log("Compiling contracts...");
  await hre.run("compile");

  const Factory  = await hre.ethers.getContractFactory("PlayerSaveAnchor");
  const contract = await Factory.deploy(deployer.address);

  const deployTx = contract.deploymentTransaction();
  console.log(`\nTransaction sent: ${deployTx?.hash}`);
  console.log("Waiting for confirmation...");

  await contract.waitForDeployment();
  const address = await contract.getAddress();

  console.log("");
  console.log("✅ PlayerSaveAnchor deployed successfully");
  console.log(`   Address:      ${address}`);
  console.log(`   Operator:     ${deployer.address}  (immutable, cannot be changed)`);
  console.log(`   Explorer:     https://chainscan.0g.ai/address/${address}`);
  console.log("");
  console.log("Add to .env:");
  console.log(`   ZG_ANCHOR_CONTRACT_ADDRESS=${address}`);
  console.log("");
}

main().catch(err => {
  console.error("\n❌ Deploy failed:", err.message);
  process.exit(1);
});
