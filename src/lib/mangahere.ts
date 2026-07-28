/**
 * MangaHere scraper — replaces MangaDex for chapter image scraping.
 *
 * MangaHere doesn't have an official API, but its HTML is scrapable:
 * 1. Search: GET /search.php?name={query} → parse manga slug links
 * 2. Chapter list: GET /manga/{slug}/ → parse chapter links
 * 3. Image URLs: GET /manga/{slug}/c{chapter}/1.html → extract image filenames
 *    from obfuscated JavaScript, construct full CDN URLs
 * 4. Download: images require Referer: https://www.mangahere.cc/ header
 */

import type { MangadexManga } from "@/types/pipeline";

const MANGAHERE_BASE = "https://www.mangahere.cc";
const MANGAHERE_CDN = "https://zjcdn.mangahere.org";

interface MangaHereSearchResult {
  slug: string; // e.g. "solo_leveling"
  title: string;
  url: string;
}

interface MangaHereChapter {
  slug: string; // e.g. "c001"
  url: string; // full URL to first page
  chapterNum: string; // e.g. "1", "200.5"
  title: string | null;
}

/**
 * Search MangaHere by title. Returns manga slugs that can be used to fetch
 * chapter lists.
 */
export async function searchMangaHere(
  query: string,
  limit = 10
): Promise<MangaHereSearchResult[]> {
  const url = `${MANGAHERE_BASE}/search.php?name=${encodeURIComponent(query)}`;
  const res = await fetch(url, {
    headers: {
      "User-Agent":
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
    },
  });
  if (!res.ok) {
    throw new Error(`MangaHere search ${res.status}`);
  }
  const html = await res.text();

  // Parse manga links: href="/manga/{slug}/"
  const slugSet = new Set<string>();
  const matches = html.matchAll(/href="\/manga\/([a-z0-9_]+)\/"/gi);
  for (const m of matches) {
    const slug = m[1];
    // Skip chapter links (they contain c followed by digits)
    if (!/^c\d/.test(slug)) {
      slugSet.add(slug);
    }
  }

  const slugs = Array.from(slugSet).slice(0, limit);
  return slugs.map((slug) => ({
    slug,
    title: slug
      .replace(/_/g, " ")
      .replace(/\b\w/g, (c) => c.toUpperCase()),
    url: `${MANGAHERE_BASE}/manga/${slug}/`,
  }));
}

/**
 * Get the chapter list for a manga from MangaHere.
 * Returns chapters in descending order (newest first) as they appear on the page.
 */
export async function getMangaHereChapters(
  slug: string
): Promise<MangaHereChapter[]> {
  const url = `${MANGAHERE_BASE}/manga/${slug}/`;
  const res = await fetch(url, {
    headers: {
      "User-Agent":
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
    },
  });
  if (!res.ok) {
    throw new Error(`MangaHere chapters ${res.status} for ${slug}`);
  }
  const html = await res.text();

  // Parse chapter links: href="/manga/{slug}/c{chapter}/1.html"
  const chapters: MangaHereChapter[] = [];
  const seen = new Set<string>();
  const chapterRegex = new RegExp(
    `href="/manga/${slug}/(c[0-9.]+)/1\\.html"[^>]*>([^<]*)`,
    "gi"
  );
  let match;
  while ((match = chapterRegex.exec(html)) !== null) {
    const chapSlug = match[1]; // e.g. "c001" or "c200.5"
    if (seen.has(chapSlug)) continue;
    seen.add(chapSlug);

    // Extract chapter number from slug: "c001" → "1", "c200.5" → "200.5"
    const chapterNum = chapSlug.replace(/^c0*/, "").replace(/^0+/, "") || "0";
    const title = match[2]?.trim() || null;

    chapters.push({
      slug: chapSlug,
      url: `${MANGAHERE_BASE}/manga/${slug}/${chapSlug}/1.html`,
      chapterNum,
      title,
    });
  }

  return chapters;
}

/**
 * Extract all image URLs for a MangaHere chapter.
 *
 * MangaHere loads images via obfuscated JavaScript. The image filenames are
 * embedded in the HTML as pipe-separated values. We extract them and construct
 * full CDN URLs using the pattern:
 *   https://zjcdn.mangahere.org/store/manga/{storeId}/{chapterFolder}.0/compressed/{filename}.jpg
 *
 * The storeId is extracted from the cover image URL on the page.
 * The chapterFolder is the zero-padded chapter number.
 */
export async function getMangaHereChapterImages(
  slug: string,
  chapterSlug: string
): Promise<string[]> {
  const url = `${MANGAHERE_BASE}/manga/${slug}/${chapterSlug}/1.html`;
  const res = await fetch(url, {
    headers: {
      "User-Agent":
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
    },
  });
  if (!res.ok) {
    throw new Error(`MangaHere chapter ${res.status} for ${slug}/${chapterSlug}`);
  }
  const html = await res.text();

  // Extract store ID from cover image URL: store/manga/{storeId}/cover.jpg
  const storeMatch = html.match(/store\/manga\/(\d+)/);
  const storeId = storeMatch?.[1];
  if (!storeId) {
    throw new Error(`Could not extract store ID from ${url}`);
  }

  // Extract chapter folder from chapter slug: "c001" → "001", "c200.5" → "200.5"
  const chapterFolder = chapterSlug.replace(/^c/, "").padStart(3, "0");

  // Extract image filenames from obfuscated JavaScript.
  // Pattern: {letter}{date}_{time}_{number} e.g. h20181105_144325_927
  const filenameRegex = /([a-z]\d{8}_\d{6}_[a-z0-9]+)/gi;
  const filenames = new Set<string>();
  let m;
  while ((m = filenameRegex.exec(html)) !== null) {
    filenames.add(m[1]);
  }

  if (filenames.size === 0) {
    throw new Error(`No image filenames found in ${url}`);
  }

  // Construct full CDN URLs
  const imageUrls = Array.from(filenames).map(
    (fn) =>
      `${MANGAHERE_CDN}/store/manga/${storeId}/${chapterFolder}.0/compressed/${fn}.jpg`
  );

  return imageUrls;
}

/**
 * Download a MangaHere image. Requires Referer header to avoid 403.
 */
export async function downloadMangaHereImage(
  imageUrl: string,
  destPath: string
): Promise<void> {
  const res = await fetch(imageUrl, {
    headers: {
      "User-Agent":
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
      Referer: `${MANGAHERE_BASE}/`,
      Accept: "image/*",
    },
  });
  if (!res.ok) {
    throw new Error(`MangaHere image download ${res.status}: ${imageUrl}`);
  }
  const buf = Buffer.from(await res.arrayBuffer());
  const { promises: fs } = await import("fs");
  await fs.writeFile(destPath, buf);
}

/**
 * Convert a MangaHere search result to the unified MangadexManga type.
 * The id is formatted as "mh-{slug}" to distinguish from other sources.
 */
export function mangaHereToManga(
  result: MangaHereSearchResult
): MangadexManga {
  return {
    id: `mh-${result.slug}`,
    title: result.title,
    description: "",
    coverUrl: null,
    status: null,
    year: null,
    originalLanguage: null,
    availableTranslatedLanguages: [],
    tags: [],
    contentRating: null,
    lastChapter: null,
    source: "mangahere",
    externalUrl: result.url,
  };
}
