#!/bin/bash
###############################################################################
# OrchardPatch — Jamf Enrollment Script
# Writes org-specific config after the agent PKG is installed.
#
# Parameters:
#   $1  Mount Point     (Jamf built-in — not used)
#   $2  Computer Name   (Jamf built-in — not used)
#   $3  Username        (Jamf built-in — not used)
#   $4  Enrollment Token  (your org token, e.g. "org_acme_abc123")
#   $5  Fleet Server URL  (e.g. "https://orchardpatch-server.fly.dev")
#
# Usage in Jamf Pro:
#   1. Upload this script to Jamf Pro (Scripts)
#   2. Create a Policy → add the OrchardPatch-Agent.pkg
#   3. Add this script to the same Policy (After)
#   4. Set Parameter 4 = your org token
#   5. Set Parameter 5 = your fleet server URL (or leave blank for default)
#
###############################################################################

ENROLLMENT_TOKEN="$4"
SERVER_URL="${5:-https://orchardpatch-server.fly.dev}"
CONFIG_DIR="/etc/orchardpatch"
CONFIG_FILE="$CONFIG_DIR/config.json"

# ── Validate ──────────────────────────────────────────────────────────────────
if [ -z "$ENROLLMENT_TOKEN" ]; then
    echo "[OrchardPatch] ERROR: No enrollment token provided (Parameter 4 is empty)."
    echo "[OrchardPatch] Set Parameter 4 in your Jamf policy to your org token."
    exit 1
fi

# ── Write config ──────────────────────────────────────────────────────────────
echo "[OrchardPatch] Writing org config..."
echo "[OrchardPatch]   Server:  $SERVER_URL"
echo "[OrchardPatch]   Token:   ${ENROLLMENT_TOKEN:0:8}... (truncated for log)"

mkdir -p "$CONFIG_DIR"
chmod 700 "$CONFIG_DIR"

cat > "$CONFIG_FILE" << CONFIGEOF
{
  "server": {
    "url": "$SERVER_URL",
    "token": "$ENROLLMENT_TOKEN"
  }
}
CONFIGEOF

chmod 600 "$CONFIG_FILE"
chown root:wheel "$CONFIG_FILE"

echo "[OrchardPatch] Config written to $CONFIG_FILE"

# ── Restart agent to pick up new config ──────────────────────────────────────
PLIST="/Library/LaunchDaemons/com.orchardpatch.agent.plist"
if [ -f "$PLIST" ]; then
    echo "[OrchardPatch] Restarting agent to apply new config..."
    launchctl unload "$PLIST" 2>/dev/null || true
    sleep 1
    launchctl load "$PLIST"
    echo "[OrchardPatch] Agent restarted."
else
    echo "[OrchardPatch] WARNING: LaunchDaemon not found at $PLIST — agent may not be installed yet."
    echo "[OrchardPatch] Make sure this script runs AFTER the OrchardPatch-Agent.pkg installs."
fi

# ── Verify ────────────────────────────────────────────────────────────────────
echo "[OrchardPatch] Waiting for agent to respond..."
for i in {1..10}; do
    sleep 1
    if curl -sf http://127.0.0.1:47652/health > /dev/null 2>&1; then
        echo "[OrchardPatch] ✅ Agent is running — device will check in to $SERVER_URL shortly."
        exit 0
    fi
done

echo "[OrchardPatch] WARNING: Agent did not respond within 10s. Check /var/log/orchardpatch/agent.log"
exit 0
