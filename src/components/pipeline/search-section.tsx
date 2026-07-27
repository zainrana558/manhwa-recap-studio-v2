"use client";

import { useState, useCallback, useMemo } from "react";
import { Search, Loader2, Sparkles, ExternalLink } from "lucide-react";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { useToast } from "@/hooks/use-toast";
import type { MangadexManga, MangaSource } from "@/types/pipeline";

interface SearchSectionProps {
  onResults: (manga: MangadexManga[], query: string) => void;
  onSelectManga: (manga: MangadexManga) => void;
}

type SourceFilter = "all" | MangaSource;

const SOURCE_FILTERS: { value: SourceFilter; label: string }[] = [
  { value: "all", label: "All Sources" },
  { value: "mangahere", label: "MangaHere" },
  { value: "fanfox", label: "FanFox" },
  { value: "webtoons", label: "Webtoons" },
  { value: "mal", label: "MAL" },
  { value: "anilist", label: "AniList" },
];

/** Tailwind class strings for each source badge (used in result cards). */
const SOURCE_BADGE_CLASSES: Record<MangaSource, string> = {
  mangahere:
    "bg-emerald-500/15 text-emerald-300 border-emerald-500/30",
  fanfox:
    "bg-orange-500/15 text-orange-300 border-orange-500/30",
  webtoons:
    "bg-green-500/15 text-green-300 border-green-500/30",
  mal: "bg-sky-500/15 text-sky-300 border-sky-500/30",
  anilist:
    "bg-fuchsia-500/15 text-fuchsia-300 border-fuchsia-500/30",
};

const SOURCE_LABEL: Record<MangaSource, string> = {
  mangahere: "MangaHere",
  fanfox: "FanFox",
  webtoons: "Webtoons",
  mal: "MAL",
  anilist: "AniList",
};

interface SourceCounts {
  mangahere: number;
  fanfox: number;
  webtoons: number;
  mal: number;
  anilist: number;
}

