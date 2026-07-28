#!/bin/bash
# Keep both services alive with proper duplicate detection
PID_NEXT=""
PID_PIPE=""

start_next() {
    cd /home/z/my-project
    HOST=0.0.0.0 nohup bun run dev >> /home/z/my-project/dev.log 2>&1 &
    PID_NEXT=$!
    echo "$(date) Started Next.js PID=$PID_NEXT" >> /home/z/my-project/keepalive.log
}

start_pipe() {
    cd /home/z/my-project/mini-services/pipeline-service
    nohup bun --hot run index.ts >> /home/z/my-project/pipeline-service.log 2>&1 &
    PID_PIPE=$!
    echo "$(date) Started Pipeline PID=$PID_PIPE" >> /home/z/my-project/keepalive.log
}

while true; do
    # Check if Next.js is actually listening
    if ! ss -tlnp 2>/dev/null | grep -q ":3000 "; then
        # Kill any stale process
        [ -n "$PID_NEXT" ] && kill "$PID_NEXT" 2>/dev/null
        start_next
    fi
    # Check if pipeline service is listening
    if ! ss -tlnp 2>/dev/null | grep -q ":3001 "; then
        [ -n "$PID_PIPE" ] && kill "$PID_PIPE" 2>/dev/null
        start_pipe
    fi
    sleep 8
done
