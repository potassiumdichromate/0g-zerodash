# Warzone 0G Backend — Full Implementation Prompt

Paste this entire document into an AI assistant (Claude, GPT-4, etc.) to implement
the Warzone game backend on 0G decentralized infrastructure.

---

## What you are building

A Node.js/Express backend for a mobile shooter game ("Warzone") that stores player
save data on the 0G decentralized stack:

```
0G Storage   — binary player save files (MessagePack encoded)
0G Chain     — root hash anchored on-chain (PlayerSaveAnchor contract)
0G DA        — BLS-signed data availability proof
0G Compute   — TEE anti-cheat validation
MongoDB      — metadata index + fast API queries
```

Auth is wallet-based SIWE (Sign-In With Ethereum). The game client (Unity WebGL or
mobile) signs a nonce message with its wallet, receives a 7-day JWT, and uses that
JWT for all subsequent API calls. No passwords, no usernames.

---

## Source repository to fork

Fork from `zerodash-0g-backend`. The folder structure to keep and modify:

```
src/
  server.js               — keep, update CORS origins + game name
  config/db.js            — keep as-is
  middleware/auth.js      — keep as-is (JWT verify → req.walletAddress)
  models/
    AuthNonce.js          — keep as-is
    PlayerSaveRecord.js   — MODIFY (rename coinSnapshot field)
    Player.js             — REPLACE entirely with WarzonePlayerProfile schema
  services/
    ZeroGStorage.js       — keep as-is
    ZeroGChain.js         — keep as-is
    ZeroGDA.js            — keep as-is
    ZeroGCompute.js       — MODIFY (update anti-cheat prompt)
  utils/retry.js          — keep as-is
  controllers/
    authController.js     — keep as-is
    zgController.js       — MODIFY (update serialize/deserialize)
    zgUXController.js     — MODIFY (update coinSnapshot reference)
    player.controller.js  — REPLACE entirely for Warzone endpoints
  routes/                 — keep structure, update route handlers
  blockchain/
    sessionService.js     — keep as-is (update ABI if redeploying)
    leaderboardService.js — keep as-is
scripts/
  deploy.js               — keep as-is
  transfer-ownership.mjs  — keep as-is
  verify-helper.mjs       — keep as-is
contracts/
  PlayerSaveAnchor.sol    — keep as-is (redeploy with new wallet)
```

---

## Environment variables (.env)

```env
PORT=3001
NODE_ENV=production
MONGO_URI=mongodb+srv://<user>:<pass>@cluster.mongodb.net/warzone-0g

# JWT — generate: node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
BROWSER_JWT_SECRET=<32_byte_hex>

# 0G Mainnet (chainId 16661)
OG_MAINNET_RPC=https://evmrpc.0g.ai
OG_MAINNET_CHAIN_ID=16661

# 0G Storage indexer
ZG_INDEXER_RPC=https://indexer-storage-turbo-v2.0g.ai

# PlayerSaveAnchor — deploy fresh: npm run deploy:anchor
ZG_ANCHOR_CONTRACT_ADDRESS=0x<warzone_anchor_contract>

# Backend operator wallet (becomes immutable backendOperator in contract)
ZG_PRIVATE_KEY=0x<warzone_operator_private_key>

# 0G DA (testnet — mainnet not available yet)
ZG_DA_DISPERSER=disperser-testnet.0g.ai:51001

# 0G Compute anti-cheat (optional, get key at https://pc.0g.ai)
ZG_COMPUTE_API_KEY=<key_or_leave_blank>

# Master switch
ZG_ENABLED=true

# Session + leaderboard contracts
PRIVATE_KEY=0x<session_leaderboard_wallet_key>
SESSION_CONTRACT_ADDRESS=0x<warzone_session_contract>
LEADERBOARD_CONTRACT_ADDRESS=0x<warzone_leaderboard_contract>
```

---

## MongoDB model — replace Player.js with this exactly

File: `src/models/PlayerProfile.js`

