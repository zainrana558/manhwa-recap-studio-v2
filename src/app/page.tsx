"use client";

import { useState, useCallback } from "react";
import { Github, Zap } from "lucide-react";
import { SearchSection } from "@/components/pipeline/search-section";
import { MangaConfig } from "@/components/pipeline/manga-config";
import { JobProgress } from "@/components/pipeline/job-progress";
import { JobHistory } from "@/components/pipeline/job-history";
import { HowItWorks } from "@/components/pipeline/how-it-works";
import { useJobProgress } from "@/hooks/use-job-progress";
import type { MangadexManga } from "@/types/pipeline";

type View = "search" | "config" | "job";

export default function Home() {
  const [view, setView] = useState<View>("search");
  const [selectedManga, setSelectedManga] = useState<MangadexManga | null>(null);
  const [currentJobId, setCurrentJobId] = useState<string | null>(null);
  const [historyRefresh, setHistoryRefresh] = useState(0);

  const { job, logs, connected } = useJobProgress(currentJobId);

  const handleSelectManga = useCallback((manga: MangadexManga) => {
    setSelectedManga(manga);
    setView("config");
  }, []);

  const handleJobCreated = useCallback((jobId: string) => {
    setCurrentJobId(jobId);
    setView("job");
    setHistoryRefresh((n) => n + 1);
  }, []);

  const handleNewJob = useCallback(() => {
    setCurrentJobId(null);
    setSelectedManga(null);
    setView("search");
    setHistoryRefresh((n) => n + 1);
  }, []);

  const handleSelectHistoryJob = useCallback((jobId: string) => {
    setCurrentJobId(jobId);
    setView("job");
  }, []);

  return (
    <div className="min-h-screen flex flex-col bg-background bg-grain">
      {/* Header */}
      <header className="sticky top-0 z-40 border-b border-border bg-background/80 backdrop-blur-md">
        <div className="max-w-6xl mx-auto flex items-center justify-between px-4 py-3">
          <button onClick={handleNewJob} className="flex items-center gap-2 group">
            <div className="p-1.5 rounded-md bg-primary/10 group-hover:bg-primary/20 transition">
              <Zap className="h-5 w-5 text-primary" />
            </div>
            <span className="font-bold text-sm sm:text-base">Manhwa Recap Studio</span>
          </button>
          <div className="flex items-center gap-3">
            <a
              href="https://github.com"
              target="_blank"
              rel="noopener noreferrer"
              className="text-muted-foreground hover:text-foreground transition"
              aria-label="Source"
            >
              <Github className="h-4 w-4" />
            </a>
          </div>
        </div>
      </header>

      {/* Main */}
      <main className="flex-1 px-4 py-8 sm:py-12">
        {view === "search" && (
          <div className="space-y-12">
            <SearchSection
              onResults={() => {}}
              onSelectManga={handleSelectManga}
            />
            <HowItWorks />
            <JobHistory onSelectJob={handleSelectHistoryJob} refreshKey={historyRefresh} />
          </div>
        )}

        {view === "config" && selectedManga && (
          <MangaConfig
            manga={selectedManga}
            onBack={handleNewJob}
            onJobCreated={handleJobCreated}
          />
        )}

        {view === "job" && (
          <JobProgress
            job={job}
            logs={logs}
            connected={connected}
            onCancel={handleNewJob}
            onNewJob={handleNewJob}
          />
        )}
      </main>

      {/* Footer */}
      <footer className="mt-auto border-t border-border bg-background/50">
        <div className="max-w-6xl mx-auto px-4 py-6 flex flex-col sm:flex-row items-center justify-between gap-3 text-xs text-muted-foreground">
          <p>
            Powered by{" "}
            <a href="https://api.mangadex.org" target="_blank" rel="noopener noreferrer" className="text-foreground/80 hover:text-foreground underline underline-offset-2">
              MangaDex API
            </a>{" "}
            ·{" "}
            <a href="https://groq.com" target="_blank" rel="noopener noreferrer" className="text-foreground/80 hover:text-foreground underline underline-offset-2">
              Groq
            </a>{" "}
            ·{" "}
            <span>VLM · edge-tts · ffmpeg</span>
          </p>
          <p>For personal use — respect copyright &amp; terms of service.</p>
        </div>
      </footer>
    </div>
  );
}
