/**
 * OrchardPatch Agent — Local HTTP Server
 * Runs on localhost:47652 and exposes inventory data to the OrchardPatch web app.
 * The web app talks to this agent; the agent talks to Jamf and the local machine.
 */

const express = require("express");
const cors = require("cors");
const helmet = require("helmet");
const fs = require("fs");
const path = require("path");
const { collectInventory } = require("./inventory");
const { getJamfInventory } = require("./jamf");
const { startScheduler, runCollection, readCache, getCacheAge } = require("./scheduler");
const { checkLatestVersions, BUNDLE_VERSION_MAP } = require("./versions");
const { runPatchJob, getJob, listJobs, ensureInstallomator, findInstallomator, getSudoersInstruction } = require("./patcher");
const { syncCatalog, enrichAppsWithLabels, lookupLabel, getCatalog, getCatalogAge } = require("./catalog");
const { getOverride, setOverride, deleteOverride, listOverrides } = require("./overrides");

const CACHE_MAX_AGE_MS = 15 * 60 * 1000; // serve cache if < 15 min old

// Compare versions loosely — strips parentheses, spaces, normalizes separators
// "7.0.0 (77593)" === "7.0.0.77593" → true
function normalizeVersion(v) {
  return v.replace(/[)(]/g, "").replace(/\s+/g, ".").replace(/\.+/g, ".").trim();
}
function versionsMatch(a, b) {
  if (!a || !b) return false;
  const na = normalizeVersion(a);
  const nb = normalizeVersion(b);
  if (na === nb) return true;
  // Also compare just the numeric parts
  const digitsA = na.replace(/[^0-9.]/g, "");
  const digitsB = nb.replace(/[^0-9.]/g, "");
  return digitsA === digitsB;
}

const app = express();
const PORT = 47652; // OrchardPatch agent port
// When running as LaunchDaemon (root), config lives in /etc/orchardpatch
// When running as user (dev), falls back to ~/.orchardpatch
const CONFIG_PATH = process.getuid && process.getuid() === 0
  ? "/etc/orchardpatch/config.json"
  : path.join(process.env.HOME || "/var/root", ".orchardpatch", "config.json");

// Security — only allow requests from localhost
app.use(cors({ origin: ["http://localhost:3000", "https://orchardpatch.vercel.app", /\.orchardpatch\.com$/] }));
app.use(helmet());
app.use(express.json());

// Simple token auth — set during agent setup
const AGENT_TOKEN = process.env.ORCHARDPATCH_TOKEN || loadConfig()?.agentToken;

function loadConfig() {
  try {
    if (fs.existsSync(CONFIG_PATH)) {
      return JSON.parse(fs.readFileSync(CONFIG_PATH, "utf8"));
    }
  } catch { /* ignore */ }
  return {};
}

function saveConfig(config) {
  const dir = path.dirname(CONFIG_PATH);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2));
}

function authMiddleware(req, res, next) {
  const token = req.headers["x-agent-token"];
  if (AGENT_TOKEN && token !== AGENT_TOKEN) {
    return res.status(401).json({ error: "Unauthorized" });
  }
  next();
}

// ─── Routes ──────────────────────────────────────────────────────────────────

// Health check — web app uses this to detect if agent is running
app.get("/health", (req, res) => {
  const cacheAge = getCacheAge();
  res.json({
    status: "ok",
    agent: "orchardpatch",
    version: "0.1.0",
    hostname: require("os").hostname(),
    lastInventoryMs: cacheAge === Infinity ? null : cacheAge,
    lastInventoryAgo: cacheAge === Infinity ? "never" : `${Math.round(cacheAge / 60000)}m ago`,
  });
});

