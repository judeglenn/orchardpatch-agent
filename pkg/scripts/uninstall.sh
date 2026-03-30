#!/bin/bash
# OrchardPatch Agent — uninstall
# Run as root: sudo /usr/local/orchardpatch/agent/pkg/scripts/uninstall.sh

LAUNCHDAEMON_PLIST="/Library/LaunchDaemons/com.orchardpatch.agent.plist"
AGENT_DIR="/usr/local/orchardpatch"
CONFIG_DIR="/etc/orchardpatch"

echo "[OrchardPatch] Uninstalling agent..."

# Unload and remove LaunchDaemon
if launchctl list | grep -q "com.orchardpatch.agent"; then
    launchctl unload "$LAUNCHDAEMON_PLIST" 2>/dev/null || true
fi
rm -f "$LAUNCHDAEMON_PLIST"

# Remove agent files
rm -rf "$AGENT_DIR"

# Optionally remove config (ask first in production)
# rm -rf "$CONFIG_DIR"

echo "[OrchardPatch] Agent uninstalled. Config preserved at $CONFIG_DIR"
echo "[OrchardPatch] To remove config: sudo rm -rf $CONFIG_DIR"
