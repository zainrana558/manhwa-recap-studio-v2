#!/bin/bash
# Keepalive wrapper for Next.js dev server
# Restarts the server automatically if it crashes
cd /home/z/my-project
while true; do
  echo "[$(date)] Starting dev server..." >> keepalive.log
  bun --bun run dev >> dev.log 2>&1
  EXIT_CODE=$?
  echo "[$(date)] Server exited with code $EXIT_CODE, restarting in 2s..." >> keepalive.log
  sleep 2
done