```javascript
const mongoose = require('mongoose');
const { Schema } = mongoose;

const DOT_ENC = '__dot__';

function toPlainObject(input) {
  if (!input) return {};
  if (input instanceof Map) {
    const out = {};
    for (const [k, v] of input.entries()) out[String(k)] = v;
    return out;
  }
  if (typeof input === 'object' && !Array.isArray(input)) {
    const out = {};
    for (const [k, v] of Object.entries(input)) {
      if (k.startsWith('$__')) continue;
      out[k] = v;
    }
    return out;
  }
  return {};
}

function encodeObjKeys(input) {
  const obj = toPlainObject(input);
  const out = {};
  for (const [k, v] of Object.entries(obj))
    out[String(k).replace(/\./g, DOT_ENC)] = v;
  return out;
}
function decodeObjKeys(obj) {
  const plain = toPlainObject(obj);
  const out = {};
  for (const [k, v] of Object.entries(plain))
    out[String(k).replace(new RegExp(DOT_ENC, 'g'), '.')] = v;
  return out;
}

function normalizeStageArray(val) {
  if (!Array.isArray(val)) return [false, false, false];
  return [Boolean(val[0]), Boolean(val[1]), Boolean(val[2])];
}
function encodeStageProgressObj(input) {
  const encoded = encodeObjKeys(input);
  for (const k of Object.keys(encoded)) encoded[k] = normalizeStageArray(encoded[k]);
  return encoded;
}
function decodeStageProgressObj(obj) {
  const decoded = decodeObjKeys(obj);
  for (const k of Object.keys(decoded)) decoded[k] = normalizeStageArray(decoded[k]);
  return decoded;
}

const GunSchema = new Schema({
  id: { type: Number, required: true },
  level: { type: Number, default: 1 },
  ammo: { type: Number, default: 0 },
  isNew: { type: Boolean, default: false }
}, { _id: false });

const GrenadeSchema = new Schema({
  id: { type: Number, required: true },
  level: { type: Number, default: 1 },
  quantity: { type: Number, default: 0 },
  isNew: { type: Boolean, default: false }
}, { _id: false });

const MeleeSchema = new Schema({
  id: { type: Number, required: true },
  level: { type: Number, default: 1 },
  isNew: { type: Boolean, default: false }
}, { _id: false });

const DailyQuestSchema = new Schema({
  type:      { $type: Number, required: true, min: 0 },
  progress:  { $type: Number, required: true, min: 0 },
  isClaimed: { $type: Boolean, required: true }
}, { _id: false, typeKey: '$type' });

const PlayerProfileSchema = new Schema({
  walletAddress: { type: String, required: true, unique: true, index: true },

  Intraverse: {
    userId:   { type: String, default: '' },
    userName: { type: String, default: '' },
  },

  PlayerProfile: {
    level:           { type: Number, default: 1 },
    exp:             { type: Number, default: 0 },
    totalTimePlayed: { type: Number, default: 0 }
  },

  PlayerResources: {
    coin:             { type: Number, default: 1000 },
    gem:              { type: Number, default: 0 },
    stamina:          { type: Number, default: 0 },
    medal:            { type: Number, default: 0 },
    tournamentTicket: { type: Number, default: 0 }
  },

  PlayerRambos:       { type: Map, of: new Schema({ id: Number, level: Number }, { _id: false }), default: {} },
  PlayerRamboSkills:  { type: Map, of: { type: Map, of: Number }, default: {} },
  PlayerGuns:         { type: Map, of: GunSchema,     default: {} },
  PlayerGrenades:     { type: Map, of: GrenadeSchema, default: {} },
  PlayerMeleeWeapons: { type: Map, of: MeleeSchema,   default: {} },

  PlayerCampaignProgress: {
    type: Schema.Types.Mixed,
    default: {},
    set: encodeObjKeys,
    get: decodeObjKeys
  },

  PlayerCampaignStageProgress: {
    type: Schema.Types.Mixed,
    default: {},
    set: encodeStageProgressObj,
    get: decodeStageProgressObj
  },

  PlayerCampaignRewardProgress: { type: Map, of: Schema.Types.Mixed, default: {} },
  PlayerBoosters:                { type: Map, of: Number,             default: {} },
  PlayerSelectingBooster:        { type: [Number],                    default: [] },
  PlayerDailyQuestData:          { type: [DailyQuestSchema],          default: [] },
  PlayerAchievementData:         { type: Map, of: Schema.Types.Mixed, default: {} },

  PlayerTutorialData: {
    Character:    { type: Boolean, default: false },
    Booster:      { type: Boolean, default: false },
    ActionInGame: { type: Boolean, default: false }
  }
}, {
  timestamps: true,
  minimize: false,
  versionKey: false,
  toJSON:   { getters: true },
  toObject: { getters: true }
});

PlayerProfileSchema.index({ 'PlayerResources.coin': -1 });

module.exports = mongoose.models.WarzonePlayerProfile
  || mongoose.model('WarzonePlayerProfile', PlayerProfileSchema);
```

---

## PlayerSaveRecord model — one field change

File: `src/models/PlayerSaveRecord.js`

Change `coinSnapshot` → `coinSnapshot` (keep the same — coin is still the primary
resource). Only rename if your leaderboard sorts by a different stat.

Actually rename it to `coinSnapshot` staying the same name but update the comment:

```javascript
// Primary resource snapshot used for leaderboard queries
// For Warzone: PlayerResources.coin
coinSnapshot: { type: Number, default: 0 },
```

---

## Binary save format — MessagePack

Use MessagePack (already in dependencies as `@msgpack/msgpack`) to encode/decode
the full player profile as binary. Wrap with a magic header for format validation.

### Wire format

```
[4 bytes]  Magic: 0x57 0x5A 0x53 0x56  ("WZSV" = WarZone SaVe)
[1 byte]   Version: 0x01
[N bytes]  MessagePack-encoded payload (see below)
```

### Payload object (what gets MessagePack-encoded)

