/**
 * profileRoutes — 0G decentralized save/load routes.
 *
 * These are mounted BEFORE the legacy player routes in server.js so they
 * take priority. Legacy routes below remain 100% unchanged.
 *
 * Security stack per endpoint:
 *   POST /save/binary          rateLimiter(10/min) → verifyUser → express.raw(5mb) → saveBinary
 *   GET  /load/binary          rateLimiter(30/min) → verifyUser → loadBinary
 *   GET  /save/metadata        rateLimiter(60/min) → getSaveMetadata          (public)
 *   GET  /verify               rateLimiter(20/min) → verifySave               (public)
 *   GET  /leaderboard/decentralized  rateLimiter(30/min) → getDecentralizedLeaderboard (public)
 */

const router = require("express").Router();
const rateLimit = require("express-rate-limit");
const express = require("express");
const auth = require("../middleware/auth");
const zg = require("../controllers/zgController");

const limiter = (max, windowMs = 60_000) =>
  rateLimit({ windowMs, max, standardHeaders: true, legacyHeaders: false });

router.post(
  "/save/binary",
  limiter(10),
  auth,
  express.raw({ type: "application/octet-stream", limit: "5mb" }),
  zg.saveBinary
);

router.get("/load/binary",               limiter(30), auth, zg.loadBinary);
router.get("/save/metadata",             limiter(60),       zg.getSaveMetadata);
router.get("/verify",                    limiter(20),       zg.verifySave);
router.get("/leaderboard/decentralized", limiter(30),       zg.getDecentralizedLeaderboard);

module.exports = router;
