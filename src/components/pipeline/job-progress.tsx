"use client";

import { useCallback } from "react";
import {
  Loader2,
  CheckCircle2,
  AlertCircle,
  XCircle,
  Wifi,
  WifiOff,
  Search as SearchIcon,
  ScanLine,
  Eye,
  Scissors,
  Clapperboard,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Progress } from "@/components/ui/progress";
import { Badge } from "@/components/ui/badge";
import { ChapterGrid } from "./chapter-grid";
import { LogStream } from "./log-stream";
import { VideoResult } from "./video-result";
import type { JobSummary, JobLogEntry } from "@/types/pipeline";
import { cn } from "@/lib/utils";

interface JobProgressProps {
  job: JobSummary | null;
  logs: JobLogEntry[];
  connected: boolean;
  onCancel: () => void;
  onNewJob: () => void;
}

interface StageInfo {
  key: string;
  label: string;
  icon: typeof SearchIcon;
}

const PIPELINE_STAGES: StageInfo[] = [
  { key: "search", label: "Search", icon: SearchIcon },
  { key: "scrape", label: "Download", icon: ScanLine },
  { key: "transcribe", label: "Transcribe", icon: Eye },
  { key: "slice", label: "Slice", icon: Scissors },
  { key: "render", label: "Render", icon: Clapperboard },
  { key: "done", label: "Done", icon: CheckCircle2 },
];

function getActiveStageIndex(job: JobSummary | null): number {
  if (!job) return -1;
  if (job.status === "done") return PIPELINE_STAGES.length - 1;
  if (job.status === "error" || job.status === "cancelled") return -1;
  const statusMap: Record<string, number> = {
    pending: 0,
    scraping: 1,
    summarizing: 2,
    rendering: 4,
  };
  // All Python sub-stages (slice, narrate, tts, captions, merge, bgm)
  // map to the Render stage in the UI.
  const stageMap: Record<string, number> = {
    search: 0,
    scrape: 1,
    summarize: 2,
    transcribe: 2,
    translate: 2,
    slice: 3,
    narrate: 4,
    tts: 4,
    captions: 4,
    render: 4,
    merge: 4,
    bgm: 4,
  };
  const stageIdx = job.stage ? (stageMap[job.stage] ?? -1) : -1;
  const statusIdx = job.status ? (statusMap[job.status] ?? -1) : -1;
  return Math.max(stageIdx, statusIdx);
}

