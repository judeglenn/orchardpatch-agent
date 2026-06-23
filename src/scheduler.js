/**
 * OrchardPatch Agent — Inventory Scheduler
 * Phase 6: fast loop (60s) + slow loop (15min) architecture.
 *
 * Fast loop (60s): polls pending_patches AND pending_commands.
 *   - Fires patches immediately (fire-and-forget); proc.on('close') in
 *     patcher.js is the report path.
 *   - Processes force check-in commands by calling runInventoryAndVersionCheck().
 *
 * Slow loop (15min): full inventory collection + version checks.
 *   - runInventoryAndVersionCheck() is extracted so the fast loop can
 *     invoke it on-demand for check_in commands.
 */

const fs = require("fs");
const path = require("path");
const os = require("os");
const { collectInventory } = require("./inventory");
const { checkinToServer, fetchPendingPatches, claimPatch, reportPatchJob, saveDeviceId, loadDeviceId, loadConfig } = require("./checkin");
const { enrichAppsWithLabels, lookupLabel } = require("./catalog");
const { runPatchJob } = require("./patcher");
const { getOverride } = require("./overrides");
const { runVersionCheck } = require("./version-checker");

const CACHE_DIR = path.join(process.env.HOME || "/var/root", ".orchardpatch");
const CACHE_FILE = path.join(CACHE_DIR, "inventory-cache.json");
const DEFAULT_INTERVAL_MS = 15 * 60 * 1000; // 15 minutes
const FAST_LOOP_INTERVAL_MS = 60 * 1000;     // 60 seconds

// Version check: run every N slow-loop check-ins (configurable)
const VERSION_CHECK_INTERVAL = parseInt(process.env.VERSION_CHECK_INTERVAL) || 10;
let checkinCount = 0;

function ensureCacheDir() {
  if (!fs.existsSync(CACHE_DIR)) {
    fs.mkdirSync(CACHE_DIR, { recursive: true });
  }
}

function writeCache(inventory) {
  ensureCacheDir();
  fs.writeFileSync(CACHE_FILE, JSON.stringify(inventory, null, 2));
  console.log("[OrchardPatch Scheduler] Cache written: " + inventory.apps.length + " apps");
}

function readCache() {
  try {
    if (fs.existsSync(CACHE_FILE)) {
      return JSON.parse(fs.readFileSync(CACHE_FILE, "utf8"));
    }
  } catch { /* ignore */ }
  return null;
}

function getCacheAge() {
  try {
    if (fs.existsSync(CACHE_FILE)) {
      const stat = fs.statSync(CACHE_FILE);
      return Date.now() - stat.mtimeMs;
    }
  } catch { /* ignore */ }
  return Infinity;
}

function getDeviceId() {
  return loadDeviceId() || ("device-" + os.hostname());
}

// Inject config secrets into process.env so child-process spawns (e.g. Installomator)
// inherit them without requiring plist EnvironmentVariables entries.
// Called once at startup before any version checks run.
function applyConfigEnv() {
  const config = loadConfig();
  const githubToken = config.githubToken || process.env.GITHUB_TOKEN;
  if (githubToken) {
    process.env.GITHUB_TOKEN = githubToken;
    console.log("[OrchardPatch Scheduler] GITHUB_TOKEN loaded from config");
  }
}

// ─── Slow loop body ─────────────────────────────────────────────────────────────────────────────

/**
 * Run a full inventory collection + version check batch.
 * Called by:
 *   1. The slow loop timer (every 15min)
 *   2. The fast loop when a check_in command is received
 */
async function runInventoryAndVersionCheck() {
  console.log("[OrchardPatch Scheduler] Running inventory collection...");
  const inventory = collectInventory();
  inventory.apps = enrichAppsWithLabels(inventory.apps);
  writeCache(inventory);

  checkinToServer(inventory).catch(err =>
    console.warn("[OrchardPatch Scheduler] Server check-in failed:", err.message)
  );

  checkinCount++;
  if (checkinCount % VERSION_CHECK_INTERVAL === 0) {
    console.log("[OrchardPatch Scheduler] Check-in #" + checkinCount + " — triggering version check batch");
    runVersionCheck(inventory.apps).catch(err =>
      console.warn("[OrchardPatch Scheduler] Version check failed:", err.message)
    );
  }

  return inventory;
}

// Wrapper for the slow loop setInterval — catches errors so the interval keeps ticking
async function runCollection() {
  try {
    return await runInventoryAndVersionCheck();
  } catch (err) {
    console.error("[OrchardPatch Scheduler] Collection failed:", err.message);
    return null;
  }
}

// ─── Fast loop helpers ──────────────────────────────────────────────────────────────────────────

