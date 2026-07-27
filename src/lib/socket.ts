"use client";

import { io, type Socket } from "socket.io-client";

let socket: Socket | null = null;

/**
 * Singleton socket.io client.
 * Connects through the Caddy gateway using XTransformPort=3001 so the
 * request is forwarded to the pipeline mini-service. Path MUST be "/".
 */
export function getSocket(): Socket {
  if (!socket) {
    socket = io({
      path: "/",
      query: { XTransformPort: "3001" },
      transports: ["polling", "websocket"],
      reconnection: true,
      reconnectionDelay: 1500,
      reconnectionAttempts: 20,
      timeout: 20000,
    });
  }
  return socket;
}

export function disconnectSocket() {
  if (socket) {
    socket.removeAllListeners();
    socket.disconnect();
    socket = null;
  }
}