```javascript
{
  Intraverse: { userId: string, userName: string },
  PlayerProfile: { level: int, exp: int, totalTimePlayed: int },
  PlayerResources: { coin: int, gem: int, stamina: int, medal: int, tournamentTicket: int },
  PlayerRambos: { "0": { id: 0, level: 1 }, ... },          // plain object, not Map
  PlayerRamboSkills: { "0": { "0": 0, "1": 0, ... }, ... }, // nested plain objects
  PlayerGuns: { "0": { id: 0, level: 1, ammo: 0, isNew: false }, ... },
  PlayerGrenades: { "500": { id: 500, level: 1, quantity: 0, isNew: false }, ... },
  PlayerMeleeWeapons: { "600": { id: 600, level: 1, isNew: false }, ... },
  PlayerCampaignProgress: {},
  PlayerCampaignStageProgress: { "1.1": [true,false,false], ... }, // decoded (real dots)
  PlayerCampaignRewardProgress: { "Map_1_Desert": [false,false,false], ... },
  PlayerBoosters: { "Hp": 0, "Grenade": 0, ... },
  PlayerSelectingBooster: [int, ...],
  PlayerDailyQuestData: [{ type: int, progress: int, isClaimed: bool }, ...],
  PlayerAchievementData: { "KILL_ENEMY": { type: int, claimTimes: int, progress: int, isReady: bool }, ... },
  PlayerTutorialData: { Character: bool, Booster: bool, ActionInGame: bool }
}
```

**Important:** When writing to DB, Maps use `toObject({ getters: true })` to decode
dot-encoded keys back to real dots before serializing to MessagePack. When reading
from DB, the getter runs automatically, so the decoded object is already correct.

### Backend serialize function (`src/controllers/zgController.js`)

```javascript
const { encode, decode } = require('@msgpack/msgpack');

const MAGIC   = Buffer.from([0x57, 0x5A, 0x53, 0x56]); // WZSV
const VERSION = 0x01;

function serializeSave(profileDoc) {
  const p = profileDoc.toObject({ getters: true });

  // Convert Maps to plain objects for MessagePack
  function mapToObj(m) {
    if (!m) return {};
    if (m instanceof Map) {
      const o = {};
      for (const [k, v] of m) o[k] = v instanceof Map ? mapToObj(v) : v;
      return o;
    }
    return m; // already plain (getters decoded it)
  }

  const payload = {
    Intraverse:                   p.Intraverse,
    PlayerProfile:                p.PlayerProfile,
    PlayerResources:              p.PlayerResources,
    PlayerRambos:                 mapToObj(p.PlayerRambos),
    PlayerRamboSkills:            mapToObj(p.PlayerRamboSkills),
    PlayerGuns:                   mapToObj(p.PlayerGuns),
    PlayerGrenades:               mapToObj(p.PlayerGrenades),
    PlayerMeleeWeapons:           mapToObj(p.PlayerMeleeWeapons),
    PlayerCampaignProgress:       p.PlayerCampaignProgress   || {},
    PlayerCampaignStageProgress:  p.PlayerCampaignStageProgress || {},
    PlayerCampaignRewardProgress: mapToObj(p.PlayerCampaignRewardProgress),
    PlayerBoosters:               mapToObj(p.PlayerBoosters),
    PlayerSelectingBooster:       p.PlayerSelectingBooster || [],
    PlayerDailyQuestData:         p.PlayerDailyQuestData   || [],
    PlayerAchievementData:        mapToObj(p.PlayerAchievementData),
    PlayerTutorialData:           p.PlayerTutorialData,
  };

  const msgpack = Buffer.from(encode(payload));
  const header  = Buffer.alloc(5);
  MAGIC.copy(header);
  header[4] = VERSION;
  return Buffer.concat([header, msgpack]);
}

function deserializeSave(bytes) {
  if (bytes.length < 5)
    throw new Error('Save too short');
  if (bytes[0] !== 0x57 || bytes[1] !== 0x5A || bytes[2] !== 0x53 || bytes[3] !== 0x56)
    throw new Error('Invalid magic header — not a Warzone save file');
  if (bytes[4] !== VERSION)
    throw new Error(`Unsupported save version: ${bytes[4]}`);
  return decode(bytes.slice(5));
}
```

### Backend save endpoints (zgController.js)

