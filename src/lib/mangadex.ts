import type { MangadexManga } from "@/types/pipeline";

const API_BASE = "https://api.mangadex.org";
const COVERS_BASE = "https://uploads.mangadex.org/covers";

interface Relationship {
  id: string;
  type: string;
  attributes?: Record<string, unknown>;
}

interface MangaAttributes {
  title?: Record<string, string>;
  altTitles?: Record<string, string>[];
  description?: Record<string, string>;
  originalLanguage?: string;
  availableTranslatedLanguages?: string[];
  tags?: Array<{ attributes?: { name?: Record<string, string> } }>;
  contentRating?: string;
  status?: string;
  year?: number | null;
  lastChapter?: string | null;
}

interface MangaResource {
  id: string;
  type: "manga";
  attributes: MangaAttributes;
  relationships?: Relationship[];
}

interface ChapterAttributes {
  chapter?: string | null;
  title?: string | null;
  translatedLanguage?: string;
  pages?: number;
  volume?: string | null;
  externalUrl?: string | null;
}

interface ChapterResource {
  id: string;
  type: "chapter";
  attributes: ChapterAttributes;
  relationships?: Relationship[];
}

interface AtHomeResponse {
  baseUrl: string;
  chapter: {
    hash: string;
    data: string[];
    dataSaver: string[];
  };
}

/**
 * Pull the first available string value from a localized dictionary.
 * Prefers English, then any key.
 */
function pickLocalized(dict: Record<string, string> | undefined): string {
  if (!dict) return "";
  if (dict.en) return dict.en;
  const keys = Object.keys(dict);
  if (keys.length > 0) return dict[keys[0]];
  return "";
}

/** Find a relationship of a given type on a resource. */
function findRelationship(
  resource: { relationships?: Relationship[] },
  type: string
): Relationship | undefined {
  return resource.relationships?.find((r) => r.type === type);
}

/** Build a cover URL from a manga id + cover_art relationship. */
function buildCoverUrl(mangaId: string, relationships?: Relationship[]): string | null {
  const cover = findRelationship({ relationships }, "cover_art");
  const fileName = cover?.attributes?.fileName as string | undefined;
  if (!fileName) return null;
  return `${COVERS_BASE}/${mangaId}/${fileName}`;
}

/** Convert a raw MangaDex manga resource into our flat MangadexManga type. */
export function mapManga(resource: MangaResource): MangadexManga {
  const attrs = resource.attributes ?? {};
  const title =
    pickLocalized(attrs.title) ||
    (attrs.altTitles && attrs.altTitles.length > 0
      ? pickLocalized(attrs.altTitles[0])
      : "") ||
    resource.id;

  const description =
    pickLocalized(attrs.description) ||
    (attrs.altTitles && attrs.altTitles.length > 0
      ? pickLocalized(attrs.description)
      : "");

  return {
    id: resource.id,
    title,
    description,
    coverUrl: buildCoverUrl(resource.id, resource.relationships),
    status: attrs.status ?? null,
    year: attrs.year ?? null,
    originalLanguage: attrs.originalLanguage ?? null,
    availableTranslatedLanguages: attrs.availableTranslatedLanguages ?? [],
    tags: (attrs.tags ?? [])
      .map((t) => pickLocalized(t.attributes?.name))
      .filter(Boolean),
    contentRating: attrs.contentRating ?? null,
    lastChapter: attrs.lastChapter ?? null,
  };
}

/** Small fetch wrapper with JSON parsing + error handling. */
async function mdFetch<T>(path: string): Promise<T> {
  const url = path.startsWith("http") ? path : `${API_BASE}${path}`;
  let res: Response;
  try {
    res = await fetch(url, {
      headers: { accept: "application/json" },
      // Always fetch fresh (search results change).
      cache: "no-store",
    });
  } catch (err) {
    throw new Error(
      `MangaDex network error: ${err instanceof Error ? err.message : String(err)}`
    );
  }

  if (!res.ok) {
    let detail = "";
    try {
      const body = (await res.json()) as { errors?: Array<{ detail?: string }> };
      detail = body.errors?.map((e) => e.detail).filter(Boolean).join("; ") ?? "";
    } catch {
      // ignore JSON parse error
    }
    throw new Error(
      `MangaDex API ${res.status} ${res.statusText}${detail ? `: ${detail}` : ""}`
    );
  }

  return (await res.json()) as T;
}

/**
 * Search MangaDex for manga by title.
 */
export async function searchManga(
  query: string,
  limit = 12
): Promise<MangadexManga[]> {
  const params = new URLSearchParams();
  params.set("title", query);
  params.set("limit", String(Math.min(Math.max(limit, 1), 100)));
  params.append("includes[]", "cover_art");
  params.set("order[relevance]", "desc");
  for (const rating of ["safe", "suggestive", "erotica"]) {
    params.append("contentRating[]", rating);
  }

  const data = await mdFetch<{ data: MangaResource[]; total: number }>(
    `/manga?${params.toString()}`
  );
  return (data.data ?? []).map(mapManga);
}

/** Fetch a single manga by id (with cover_art included). */
export async function getManga(id: string): Promise<MangadexManga> {
  const params = new URLSearchParams({ "includes[]": "cover_art" });
  const data = await mdFetch<{ data: MangaResource }>(
    `/manga/${encodeURIComponent(id)}?${params.toString()}`
  );
  return mapManga(data.data);
}

/**
 * Fetch a manga's chapter feed.
 * Excludes external (no-image) chapters.
 * Optionally filtered by translated language.
 */
export async function getMangaChapters(
  mangaId: string,
  translatedLanguage?: string,
  limit = 500
): Promise<ChapterResource[]> {
  const params = new URLSearchParams();
  params.set("order[chapter]", "asc");
  params.set("order[volume]", "asc");
  params.set("limit", String(Math.min(Math.max(limit, 1), 500)));
  params.append("includes[]", "scanlation_group");
  for (const rating of ["safe", "suggestive", "erotica"]) {
    params.append("contentRating[]", rating);
  }
  if (translatedLanguage) {
    params.append("translatedLanguage[]", translatedLanguage);
  }

  const data = await mdFetch<{ data: ChapterResource[]; total: number }>(
    `/manga/${encodeURIComponent(mangaId)}/feed?${params.toString()}`
  );

  // Filter out external-link chapters (no readable images).
  return (data.data ?? []).filter((ch) => {
    const external = ch.attributes?.externalUrl;
    return !external; // keep when externalUrl is null/undefined/empty
  });
}

/**
 * Get at-home server info for a chapter (base URL + file list).
 */
export async function getChapterPages(
  chapterId: string
): Promise<{ baseUrl: string; hash: string; files: string[] }> {
  const data = await mdFetch<AtHomeResponse>(
    `/at-home/server/${encodeURIComponent(chapterId)}`
  );
  return {
    baseUrl: data.baseUrl,
    hash: data.chapter.hash,
    files: data.chapter.data ?? [],
  };
}

/** Build a page image URL from at-home info. */
export function buildImageUrl(
  baseUrl: string,
  hash: string,
  file: string,
  saver = false
): string {
  const folder = saver ? "data-saver" : "data";
  return `${baseUrl}/${folder}/${hash}/${file}`;
}
