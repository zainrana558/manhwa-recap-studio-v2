import { NextRequest, NextResponse } from "next/server";
import { searchAllManga, searchSingleSource } from "@/lib/manga-search";

export const dynamic = "force-dynamic";

const VALID_SOURCES = ["mangahere", "fanfox", "webtoons", "mal", "anilist"] as const;
type ValidSource = (typeof VALID_SOURCES)[number];

function isSource(s: string): s is ValidSource {
  return (VALID_SOURCES as readonly string[]).includes(s);
}

/**
 * GET /api/search?q={query}&limit={limit}&source={mangahere|fanfox|webtoons|mal|anilist}
 *
 * - No `source`: queries all 5 sources in parallel, dedupes, returns sources counts.
 * - `source=...`: queries just that one source.
 *
 * Returns: { manga: MangadexManga[], total: number, sources: { mangahere, fanfox, webtoons, mal, anilist } }
 */
export async function GET(req: NextRequest) {
  try {
    const { searchParams } = new URL(req.url);
    const q = (searchParams.get("q") ?? "").trim();
    const limitParam = searchParams.get("limit");
    const limit = limitParam ? Math.max(1, parseInt(limitParam, 10) || 12) : 12;
    const sourceParam = (searchParams.get("source") ?? "").trim().toLowerCase();

    if (!q) {
      return NextResponse.json(
        { error: "Query parameter 'q' is required." },
        { status: 400 }
      );
    }

    // Single-source mode.
    if (isSource(sourceParam)) {
      try {
        const manga = await searchSingleSource(q, sourceParam, limit);
        const sources: Record<string, number> = {};
        for (const s of VALID_SOURCES) {
          sources[s] = s === sourceParam ? manga.length : 0;
        }
        return NextResponse.json({ manga, total: manga.length, sources });
      } catch (err) {
        const message = err instanceof Error ? err.message : "Unknown error";
        return NextResponse.json(
          { error: `${sourceParam} search failed: ${message}` },
          { status: 502 }
        );
      }
    }

    // All-source mode.
    const { manga, sources } = await searchAllManga(q, limit);
    return NextResponse.json({
      manga,
      total: manga.length,
      sources,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown error";
    return NextResponse.json(
      { error: `Search failed: ${message}` },
      { status: 502 }
    );
  }
}