```javascript
// POST /player/save/binary
// Content-Type: application/octet-stream
// Authorization: Bearer <jwt>
exports.saveBinary = async (req, res) => {
  const wallet = req.walletAddress;
  const bytes  = req.body; // raw Buffer (use express.raw middleware)

  let payload;
  try { payload = deserializeSave(bytes); }
  catch (e) { return res.status(400).json({ error: e.message }); }

  // Upsert player profile in MongoDB
  const update = {
    Intraverse:                   payload.Intraverse,
    PlayerProfile:                payload.PlayerProfile,
    PlayerResources:              payload.PlayerResources,
    PlayerRambos:                 payload.PlayerRambos,
    PlayerRamboSkills:            payload.PlayerRamboSkills,
    PlayerGuns:                   payload.PlayerGuns,
    PlayerGrenades:               payload.PlayerGrenades,
    PlayerMeleeWeapons:           payload.PlayerMeleeWeapons,
    PlayerCampaignProgress:       payload.PlayerCampaignProgress,
    PlayerCampaignStageProgress:  payload.PlayerCampaignStageProgress,
    PlayerCampaignRewardProgress: payload.PlayerCampaignRewardProgress,
    PlayerBoosters:               payload.PlayerBoosters,
    PlayerSelectingBooster:       payload.PlayerSelectingBooster,
    PlayerDailyQuestData:         payload.PlayerDailyQuestData,
    PlayerAchievementData:        payload.PlayerAchievementData,
    PlayerTutorialData:           payload.PlayerTutorialData,
  };

  const profile = await PlayerProfile.findOneAndUpdate(
    { walletAddress: wallet },
    { $set: update },
    { upsert: true, new: true, setDefaultsOnInsert: true }
  );

  // Run 0G pipeline (storage → anchor → DA → compute) asynchronously
  // coinSnapshot = PlayerResources.coin for leaderboard
  runZGPipeline(wallet, bytes, profile.PlayerResources?.coin ?? 0);

  return res.json({ success: true });
};

// GET /player/load/binary
// Authorization: Bearer <jwt>
exports.loadBinary = async (req, res) => {
  const wallet  = req.walletAddress;
  const profile = await PlayerProfile.findOne({ walletAddress: wallet });

  if (!profile) return res.status(404).json({ error: 'No save found' });

  const bytes = serializeSave(profile);
  res.set('Content-Type', 'application/octet-stream');
  return res.send(bytes);
};
```

---

## All API endpoints

### Auth

```
GET  /auth/nonce?wallet=0x...
     → { message: string, nonce: string }
     No auth. Returns the SIWE message to sign.

POST /auth/login
     Body: { wallet: string, signature: string, nonce: string }
     → { token: string }   (7-day JWT)
     No auth.
```

### Save / Load (0G binary pipeline)

```
POST /player/save/binary
     Content-Type: application/octet-stream
     Authorization: Bearer <jwt>
     Body: raw binary (WZSV header + MessagePack payload)
     → { success: true, saveIndex: int }
     Stores file on 0G Storage, anchors root hash on-chain,
     submits to DA, triggers TEE compute. All async.

GET  /player/load/binary
     Authorization: Bearer <jwt>
     → raw binary (WZSV header + MessagePack payload)
     Returns 404 if no save exists (first-time player).
```

### Player profile (REST)

```
GET  /player/profile
     Authorization: Bearer <jwt>
     → full WarzonePlayerProfile document as JSON

PATCH /player/profile
     Authorization: Bearer <jwt>
     Body: partial update (any top-level field)
     → updated WarzonePlayerProfile document

GET  /player/profile/:wallet
     Public. Returns public-safe profile (no wallet key).

GET  /player/leaderboard?limit=100
     Public. Returns top players sorted by PlayerResources.coin desc.
     → [{ walletAddress, PlayerResources, PlayerProfile, rank }, ...]
```

### 0G UX endpoints (dashboard, trust, activity)

```
GET  /0g/dashboard
     Authorization: Bearer <jwt>
     → {
         wallet,
         summary: { totalSaves, finalizedSaves, anchoredSaves, pendingSaves, failedSaves, totalDataStored },
         trustScore: { score: 0-100, label: UNVERIFIED|BRONZE|SILVER|GOLD|PLATINUM, description, breakdown },
         latestSave: {
           saveIndex,
           rootHash,
           coinSnapshot,    ← PlayerResources.coin at save time
           fileSize,
           pipeline: {
             stored:    { done, rootHash, txHash, explorerUrl, fileSize },
             anchored:  { done, txHash, block, explorerUrl },
             finalized: { done, status, batchId, blobIndex },
             validated: { done, verdict, confidence, teeVerified }
           }
         },
         recentActivity: [ event, ... ],
         contracts: { playerSaveAnchor: { address, explorerUrl } }
       }

GET  /0g/activity?page=1&limit=20
     Authorization: Bearer <jwt>
     → { wallet, page, totalPages, totalEvents, hasMore, events: [ event, ... ] }

     Event shape:
     {
       id, type, saveIndex, timestamp, title, description, status,
       data: { ... type-specific ... },
       explorerUrl: string|null
     }
     Event types: SAVE_STORED | SAVE_ANCHORED | DA_FINALIZED | DA_FAILED
                  COMPUTE_VALIDATED | COMPUTE_REJECTED

GET  /0g/badge
     Authorization: Bearer <jwt>
     → { wallet, badge, score, description, breakdown, nextLevel }

GET  /0g/network
     Public.
     → {
         timestamp,
         overall: 'healthy'|'minor issues',
         services: {
           storage: { status, latencyMs, endpoint, label },
           chain:   { status, latencyMs, blockNumber, chainId, explorerUrl, label },
           da:      { status, endpoint, protocol, label },
           compute: { status, endpoint, label, note }
         },
         contracts: { playerSaveAnchor: { address, explorerUrl } }
       }

GET  /0g/proof/:wallet/:saveIndex
     Public. Shareable save certificate.
     → { certificate, storage, onChain, da, compute }

GET  /0g/explorer/:wallet
     Public. Full 0G save history for any wallet.
     → { wallet, trustBadge, trustScore, totalSaves, totalDataStored, saves: [...], contractUrl }

GET  /0g/leaderboard/verified?filter=finalized
     Public. Leaderboard filtered to only wallets with verified saves.
     filter: finalized | anchored | validated | any
```

