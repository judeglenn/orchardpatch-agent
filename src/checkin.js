/**
 * OrchardPatch Agent — Central Server Check-in
 * Reports inventory to the OrchardPatch central server periodically.
 * Non-blocking — agent works fine if server is unreachable.
 */

const fs = require("fs");
const path = require("path");
const os = require("os");
const { enrichAppsWithLabels } = require("./catalog");

const CONFIG_PATH = process.getuid && process.getuid() === 0
  ? "/etc/orchardpatch/config.json"
  : path.join(os.homedir(), ".orchardpatch", "config.json");

const DEVICE_ID_DIR = process.getuid && process.getuid() === 0
  ? "/var/root/.orchardpatch"
  : path.join(os.homedir(), ".orchardpatch");
const DEVICE_ID_FILE = path.join(DEVICE_ID_DIR, "device-id.json");

const AGENT_VERSION = "0.1.0";

function saveDeviceId(deviceId) {
  try {
    if (!fs.existsSync(DEVICE_ID_DIR)) fs.mkdirSync(DEVICE_ID_DIR, { recursive: true });
    fs.writeFileSync(DEVICE_ID_FILE, JSON.stringify({ deviceId }));
  } catch { /* non-fatal */ }
}

function loadDeviceId() {
  try {
    if (fs.existsSync(DEVICE_ID_FILE)) {
      return JSON.parse(fs.readFileSync(DEVICE_ID_FILE, "utf8")).deviceId || null;
    }
  } catch { /* ignore */ }
  return null;
}

function loadConfig() {
  try {
    if (fs.existsSync(CONFIG_PATH)) {
      return JSON.parse(fs.readFileSync(CONFIG_PATH, "utf8"));
    }
  } catch { /* ignore */ }
  return {};
}

/**
 * Report inventory to the central OrchardPatch server.
 * Config must have: server.url and server.token
 */
async function checkinToServer(inventory) {
  const config = loadConfig();
  const serverUrl = config.server?.url || process.env.ORCHARDPATCH_SERVER_URL;
  const serverToken = config.server?.token || process.env.ORCHARDPATCH_SERVER_TOKEN;

  if (!serverUrl || !serverToken) {
    // Not configured — silently skip
    return;
  }

  const enrichedApps = enrichAppsWithLabels(inventory.apps);
  const payload = {
    device: inventory.device,
    apps: enrichedApps,
    agentVersion: AGENT_VERSION,
    collectedAt: inventory.collectedAt || new Date().toISOString(),
  };

  const res = await fetch(`${serverUrl}/checkin`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-orchardpatch-token": serverToken,
    },
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(15000),
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Server returned ${res.status}: ${text}`);
  }

  const data = await res.json();
  console.log(`[CheckIn] Reported to server — deviceId: ${data.deviceId}`);
  if (data.deviceId) saveDeviceId(data.deviceId);
  return data;
}

/**
 * Report a completed patch job to the central server.
 */
async function reportPatchJob(job) {
  const config = loadConfig();
  const serverUrl = config.server?.url || process.env.ORCHARDPATCH_SERVER_URL;
  const serverToken = config.server?.token || process.env.ORCHARDPATCH_SERVER_TOKEN;

  if (!serverUrl || !serverToken) return;

  await fetch(`${serverUrl}/patch-jobs`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-orchardpatch-token": serverToken,
    },
    body: JSON.stringify({
      jobId: job.id,
      deviceId: loadDeviceId() || job.deviceId || `device-${os.hostname()}`,
      bundleId: job.bundleId,
      appName: job.appName,
      label: job.label,
      mode: job.mode,
      status: job.status,
      exitCode: job.exitCode,
      error: job.error,
      log: job.log,
      createdAt: job.createdAt,
      startedAt: job.startedAt,
      completedAt: job.completedAt,
    }),
    signal: AbortSignal.timeout(10000),
  });
}

/**
 * Fetch pending patches assigned to this device from the fleet server.
 * Returns an array of patch objects (may be empty).
 */
async function fetchPendingPatches(deviceId) {
  const config = loadConfig();
  const serverUrl = config.server?.url || process.env.ORCHARDPATCH_SERVER_URL;
  const serverToken = config.server?.token || process.env.ORCHARDPATCH_SERVER_TOKEN;

  if (!serverUrl || !serverToken) return [];

  const res = await fetch(
    `${serverUrl}/pending-patches?device_id=${encodeURIComponent(deviceId)}`,
    {
      headers: { "x-orchardpatch-token": serverToken },
      signal: AbortSignal.timeout(10000),
    }
  );

  if (!res.ok) return [];
  const data = await res.json();
  return Array.isArray(data) ? data : (data.patches || []);
}

/**
 * Claim a pending patch so no other agent picks it up.
 * Returns true if successfully claimed.
 */
async function claimPatch(patchId) {
  const config = loadConfig();
  const serverUrl = config.server?.url || process.env.ORCHARDPATCH_SERVER_URL;
  const serverToken = config.server?.token || process.env.ORCHARDPATCH_SERVER_TOKEN;

  if (!serverUrl || !serverToken) return false;

  const res = await fetch(`${serverUrl}/pending-patches/${patchId}/claim`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-orchardpatch-token": serverToken,
    },
    signal: AbortSignal.timeout(10000),
  });

  return res.ok;
}

module.exports = { checkinToServer, reportPatchJob, fetchPendingPatches, claimPatch, saveDeviceId, loadDeviceId };
