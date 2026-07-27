"use client";

import { Download, Film, CheckCircle2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import type { JobSummary } from "@/types/pipeline";

interface VideoResultProps {
  job: JobSummary;
}

export function VideoResult({ job }: VideoResultProps) {
  return (
    <div className="p-6 rounded-xl border border-emerald-500/30 bg-emerald-500/5 space-y-4">
      <div className="flex items-center gap-2">
        <CheckCircle2 className="h-5 w-5 text-emerald-400" />
        <h3 className="text-lg font-semibold text-emerald-300">Recap video ready!</h3>
      </div>

      <div className="rounded-lg overflow-hidden bg-black border border-border">
        <video
          controls
          className="w-full max-h-[480px]"
          preload="metadata"
        >
          <source src={`/api/download/${job.id}`} type="video/mp4" />
          Your browser does not support the video tag.
        </video>
      </div>

      <div className="flex flex-wrap gap-3">
        <Button asChild size="lg">
          <a href={`/api/download/${job.id}`} download={`${job.mangaTitle.replace(/[^a-z0-9]+/gi, "_")}_recap.mp4`}>
            <Download className="h-5 w-5 mr-2" />
            Download MP4
          </a>
        </Button>
        <Button asChild variant="outline" size="lg">
          <a href={`/api/download/${job.id}`} target="_blank" rel="noopener noreferrer">
            <Film className="h-5 w-5 mr-2" />
            Open in new tab
          </a>
        </Button>
      </div>

      <p className="text-xs text-muted-foreground">
        Video includes narrated chapter summaries with text-to-speech audio. Source: {job.mangaTitle} · {job.totalChapters} chapters · {job.totalImages} images.
      </p>
    </div>
  );
}
