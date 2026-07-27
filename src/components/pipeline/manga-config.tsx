"use client";

import { useState, useEffect, useCallback } from "react";
import {
  ArrowLeft,
  Loader2,
  Play,
  Globe,
  BookOpen,
  Mic2,
  Key,
  Languages,
  Info,
  Music,
  Upload,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Slider } from "@/components/ui/slider";
import { Switch } from "@/components/ui/switch";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Badge } from "@/components/ui/badge";
import { Separator } from "@/components/ui/separator";
import type { MangadexManga, AppSettings, BgmTrack } from "@/types/pipeline";

interface MangaConfigProps {
  manga: MangadexManga;
  onBack: () => void;
  onJobCreated: (jobId: string) => void;
}

interface ChapterFeedItem {
  id: string;
  chapter: string | null;
  title: string | null;
  language: string;
  pages: number;
  volume: string | null;
}

const VOICES = [
  { value: "en-US-AndrewNeural", label: "Andrew (US, male)" },
  { value: "en-US-EmmaNeural", label: "Emma (US, female)" },
  { value: "en-US-BrianNeural", label: "Brian (US, male)" },
  { value: "en-US-AvaNeural", label: "Ava (US, female)" },
  { value: "en-GB-RyanNeural", label: "Ryan (UK, male)" },
  { value: "en-GB-SoniaNeural", label: "Sonia (UK, female)" },
  { value: "en-AU-WilliamNeural", label: "William (AU, male)" },
  { value: "en-AU-NatashaNeural", label: "Natasha (AU, female)" },
];