---

## 0G Compute anti-cheat prompt — update in ZeroGCompute.js

Replace the existing prompt with one tailored to Warzone save validation:

```javascript
const prompt = `
You are an anti-cheat validator for Warzone, a mobile shooter game.
Analyze this player save data and determine if it is CLEAN or SUSPICIOUS.

Save data:
${JSON.stringify(saveData, null, 2)}

Rules for a CLEAN save:
- PlayerResources.coin: reasonable value (0 – 9,999,999). Sudden jumps >50,000 in one session are suspicious.
- PlayerResources.gem: 0 – 99,999. Gems are premium currency, large values are suspicious.
- PlayerProfile.level: 1 – 100. Must be consistent with exp value.
- PlayerProfile.exp: non-negative. Cannot decrease between sessions.
- PlayerRambos: characters must have valid id values (0–99) and level 1–10.
- PlayerRamboSkills: skill values must be non-negative integers 0–10 per skill.
- PlayerGuns/Grenades/MeleeWeapons: level must be 1–10, ammo/quantity non-negative.
- PlayerCampaignStageProgress: each stage array must be [bool, bool, bool].
  Stage unlock must be sequential — later stages cannot be unlocked without earlier ones.
- PlayerAchievementData: progress values must be non-negative. claimTimes must be non-negative.
- PlayerDailyQuestData: progress must be non-negative. Cannot have duplicate quest types.
- PlayerBoosters: all values non-negative integers.
- totalTimePlayed: non-negative. Cannot decrease.

Return JSON only:
{
  "verdict": "CLEAN" or "SUSPICIOUS",
  "confidence": 0.0 to 1.0,
  "flags": ["reason1", "reason2"],
  "summary": "one sentence"
}
`;
```

---

## Unity integration — ZGSaveManager.cs

Replace the existing ZGSaveManager.cs with the Warzone version.
Use `Newtonsoft.Json` (already available) to serialize to JSON bytes, then wrap
with the WZSV magic header. This avoids implementing a full MessagePack Unity
library — the backend accepts and returns raw MessagePack, but on the Unity side
JSON→bytes is simpler to maintain.

**Alternative**: Use the MessagePack-CSharp Unity package
(`com.neuecc.messagepack`) for full fidelity. Recommended for production.

### Save data C# model

```csharp
[Serializable]
public class WarzonePlayerSave
{
    // Intraverse
    public string IntraverseUserId   = "";
    public string IntraverseUserName = "";

    // PlayerProfile
    public int Level           = 1;
    public int Exp             = 0;
    public int TotalTimePlayed = 0;

    // PlayerResources
    public int Coin             = 1000;
    public int Gem              = 0;
    public int Stamina          = 0;
    public int Medal            = 0;
    public int TournamentTicket = 0;

    // Inventories — serialized as JSON strings (Map<string, object>)
    public string PlayerRambosJson        = "{}";
    public string PlayerRamboSkillsJson   = "{}";
    public string PlayerGunsJson          = "{}";
    public string PlayerGrenadesJson      = "{}";
    public string PlayerMeleeWeaponsJson  = "{}";

    // Campaign
    public string PlayerCampaignProgressJson      = "{}";
    public string PlayerCampaignStageProgressJson = "{}";
    public string PlayerCampaignRewardProgressJson= "{}";

    // Boosters
    public string PlayerBoostersJson          = "{}";
    public int[]  PlayerSelectingBooster      = new int[0];

    // Quests + achievements
    public string PlayerDailyQuestDataJson  = "[]";
    public string PlayerAchievementDataJson = "{}";

    // Tutorial
    public bool TutorialCharacter    = false;
    public bool TutorialBooster      = false;
    public bool TutorialActionInGame = false;
}
```

### ZGSaveManager.cs — binary serialize/deserialize

