"use client";

import { useEffect, useRef } from "react";
import { Terminal } from "lucide-react";
import type { JobLogEntry } from "@/types/pipeline";
import { cn } from "@/lib/utils";

interface LogStreamProps {
  logs: JobLogEntry[];
}

const levelColor: Record<string, string> = {
  info: "text-zinc-300",
  success: "text-emerald-400",
  warn: "text-amber-400",
  error: "text-rose-400",
};

const stageColor: Record<string, string> = {
  search: "text-sky-400",
  scrape: "text-amber-400",
  summarize: "text-orange-400",
  translate: "text-purple-400",
  render: "text-emerald-400",
  merge: "text-teal-400",
  bgm: "text-pink-400",
  done: "text-emerald-300",
  cancel: "text-rose-400",
};

export function LogStream({ logs }: LogStreamProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const autoScrollRef = useRef(true);

  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    if (autoScrollRef.current) {
      el.scrollTop = el.scrollHeight;
    }
  }, [logs]);

  const handleScroll = () => {
    const el = containerRef.current;
    if (!el) return;
    const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 40;
    autoScrollRef.current = atBottom;
  };

  return (
    <div className="rounded-lg border border-border bg-zinc-950/60 overflow-hidden">
      <div className="flex items-center gap-2 px-3 py-2 border-b border-border bg-muted/30">
        <Terminal className="h-4 w-4 text-muted-foreground" />
        <span className="text-xs font-medium text-muted-foreground">Live log</span>
        <span className="text-xs text-muted-foreground/70 ml-auto">{logs.length} lines</span>
      </div>
      <div
        ref={containerRef}
        onScroll={handleScroll}
        className="h-64 overflow-y-auto scrollbar-thin p-3 font-mono text-xs space-y-0.5"
      >
        {logs.length === 0 ? (
          <p className="text-muted-foreground/50">Waiting for logs…</p>
        ) : (
          logs.map((log) => (
            <div key={log.id} className="flex gap-2 leading-relaxed">
              <span className="text-muted-foreground/50 flex-shrink-0">
                {new Date(log.createdAt).toLocaleTimeString("en-US", { hour12: false })}
              </span>
              {log.stage && (
                <span className={cn("flex-shrink-0 font-semibold", stageColor[log.stage] ?? "text-muted-foreground")}>
                  [{log.stage}]
                </span>
              )}
              <span className={cn("flex-1 break-words", levelColor[log.level] ?? "text-zinc-300")}>
                {log.message}
              </span>
            </div>
          ))
        )}
      </div>
    </div>
  );
}
