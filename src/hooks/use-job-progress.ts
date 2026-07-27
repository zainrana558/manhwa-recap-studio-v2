"use client";

import { useEffect, useRef, useState, useCallback } from "react";
import { getSocket } from "@/lib/socket";
import type { JobSummary, JobLogEntry, ChapterInfo, ServerEvent } from "@/types/pipeline";

interface UseJobProgressResult {
  job: JobSummary | null;
  logs: JobLogEntry[];
  connected: boolean;
}

/**
 * Subscribe to a job's live progress via socket.io.
 * Also bootstraps the initial state from the REST API so the UI
 * isn't blank while the socket connects.
 */
export function useJobProgress(jobId: string | null): UseJobProgressResult {
  const [job, setJob] = useState<JobSummary | null>(null);
  const [logs, setLogs] = useState<JobLogEntry[]>([]);
  const [connected, setConnected] = useState(false);

  const mergeChapter = useCallback((chapter: ChapterInfo) => {
    setJob((prev) =>
      prev
        ? {
            ...prev,
            chapters: prev.chapters.map((c) =>
              c.index === chapter.index ? chapter : c
            ),
          }
        : prev
    );
  }, []);

  // Reset state when jobId changes (React-recommended "adjust state during render" pattern).
  const [prevJobId, setPrevJobId] = useState<string | null>(jobId);
  if (jobId !== prevJobId) {
    setPrevJobId(jobId);
    setJob(null);
    setLogs([]);
    setConnected(false);
  }

  useEffect(() => {
    if (!jobId) {
      return;
    }

    let cancelled = false;

    // Bootstrap from REST first.
    fetch(`/api/jobs/${jobId}`)
      .then((r) => (r.ok ? r.json() : null))
      .then((data) => {
        if (cancelled || !data) return;
        setJob(data.job);
        setLogs(data.logs ?? []);
      })
      .catch(() => {});

    const socket = getSocket();

    const onConnect = () => {
      setConnected(true);
      socket.emit("subscribe", { jobId });
    };
    const onDisconnect = () => setConnected(false);
    const onSubscribed = () => {
      // Receiving the subscribed ack means the socket is live.
      setConnected(true);
    };
    const onStatus = (payload: ServerEvent) => {
      if (payload.type === "status" && payload.job) setJob(payload.job);
    };
    const onLog = (payload: ServerEvent) => {
      if (payload.type === "log" && payload.log) {
        setLogs((prev) => {
          const next = [...prev, payload.log as JobLogEntry];
          // Cap at 500 lines to avoid memory bloat.
          return next.length > 500 ? next.slice(-500) : next;
        });
      }
    };
    const onProgress = (payload: ServerEvent) => {
      if (payload.type !== "progress") return;
      setJob((prev) =>
        prev
          ? {
              ...prev,
              progress: payload.progress ?? prev.progress,
              doneChapters: payload.doneChapters ?? prev.doneChapters,
              totalChapters: payload.totalChapters ?? prev.totalChapters,
              doneImages: payload.doneImages ?? prev.doneImages,
              totalImages: payload.totalImages ?? prev.totalImages,
              stage: payload.stage ?? prev.stage,
              message: payload.message ?? prev.message,
            }
          : prev
      );
    };
    const onChapter = (payload: ServerEvent) => {
      if (payload.type === "chapter" && payload.chapter) {
        mergeChapter(payload.chapter as ChapterInfo);
      }
    };
    const onDone = (payload: ServerEvent) => {
      if (payload.type !== "done") return;
      setJob((prev) =>
        prev
          ? {
              ...prev,
              status: "done",
              progress: 100,
              outputVideo: payload.outputVideo ?? prev.outputVideo,
              message: "Pipeline complete.",
            }
          : prev
      );
    };
    const onError = (payload: ServerEvent) => {
      if (payload.type !== "error") return;
      setJob((prev) =>
        prev
          ? { ...prev, status: "error", error: payload.error ?? "Unknown error" }
          : prev
      );
    };
    const onCancelled = (payload: ServerEvent) => {
      if (payload.type !== "cancelled") return;
      setJob((prev) => (prev ? { ...prev, status: "cancelled" } : prev));
    };

    socket.on("connect", onConnect);
    socket.on("disconnect", onDisconnect);
    socket.on("subscribed", onSubscribed);
    socket.on("status", onStatus);
    socket.on("log", onLog);
    socket.on("progress", onProgress);
    socket.on("chapter", onChapter);
    socket.on("done", onDone);
    socket.on("error", onError);
    socket.on("cancelled", onCancelled);

    if (socket.connected) {
      // Already connected (persistent socket) — just subscribe.
      // connected state will be set by the `subscribed` ack.
      socket.emit("subscribe", { jobId });
    }

    return () => {
      cancelled = true;
      socket.emit("unsubscribe", { jobId });
      socket.off("connect", onConnect);
      socket.off("disconnect", onDisconnect);
      socket.off("subscribed", onSubscribed);
      socket.off("status", onStatus);
      socket.off("log", onLog);
      socket.off("progress", onProgress);
      socket.off("chapter", onChapter);
      socket.off("done", onDone);
      socket.off("error", onError);
      socket.off("cancelled", onCancelled);
    };
  }, [jobId, mergeChapter]);

  return { job, logs, connected };
}
