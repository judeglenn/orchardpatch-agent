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

const CACHE_MAX_AGE_MS = 15 * 60 * 1000; // serve cache if < 15 min old

const app = express();
const PORT = 47652; // OrchardPatch agent port
const CONFIG_PATH = path.join(process.env.HOME || "/var/root", ".orchardpatch", "config.json");

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
        const enrichedApps = cached.apps.map(app => ({
          ...app,
          latestVersion: latestVersions[app.bundleId] ?? null,
          isOutdated: latestVersions[app.bundleId]
            ? latestVersions[app.bundleId] !== app.version
            : false,
        }));
        return res.json({ ...cached, apps: enrichedApps, fromCache: true, cacheAgeMs: cacheAge });
      }
    }

    // Collect fresh
    const inventory = await runCollection();
    if (!inventory) throw new Error("Collection failed");

    // Enrich with latest version data
    const bundleIds = inventory.apps.map(a => a.bundleId);
    const latestVersions = await checkLatestVersions(bundleIds);

    const enrichedApps = inventory.apps.map(app => ({
      ...app,
      latestVersion: latestVersions[app.bundleId] ?? null,
      isOutdated: latestVersions[app.bundleId]
        ? latestVersions[app.bundleId] !== app.version
        : false,
    }));

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
  const { bundleId, label, appName, mode, deviceId } = req.body || {};

  if (!label || !appName) {
    return res.status(400).json({ error: "label and appName are required" });
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

// ─── Start ───────────────────────────────────────────────────────────────────

app.listen(PORT, "localhost", () => {
  console.log(`[OrchardPatch Agent] Listening on http://127.0.0.1:${PORT}`);
  console.log(`[OrchardPatch Agent] Config: ${CONFIG_PATH}`);
  // Start scheduled inventory collection
  startScheduler();
});