```csharp
using UnityEngine;
using UnityEngine.Networking;
using System;
using System.Collections;
using System.IO;
using System.Text;
using Newtonsoft.Json;
using Newtonsoft.Json.Linq;

public class ZGSaveManager : MonoBehaviour
{
    public static ZGSaveManager Instance { get; private set; }

    private const string BASE_URL = "https://<your-warzone-backend>.onrender.com";

    // WZSV magic header
    private static readonly byte[] MAGIC   = { 0x57, 0x5A, 0x53, 0x56 };
    private const byte             VERSION = 0x01;

    void Awake()
    {
        if (Instance != null) { Destroy(gameObject); return; }
        Instance = this;
        DontDestroyOnLoad(gameObject);
    }

    // ── Serialize: WarzonePlayerSave → binary ──────────────────────────────

    public byte[] Serialize(WarzonePlayerSave save)
    {
        // Build the same payload object the backend expects
        var payload = new JObject
        {
            ["Intraverse"] = new JObject {
                ["userId"]   = save.IntraverseUserId,
                ["userName"] = save.IntraverseUserName
            },
            ["PlayerProfile"] = new JObject {
                ["level"]           = save.Level,
                ["exp"]             = save.Exp,
                ["totalTimePlayed"] = save.TotalTimePlayed
            },
            ["PlayerResources"] = new JObject {
                ["coin"]             = save.Coin,
                ["gem"]              = save.Gem,
                ["stamina"]          = save.Stamina,
                ["medal"]            = save.Medal,
                ["tournamentTicket"] = save.TournamentTicket
            },
            ["PlayerRambos"]              = JObject.Parse(save.PlayerRambosJson),
            ["PlayerRamboSkills"]         = JObject.Parse(save.PlayerRamboSkillsJson),
            ["PlayerGuns"]                = JObject.Parse(save.PlayerGunsJson),
            ["PlayerGrenades"]            = JObject.Parse(save.PlayerGrenadesJson),
            ["PlayerMeleeWeapons"]        = JObject.Parse(save.PlayerMeleeWeaponsJson),
            ["PlayerCampaignProgress"]    = JObject.Parse(save.PlayerCampaignProgressJson),
            ["PlayerCampaignStageProgress"]   = JObject.Parse(save.PlayerCampaignStageProgressJson),
            ["PlayerCampaignRewardProgress"]  = JObject.Parse(save.PlayerCampaignRewardProgressJson),
            ["PlayerBoosters"]            = JObject.Parse(save.PlayerBoostersJson),
            ["PlayerSelectingBooster"]    = JArray.FromObject(save.PlayerSelectingBooster),
            ["PlayerDailyQuestData"]      = JArray.Parse(save.PlayerDailyQuestDataJson),
            ["PlayerAchievementData"]     = JObject.Parse(save.PlayerAchievementDataJson),
            ["PlayerTutorialData"] = new JObject {
                ["Character"]    = save.TutorialCharacter,
                ["Booster"]      = save.TutorialBooster,
                ["ActionInGame"] = save.TutorialActionInGame
            }
        };

        byte[] jsonBytes = Encoding.UTF8.GetBytes(payload.ToString(Formatting.None));

        using var ms = new MemoryStream();
        ms.Write(MAGIC, 0, 4);
        ms.WriteByte(VERSION);
        ms.Write(jsonBytes, 0, jsonBytes.Length);
        return ms.ToArray();
    }

    // ── Deserialize: binary → WarzonePlayerSave ───────────────────────────

    public WarzonePlayerSave Deserialize(byte[] bytes)
    {
        if (bytes.Length < 5)
            throw new InvalidDataException("Save too short");
        if (bytes[0] != MAGIC[0] || bytes[1] != MAGIC[1] ||
            bytes[2] != MAGIC[2] || bytes[3] != MAGIC[3])
            throw new InvalidDataException("Invalid magic — not a Warzone save");
        if (bytes[4] != VERSION)
            throw new InvalidDataException($"Unsupported version: {bytes[4]}");

        string json = Encoding.UTF8.GetString(bytes, 5, bytes.Length - 5);
        var j = JObject.Parse(json);

        var save = new WarzonePlayerSave();

        // Intraverse
        save.IntraverseUserId   = j["Intraverse"]?["userId"]?.ToString()   ?? "";
        save.IntraverseUserName = j["Intraverse"]?["userName"]?.ToString() ?? "";

        // PlayerProfile
        save.Level           = j["PlayerProfile"]?["level"]?.Value<int>()           ?? 1;
        save.Exp             = j["PlayerProfile"]?["exp"]?.Value<int>()             ?? 0;
        save.TotalTimePlayed = j["PlayerProfile"]?["totalTimePlayed"]?.Value<int>() ?? 0;

        // PlayerResources
        save.Coin             = j["PlayerResources"]?["coin"]?.Value<int>()             ?? 1000;
        save.Gem              = j["PlayerResources"]?["gem"]?.Value<int>()              ?? 0;
        save.Stamina          = j["PlayerResources"]?["stamina"]?.Value<int>()          ?? 0;
        save.Medal            = j["PlayerResources"]?["medal"]?.Value<int>()            ?? 0;
        save.TournamentTicket = j["PlayerResources"]?["tournamentTicket"]?.Value<int>() ?? 0;

        // Inventories
        save.PlayerRambosJson        = j["PlayerRambos"]?.ToString()              ?? "{}";
        save.PlayerRamboSkillsJson   = j["PlayerRamboSkills"]?.ToString()         ?? "{}";
        save.PlayerGunsJson          = j["PlayerGuns"]?.ToString()                ?? "{}";
        save.PlayerGrenadesJson      = j["PlayerGrenades"]?.ToString()            ?? "{}";
        save.PlayerMeleeWeaponsJson  = j["PlayerMeleeWeapons"]?.ToString()        ?? "{}";

        // Campaign
        save.PlayerCampaignProgressJson       = j["PlayerCampaignProgress"]?.ToString()       ?? "{}";
        save.PlayerCampaignStageProgressJson  = j["PlayerCampaignStageProgress"]?.ToString()  ?? "{}";
        save.PlayerCampaignRewardProgressJson = j["PlayerCampaignRewardProgress"]?.ToString() ?? "{}";

        // Boosters
        save.PlayerBoostersJson     = j["PlayerBoosters"]?.ToString() ?? "{}";
        var boosterArr = j["PlayerSelectingBooster"] as JArray;
        save.PlayerSelectingBooster = boosterArr?.ToObject<int[]>() ?? new int[0];

        // Quests + achievements
        save.PlayerDailyQuestDataJson  = j["PlayerDailyQuestData"]?.ToString()  ?? "[]";
        save.PlayerAchievementDataJson = j["PlayerAchievementData"]?.ToString() ?? "{}";

        // Tutorial
        save.TutorialCharacter    = j["PlayerTutorialData"]?["Character"]?.Value<bool>()    ?? false;
        save.TutorialBooster      = j["PlayerTutorialData"]?["Booster"]?.Value<bool>()      ?? false;
        save.TutorialActionInGame = j["PlayerTutorialData"]?["ActionInGame"]?.Value<bool>() ?? false;

        return save;
    }

    // ── Network: Load from 0G ─────────────────────────────────────────────

    public IEnumerator LoadSave(
        string jwt,
        Action<WarzonePlayerSave> onSuccess,
        Action onNotFound,
        Action<string> onError)
    {
        using var req = UnityWebRequest.Get(BASE_URL + "/player/load/binary");
        req.SetRequestHeader("Authorization", "Bearer " + jwt);
        req.downloadHandler = new DownloadHandlerBuffer();
        yield return req.SendWebRequest();

        if (req.responseCode == 404) { onNotFound?.Invoke(); yield break; }

        if (req.result != UnityWebRequest.Result.Success)
        {
            onError?.Invoke(req.downloadHandler?.text ?? req.error);
            yield break;
        }

        try
        {
            var save = Deserialize(req.downloadHandler.data);
            onSuccess?.Invoke(save);
        }
        catch (Exception e) { onError?.Invoke(e.Message); }
    }

    // ── Network: Upload to 0G ─────────────────────────────────────────────

    public IEnumerator UploadSave(string jwt, WarzonePlayerSave save, Action<bool> onDone)
    {
        byte[] bytes = Serialize(save);

        using var req = new UnityWebRequest(BASE_URL + "/player/save/binary", "POST");
        req.uploadHandler   = new UploadHandlerRaw(bytes);
        req.downloadHandler = new DownloadHandlerBuffer();
        req.SetRequestHeader("Authorization", "Bearer " + jwt);
        req.SetRequestHeader("Content-Type",  "application/octet-stream");
        yield return req.SendWebRequest();

        onDone?.Invoke(req.result == UnityWebRequest.Result.Success);
    }

    // ── Default save for first-time players ───────────────────────────────

    public static WarzonePlayerSave DefaultSave() => new WarzonePlayerSave
    {
        Coin  = 1000,
        Level = 1,
        PlayerRambosJson  = "{\"0\":{\"id\":0,\"level\":1}}",
        PlayerGunsJson    = "{\"0\":{\"id\":0,\"level\":1,\"ammo\":0,\"isNew\":false}}",
        PlayerGrenadesJson= "{\"500\":{\"id\":500,\"level\":1,\"quantity\":0,\"isNew\":false}}",
        PlayerMeleeWeaponsJson = "{\"600\":{\"id\":600,\"level\":1,\"isNew\":false}}",
        PlayerBoostersJson= "{\"Hp\":0,\"Grenade\":0,\"Damage\":0,\"CoinMagnet\":0,\"Speed\":0,\"Critical\":0}",
        PlayerRamboSkillsJson = "{\"0\":{\"0\":0,\"1\":0,\"2\":0,\"3\":0,\"4\":0,\"5\":0,\"6\":0,\"7\":0,\"8\":0,\"9\":0,\"10\":0,\"11\":0,\"12\":0,\"13\":0,\"14\":0,\"15\":0,\"16\":0}}"
    };

    // ── Snapshot helper for leaderboard ──────────────────────────────────

    public WarzonePlayerSave BuildSaveFromGameData()
    {
        // Call this from your GameManager / SaveManager before uploading
        // Fill fields from your in-game state managers
        return new WarzonePlayerSave
        {
            Coin  = WarzoneGameData.Coin,
            Gem   = WarzoneGameData.Gem,
            Level = WarzoneGameData.Level,
            Exp   = WarzoneGameData.Exp,
            TotalTimePlayed = WarzoneGameData.TotalTimePlayed,
            // ... fill remaining fields from your game state
        };
    }
}
```

