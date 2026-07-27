/**
 * Multi-source manga scraper — 3 scraping APIs + 2 metadata APIs.
 *
 * Scraping sources (provide chapter images):
 *  1. MangaHere (mangahere.cc) — manga + manhwa, obfuscated JS image URLs
 *  2. FanFox (fanfox.net) — same CMS as MangaHere, different CDN (fmcdn.mfcdn.net)
 *  3. Webtoons (webtoons.com) — official manhwa/webtoons, direct img tags
 *
 * Metadata sources (search only, resolve to scraping sources by title):
 *  - Jikan (MyAnimeList)
 *  - AniList
 *
 * Each manga result is tagged with `source: "mangahere" | "fanfox" | "webtoons" | "mal" | "anilist"`.
 * The pipeline service uses the source to determine which scraper to use.
 */

import type { MangadexManga } from "@/types/pipeline";

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

const FETCH_TIMEOUT_MS = 10_000; // 10s timeout for all external fetches

async function fetchWithTimeout(url: string, init?: RequestInit): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

// ---------------------------------------------------------------------------
// Shared types
// ---------------------------------------------------------------------------

export interface ScrapedChapter {
  id: string; // chapter slug/id used by the source
  chapterNum: string;
  title: string | null;
}

export interface ScrapedImage {
  url: string;
  referer: string; // required Referer header for this CDN
}

// ---------------------------------------------------------------------------
// Source 1: MangaHere (mangahere.cc)
// ---------------------------------------------------------------------------

const MANGAHERE_BASE = "https://www.mangahere.cc";
const MANGAHERE_CDN = "https://zjcdn.mangahere.org";

export async function searchMangaHere(
  query: string,
  limit = 10
): Promise<MangadexManga[]> {
  const res = await fetchWithTimeout(
    `${MANGAHERE_BASE}/search.php?name=${encodeURIComponent(query)}`,
    { headers: { "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36" } }
  );
  if (!res.ok) throw new Error(`MangaHere search ${res.status}`);
  const html = await res.text();

  const slugSet = new Set<string>();
  const matches = html.matchAll(/href="\/manga\/([a-z0-9_]+)\/"/gi);
  for (const m of matches) {
    if (!/^c\d/.test(m[1])) slugSet.add(m[1]);
  }

  return Array.from(slugSet).slice(0, limit).map((slug) => ({
    id: `mh-${slug}`,
    title: slug.replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase()),
    description: "",
    coverUrl: null,
    status: null,
    year: null,
    originalLanguage: null,
    availableTranslatedLanguages: [],
    tags: [],
    contentRating: null,
    lastChapter: null,
    source: "mangahere" as const,
    externalUrl: `${MANGAHERE_BASE}/manga/${slug}/`,
  }));
}

export async function getMangaHereChapters(slug: string): Promise<ScrapedChapter[]> {
  const res = await fetchWithTimeout(`${MANGAHERE_BASE}/manga/${slug}/`, {
    headers: { "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36" },
  });
  if (!res.ok) throw new Error(`MangaHere chapters ${res.status}`);
  const html = await res.text();

  const chapters: ScrapedChapter[] = [];
  const seen = new Set<string>();
  const regex = new RegExp(`href="/manga/${slug}/(c[0-9.]+)/1\\.html"`, "gi");
  let match;
  while ((match = regex.exec(html)) !== null) {
    if (seen.has(match[1])) continue;
    seen.add(match[1]);
    chapters.push({
      id: match[1],
      chapterNum: match[1].replace(/^c0*/, "").replace(/^0+/, "") || "0",
      title: null,
    });
  }
  chapters.reverse();
  return chapters;
}

