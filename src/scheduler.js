/**
 * OrchardPatch Agent — Inventory Scheduler
 * Runs periodic inventory collection and caches results to disk.
 * Default interval: every 15 minutes.
 */

const fs = require("fs");
const path = require("path");
const os = require("os");
const { collectInventory } = require("./inventory");
const { checkinToServer, fetchPendingPatches, claimPatch, reportPatchJob } = require("./checkin");
const { enrichAppsWithLabels, lookupLabel } = require("./catalog");
const { runPatchJob } = require("./patcher");
const { getOverride } = require("./overrides");
const { runVersionCheck } = require("./version-checker");

const CACHE_DIR = path.join(process.env.HOME || "/var/root", ".orchardpatch");
const CACHE_FILE = path.join(CACHE_DIR, "inventory-cache.json");
const DEFAULT_INTERVAL_MS = 15 * 60 * 1000; // 15 minutes
const POLL_INTERVAL_MS = 45 * 1000; // 45 seconds

// Version check: run every N check-ins (configurable)
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
  console.log(`[OrchardPatch Scheduler] Cache written: ${inventory.apps.length} apps`);
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

async function runCollection() {
  try {
    console.log("[OrchardPatch Scheduler] Running scheduled inventory collection...");
    const inventory = collectInventory();
    // Enrich with Installomator labels before caching and check-in
    inventory.apps = enrichAppsWithLabels(inventory.apps);
    writeCache(inventory);
    // Report to central server if configured (non-blocking)
    checkinToServer(inventory).catch(err =>
      console.warn("[OrchardPatch Scheduler] Server check-in failed:", err.message)
    );

    // Every N check-ins, run a version batch and ingest results to fleet server
    // Fire-and-forget — does not block the check-in response
    checkinCount++;
    if (checkinCount % VERSION_CHECK_INTERVAL === 0) {
      console.log(`[OrchardPatch Scheduler] Check-in #${checkinCount} — triggering version check batch`);
      runVersionCheck(inventory.apps).catch(err =>
        console.warn("[OrchardPatch Scheduler] Version check failed:", err.message)
      );
    }

    return inventory;
  } catch (err) {
    console.error("[OrchardPatch Scheduler] Collection failed:", err.message);
    return null;
  }
}

function getDeviceId() {
  return `device-${os.hostname()}`;
}

function waitForJob(job) {
  return new Promise((resolve) => {
    const check = setInterval(() => {
      if (job.status === "success" || job.status === "failed") {
        clearInterval(check);
        resolve(job);
      }
    }, 2000);
    // Timeout after 10 minutes
    setTimeout(() => { clearInterval(check); resolve(job); }, 10 * 60 * 1000);
  });
}

async function pollAndRunPatches() {
  const deviceId = getDeviceId();
  let patches;
  try {
    patches = await fetchPendingPatches(deviceId);
  } catch (err) {
    console.warn("[OrchardPatch Poller] Failed to fetch pending patches:", err.message);
    return;
  }

  if (!patches.length) return;

  console.log(`[OrchardPatch Poller] Found ${patches.length} pending patch(es)`);

  for (const patch of patches) {
    try {
      const claimed = await claimPatch(patch.id);
      if (!claimed) {
        console.log(`[OrchardPatch Poller] Could not claim patch ${patch.id} — skipping`);
        continue;
      }

      const { bundleId, appName, mode } = patch;
      let { label } = patch;

      if (!label && bundleId) {
        label = getOverride(bundleId) || lookupLabel(appName, bundleId) || null;
      }

      if (!label) {
        console.warn(`[OrchardPatch Poller] No label for "${appName}" (${bundleId || "no bundle ID"}) — skipping`);
        continue;
      }

      console.log(`[OrchardPatch Poller] Running patch: ${appName} (${label}) mode=${mode || "managed"}`);
      const job = await runPatchJob(label, appName, mode || "managed", deviceId);

      await waitForJob(job);

      reportPatchJob(job).catch(err =>
        console.warn("[OrchardPatch Poller] Failed to report patch job:", err.message)
      );
    } catch (err) {
      console.error(`[OrchardPatch Poller] Error processing patch ${patch.id}:`, err.message);
    }
  }
}

function startScheduler(intervalMs = DEFAULT_INTERVAL_MS) {
  console.log(`[OrchardPatch Scheduler] Started — interval: ${intervalMs / 60000} minutes`);

  // Run immediately on start
  runCollection();

  // Then run on schedule
  setInterval(runCollection, intervalMs);

  // Poll fleet server for pending patches
  console.log(`[OrchardPatch Poller] Started — interval: ${POLL_INTERVAL_MS / 1000}s`);
  // First poll after 15 seconds (let agent finish startup)
  setTimeout(() => {
    pollAndRunPatches().catch(err =>
      console.warn("[OrchardPatch Poller] Unhandled error:", err.message)
    );
    setInterval(() => {
      pollAndRunPatches().catch(err =>
        console.warn("[OrchardPatch Poller] Unhandled error:", err.message)
      );
    }, POLL_INTERVAL_MS);
  }, 15000);
}

module.exports = { startScheduler, runCollection, readCache, writeCache, getCacheAge };