export function JobProgress({ job, logs, connected, onCancel, onNewJob }: JobProgressProps) {
  const handleCancel = useCallback(() => {
    if (!job) return;
    if (confirm("Cancel this job? The pipeline will stop after the current step.")) {
      fetch(`/api/jobs/${job.id}`, { method: "DELETE" });
    }
  }, [job]);

  if (!job) {
    return (
      <div className="flex items-center justify-center py-20">
        <Loader2 className="h-8 w-8 animate-spin text-muted-foreground" />
      </div>
    );
  }

  const activeStageIdx = getActiveStageIndex(job);
  const isDone = job.status === "done";
  const isError = job.status === "error";
  const isCancelled = job.status === "cancelled";
  const isRunning = !isDone && !isError && !isCancelled;

  return (
    <section className="max-w-5xl mx-auto space-y-6">
      {/* Header */}
      <div className="flex flex-col sm:flex-row sm:items-center gap-4 p-6 rounded-xl border border-border bg-card">
        <div className="w-16 h-16 sm:w-20 sm:h-20 rounded-lg overflow-hidden bg-muted flex-shrink-0 border border-border">
          {job.coverUrl ? (
            <img src={job.coverUrl} alt={job.mangaTitle} className="w-full h-full object-cover" />
          ) : null}
        </div>
        <div className="flex-1 min-w-0 space-y-1">
          <h2 className="text-xl font-bold truncate">{job.mangaTitle}</h2>
          <div className="flex flex-wrap items-center gap-2 text-sm text-muted-foreground">
            <Badge variant="outline" className="capitalize">{job.status}</Badge>
            <span>·</span>
            <span>{job.totalChapters} chapters</span>
            <span>·</span>
            <span>{job.doneImages}/{job.totalImages} images</span>
            <span>·</span>
            <span className="flex items-center gap-1">
              {connected ? <Wifi className="h-3.5 w-3.5 text-emerald-400" /> : <WifiOff className="h-3.5 w-3.5 text-amber-400" />}
              {connected ? "live" : "reconnecting…"}
            </span>
          </div>
          {job.message && (
            <p className="text-sm text-muted-foreground truncate">{job.message}</p>
          )}
        </div>
        <div className="flex gap-2">
          {isRunning && (
            <Button variant="destructive" size="sm" onClick={handleCancel}>
              <XCircle className="h-4 w-4 mr-1.5" />
              Cancel
            </Button>
          )}
          {(isDone || isError || isCancelled) && (
            <Button variant="outline" size="sm" onClick={onNewJob}>
              <SearchIcon className="h-4 w-4 mr-1.5" />
              New search
            </Button>
          )}
        </div>
      </div>

      {/* Progress bar */}
      <div className="p-6 rounded-xl border border-border bg-card space-y-4">
        <div className="flex items-center justify-between">
          <span className="text-sm font-medium">
            {isDone ? "Complete" : isError ? "Failed" : isCancelled ? "Cancelled" : "Processing…"}
          </span>
          <span className="text-2xl font-bold tabular-nums text-primary">{job.progress}%</span>
        </div>
        <Progress value={job.progress} className="h-2.5" />
        
        {/* Stage pipeline */}
        <div className="flex flex-wrap items-center gap-1.5 pt-2">
          {PIPELINE_STAGES.map((stage, idx) => {
            const isDone_ = idx < activeStageIdx;
            const isActive = idx === activeStageIdx && isRunning;
            const isFuture = idx > activeStageIdx;
            const Icon = stage.icon;
            return (
              <div
                key={stage.key}
                className={cn(
                  "flex items-center gap-1.5 px-2 py-1 rounded-md text-xs font-medium transition-all",
                  isDone_ && "text-emerald-400",
                  isActive && "text-primary bg-primary/10 ring-1 ring-primary/30",
                  isFuture && "text-muted-foreground/50"
                )}
              >
                {isDone_ ? (
                  <CheckCircle2 className="h-3.5 w-3.5" />
                ) : isActive ? (
                  <Loader2 className="h-3.5 w-3.5 animate-spin" />
                ) : (
                  <Icon className="h-3.5 w-3.5" />
                )}
                <span className="hidden sm:inline">{stage.label}</span>
              </div>
            );
          })}
        </div>
      </div>

      {/* Error banner */}
      {isError && job.error && (
        <div className="p-4 rounded-xl border border-rose-500/30 bg-rose-500/10 flex items-start gap-3">
          <AlertCircle className="h-5 w-5 text-rose-400 flex-shrink-0 mt-0.5" />
          <div className="space-y-1">
            <p className="text-sm font-medium text-rose-300">Pipeline failed</p>
            <p className="text-sm text-rose-400/80 font-mono break-all">{job.error}</p>
            <p className="text-xs text-muted-foreground mt-2">
              Partial progress is saved. You can start a new search or retry with fewer chapters.
            </p>
          </div>
        </div>
      )}

      {/* Video result */}
      {isDone && <VideoResult job={job} />}

      {/* Chapters + logs */}
      <div className="grid lg:grid-cols-2 gap-6">
        <div className="p-5 rounded-xl border border-border bg-card space-y-3">
          <div className="flex items-center justify-between">
            <h3 className="text-sm font-semibold">Chapters</h3>
            <span className="text-xs text-muted-foreground">
              {job.chapters.filter((c) => c.rendered || c.summarized || c.status === "scraped").length}/{job.chapters.length} processed
            </span>
          </div>
          <ChapterGrid chapters={job.chapters} jobId={job.id} />
        </div>

        <LogStream logs={logs} />
      </div>
    </section>
  );
}
