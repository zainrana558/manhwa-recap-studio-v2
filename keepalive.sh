#!/bin/bash
# Keep both services alive
while true; do
    if ! lsof -i:3000 -sTCP:LISTEN >/dev/null 2>&1; then
        echo "$(date) Starting Next.js on 3000" >> /home/z/my-project/keepalive.log
        cd /home/z/my-project && bun run dev >> /home/z/my-project/dev.log 2>&1 &
    fi
    if ! lsof -i:3001 -sTCP:LISTEN >/dev/null 2>&1; then
        echo "$(date) Starting Pipeline on 3001" >> /home/z/my-project/keepalive.log
        cd /home/z/my-project/mini-services/pipeline-service && bun run dev >> /home/z/my-project/pipeline.log 2>&1 &
    fi
    sleep 5
done
