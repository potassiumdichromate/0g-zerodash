const Player = require("../models/Player");
const sessionService = require("../blockchain/sessionService");
const leaderboardService = require("../blockchain/leaderboardService");
const { persistProfileTo0G } = require("./zgController");

exports.getProfile = async (req, res) => {
  try {
    let player = await Player.findOne({ walletAddress: req.walletAddress });

    if (!player) {
      player = await Player.create({
        walletAddress: req.walletAddress,
        coins: 10,
        highScore: 0,
        nftPass: false,
        characters: { unlocked: [], currentIndex: 0 }
      });
    }

    let blockchainResult = null;
    try {
      blockchainResult = await sessionService.saveSessionOnChain(
        req.walletAddress, player.coins, player.highScore
      );
    } catch (blockchainError) {
      console.error("Blockchain session recording failed (non-critical):", blockchainError);
    }

    return res.json({ ...player.toObject(), blockchain: blockchainResult });
  } catch (err) {
    console.error("Get profile error:", err);
    return res.status(500).json({ error: "Failed to load player profile" });
  }
};

exports.saveProfile = async (req, res) => {
  try {
    const { coins, highScore, characters, dailyReward } = req.body;

    const update = {};
    if (Number.isInteger(coins)) update.coins = coins;
    if (Number.isInteger(highScore)) update.highScore = highScore;

    if (characters) {
      update.characters = {
        unlocked: characters.unlocked || [],
        currentIndex: characters.currentIndex || 0
      };
    }

    if (dailyReward?.nextRewardAt) {
      update["dailyReward.nextRewardAt"] = new Date(dailyReward.nextRewardAt);
    }

    const player = await Player.findOneAndUpdate(
      { walletAddress: req.walletAddress },
      { $set: update },
      { upsert: true, new: true }
    );

    let blockchainResult = null;
    try {
      blockchainResult = await sessionService.saveSessionOnChain(
        req.walletAddress,
        coins || player.coins,
        highScore || player.highScore
      );
    } catch (blockchainError) {
      console.error("Blockchain save failed (non-critical):", blockchainError);
      blockchainResult = { success: false, error: blockchainError.message };
    }

    res.json({
      success: true,
      savedToBlockchain: blockchainResult?.success || false,
      blockchain: blockchainResult
    });

    // Dual-write: persist to 0G Storage asynchronously — never awaited
    setImmediate(() =>
      persistProfileTo0G(req.walletAddress, player.toObject(), "game_save")
        .catch(err => console.error("[0G] dual-write error:", err.message))
    );

  } catch (err) {
    console.error("Save profile error:", err);
    return res.status(500).json({ error: "Failed to save player profile" });
  }
};

exports.getLeaderboard = async (req, res) => {
  try {
    const limit = Math.min(parseInt(req.query.limit) || 50, 100);
    const userWallet = req.walletAddress || req.query.wallet;

    const players = await Player.find(
      {}, { walletAddress: 1, highScore: 1, _id: 0 }
    ).sort({ highScore: -1 }).limit(limit).lean();

    let userStanding = 0;
    let userScore = 0;

    if (userWallet) {
      const allPlayers = await Player.find({}, { walletAddress: 1, highScore: 1 })
        .sort({ highScore: -1 }).lean();

      const userIndex = allPlayers.findIndex(
        p => p.walletAddress.toLowerCase() === userWallet.toLowerCase()
      );

      if (userIndex !== -1) {
        userStanding = userIndex + 1;
        userScore    = allPlayers[userIndex].highScore;
      }
    }

    let blockchainResult = null;
    if (userWallet && userStanding > 0) {
      try {
        blockchainResult = await leaderboardService.saveLeaderboardOnChain(
          userWallet, userWallet,
          { userScore, userStanding, topPlayers: players }
        );
      } catch (err) {
        console.error("Leaderboard blockchain save failed (non-critical):", err);
        blockchainResult = { success: false, error: err.message };
      }
    }

    res.json({
      leaderboard:  players ?? [],
      userStanding: userStanding || null,
      userScore:    userScore || null,
      blockchain:   blockchainResult
    });
  } catch (err) {
    console.error("Leaderboard error:", err);
    res.status(200).json({ leaderboard: [], userStanding: null, userScore: null });
  }
};

