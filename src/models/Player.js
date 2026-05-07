const mongoose = require("mongoose");

const PlayerSchema = new mongoose.Schema(
  {
    walletAddress: {
      type: String,
      unique: true,
      index: true
    },
    coins: { type: Number, default: 0 },
    highScore: { type: Number, default: 0 },
    nftPass: {
      type: Boolean,
      default: false
    },
    characters: {
      unlocked: { type: [String], default: [] },
      currentIndex: { type: Number, default: 0 }
    },
    dailyReward: {
      nextRewardAt: { type: Date, default: Date.now }
    }
  },
  { timestamps: true }
);

PlayerSchema.index({ highScore: -1 });

module.exports = mongoose.model("Player", PlayerSchema);
