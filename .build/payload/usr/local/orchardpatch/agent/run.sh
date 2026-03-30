#!/bin/bash
# OrchardPatch Agent — startup wrapper
cd /usr/local/orchardpatch/agent
exec /usr/local/bin/node src/server.js
