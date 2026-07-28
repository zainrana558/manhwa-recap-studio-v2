"use client";

import { Search, ScanLine, Eye, Scissors, Clapperboard } from "lucide-react";

const STEPS = [
  { icon: Search, title: "Search by name", desc: "Enter any manhwa title. We query MangaDex's free API — no URLs, no manual chapter pasting." },
  { icon: ScanLine, title: "Download panels", desc: "Downloads all panel images from every chapter — even hundreds — automatically." },
  { icon: Eye, title: "Transcribe text", desc: "Vision AI reads speech bubbles and captions from each panel, transcribing the exact dialogue." },
  { icon: Scissors, title: "Slice panels", desc: "Smart gutter detection splits each page into individual manga panels for clean framing." },
  { icon: Clapperboard, title: "Render video", desc: "Panels are voiced with TTS narration and merged into a single recap MP4." },
];

export function HowItWorks() {
  return (
    <section className="max-w-5xl mx-auto py-8">
      <h2 className="text-center text-sm font-semibold uppercase tracking-wider text-muted-foreground mb-6">
        How it works
      </h2>
      <div className="grid sm:grid-cols-2 lg:grid-cols-5 gap-4">
        {STEPS.map((s, i) => {
          const Icon = s.icon;
          return (
            <div
              key={s.title}
              className="p-4 rounded-lg border border-border bg-card/50 space-y-2 relative overflow-hidden"
            >
              <div className="absolute top-2 right-3 text-5xl font-bold text-muted-foreground/10 select-none">
                {i + 1}
              </div>
              <div className="flex items-center gap-2 relative">
                <div className="p-1.5 rounded-md bg-primary/10">
                  <Icon className="h-4 w-4 text-primary" />
                </div>
                <h3 className="text-sm font-semibold">{s.title}</h3>
              </div>
              <p className="text-xs text-muted-foreground leading-relaxed relative">{s.desc}</p>
            </div>
          );
        })}
      </div>
    </section>
  );
}
