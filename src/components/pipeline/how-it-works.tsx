"use client";

import { Search, ScanLine, Brain, Languages, Mic2, Film, Combine } from "lucide-react";

const STEPS = [
  { icon: Search, title: "Search by name", desc: "Enter any title. We query MangaDex's free API — no URLs, no manual chapter pasting." },
  { icon: ScanLine, title: "Scrape every chapter", desc: "Downloads all panel images from every chapter — even hundreds — automatically." },
  { icon: Brain, title: "VLM summaries", desc: "A vision-language model reads each chapter's panels and writes an English narrative summary." },
  { icon: Languages, title: "Translate to English", desc: "Non-English content is translated with Groq's free-tier LLM before narration." },
  { icon: Mic2, title: "Narrate & caption", desc: "Edge-TTS voices each frame's narration; word-level captions are burned in." },
  { icon: Film, title: "Render & merge", desc: "moviepy + ffmpeg assemble each chapter, then concat into one master recap MP4." },
];

export function HowItWorks() {
  return (
    <section className="max-w-5xl mx-auto py-8">
      <h2 className="text-center text-sm font-semibold uppercase tracking-wider text-muted-foreground mb-6">
        How it works
      </h2>
      <div className="grid sm:grid-cols-2 lg:grid-cols-3 gap-4">
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
