// Legacy player routes — unchanged from original backend.
// Dual-write to 0G Storage is handled inside player.controller.js via setImmediate.

const router = require("express").Router();
const auth   = require("../middleware/auth");
const ctrl   = require("../controllers/player.controller");

router.get("/profile", auth, ctrl.getProfile);
router.post("/profile", auth, ctrl.getProfile);
router.post("/save", auth, ctrl.saveProfile);
router.get("/leaderboard", ctrl.getLeaderboard);
router.post("/nft-pass", auth, ctrl.activateNftPass);

router.get("/sessions", auth, ctrl.getOnChainSessions);
router.get("/latest-session", auth, ctrl.getLatestSession);
router.get("/blockchain-stats", auth, ctrl.getBlockchainStats);

router.get("/leaderboard-snapshot/:snapshotId", ctrl.getLeaderboardSnapshot);
router.get("/leaderboard-history", auth, ctrl.getPlayerLeaderboardHistory);

module.exports = router;