export function SearchSection({ onResults, onSelectManga }: SearchSectionProps) {
  const { toast } = useToast();
  const [query, setQuery] = useState("");
  const [loading, setLoading] = useState(false);
  const [resolvingId, setResolvingId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [results, setResults] = useState<MangadexManga[]>([]);
  const [sourceCounts, setSourceCounts] = useState<SourceCounts | null>(null);
  const [filter, setFilter] = useState<SourceFilter>("all");
  const [hasSearched, setHasSearched] = useState(false);

  const handleSearch = useCallback(async () => {
    const q = query.trim();
    if (!q) return;
    setLoading(true);
    setError(null);
    setHasSearched(true);

    // Retry up to 3 times with delay (handles transient 502 from server restart)
    const MAX_RETRIES = 3;
    const RETRY_DELAY_MS = 1000;
    let lastError: Error | null = null;

    for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
      try {
        const res = await fetch(`/api/search?q=${encodeURIComponent(q)}&limit=24`);
        if (!res.ok) {
          const data = await res.json().catch(() => ({}));
          throw new Error(data.error || `Search failed (${res.status})`);
        }
        const data = await res.json();
        const manga: MangadexManga[] = data.manga ?? [];
        setResults(manga);
        setSourceCounts(data.sources ?? null);
        onResults(manga, q);
        lastError = null;
        break;
      } catch (e) {
        lastError = e instanceof Error ? e : new Error("Search failed");
        // Retry on network/502 errors, but not on 400 (bad request)
        if (attempt < MAX_RETRIES && (lastError.message.includes("Failed to fetch") || lastError.message.includes("502") || lastError.message.includes("fetch"))) {
          await new Promise((r) => setTimeout(r, RETRY_DELAY_MS * attempt));
          continue;
        }
        break;
      }
    }

    if (lastError) {
      setError(lastError.message);
      setResults([]);
      setSourceCounts(null);
    }
    setLoading(false);
  }, [query, onResults]);

  // Filtered view of results based on the source filter toggle.
  const visibleResults = useMemo(() => {
    if (filter === "all") return results;
    return results.filter((m) => (m.source ?? "mangahere") === filter);
  }, [results, filter]);

  /**
   * When a user selects a scrapeable result (MangaHere, FanFox, Webtoons),
   * proceed straight to the config page. For metadata-only results (MAL/AniList),
   * we re-search MangaHere by title to find the scrapeable version.
   */
  const handleSelect = useCallback(
    async (m: MangadexManga) => {
      const source = m.source ?? "mangahere";
      // All 3 scraping sources are directly usable.
      if (source === "mangahere" || source === "fanfox" || source === "webtoons") {
        onSelectManga(m);
        return;
      }

      // Metadata-only sources (MAL/AniList): resolve to a MangaHere manga first.
      setResolvingId(m.id);
      const findingToast = toast({
        title: "Resolving on MangaHere",
        description: `Finding on MangaHere…`,
      });

      try {
        const res = await fetch(
          `/api/search?q=${encodeURIComponent(m.title)}&limit=1&source=mangahere`
        );
        const data = await res.json().catch(() => ({}));
        const mdMatch: MangadexManga | undefined = (data.manga ?? [])[0];

        if (!res.ok || !mdMatch) {
          findingToast.update({
            id: findingToast.id,
            title: "Not found on MangaHere",
            description: `Could not find on MangaHere for scraping.`,
            variant: "destructive",
          });
          return;
        }

        findingToast.update({
          id: findingToast.id,
          title: "Matched on MangaHere",
          description: `Using "${mdMatch.title}" for scraping.`,
        });
        // Preserve the external source link on the resolved MangaHere manga
        // so the config page can show a "View on {source}" link if desired.
        onSelectManga({
          ...mdMatch,
          externalUrl: mdMatch.externalUrl ?? m.externalUrl ?? null,
        });
      } catch {
        findingToast.update({
          id: findingToast.id,
          title: "Resolution failed",
          description: `Could not find on MangaHere for scraping.`,
          variant: "destructive",
        });
      } finally {
        setResolvingId(null);
      }
    },
    [onSelectManga, toast]
  );

  return (
    <section className="space-y-6">
      <div className="text-center space-y-3">
        <h1 className="text-4xl sm:text-5xl font-bold tracking-tight">
          <span className="text-gradient">Manhwa Recap Studio</span>
        </h1>
        <p className="text-muted-foreground text-lg max-w-2xl mx-auto">
          Enter any manhwa, manga, or webtoon name. We search{" "}
          <span className="text-foreground font-medium">MangaHere, MyAnimeList &amp; AniList</span> at once,
          scrape every single chapter, translate to English, and render a narrated recap video.
        </p>
      </div>

      <form
        onSubmit={(e) => {
          e.preventDefault();
          handleSearch();
        }}
        className="flex flex-col sm:flex-row gap-3 max-w-2xl mx-auto"
      >
        <div className="relative flex-1">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-5 w-5 text-muted-foreground" />
          <Input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="e.g. Solo Leveling, Tower of God, One Piece…"
            className="pl-10 h-12 text-base bg-card border-border"
            autoFocus
          />
        </div>
        <Button
          type="submit"
          size="lg"
          className="h-12 px-8 font-semibold"
          disabled={loading || !query.trim()}
        >
          {loading ? (
            <>
              <Loader2 className="h-5 w-5 mr-2 animate-spin" />
              Searching…
            </>
          ) : (
            <>
              <Sparkles className="h-5 w-5 mr-2" />
              Search
            </>
          )}
        </Button>
      </form>

      {error && (
        <p className="text-center text-destructive text-sm">{error}</p>
      )}

      {/* Source filter row + counts */}
      {hasSearched && !loading && results.length > 0 && (
        <div className="flex flex-wrap items-center justify-center gap-2">
          {SOURCE_FILTERS.map((f) => {
            const isActive = filter === f.value;
            const count =
              f.value === "all"
                ? results.length
                : sourceCounts
                  ? sourceCounts[f.value]
                  : results.filter((m) => (m.source ?? "mangahere") === f.value).length;
            return (
              <Button
                key={f.value}
                type="button"
                size="sm"
                variant={isActive ? "default" : "outline"}
                onClick={() => setFilter(f.value)}
                className="h-8 px-3 text-xs"
              >
                {f.label}
                <span
                  className={`ml-1.5 rounded px-1.5 py-0.5 text-[10px] font-mono ${
                    isActive
                      ? "bg-primary-foreground/20 text-primary-foreground"
                      : "bg-muted text-muted-foreground"
                  }`}
                >
                  {count}
                </span>
              </Button>
            );
          })}
        </div>
      )}

      {hasSearched && !loading && visibleResults.length === 0 && !error && (
        <p className="text-center text-muted-foreground text-sm">
          {results.length === 0
            ? "No results found. Try a different title or spelling."
            : `No results from ${SOURCE_FILTERS.find((f) => f.value === filter)?.label}. Try another filter.`}
        </p>
      )}

      {visibleResults.length > 0 && (
        <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-6 gap-4">
          {visibleResults.map((m) => {
            const source = m.source ?? "mangahere";
            const isResolving = resolvingId === m.id;
            const isExternal = source === "mal" || source === "anilist";
            return (
              <div
                key={m.id}
                onClick={() => !isResolving && handleSelect(m)}
                role="button"
                tabIndex={0}
                onKeyDown={(e) => {
                  if ((e.key === "Enter" || e.key === " ") && !isResolving) {
                    e.preventDefault();
                    handleSelect(m);
                  }
                }}
                className="group text-left space-y-2 transition-all hover:scale-[1.03] focus:outline-none focus:ring-2 focus:ring-ring rounded-lg disabled:opacity-60 disabled:hover:scale-100 cursor-pointer"
              >
                <div className="aspect-[3/4] rounded-lg overflow-hidden bg-muted border border-border relative">
                  {m.coverUrl ? (
                    <img
                      src={m.coverUrl}
                      alt={m.title}
                      className="w-full h-full object-cover group-hover:brightness-110 transition"
                      loading="lazy"
                    />
                  ) : (
                    <div className="w-full h-full flex items-center justify-center text-muted-foreground text-xs p-2 text-center">
                      No cover
                    </div>
                  )}
                  {/* Source badge (top-left) */}
                  <span
                    className={`absolute top-1.5 left-1.5 text-[10px] font-semibold px-1.5 py-0.5 rounded border backdrop-blur-sm ${SOURCE_BADGE_CLASSES[source]}`}
                  >
                    {isResolving ? "…" : SOURCE_LABEL[source]}
                  </span>
                  {/* External link hint (top-right) for non-MangaHere sources */}
                  {isExternal && m.externalUrl && (
                    <a
                      href={m.externalUrl}
                      target="_blank"
                      rel="noopener noreferrer"
                      onClick={(e) => e.stopPropagation()}
                      className="absolute top-1.5 right-1.5 p-1 rounded bg-black/50 text-white/80 hover:text-white hover:bg-black/70 transition z-10"
                      aria-label={`View ${SOURCE_LABEL[source]} page (opens new tab)`}
                    >
                      <ExternalLink className="h-3 w-3" />
                    </a>
                  )}
                  <div className="absolute inset-0 bg-gradient-to-t from-black/60 via-transparent to-transparent opacity-0 group-hover:opacity-100 transition flex items-end p-2">
                    <span className="text-white text-xs font-medium">
                      {isResolving
                        ? "Finding on MangaDex…"
                        : isExternal
                          ? "Match on MangaDex →"
                          : "Select →"}
                    </span>
                  </div>
                </div>
                <div className="space-y-0.5">
                  <p className="text-sm font-medium line-clamp-2 leading-tight">
                    {m.title}
                  </p>
                  <p className="text-xs text-muted-foreground">
                    {m.year ? `${m.year} · ` : ""}
                    {m.originalLanguage?.toUpperCase() ?? (isExternal ? SOURCE_LABEL[source] : "?")}
                    {m.lastChapter ? ` · Ch.${m.lastChapter}` : ""}
                  </p>
                </div>
              </div>
            );
          })}
        </div>
      )}

      {hasSearched && !loading && results.length > 0 && (
        <p className="text-center text-xs text-muted-foreground">
          {sourceCounts
            ? `MangaDex: ${sourceCounts.mangadex} · MAL: ${sourceCounts.mal} · AniList: ${sourceCounts.anilist} — non-MangaHere results are auto-matched to MangaDex on selection.`
            : "Non-MangaHere results are auto-matched to MangaDex on selection."}
        </p>
      )}
    </section>
  );
}