exports.activateNftPass = async (req, res) => {
  try {
    const { nftPass } = req.body;

    if (nftPass !== true) {
      return res.status(400).json({ success: false, error: "nftPass must be true" });
    }

    const player = await Player.findOneAndUpdate(
      { walletAddress: req.walletAddress },
      { $set: { nftPass: true } },
      { upsert: true, new: true }
    );

    return res.json({
      success: true,
      nftPass: player.nftPass,
      walletAddress: player.walletAddress
    });
  } catch (err) {
    console.error("NFT Pass update error:", err);
    return res.status(500).json({ success: false, error: "Failed to activate NFT Pass" });
  }
};

exports.getOnChainSessions = async (req, res) => {
  try {
    const sessions     = await sessionService.getPlayerSessions(req.walletAddress);
    const sessionCount = await sessionService.getSessionCount(req.walletAddress);

    res.json({
      success: true,
      sessions,
      count: sessionCount,
      contractAddress: process.env.SESSION_CONTRACT_ADDRESS,
      explorerUrl: `https://chainscan.0g.ai/address/${process.env.SESSION_CONTRACT_ADDRESS}`
    });
  } catch (err) {
    console.error("Error fetching on-chain sessions:", err);
    res.status(500).json({ error: "Failed to fetch sessions" });
  }
};

exports.getLatestSession = async (req, res) => {
  try {
    const session = await sessionService.getLatestSession(req.walletAddress);

    if (!session) {
      return res.status(404).json({ success: false, message: "No sessions found for this player" });
    }

    res.json({ success: true, session });
  } catch (err) {
    console.error("Error fetching latest session:", err);
    res.status(500).json({ error: "Failed to fetch latest session" });
  }
};

exports.getBlockchainStats = async (req, res) => {
  try {
    const sessionCount    = await sessionService.getSessionCount(req.walletAddress);
    const totalSessions   = await sessionService.getTotalSessions();
    const owner           = await sessionService.getOwner();
    const contractInfo    = sessionService.getContractInfo();
    const totalSnapshots  = await leaderboardService.getTotalSnapshots();
    const playerSnapshots = await leaderboardService.getPlayerSnapshots(req.walletAddress);
    const latestTop3      = await leaderboardService.getLatestTop3();

    res.json({
      success: true,
      stats: {
        sessions: { yourSessions: sessionCount, totalSessions, contractOwner: owner, ...contractInfo },
        leaderboard: {
          totalSnapshots,
          yourSnapshots: playerSnapshots.length,
          latestTop3,
          ...leaderboardService.getContractInfo()
        }
      }
    });
  } catch (err) {
    console.error("Error fetching blockchain stats:", err);
    res.status(500).json({ error: "Failed to fetch blockchain stats" });
  }
};

exports.getLeaderboardSnapshot = async (req, res) => {
  try {
    const snapshotId = req.params.snapshotId;

    if (snapshotId === "latest") {
      return res.json({ success: true, snapshot: await leaderboardService.getLatestSnapshot() });
    }

    const snapshot = await leaderboardService.getSnapshot(parseInt(snapshotId));
    res.json({ success: true, snapshot });
  } catch (err) {
    console.error("Error fetching snapshot:", err);
    res.status(500).json({ error: "Failed to fetch snapshot" });
  }
};

exports.getPlayerLeaderboardHistory = async (req, res) => {
  try {
    const snapshotIds = await leaderboardService.getPlayerSnapshots(req.walletAddress);
    const snapshots   = await Promise.all(snapshotIds.map(id => leaderboardService.getSnapshot(id)));

    res.json({
      success: true,
      count: snapshots.length,
      snapshots: snapshots.filter(s => s !== null)
    });
  } catch (err) {
    console.error("Error fetching player history:", err);
    res.status(500).json({ error: "Failed to fetch player history" });
  }
};

exports.healthCheck = async (req, res) => {
  try {
    const health = await sessionService.healthCheck();
    res.json(health);
  } catch (err) {
    console.error("Health check error:", err);
    res.status(500).json({ healthy: false, error: err.message });
  }
};
