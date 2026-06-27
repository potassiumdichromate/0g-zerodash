const WARZONE_API_BASE_URL = 'https://api.warzonewarriors.xyz/warzone';
const CROSS_GAME_REWARD_SECRET = 'warzone-gun-cross-game-reward-v1';

const MEDIUM_OR_HIGHER = new Set(['medium', 'hard']);

function isMediumOrHigher(difficulty) {
  return MEDIUM_OR_HIGHER.has(String(difficulty || '').toLowerCase());
}

function bestEligibleCrossGame(crossGame) {
  const candidates = [crossGame?.best, crossGame?.coins].filter((entry) => (
    entry && isMediumOrHigher(entry.difficulty)
  ));
  if (candidates.find((entry) => entry.difficulty === 'hard')) {
    return candidates.find((entry) => entry.difficulty === 'hard');
  }
  return candidates[0] || null;
}

async function grantWarzoneGunReward({ walletAddress, sourceGame, crossGame }) {
  const eligibleCrossGame = bestEligibleCrossGame(crossGame);
  if (!walletAddress || !eligibleCrossGame) {
    return { eligible: false, granted: false };
  }

  const response = await fetch(`${WARZONE_API_BASE_URL}/internal/cross-game/gun-reward`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-cross-game-reward-secret': CROSS_GAME_REWARD_SECRET,
    },
    body: JSON.stringify({
      walletAddress,
      sourceGame,
      difficulty: eligibleCrossGame.difficulty,
      metric: eligibleCrossGame.metric,
      value: eligibleCrossGame.value,
    }),
  });

  const body = await response.json().catch(() => ({}));
  if (!response.ok || body?.success === false) {
    throw new Error(body?.error || body?.message || `Warzone reward grant failed (${response.status})`);
  }

  return { eligible: true, granted: true, ...(body.reward ? { reward: body.reward } : {}) };
}

function queueWarzoneGunReward({ walletAddress, sourceGame, crossGame, source = 'unknown' }) {
  setImmediate(async () => {
    try {
      const result = await grantWarzoneGunReward({ walletAddress, sourceGame, crossGame });
      if (result.eligible) {
        console.log('[cross-game-warzone-reward] sync complete', {
          source,
          walletAddress,
          sourceGame,
          granted: result.granted,
          reward: result.reward?.rewardName || result.reward?.rewardId || null,
        });
      }
    } catch (error) {
      console.error('[cross-game-warzone-reward] sync failed', {
        source,
        walletAddress,
        sourceGame,
        message: error?.message || String(error),
      });
    }
  });
}

module.exports = { bestEligibleCrossGame, grantWarzoneGunReward, isMediumOrHigher, queueWarzoneGunReward };