async function fastLoopPatchPoll(deviceId) {
  let patches;
  try {
    patches = await fetchPendingPatches(deviceId);
  } catch (err) {
    console.warn("[OrchardPatch Poller] Failed to fetch pending patches:", err.message);
    return;
  }

  if (!patches.length) return;
  console.log("[OrchardPatch Poller] Found " + patches.length + " pending patch(es)");

  for (const patch of patches) {
    try {
      const claimed = await claimPatch(patch.id);
      if (claimed === null) {
        // Zero rows returned from conditional UPDATE — race: another agent claimed it
        // first, or it was cancelled between fetch and claim
        console.log("[OrchardPatch Poller] Lost claim on patch " + patch.id + " — skipping");
        continue;
      }

      const bundleId = patch.bundleId ?? patch.bundle_id;
      const appName = patch.appName ?? patch.app_name;
      const mode = patch.mode;
      let label = patch.label;

      if (!label && bundleId) {
        label = getOverride(bundleId) || lookupLabel(appName, bundleId) || null;
      }

      if (!label) {
        console.warn("[OrchardPatch Poller] No label for \"" + appName + "\" (" + (bundleId || "no bundle ID") + ") — skipping");
        continue;
      }

      console.log("[OrchardPatch Poller] Firing patch: " + appName + " (" + label + ") mode=" + (mode || "managed"));
      // Fire and forget — proc.on('close') in patcher.js is the report path
      runPatchJob(label, appName, mode || "managed", deviceId, patch.id).catch(err =>
        console.error("[OrchardPatch Poller] runPatchJob error for " + patch.id + ":", err.message)
      );
    } catch (err) {
      console.error("[OrchardPatch Poller] Error processing patch " + patch.id + ":", err.message);
    }
  }
}

async function fastLoopCommandPoll(deviceId) {
  const config = loadConfig();
  const serverUrl = (config.server && config.server.url) || process.env.ORCHARDPATCH_SERVER_URL;
  const serverToken = (config.server && config.server.token) || process.env.ORCHARDPATCH_SERVER_TOKEN;
  if (!serverUrl || !serverToken) return;

  let commands;
  try {
    const res = await fetch(
      serverUrl + "/pending-commands?device_id=" + encodeURIComponent(deviceId),
      {
        headers: { "x-orchardpatch-token": serverToken },
        signal: AbortSignal.timeout(10000),
      }
    );
    if (!res.ok) return;
    const data = await res.json();
    commands = data.commands || [];
  } catch (err) {
    console.warn("[OrchardPatch Commander] Failed to fetch pending commands:", err.message);
    return;
  }

  if (!commands.length) return;
  console.log("[OrchardPatch Commander] Found " + commands.length + " pending command(s)");

  for (const cmd of commands) {
    let result = "";
    try {
      // Claim the command — conditional UPDATE, 409 if already claimed
      const claimRes = await fetch(serverUrl + "/pending-commands/" + cmd.id + "/claim", {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-orchardpatch-token": serverToken },
        signal: AbortSignal.timeout(10000),
      });
      if (claimRes.status === 409) {
        console.log("[OrchardPatch Commander] Lost claim on command " + cmd.id + " — skipping");
        continue;
      }
      if (!claimRes.ok) {
        console.warn("[OrchardPatch Commander] Claim failed for command " + cmd.id + ": " + claimRes.status);
        continue;
      }

      // Execute command
      switch (cmd.command) {
        case "check_in":
          console.log("[OrchardPatch Commander] Executing force check-in (command " + cmd.id + ")");
          try {
            await runInventoryAndVersionCheck();
          } catch (err) {
            result = "check_in failed: " + err.message;
            console.error("[OrchardPatch Commander] check_in error:", err.message);
          }
          break;
        default:
          console.log("[OrchardPatch Commander] Unknown command type: " + cmd.command);
          result = "ignored: unknown command type";
      }
    } catch (err) {
      result = "error: " + err.message;
      console.error("[OrchardPatch Commander] Error processing command " + cmd.id + ":", err.message);
    }

    // Mark complete — idempotent, always fires even on error paths above
    try {
      await fetch(serverUrl + "/pending-commands/" + cmd.id + "/complete", {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-orchardpatch-token": serverToken },
        body: JSON.stringify({ result }),
        signal: AbortSignal.timeout(10000),
      });
    } catch (err) {
      console.warn("[OrchardPatch Commander] Failed to mark command " + cmd.id + " complete:", err.message);
    }
  }
}

// ─── Scheduler entry point ──────────────────────────────────────────────────────────────────────

function startScheduler(intervalMs = DEFAULT_INTERVAL_MS) {
  console.log("[OrchardPatch Scheduler] Started — slow loop: " + (intervalMs / 60000) + "min, fast loop: " + (FAST_LOOP_INTERVAL_MS / 1000) + "s");

  // Inject config secrets (e.g. githubToken) into process.env at startup
  applyConfigEnv();

  // Slow loop — full inventory + version checks every 15min
  runCollection();
  setInterval(runCollection, intervalMs);

  // Fast loop — patch poll + command poll every 60s
  // First tick after 15s (let agent finish startup)
  setTimeout(() => {
    const deviceId = getDeviceId();

    const runFastLoop = () => {
      fastLoopPatchPoll(deviceId).catch(err =>
        console.warn("[OrchardPatch Poller] Unhandled error:", err.message)
      );
      fastLoopCommandPoll(deviceId).catch(err =>
        console.warn("[OrchardPatch Commander] Unhandled error:", err.message)
      );
    };

    runFastLoop();
    setInterval(runFastLoop, FAST_LOOP_INTERVAL_MS);
  }, 15000);
}

module.exports = { startScheduler, runCollection, readCache, writeCache, getCacheAge };