export function MangaConfig({ manga, onBack, onJobCreated }: MangaConfigProps) {
  const [settings, setSettings] = useState<AppSettings | null>(null);
  const [chapters, setChapters] = useState<ChapterFeedItem[]>([]);
  const [chapterLoading, setChapterLoading] = useState(true);
  const [language, setLanguage] = useState("en");
  const [chapterLimit, setChapterLimit] = useState(5);
  const [voice, setVoice] = useState("en-US-AndrewNeural");
  const [groqKey, setGroqKey] = useState("");
  const [translate, setTranslate] = useState(true);
  const [useBgm, setUseBgm] = useState(true);
  const [bgmTracks, setBgmTracks] = useState<BgmTrack[]>([]);
  const [selectedBgm, setSelectedBgm] = useState<string>("default"); // "default" = default track, else filename
  const [starting, setStarting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Load saved settings + chapter feed + BGM tracks on mount.
  useEffect(() => {
    (async () => {
      try {
        const [settingsRes, chaptersRes, bgmRes] = await Promise.all([
          fetch("/api/settings").then((r) => r.json()),
          fetch(`/api/manga/${manga.id}`).then((r) => r.json()),
          fetch("/api/bgm").then((r) => r.json()),
        ]);
        const s = settingsRes.settings ?? settingsRes;
        setSettings(s);
        setGroqKey(s.groqKey ?? "");
        setVoice(s.defaultVoice ?? "en-US-AndrewNeural");
        setChapterLimit(s.defaultChapterLimit ?? 5);
        setBgmTracks(bgmRes.tracks ?? []);

        const allChapters: ChapterFeedItem[] = chaptersRes.chapters ?? [];
        setChapters(allChapters);

        // Pick the best language: prefer English, else original, else first available.
        const langs = Array.from(new Set(allChapters.map((c) => c.language)));
        const preferred =
          langs.find((l) => l === "en") ||
          langs.find((l) => l === manga.originalLanguage) ||
          langs[0] ||
          "en";
        setLanguage(preferred);
      } catch {
        // non-fatal
      } finally {
        setChapterLoading(false);
      }
    })();
  }, [manga.id, manga.originalLanguage]);

  const availableLanguages = Array.from(new Set(chapters.map((c) => c.language)));
  const filteredChapters = chapters.filter((c) => c.language === language);
  const totalImages = filteredChapters.reduce((s, c) => s + (c.pages ?? 0), 0);
  const effectiveLimit = chapterLimit === 0 ? filteredChapters.length : Math.min(chapterLimit, filteredChapters.length);

  const handleStart = useCallback(async () => {
    setStarting(true);
    setError(null);
    try {
      // Persist settings.
      await fetch("/api/settings", {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          groqKey,
          defaultVoice: voice,
          defaultLanguage: language,
          defaultChapterLimit: chapterLimit,
        }),
      });

      // Create job.
      const res = await fetch("/api/jobs", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          mangaId: manga.id,
          mangaTitle: manga.title,
          coverUrl: manga.coverUrl,
          language,
          chapterLimit,
          voice,
          translate,
          groqKey: groqKey || undefined,
          bgmPath: selectedBgm === "default" ? null : selectedBgm,
          useBgm,
        }),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error(data.error || `Failed to start job (${res.status})`);
      }
      const data = await res.json();
      onJobCreated(data.job.id);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to start");
    } finally {
      setStarting(false);
    }
  }, [groqKey, voice, language, chapterLimit, translate, useBgm, selectedBgm, manga, onJobCreated]);

  return (
    <section className="max-w-5xl mx-auto space-y-6">
      <Button variant="ghost" size="sm" onClick={onBack} className="text-muted-foreground">
        <ArrowLeft className="h-4 w-4 mr-2" />
        Back to search
      </Button>

      {/* Manga header */}
      <div className="flex flex-col sm:flex-row gap-6 p-6 rounded-xl border border-border bg-card">
        <div className="w-32 sm:w-40 aspect-[3/4] rounded-lg overflow-hidden bg-muted flex-shrink-0 border border-border">
          {manga.coverUrl ? (
            <img src={manga.coverUrl} alt={manga.title} className="w-full h-full object-cover" />
          ) : (
            <div className="w-full h-full flex items-center justify-center text-muted-foreground text-xs">
              No cover
            </div>
          )}
        </div>
        <div className="flex-1 space-y-3 min-w-0">
          <div>
            <h2 className="text-2xl font-bold leading-tight">{manga.title}</h2>
            <div className="flex flex-wrap gap-2 mt-2">
              {manga.year && <Badge variant="secondary">{manga.year}</Badge>}
              {manga.status && <Badge variant="secondary">{manga.status}</Badge>}
              {manga.originalLanguage && (
                <Badge variant="outline">Original: {manga.originalLanguage.toUpperCase()}</Badge>
              )}
              {manga.contentRating && (
                <Badge variant="outline" className="capitalize">{manga.contentRating}</Badge>
              )}
            </div>
          </div>
          {manga.description && (
            <p className="text-sm text-muted-foreground line-clamp-4 leading-relaxed">
              {manga.description}
            </p>
          )}
          {manga.tags.length > 0 && (
            <div className="flex flex-wrap gap-1.5">
              {manga.tags.slice(0, 8).map((t) => (
                <span key={t} className="text-xs px-2 py-0.5 rounded-full bg-muted text-muted-foreground">
                  {t}
                </span>
              ))}
            </div>
          )}
        </div>
      </div>

      {/* Configuration */}
      <div className="p-6 rounded-xl border border-border bg-card space-y-6">
        <div className="flex items-center gap-2">
          <Play className="h-5 w-5 text-primary" />
          <h3 className="text-lg font-semibold">Pipeline Configuration</h3>
        </div>

        {/* Language */}
        <div className="space-y-2">
          <Label className="flex items-center gap-2 text-sm font-medium">
            <Globe className="h-4 w-4 text-muted-foreground" />
            Source language
          </Label>
          <Select value={language} onValueChange={setLanguage} disabled={chapterLoading}>
            <SelectTrigger className="w-full">
              <SelectValue placeholder="Select language" />
            </SelectTrigger>
            <SelectContent>
              {availableLanguages.length === 0 && !chapterLoading && (
                <SelectItem value="en">English (fallback)</SelectItem>
              )}
              {availableLanguages.map((l) => (
                <SelectItem key={l} value={l}>
                  {new Intl.DisplayNames(["en"], { type: "language" }).of(l) ?? l} ({l.toUpperCase()})
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <p className="text-xs text-muted-foreground">
            {chapterLoading
              ? "Loading available chapters…"
              : `${filteredChapters.length} chapter(s) available in this language${language !== "en" && translate ? " — will be auto-translated to English" : ""}.`}
          </p>
        </div>

        {/* Chapter limit */}
        <div className="space-y-3">
          <div className="flex items-center justify-between">
            <Label className="flex items-center gap-2 text-sm font-medium">
              <BookOpen className="h-4 w-4 text-muted-foreground" />
              Chapters to process
            </Label>
            <Badge variant="secondary" className="font-mono">
              {chapterLimit === 0 ? "ALL" : `${effectiveLimit} / ${filteredChapters.length}`}
            </Badge>
          </div>
          <Slider
            value={[chapterLimit]}
            onValueChange={([v]) => setChapterLimit(v)}
            min={0}
            max={Math.max(50, filteredChapters.length)}
            step={1}
            className="w-full"
          />
          <div className="flex justify-between text-xs text-muted-foreground">
            <span>0 = all chapters</span>
            <span>~{totalImages > 0 ? Math.round((effectiveLimit / Math.max(1, filteredChapters.length)) * totalImages) : 0} images to download</span>
          </div>
          {effectiveLimit > 10 && (
            <p className="text-xs text-amber-400/90 flex items-center gap-1.5">
              <Info className="h-3.5 w-3.5" />
              Processing {effectiveLimit} chapters may take a long time (scraping + VLM + TTS + rendering per chapter).
            </p>
          )}
        </div>

        <Separator />

        {/* Voice */}
        <div className="space-y-2">
          <Label className="flex items-center gap-2 text-sm font-medium">
            <Mic2 className="h-4 w-4 text-muted-foreground" />
            Narration voice
          </Label>
          <Select value={voice} onValueChange={setVoice}>
            <SelectTrigger className="w-full">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {VOICES.map((v) => (
                <SelectItem key={v.value} value={v.value}>
                  {v.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>

        {/* Translate toggle */}
        <div className="flex items-center justify-between gap-4 p-3 rounded-lg bg-muted/50">
          <div className="space-y-0.5">
            <Label className="flex items-center gap-2 text-sm font-medium">
              <Languages className="h-4 w-4 text-muted-foreground" />
              Auto-translate to English
            </Label>
            <p className="text-xs text-muted-foreground">
              Uses Groq to translate non-English chapter summaries before narration.
            </p>
          </div>
          <Switch checked={translate} onCheckedChange={setTranslate} />
        </div>

        {/* BGM section */}
        <div className="space-y-3">
          <div className="flex items-center justify-between gap-4 p-3 rounded-lg bg-muted/50">
            <div className="space-y-0.5">
              <Label className="flex items-center gap-2 text-sm font-medium">
                <Music className="h-4 w-4 text-muted-foreground" />
                Background music
              </Label>
              <p className="text-xs text-muted-foreground">
                Loops a cinematic ambient track under the narration at -20dB.
              </p>
            </div>
            <Switch checked={useBgm} onCheckedChange={setUseBgm} />
          </div>
          {useBgm && (
            <div className="space-y-2 pl-3">
              <Select value={selectedBgm} onValueChange={setSelectedBgm}>
                <SelectTrigger className="w-full">
                  <SelectValue placeholder="Default cinematic ambient" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="default">Default cinematic ambient</SelectItem>
                  {bgmTracks.filter((t) => !t.isDefault).map((t) => (
                    <SelectItem key={t.name} value={t.name}>
                      {t.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <BgmUploader onUploaded={(name) => {
                setSelectedBgm(name);
                // Refresh track list
                fetch("/api/bgm").then((r) => r.json()).then((d) => setBgmTracks(d.tracks ?? [])).catch(() => {});
              }} />
            </div>
          )}
        </div>

        {/* Groq key */}
        <div className="space-y-2">
          <Label className="flex items-center gap-2 text-sm font-medium" htmlFor="groqKey">
            <Key className="h-4 w-4 text-muted-foreground" />
            Groq API key
            <span className="text-xs text-muted-foreground font-normal">(optional — for translation &amp; narration)</span>
          </Label>
          <Input
            id="groqKey"
            type="password"
            value={groqKey}
            onChange={(e) => setGroqKey(e.target.value)}
            placeholder="gsk_…"
            className="font-mono text-sm"
          />
          <p className="text-xs text-muted-foreground">
            Get a free key at{" "}
            <a
              href="https://console.groq.com/keys"
              target="_blank"
              rel="noopener noreferrer"
              className="text-primary underline underline-offset-2 hover:text-primary/80"
            >
              console.groq.com/keys
            </a>
            . Without a key, narration uses the raw VLM summary verbatim (still works, less polished).
          </p>
        </div>

        {error && (
          <p className="text-sm text-destructive">{error}</p>
        )}

        {/* No chapters available warning */}
        {!chapterLoading && chapters.length === 0 && (
          <div className="p-4 rounded-lg border border-amber-500/30 bg-amber-500/10 space-y-2">
            <div className="flex items-start gap-2">
              <Info className="h-5 w-5 text-amber-400 flex-shrink-0 mt-0.5" />
              <div className="space-y-1">
                <p className="text-sm font-medium text-amber-300">No readable chapters available</p>
                <p className="text-xs text-amber-400/80 leading-relaxed">
                  This manga&apos;s chapters are hosted on external sites (MangaDex doesn&apos;t host the images directly), so they can&apos;t be scraped.
                  Try searching for a different version of the same title, or pick a manga that has chapters hosted on MangaDex.
                </p>
              </div>
            </div>
          </div>
        )}
        {!chapterLoading && chapters.length > 0 && filteredChapters.length === 0 && (
          <div className="p-4 rounded-lg border border-amber-500/30 bg-amber-500/10 space-y-2">
            <div className="flex items-start gap-2">
              <Info className="h-5 w-5 text-amber-400 flex-shrink-0 mt-0.5" />
              <div className="space-y-1">
                <p className="text-sm font-medium text-amber-300">
                  No chapters in {new Intl.DisplayNames(["en"], { type: "language" }).of(language) ?? language.toUpperCase()}
                </p>
                <p className="text-xs text-amber-400/80">
                  Available languages: {availableLanguages.map((l) => new Intl.DisplayNames(["en"], { type: "language" }).of(l) ?? l.toUpperCase()).join(", ")}. Select a different language above.
                </p>
              </div>
            </div>
          </div>
        )}

        <Button
          size="lg"
          className="w-full font-semibold"
          onClick={handleStart}
          disabled={starting || chapterLoading || filteredChapters.length === 0}
        >
          {starting ? (
            <>
              <Loader2 className="h-5 w-5 mr-2 animate-spin" />
              Starting pipeline…
            </>
          ) : chapterLoading ? (
            <>
              <Loader2 className="h-5 w-5 mr-2 animate-spin" />
              Loading chapters…
            </>
          ) : filteredChapters.length === 0 ? (
            <>
              <Info className="h-5 w-5 mr-2" />
              No chapters to process
            </>
          ) : (
            <>
              <Play className="h-5 w-5 mr-2" />
              Start Recap Pipeline
            </>
          )}
        </Button>
      </div>
    </section>
  );
}

/** BGM file uploader sub-component. */
function BgmUploader({ onUploaded }: { onUploaded: (name: string) => void }) {
  const [uploading, setUploading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleUpload = useCallback(async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    setUploading(true);
    setError(null);
    try {
      const formData = new FormData();
      formData.append("file", file);
      const res = await fetch("/api/bgm", { method: "POST", body: formData });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error(data.error || "Upload failed");
      }
      const data = await res.json();
      onUploaded(data.name);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Upload failed");
    } finally {
      setUploading(false);
      e.target.value = "";
    }
  }, [onUploaded]);

  return (
    <div className="space-y-1">
      <label className="flex items-center gap-2 text-xs text-muted-foreground cursor-pointer hover:text-foreground transition w-fit">
        {uploading ? (
          <Loader2 className="h-3.5 w-3.5 animate-spin" />
        ) : (
          <Upload className="h-3.5 w-3.5" />
        )}
        {uploading ? "Uploading…" : "Upload your own BGM track"}
        <input
          type="file"
          accept="audio/mp3,audio/wav,audio/ogg,audio/m4a,.mp3,.wav,.ogg,.m4a"
          onChange={handleUpload}
          disabled={uploading}
          className="hidden"
        />
      </label>
      {error && <p className="text-xs text-destructive">{error}</p>}
    </div>
  );
}
