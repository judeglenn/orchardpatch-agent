/**
 * OrchardPatch Agent — Inventory Scheduler
 * Runs periodic inventory collection and caches results to disk.
 * Default interval: every 15 minutes.
 */

const fs = require("fs");
const path = require("path");
const { collectInventory } = require("./inventory");

const CACHE_DIR = path.join(process.env.HOME || "/var/root", ".orchardpatch");
const CACHE_FILE = path.join(CACHE_DIR, "inventory-cache.json");
const DEFAULT_INTERVAL_MS = 15 * 60 * 1000; // 15 minutes

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
    writeCache(inventory);
    return inventory;
  } catch (err) {
    console.error("[OrchardPatch Scheduler] Collection failed:", err.message);
    return null;
  }
}

function startScheduler(intervalMs = DEFAULT_INTERVAL_MS) {
  console.log(`[OrchardPatch Scheduler] Started — interval: ${intervalMs / 60000} minutes`);

  // Run immediately on start
  runCollection();

  // Then run on schedule
  setInterval(runCollection, intervalMs);
}

module.exports = { startScheduler, runCollection, readCache, getCacheAge };