export async function getMangaHereImages(
  slug: string,
  chapterSlug: string
): Promise<ScrapedImage[]> {
  const res = await fetchWithTimeout(
    `${MANGAHERE_BASE}/manga/${slug}/${chapterSlug}/1.html`,
    { headers: { "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36" } }
  );
  if (!res.ok) throw new Error(`MangaHere chapter ${res.status}`);
  const html = await res.text();

  const storeMatch = html.match(/store\/manga\/(\d+)/);
  if (!storeMatch) throw new Error("Could not extract store ID");
  const storeId = storeMatch[1];
  const chapterFolder = chapterSlug.replace(/^c/, "").padStart(3, "0");

  const filenames = new Set<string>();
  let m;
  const re = /([a-z]\d{8}_\d{6}_[a-z0-9]+)/gi;
  while ((m = re.exec(html)) !== null) filenames.add(m[1]);

  return Array.from(filenames).map((fn) => ({
    url: `${MANGAHERE_CDN}/store/manga/${storeId}/${chapterFolder}.0/compressed/${fn}.jpg`,
    referer: `${MANGAHERE_BASE}/`,
  }));
}

// ---------------------------------------------------------------------------
// Source 2: FanFox (fanfox.net) — same CMS as MangaHere, different CDN
// ---------------------------------------------------------------------------

const FANFOX_BASE = "https://fanfox.net";
const FANFOX_CDN = "https://fmcdn.mfcdn.net";

export async function searchFanFox(
  query: string,
  limit = 10
): Promise<MangadexManga[]> {
  const res = await fetchWithTimeout(
    `${FANFOX_BASE}/search?name=${encodeURIComponent(query)}`,
    { headers: { "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36" } }
  );
  if (!res.ok) throw new Error(`FanFox search ${res.status}`);
  const html = await res.text();

  const slugSet = new Set<string>();
  const matches = html.matchAll(/href="\/manga\/([a-z0-9_]+)\/"/gi);
  for (const m of matches) {
    if (!/^c\d/.test(m[1])) slugSet.add(m[1]);
  }

  return Array.from(slugSet).slice(0, limit).map((slug) => ({
    id: `ff-${slug}`,
    title: slug.replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase()),
    description: "",
    coverUrl: null,
    status: null,
    year: null,
    originalLanguage: null,
    availableTranslatedLanguages: [],
    tags: [],
    contentRating: null,
    lastChapter: null,
    source: "fanfox" as const,
    externalUrl: `${FANFOX_BASE}/manga/${slug}/`,
  }));
}

export async function getFanFoxChapters(slug: string): Promise<ScrapedChapter[]> {
  const res = await fetchWithTimeout(`${FANFOX_BASE}/manga/${slug}/`, {
    headers: { "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36" },
  });
  if (!res.ok) throw new Error(`FanFox chapters ${res.status}`);
  const html = await res.text();

  const chapters: ScrapedChapter[] = [];
  const seen = new Set<string>();
  const regex = new RegExp(`href="/manga/${slug}/(c[0-9.]+)/1\\.html"`, "gi");
  let match;
  while ((match = regex.exec(html)) !== null) {
    if (seen.has(match[1])) continue;
    seen.add(match[1]);
    chapters.push({
      id: match[1],
      chapterNum: match[1].replace(/^c0*/, "").replace(/^0+/, "") || "0",
      title: null,
    });
  }
  chapters.reverse();
  return chapters;
}

export async function getFanFoxImages(
  slug: string,
  chapterSlug: string
): Promise<ScrapedImage[]> {
  const res = await fetchWithTimeout(
    `${FANFOX_BASE}/manga/${slug}/${chapterSlug}/1.html`,
    { headers: { "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36" } }
  );
  if (!res.ok) throw new Error(`FanFox chapter ${res.status}`);
  const html = await res.text();

  const storeMatch = html.match(/store\/manga\/(\d+)/);
  if (!storeMatch) throw new Error("Could not extract store ID");
  const storeId = storeMatch[1];
  const chapterFolder = chapterSlug.replace(/^c/, "").padStart(3, "0");

  const filenames = new Set<string>();
  let m;
  const re = /([a-z]\d{8}_\d{6}_[a-z0-9]+)/gi;
  while ((m = re.exec(html)) !== null) filenames.add(m[1]);

  return Array.from(filenames).map((fn) => ({
    url: `${FANFOX_CDN}/store/manga/${storeId}/${chapterFolder}.0/compressed/${fn}.jpg`,
    referer: `${FANFOX_BASE}/`,
  }));
}