---

## BackendService.cs — update GameData for Warzone

```csharp
public class BackendService : MonoBehaviour
{
    public static BackendService Instance;

    public static class GameData
    {
        // Mirror the fields you need in-game
        public static int  Coin             { get; set; }
        public static int  Gem              { get; set; }
        public static int  Level            { get; set; }
        public static int  Exp              { get; set; }
        public static int  TotalTimePlayed  { get; set; }
        public static bool IsLoaded         { get; set; }

        public static void Reset()
        {
            Coin = 1000; Gem = 0; Level = 1; Exp = 0;
            TotalTimePlayed = 0; IsLoaded = false;
        }
    }

    void Awake()
    {
        if (Instance) { Destroy(gameObject); return; }
        Instance = this;
        DontDestroyOnLoad(gameObject);
        GameData.Reset();
    }

    private string _jwtToken;
    public void SetJwt(string token) { _jwtToken = token; PlayerPrefs.SetString("ZGJwt", token); }
    public string GetJwt() => !string.IsNullOrEmpty(_jwtToken) ? _jwtToken : PlayerPrefs.GetString("ZGJwt", null);

    public IEnumerator SavePlayerProfile()
    {
        string jwt = GetJwt();
        if (string.IsNullOrEmpty(jwt)) yield break;
        var save = ZGSaveManager.Instance.BuildSaveFromGameData();
        yield return ZGSaveManager.Instance.UploadSave(jwt, save, ok =>
        {
            if (ok) Debug.Log("[BackendService] Save uploaded to 0G.");
            else    Debug.LogWarning("[BackendService] Save upload failed.");
        });
    }

    public void UpdateGameData(int coin, int level, int exp)
    {
        GameData.Coin  = coin;
        GameData.Level = level;
        GameData.Exp   = exp;
        PlayerPrefs.SetInt("Coin",  coin);
        PlayerPrefs.SetInt("Level", level);
        PlayerPrefs.SetInt("Exp",   exp);
        PlayerPrefs.Save();
    }
}
```

