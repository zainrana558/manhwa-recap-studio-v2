"use client";

import { useEffect, useState } from "react";
import { History, ChevronRight, Loader2, CheckCircle2, AlertCircle, Clock, XCircle, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import type { JobSummary, JobStatus } from "@/types/pipeline";

interface JobHistoryProps {
  onSelectJob: (jobId: string) => void;
  refreshKey: number;
}

const statusIcon: Record<JobStatus, typeof Clock> = {
  pending: Clock,
  scraping: Loader2,
  summarizing: Loader2,
  translating: Loader2,
  rendering: Loader2,
  merging: Loader2,
  done: CheckCircle2,
  error: AlertCircle,
  cancelled: XCircle,
};

const statusColor: Record<JobStatus, string> = {
  pending: "text-muted-foreground",
  scraping: "text-amber-400",
  summarizing: "text-orange-400",
  translating: "text-purple-400",
  rendering: "text-emerald-400",
  merging: "text-teal-400",
  done: "text-emerald-400",
  error: "text-rose-400",
  cancelled: "text-muted-foreground",
};

const ACTIVE_STATUSES = new Set<JobStatus>([
  "pending",
  "scraping",
  "summarizing",
  "translating",
  "rendering",
  "merging",
]);

export function JobHistory({ onSelectJob, refreshKey }: JobHistoryProps) {
  const [jobs, setJobs] = useState<JobSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [open, setOpen] = useState(false);
  const [deletingId, setDeletingId] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    fetch("/api/jobs")
      .then((r) => r.json())
      .then((data) => {
        if (!cancelled) setJobs(data.jobs ?? []);
      })
      .catch(() => {})
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [refreshKey]);

  const handleDelete = async (e: React.MouseEvent, job: JobSummary) => {
    e.stopPropagation();
    const isActive = ACTIVE_STATUSES.has(job.status);
    const confirmMsg = isActive
      ? `"${job.mangaTitle}" is still running. Stop and delete it?`
      : `Delete "${job.mangaTitle}" from recent jobs? This can't be undone.`;
    if (!window.confirm(confirmMsg)) return;

    setDeletingId(job.id);
    try {
      const res = await fetch(`/api/jobs/${job.id}?force=true`, { method: "DELETE" });
      if (res.ok) {
        setJobs((prev) => prev.filter((j) => j.id !== job.id));
      }
    } catch {
      // best-effort
    } finally {
      setDeletingId(null);
    }
  };

  if (!loading && jobs.length === 0) return null;

  return (
    <section className="max-w-5xl mx-auto">
      <button
        onClick={() => setOpen((o) => !o)}
        className="flex items-center gap-2 text-sm font-medium text-muted-foreground hover:text-foreground transition w-full"
      >
        <History className="h-4 w-4" />
        Recent jobs ({jobs.length})
        <ChevronRight className={`h-4 w-4 ml-auto transition-transform ${open ? "rotate-90" : ""}`} />
      </button>

      {open && (
        <div className="mt-3 space-y-2">
          {jobs.map((job) => {
            const Icon = statusIcon[job.status] ?? Clock;
            const spinning = ["scraping", "summarizing", "translating", "rendering", "merging"].includes(job.status);
            return (
              <div
                key={job.id}
                role="button"
                tabIndex={0}
                onClick={() => onSelectJob(job.id)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" || e.key === " ") onSelectJob(job.id);
                }}
                className="w-full flex items-center gap-3 p-3 rounded-lg border border-border bg-card hover:border-primary/40 hover:bg-accent/30 transition text-left group cursor-pointer"
              >
                <div className="w-10 h-12 rounded overflow-hidden bg-muted flex-shrink-0 border border-border">
                  {job.coverUrl ? (
                    <img src={job.coverUrl} alt="" className="w-full h-full object-cover" />
                  ) : null}
                </div>
                <div className="flex-1 min-w-0 space-y-0.5">
                  <p className="text-sm font-medium truncate">{job.mangaTitle}</p>
                  <div className="flex items-center gap-2 text-xs text-muted-foreground">
                    <Icon className={`h-3.5 w-3.5 ${statusColor[job.status]} ${spinning ? "animate-spin" : ""}`} />
                    <span className={statusColor[job.status]}>{job.status}</span>
                    <span>·</span>
                    <span>{job.totalChapters} ch</span>
                    <span>·</span>
                    <span>{job.progress}%</span>
                    <span>·</span>
                    <span>{new Date(job.createdAt).toLocaleDateString()}</span>
                  </div>
                </div>
                <button
                  type="button"
                  aria-label={`Delete ${job.mangaTitle}`}
                  onClick={(e) => handleDelete(e, job)}
                  className="p-1.5 rounded-md text-muted-foreground hover:text-rose-400 hover:bg-rose-500/10 transition flex-shrink-0"
                >
                  {deletingId === job.id ? (
                    <Loader2 className="h-4 w-4 animate-spin" />
                  ) : (
                    <Trash2 className="h-4 w-4" />
                  )}
                </button>
                <ChevronRight className="h-4 w-4 text-muted-foreground group-hover:text-foreground transition flex-shrink-0" />
              </div>
            );
          })}
        </div>
      )}
    </section>
  );
}