// ---------------------------------------------------------------------------
// Source 3: Webtoons (webtoons.com) — official manhwa/webtoons
// ---------------------------------------------------------------------------

const WEBTOONS_BASE = "https://www.webtoons.com";

interface WebtoonsTitle {
  titleNo: number;
  title: string;
  genre: string;
  url: string;
}

export async function searchWebtoons(
  query: string,
  limit = 10
): Promise<MangadexManga[]> {
  // Webtoons search requires a headless browser or their API.
  // We use the public search endpoint that returns HTML.
  const res = await fetchWithTimeout(
    `${WEBTOONS_BASE}/en/search?keyword=${encodeURIComponent(query)}&searchType=ALL`,
    {
      headers: {
        "User-Agent":
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
        "Accept-Language": "en-US,en;q=0.9",
      },
    }
  );
  if (!res.ok) throw new Error(`Webtoons search ${res.status}`);
  const html = await res.text();

  // Parse search results: links like /en/{genre}/{title-slug}/list?title_no={n}
  // The title text is in nested elements, so we extract the title from the URL slug.
  const titles: WebtoonsTitle[] = [];
  const seen = new Set<number>();
  const regex = /href="([^"]*\/en\/([^"]+)\/list\?title_no=(\d+))"/gi;
  let match;
  while ((match = regex.exec(html)) !== null) {
    const titleNo = parseInt(match[3], 10);
    if (seen.has(titleNo)) continue;
    seen.add(titleNo);
    // Extract title from the URL path: /en/{genre}/{title-slug}/list?title_no=N
    // match[2] is the genre/title-slug part, e.g. "fantasy/tower-of-god"
    const pathParts = match[2].split("/");
    const titleSlug = pathParts[pathParts.length - 1]; // e.g. "tower-of-god"
    const title = titleSlug.replace(/-/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
    if (!title) continue;
    titles.push({
      titleNo,
      title,
      genre: pathParts[0] ?? "",
      url: match[1].startsWith("http") ? match[1] : `${WEBTOONS_BASE}${match[1]}`,
    });
  }

  return titles.slice(0, limit).map((t) => ({
    id: `wt-${t.titleNo}`,
    title: t.title,
    description: "",
    coverUrl: null,
    status: "Ongoing",
    year: null,
    originalLanguage: "ko",
    availableTranslatedLanguages: ["en"],
    tags: [],
    contentRating: "safe",
    lastChapter: null,
    source: "webtoons" as const,
    externalUrl: t.url,
  }));
}

export async function getWebtoonsChapters(
  titleNo: number
): Promise<ScrapedChapter[]> {
  // We need to find the manga's list page URL first.
  // Webtoons episode list is at /en/{genre}/{title}/list?title_no={n}
  // We try fetching the list page directly.
  const res = await fetchWithTimeout(
    `${WEBTOONS_BASE}/en/fantasy/_/list?title_no=${titleNo}`,
    {
      headers: {
        "User-Agent":
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
        "Accept-Language": "en-US,en;q=0.9",
      },
      redirect: "follow",
    }
  );
  if (!res.ok) throw new Error(`Webtoons chapters ${res.status}`);
  const html = await res.text();

  // Parse episode links: /en/{genre}/{title}/{episode-slug}/viewer?title_no={n}&episode_no={m}
  const chapters: ScrapedChapter[] = [];
  const seen = new Set<number>();
  const regex = /href="([^"]*\/viewer\?title_no=\d+&episode_no=(\d+))"/gi;
  let match;
  while ((match = regex.exec(html)) !== null) {
    const epNo = parseInt(match[2], 10);
    if (seen.has(epNo)) continue;
    seen.add(epNo);
    chapters.push({
      id: `ep-${epNo}`,
      chapterNum: String(epNo),
      title: null,
    });
  }
  // Webtoons lists newest first; reverse to oldest first.
  chapters.reverse();
  return chapters;
}