---

## GameBootstrapper.cs — reuse exactly as-is

`GameBootstrapper.cs` does not need any changes. It handles JWT delivery (URL param
or SendMessage), boot flow (LoadSave → apply → load scene), offline fallback.
Only update `ApplySaveData()` and `EnterOfflineMode()` to use the new
`WarzonePlayerSave` fields instead of ZeroDash fields:

```csharp
void ApplySaveData(WarzonePlayerSave save)
{
    BackendService.GameData.Coin            = save.Coin;
    BackendService.GameData.Gem             = save.Gem;
    BackendService.GameData.Level           = save.Level;
    BackendService.GameData.Exp             = save.Exp;
    BackendService.GameData.TotalTimePlayed = save.TotalTimePlayed;
    BackendService.GameData.IsLoaded        = true;

    PlayerPrefs.SetInt("Coin",  save.Coin);
    PlayerPrefs.SetInt("Level", save.Level);
    PlayerPrefs.SetInt("Exp",   save.Exp);
    PlayerPrefs.Save();
}

void EnterOfflineMode()
{
    ApplySaveData(new WarzonePlayerSave
    {
        Coin  = PlayerPrefs.GetInt("Coin",  1000),
        Level = PlayerPrefs.GetInt("Level", 1),
        Exp   = PlayerPrefs.GetInt("Exp",   0),
    });
    SceneManager.LoadScene("Main");
}
```

---

## On-chain contracts — what to deploy

All 3 contracts need fresh deployments for the new game's operator wallet:

```
1. PlayerSaveAnchor
   npm run deploy:anchor
   → sets new ZG_ANCHOR_CONTRACT_ADDRESS

2. Session contract
   Tracks: player address, coins, bestScore (can reuse same ABI)
   Deploy with new PRIVATE_KEY wallet

3. Leaderboard contract
   Tracks: leaderboard snapshots
   Deploy with same PRIVATE_KEY wallet
```

After deploying PlayerSaveAnchor, verify it:
```
npm run verify-helper
```
Follow the printed instructions on chainscan.0g.ai.

---

## Frontend (React) integration — minimal changes

The same GameCanvas.jsx pattern works. After login:

1. `doJwtAuth(walletAddress)` → stores JWT in `localStorage['zgJwt']`
2. `setCurrentScreen('game')` → GameCanvas loads Unity
3. Unity receives JWT via `SendMessage('GameBootstrapper', 'SetJwtToken', jwt)`
4. GameBootstrapper runs LoadSave → BootFlow → SceneManager.LoadScene("Main")
5. On game-over: `BackendService.SavePlayerProfile()` → `ZGSaveManager.UploadSave()`

For the 0G dashboard panel (trust score, latest save, activity, network status):
Same endpoints — `/0g/dashboard`, `/0g/network`, `/0g/activity` — work identically.
The only display change is `coinSnapshot` now represents Warzone coins.

---

## Quick start checklist

```
□ Fork zerodash-0g-backend → warzone-0g-backend
□ npm install --legacy-peer-deps
□ Replace src/models/Player.js with WarzonePlayerProfile schema above
□ Update coinSnapshot field comment in PlayerSaveRecord.js
□ Replace serialize/deserialize in zgController.js with Warzone version
□ Update compute anti-cheat prompt in ZeroGCompute.js
□ Update CORS origin in server.js to your game domain
□ Fill .env with all required values
□ npm run deploy:anchor  (new PlayerSaveAnchor for Warzone)
□ Deploy session + leaderboard contracts
□ npm run verify-helper  (verify PlayerSaveAnchor on chainscan.0g.ai)
□ In Unity: replace ZGSaveManager.cs, BackendService.cs, update GameBootstrapper.cs
□ Test: POST /player/save/binary + GET /player/load/binary round-trip
□ Test: GET /0g/dashboard shows trust score + pipeline stages
```
