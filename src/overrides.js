/**
 * OrchardPatch Agent — Label Overrides
 * 
 * Allows admins to specify custom bundle ID → Installomator label mappings.
 * These take priority over catalog auto-detection.
 * 
 * Stored in /etc/orchardpatch/label-overrides.json
 */

const fs = require("fs");
const path = require("path");
const os = require("os");

const CONFIG_DIR = process.getuid && process.getuid() === 0
  ? "/etc/orchardpatch"
  : path.join(os.homedir(), ".orchardpatch");

const OVERRIDES_FILE = path.join(CONFIG_DIR, "label-overrides.json");

// In-memory overrides: { bundleId → label }
let overrides = {};

function loadOverrides() {
  try {
    if (fs.existsSync(OVERRIDES_FILE)) {
      overrides = JSON.parse(fs.readFileSync(OVERRIDES_FILE, "utf8"));
      console.log(`[Overrides] Loaded ${Object.keys(overrides).length} label overrides`);
    }
  } catch (err) {
    console.warn(`[Overrides] Could not load overrides: ${err.message}`);
  }
}

function saveOverrides() {
  try {
    if (!fs.existsSync(CONFIG_DIR)) fs.mkdirSync(CONFIG_DIR, { recursive: true });
    fs.writeFileSync(OVERRIDES_FILE, JSON.stringify(overrides, null, 2));
  } catch (err) {
    console.warn(`[Overrides] Could not save overrides: ${err.message}`);
  }
}

function getOverride(bundleId) {
  return overrides[bundleId] || null;
}

function setOverride(bundleId, label) {
  overrides[bundleId] = label;
  saveOverrides();
}

function deleteOverride(bundleId) {
  delete overrides[bundleId];
  saveOverrides();
}

function listOverrides() {
  return Object.entries(overrides).map(([bundleId, label]) => ({ bundleId, label }));
}

// Load on init
loadOverrides();

module.exports = { getOverride, setOverride, deleteOverride, listOverrides };