export async function getWebtoonsImages(
  titleNo: number,
  episodeNo: number
): Promise<ScrapedImage[]> {
  // We need the viewer URL. We try the most common pattern.
  const listRes = await fetchWithTimeout(
    `${WEBTOONS_BASE}/en/fantasy/_/list?title_no=${titleNo}`,
    {
      headers: {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
        "Accept-Language": "en-US,en;q=0.9",
      },
      redirect: "follow",
    }
  );
  if (!listRes.ok) throw new Error(`Webtoons list ${listRes.status}`);
  const listHtml = await listRes.text();

  // Find the viewer URL for this episode.
  const viewerRegex = new RegExp(
    `href="([^"]*episode_no=${episodeNo})"[^>]*>(?:[^<]*<[^>]*>)*[^<]*`,
    "i"
  );
  const viewerMatch = listHtml.match(viewerRegex);
  if (!viewerMatch) throw new Error(`Episode ${episodeNo} not found`);
  const viewerUrl = viewerMatch[1].startsWith("http")
    ? viewerMatch[1]
    : `${WEBTOONS_BASE}${viewerMatch[1]}`;

  const res = await fetchWithTimeout(viewerUrl, {
    headers: {
      "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
      "Accept-Language": "en-US,en;q=0.9",
      Referer: `${WEBTOONS_BASE}/`,
    },
  });
  if (!res.ok) throw new Error(`Webtoons viewer ${res.status}`);
  const html = await res.text();

  // Webtoons embeds image URLs in <img> tags with URLs like
  // https://webtoon-phinf.pstatic.net/...
  const images: ScrapedImage[] = [];
  const imgRegex = /data-url="(https:\/\/webtoon-phinf\.pstatic\.net\/[^"]+)"/gi;
  let m;
  while ((m = imgRegex.exec(html)) !== null) {
    images.push({ url: m[1], referer: `${WEBTOONS_BASE}/` });
  }

  // Fallback: try src attributes
  if (images.length === 0) {
    const srcRegex = /src="(https:\/\/webtoon-phinf\.pstatic\.net\/[^"]+)"/gi;
    while ((m = srcRegex.exec(html)) !== null) {
      images.push({ url: m[1], referer: `${WEBTOONS_BASE}/` });
    }
  }

  return images;
}

// ---------------------------------------------------------------------------
// Unified dispatcher: given a manga ID, determine the source and delegate.
// ---------------------------------------------------------------------------

export type ScraperSource = "mangahere" | "fanfox" | "webtoons";

export function getSourceFromId(id: string): ScraperSource | null {
  if (id.startsWith("mh-")) return "mangahere";
  if (id.startsWith("ff-")) return "fanfox";
  if (id.startsWith("wt-")) return "webtoons";
  return null;
}

export function getSlugFromId(id: string): string {
  return id.replace(/^(mh-|ff-|wt-)/, "");
}

export async function getChaptersForSource(
  source: ScraperSource,
  slug: string
): Promise<ScrapedChapter[]> {
  switch (source) {
    case "mangahere":
      return getMangaHereChapters(slug);
    case "fanfox":
      return getFanFoxChapters(slug);
    case "webtoons":
      return getWebtoonsChapters(parseInt(slug, 10));
  }
}

export async function getImagesForSource(
  source: ScraperSource,
  slug: string,
  chapterId: string
): Promise<ScrapedImage[]> {
  switch (source) {
    case "mangahere":
      return getMangaHereImages(slug, chapterId);
    case "fanfox":
      return getFanFoxImages(slug, chapterId);
    case "webtoons":
      return getWebtoonsImages(parseInt(slug, 10), parseInt(chapterId.replace(/^ep-/, ""), 10));
  }
}
