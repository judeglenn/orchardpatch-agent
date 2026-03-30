/**
 * OrchardPatch Agent — Version Checker
 * Maps bundle IDs to Installomator labels and checks latest available versions.
 * Runs periodically to build a latest-version cache.
 */

const { execSync } = require("child_process");
const fs = require("fs");
const path = require("path");

const CACHE_DIR = path.join(process.env.HOME || "/var/root", ".orchardpatch");
const VERSION_CACHE_FILE = path.join(CACHE_DIR, "latest-versions.json");
const VERSION_CACHE_TTL = 24 * 60 * 60 * 1000; // 24 hours

/**
 * Bundle ID → { label, versionCheck }
 * versionCheck is a shell command or URL pattern that returns the latest version
 */
const BUNDLE_VERSION_MAP = {
  // Browsers
  "com.google.Chrome": {
    label: "googlechromepkg",
    check: () => fetchJSON("https://chromiumdash.appspot.com/fetch_releases?platform=Mac&channel=Stable&num=1", "[0].version"),
  },
  "org.mozilla.firefox": {
    label: "firefox",
    check: () => fetchJSON("https://product-details.mozilla.org/1.0/firefox_versions.json", "LATEST_FIREFOX_VERSION"),
  },
  "com.microsoft.edgemac": {
    label: "microsoftedge",
    check: () => fetchJSON("https://edgeupdates.microsoft.com/api/products?view=enterprise", null, (data) => {
      const stable = data?.find(p => p.Product === "Stable");
      return stable?.Releases?.[0]?.ProductVersion ?? null;
    }),
  },

  // Communication
  "us.zoom.xos": {
    label: "zoom",
    check: () => fetchHeaderVersion("https://zoom.us/client/latest/ZoomInstallerIT.pkg", 5),
  },
  "com.tinyspeck.slackmacgap": {
    label: "slack",
    check: () => fetchHeaderVersion("https://slack.com/ssb/download-osx-universal", 7),
  },
  "com.microsoft.teams2": {
    label: "microsoftteams",
    check: () => fetchHeaderVersion("https://go.microsoft.com/fwlink/?linkid=2249065", 6),
  },

  // Microsoft Office
  "com.microsoft.Word": {
    label: "microsoftword",
    check: () => fetchMicrosoftVersion("Word"),
  },
  "com.microsoft.Excel": {
    label: "microsoftexcel",
    check: () => fetchMicrosoftVersion("Excel"),
  },
  "com.microsoft.Powerpoint": {
    label: "microsoftpowerpoint",
    check: () => fetchMicrosoftVersion("PowerPoint"),
  },
  "com.microsoft.Outlook": {
    label: "microsoftoutlook",
    check: () => fetchMicrosoftVersion("Outlook"),
  },
  "com.microsoft.onenote.mac": {
    label: "microsoftonenote",
    check: () => fetchMicrosoftVersion("OneNote"),
  },

  // Dev tools
  "com.microsoft.VSCode": {
    label: "visualstudiocode",
    check: () => fetchJSON("https://update.code.visualstudio.com/api/releases/stable", null, (data) => data?.[0] ?? null),
  },
  "com.docker.docker": {
    label: "docker",
    check: () => fetchJSON("https://desktop.docker.com/mac/main/arm64/appcast.xml", null, null), // RSS - skip for now
  },

  // Productivity
  "com.figma.Desktop": {
    label: "figma",
    check: () => null, // Figma auto-updates, skip
  },
  "notion.id": {
    label: "notion",
    check: () => null,
  },

  // Security
  "com.agilebits.onepassword7": {
    label: "1password7",
    check: () => fetchJSON("https://app-updates.agilebits.com/check/1/20/OPM7/en/7.0/N", "version"),
  },
  "com.agilebits.onepassword8": {
    label: "1password8",
    check: () => null,
  },
};

/**
 * Fetch a JSON value from a URL
 */
async function fetchJSON(url, key, transform) {
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(8000) });
    if (!res.ok) return null;
    const data = await res.json();
    if (transform) return transform(data);
    if (!key) return null;
    // Support dot notation like "[0].version"
    return key.split(".").reduce((obj, k) => {
      const arrMatch = k.match(/\[(\d+)\]/);
      if (arrMatch) return obj?.[parseInt(arrMatch[1])];
      return obj?.[k];
    }, data);
  } catch {
    return null;
  }
}

/**
 * Follow redirects and extract version from URL path segment
 */
async function fetchHeaderVersion(url, segmentIndex) {
  try {
    const res = await fetch(url, {
      method: "HEAD",
      redirect: "manual",
      signal: AbortSignal.timeout(8000),
    });
    const location = res.headers.get("location") || "";
    const segments = location.split("/");
    return segments[segmentIndex] ?? null;
  } catch {
    return null;
  }
}

/**
 * Microsoft Office version from their update feed
 */
async function fetchMicrosoftVersion(app) {
  try {
    const res = await fetch("https://macadmins.software/latest.xml", {
      signal: AbortSignal.timeout(8000),
    });
    if (!res.ok) return null;
    const text = await res.text();
    // Parse the version from macadmins.software XML
    const match = text.match(new RegExp(`<title>${app}[^<]*</title>[\\s\\S]*?<version>([^<]+)</version>`));
    return match?.[1] ?? null;
  } catch {
    return null;
  }
}

/**
 * Check latest versions for a list of installed apps
 * Returns { bundleId: latestVersion } map
 */
async function checkLatestVersions(installedBundleIds) {
  // Check cache first
  const cacheAge = getVersionCacheAge();
  if (cacheAge < VERSION_CACHE_TTL) {
    const cached = readVersionCache();
    if (cached) {
      console.log(`[OrchardPatch Versions] Using cached versions (${Math.round(cacheAge / 3600000)}h old)`);
      return cached;
    }
  }

  console.log("[OrchardPatch Versions] Checking latest versions...");
  const results = {};
  const toCheck = installedBundleIds.filter(id => BUNDLE_VERSION_MAP[id]);

  await Promise.allSettled(
    toCheck.map(async (bundleId) => {
      try {
        const { check } = BUNDLE_VERSION_MAP[bundleId];
        const version = await check();
        if (version) {
          results[bundleId] = String(version).trim();
        }
      } catch {
        // Skip failed checks
      }
    })
  );

  console.log(`[OrchardPatch Versions] Got latest versions for ${Object.keys(results).length} apps`);
  writeVersionCache(results);
  return results;
}

function writeVersionCache(data) {
  if (!fs.existsSync(CACHE_DIR)) fs.mkdirSync(CACHE_DIR, { recursive: true });
  fs.writeFileSync(VERSION_CACHE_FILE, JSON.stringify(data, null, 2));
}

function readVersionCache() {
  try {
    if (fs.existsSync(VERSION_CACHE_FILE)) {
      return JSON.parse(fs.readFileSync(VERSION_CACHE_FILE, "utf8"));
    }
  } catch { /* ignore */ }
  return null;
}

function getVersionCacheAge() {
  try {
    if (fs.existsSync(VERSION_CACHE_FILE)) {
      return Date.now() - fs.statSync(VERSION_CACHE_FILE).mtimeMs;
    }
  } catch { /* ignore */ }
  return Infinity;
}

module.exports = { checkLatestVersions, BUNDLE_VERSION_MAP };