// Manual sync trigger
app.post("/inventory/sync", authMiddleware, async (req, res) => {
  try {
    const inventory = await runCollection();
    res.json({ success: true, appCount: inventory?.apps?.length ?? 0 });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Local device inventory — serves cache if fresh, collects fresh if stale
app.get("/inventory/local", authMiddleware, async (req, res) => {
  try {
    const forceRefresh = req.query.refresh === "true";
    const cacheAge = getCacheAge();

    if (!forceRefresh && cacheAge < CACHE_MAX_AGE_MS) {
      const cached = readCache();
      if (cached) {
        const bundleIds = cached.apps.map(a => a.bundleId);
        const latestVersions = await checkLatestVersions(bundleIds);
        let enrichedApps = cached.apps.map(app => ({
          ...app,
          latestVersion: latestVersions[app.bundleId] ?? null,
          isOutdated: latestVersions[app.bundleId]
            ? !versionsMatch(latestVersions[app.bundleId], app.version)
            : false,
        }));
        enrichedApps = enrichAppsWithLabels(enrichedApps);
        return res.json({ ...cached, apps: enrichedApps, fromCache: true, cacheAgeMs: cacheAge });
      }
    }

    // Collect fresh
    const inventory = await runCollection();
    if (!inventory) throw new Error("Collection failed");

    // Enrich with latest version data
    const bundleIds = inventory.apps.map(a => a.bundleId);
    const latestVersions = await checkLatestVersions(bundleIds);

    let enrichedApps = inventory.apps.map(app => ({
      ...app,
      latestVersion: latestVersions[app.bundleId] ?? null,
      isOutdated: latestVersions[app.bundleId]
        ? !versionsMatch(latestVersions[app.bundleId], app.version)
        : false,
    }));

    // Enrich with Installomator labels from catalog
    enrichedApps = enrichAppsWithLabels(enrichedApps);

    res.json({ ...inventory, apps: enrichedApps, fromCache: false });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Jamf fleet inventory (if configured)
app.get("/inventory/jamf", authMiddleware, async (req, res) => {
  const config = loadConfig();
  try {
    const computers = await getJamfInventory(config.jamf);
    if (!computers) {
      return res.status(503).json({ error: "Jamf not configured or unreachable" });
    }
    res.json({ computers, totalCount: computers.length });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Save Jamf config
app.post("/config/jamf", authMiddleware, (req, res) => {
  const { serverUrl, clientId, clientSecret } = req.body;
  if (!serverUrl || !clientId || !clientSecret) {
    return res.status(400).json({ error: "Missing required fields" });
  }
  const config = loadConfig();
  config.jamf = { serverUrl, clientId, clientSecret };
  saveConfig(config);
  res.json({ success: true });
});

// Get config (without secrets)
app.get("/config", authMiddleware, (req, res) => {
  const config = loadConfig();
  res.json({
    jamf: config.jamf ? {
      serverUrl: config.jamf.serverUrl,
      clientId: config.jamf.clientId,
      configured: true,
    } : null,
  });
});

// ─── Patching ────────────────────────────────────────────────────────────────

// Check if patching is ready (Installomator present, sudo configured)
app.get("/patch/status", authMiddleware, (req, res) => {
  const installomatorPath = findInstallomator();
  res.json({
    ready: !!installomatorPath,
    installomatorPath: installomatorPath || null,
    sudoersInstruction: installomatorPath ? null : getSudoersInstruction(),
    hint: installomatorPath
      ? "Installomator found. Ensure sudoers is configured for passwordless sudo."
      : "Installomator not found. Run: POST /patch/install to download it.",
  });
});

// Download and install Installomator
app.post("/patch/install", authMiddleware, async (req, res) => {
  try {
    const installomatorPath = await ensureInstallomator();
    res.json({
      success: true,
      installomatorPath,
      sudoersInstruction: getSudoersInstruction(),
    });
  } catch (err) {
    res.status(500).json({ error: err.message, sudoersInstruction: getSudoersInstruction() });
  }
});

// Queue a patch job
// Body: { bundleId, label, appName, mode: "silent"|"managed"|"prompted", deviceId? }
app.post("/patch", authMiddleware, async (req, res) => {
  const { bundleId, appName, mode, deviceId } = req.body || {};
  let { label } = req.body || {};

  if (!appName) {
    return res.status(400).json({ error: "appName is required" });
  }

  // Resolve label: explicit > override > catalog auto-detect
  if (!label && bundleId) {
    label = getOverride(bundleId) || lookupLabel(appName, bundleId) || null;
  }

  if (!label) {
    return res.status(400).json({
      error: `No Installomator label found for "${appName}" (${bundleId || "no bundle ID"}). Add a label override in Settings.`,
      bundleId,
      appName,
    });
  }

  const validModes = ["silent", "managed", "prompted"];
  const patchMode = validModes.includes(mode) ? mode : "managed";

  console.log(`[Patch] Queuing: ${appName} (${label}) mode=${patchMode}`);

  try {
    const job = await runPatchJob(label, appName, patchMode, deviceId);
    res.json({
      jobId: job.id,
      status: job.status,
      appName: job.appName,
      label: job.label,
      mode: job.mode,
      createdAt: job.createdAt,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Poll a patch job's status
app.get("/patch/:jobId", authMiddleware, (req, res) => {
  const job = getJob(req.params.jobId);
  if (!job) return res.status(404).json({ error: "Job not found" });
  res.json(job);
});

// List recent patch jobs
app.get("/patch", authMiddleware, (req, res) => {
  const limit = parseInt(req.query.limit) || 50;
  res.json({ jobs: listJobs().slice(0, limit) });
});

// ─── Label Overrides ─────────────────────────────────────────────────────────

// List all overrides
app.get("/overrides", authMiddleware, (req, res) => {
  res.json({ overrides: listOverrides() });
});

// Set an override
app.post("/overrides", authMiddleware, (req, res) => {
  const { bundleId, label } = req.body || {};
  if (!bundleId || !label) {
    return res.status(400).json({ error: "bundleId and label are required" });
  }
  setOverride(bundleId, label);
  res.json({ success: true, bundleId, label });
});

// Delete an override
app.delete("/overrides/:bundleId", authMiddleware, (req, res) => {
  const bundleId = decodeURIComponent(req.params.bundleId);
  deleteOverride(bundleId);
  res.json({ success: true, bundleId });
});

// Resolve the best label for a bundle ID (override > catalog > null)
app.get("/overrides/resolve/:bundleId", authMiddleware, (req, res) => {
  const bundleId = decodeURIComponent(req.params.bundleId);
  const override = getOverride(bundleId);
  const catalogLabel = lookupLabel(null, bundleId);
  res.json({
    bundleId,
    label: override || catalogLabel || null,
    source: override ? "override" : catalogLabel ? "catalog" : "none",
  });
});

// ─── Catalog ─────────────────────────────────────────────────────────────────

// Get catalog status
app.get("/catalog/status", authMiddleware, (req, res) => {
  const cat = getCatalog();
  const age = getCatalogAge();
  res.json({
    synced: !!cat.syncedAt,
    syncedAt: cat.syncedAt,
    ageHours: age === Infinity ? null : Math.round(age / 3600000),
    labelCount: cat.labelList.length,
    nameCount: Object.keys(cat.byName).length,
    bundleIdCount: Object.keys(cat.byBundleId).length,
  });
});

// Force catalog resync
app.post("/catalog/sync", authMiddleware, async (req, res) => {
  try {
    res.json({ started: true, message: "Catalog sync started in background" });
    await syncCatalog(true);
  } catch (err) {
    console.error("[Catalog] Manual sync failed:", err.message);
  }
});

// ─── Start ───────────────────────────────────────────────────────────────────

app.listen(PORT, "127.0.0.1", () => {
  console.log(`[OrchardPatch Agent] Listening on http://127.0.0.1:${PORT}`);
  console.log(`[OrchardPatch Agent] Config: ${CONFIG_PATH}`);
  // Start scheduled inventory collection
  startScheduler();
});
