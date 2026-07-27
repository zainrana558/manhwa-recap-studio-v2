"use client";

import { CheckCircle2, Loader2, AlertCircle, Clock, Image as ImageIcon, FileText, Film } from "lucide-react";
import type { ChapterInfo } from "@/types/pipeline";
import { cn } from "@/lib/utils";

interface ChapterGridProps {
  chapters: ChapterInfo[];
  jobId: string;
}

type CellStatus = "pending" | "scraping" | "scraped" | "summarizing" | "summarized" | "rendering" | "rendered" | "error" | "done";

function getCellStatus(c: ChapterInfo): CellStatus {
  if (c.status === "error") return "error";
  if (c.rendered) return "rendered";
  if (c.summarized) return "summarized";
  if (c.status === "scraped") return "scraped";
  return "pending";
}

const statusConfig: Record<CellStatus, { color: string; icon: typeof Clock; label: string }> = {
  pending: { color: "bg-muted text-muted-foreground border-border", icon: Clock, label: "Pending" },
  scraping: { color: "bg-amber-500/15 text-amber-400 border-amber-500/30", icon: Loader2, label: "Scraping" },
  scraped: { color: "bg-amber-500/15 text-amber-400 border-amber-500/30", icon: ImageIcon, label: "Scraped" },
  summarizing: { color: "bg-orange-500/15 text-orange-400 border-orange-500/30", icon: Loader2, label: "Summarizing" },
  summarized: { color: "bg-orange-500/15 text-orange-400 border-orange-500/30", icon: FileText, label: "Summarized" },
  rendering: { color: "bg-emerald-500/15 text-emerald-400 border-emerald-500/30", icon: Loader2, label: "Rendering" },
  rendered: { color: "bg-emerald-500/15 text-emerald-400 border-emerald-500/30", icon: Film, label: "Rendered" },
  error: { color: "bg-rose-500/15 text-rose-400 border-rose-500/30", icon: AlertCircle, label: "Error" },
  done: { color: "bg-emerald-500/20 text-emerald-300 border-emerald-500/40", icon: CheckCircle2, label: "Done" },
};

export function ChapterGrid({ chapters, jobId }: ChapterGridProps) {
  if (chapters.length === 0) {
    return (
      <p className="text-sm text-muted-foreground">No chapters yet.</p>
    );
  }

  return (
    <div className="grid grid-cols-4 sm:grid-cols-6 md:grid-cols-8 lg:grid-cols-10 gap-2">
      {chapters.map((c) => {
        const status = getCellStatus(c);
        const config = statusConfig[status];
        const Icon = config.icon;
        const spinning = status === "scraping" || status === "summarizing" || status === "rendering";

        return (
          <a
            key={c.index}
            href={c.status === "scraped" || c.status === "summarized" || c.status === "rendered" || c.summarized
              ? `/api/preview/${jobId}/${c.index}/001.jpg`
              : undefined}
            target={c.status !== "pending" && c.status !== "error" ? "_blank" : undefined}
            rel="noopener noreferrer"
            title={`Ch. ${c.chapterNum ?? c.index}${c.title ? ` — ${c.title}` : ""}\n${config.label} · ${c.pageCount} pages`}
            className={cn(
              "aspect-square rounded-md border flex flex-col items-center justify-center gap-1 transition-all text-xs font-medium relative group",
              config.color,
              spinning && "glow-pulse",
              c.status !== "pending" && c.status !== "error" && "hover:scale-110 cursor-pointer"
            )}
          >
            <Icon className={cn("h-4 w-4", spinning && "animate-spin")} />
            <span className="font-mono text-[10px] leading-none">
              {c.chapterNum ?? c.index}
            </span>
          </a>
        );
      })}
    </div>
  );
}
