#!/bin/bash
cd "$(dirname "$0")"
pkill -f "node server.mjs" 2>/dev/null
sleep 1
node server.mjs
