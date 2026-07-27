/**
 * lib.ts — shared helpers for the pipeline-service.
 *
 * Contains:
 *  - Prisma client (single instance)
 *  - Path helpers (hardcoded to the parent app's data dir)
 *  - MangaDex fetch helpers (chapter pages, image download)
 *  - VLM helper (z-ai-web-dev-sdk) for generating chapter summaries
 *  - Small utility helpers (sleep, ensureDir, fileExists, sanitize)
 */

import { PrismaClient } from '@prisma/client'
import { promises as fs } from 'fs'
import path from 'path'

// ---------------------------------------------------------------------------
// Prisma — single shared client pointing at the same SQLite DB.
// ---------------------------------------------------------------------------

const globalForPrisma = globalThis as unknown as { pipelinePrisma: PrismaClient | undefined }

export const db =
  globalForPrisma.pipelinePrisma ??
  new PrismaClient({
    log: ['error', 'warn'],
  })

if (process.env.NODE_ENV !== 'production') globalForPrisma.pipelinePrisma = db

// ---------------------------------------------------------------------------
// Paths — hardcoded so the mini-service is decoupled from the parent app's CWD.
// ---------------------------------------------------------------------------

export const DATA_DIR = '/home/z/my-project/data'
export const PIPELINE_SCRIPT = '/home/z/my-project/pipeline/master_pipeline.py'
export const PYTHON_BIN = process.env.PYTHON_BIN || 'python3'

export function jobDir(jobId: string): string {
  return path.join(DATA_DIR, 'jobs', jobId)
}
export function datasetDir(jobId: string): string {
  return path.join(jobDir(jobId), 'dataset')
}
export function workDir(jobId: string): string {
  return path.join(jobDir(jobId), 'work')
}
export function outputDir(jobId: string): string {
  return path.join(jobDir(jobId), 'output')
}
export function chapterDir(jobId: string, index: number): string {
  return path.join(datasetDir(jobId), `chapter_${String(index).padStart(3, '0')}`)
}
export function outputVideoPath(jobId: string): string {
  return path.join(outputDir(jobId), 'master_recap.mp4')
}
export function progressFilePath(jobId: string): string {
  return path.join(jobDir(jobId), 'progress.json')
}

export async function ensureDir(p: string): Promise<void> {
  await fs.mkdir(p, { recursive: true })
}

export async function fileExists(p: string): Promise<boolean> {
  try {
    await fs.access(p)
    return true
  } catch {
    return false
  }
}

export function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms))
}

// ---------------------------------------------------------------------------
// Multi-source scraping helpers (MangaHere + FanFox + Webtoons).
// ---------------------------------------------------------------------------

// --- Source dispatchers ---

export type ScraperSource = 'mangahere' | 'fanfox' | 'webtoons'

export function getSourceFromId(id: string): ScraperSource | null {
  if (id.startsWith('mh-')) return 'mangahere'
  if (id.startsWith('ff-')) return 'fanfox'
  if (id.startsWith('wt-')) return 'webtoons'
  return null
}

export function getSlugFromId(id: string): string {
  return id.replace(/^(mh-|ff-|wt-)/, '')
}

// --- MangaHere (mangahere.cc) ---

const MANGAHERE_BASE = 'https://www.mangahere.cc'
const MANGAHERE_CDN = 'https://zjcdn.mangahere.org'

/**
 * Fetch the chapter list for a manga from MangaHere.
 * mangaId is the MangaHere slug (e.g. "solo_leveling").
 * Returns chapters oldest-first.
 */
export async function fetchMangaHereChapters(
  mangaSlug: string,
  chapterLimit: number,
): Promise<
  Array<{
    mangadexId: string // chapter slug e.g. "c001" (kept as mangadexId for DB compat)
    chapterNum: string | null
    title: string | null
    language: string
    pageCount: number
    external: boolean
  }>
> {
  const url = `${MANGAHERE_BASE}/manga/${mangaSlug}/`
  const res = await fetch(url, {
    headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36' },
  })
  if (!res.ok) {
    throw new Error(`MangaHere chapters ${res.status} for ${mangaSlug}`)
  }
  const html = await res.text()

  // Parse chapter links: href="/manga/{slug}/c{chapter}/1.html"
  const chapters: Array<{
    mangadexId: string
    chapterNum: string | null
    title: string | null
    language: string
    pageCount: number
    external: boolean
  }> = []
  const seen = new Set<string>()
  const chapterRegex = new RegExp(
    `href="/manga/${mangaSlug}/(c[0-9.]+)/1\\.html"`,
    'gi',
  )
  let match
  while ((match = chapterRegex.exec(html)) !== null) {
    const chapSlug = match[1]
    if (seen.has(chapSlug)) continue
    seen.add(chapSlug)
    const chapterNum = chapSlug.replace(/^c0*/, '').replace(/^0+/, '') || '0'
    chapters.push({
      mangadexId: chapSlug,
      chapterNum,
      title: null,
      language: 'en',
      pageCount: 0,
      external: false,
    })
  }

  // MangaHere returns newest-first; reverse to oldest-first.
  chapters.reverse()

  // Apply chapter limit (0 = all).
  const limited = chapterLimit > 0 ? chapters.slice(0, chapterLimit) : chapters
  return limited
}

/**
 * Extract all image URLs for a MangaHere chapter by scraping the chapter page HTML.
 *
 * MangaHere loads images via obfuscated JavaScript. The image filenames are
 * embedded in the HTML as pipe-separated values. We extract them and construct
 * full CDN URLs.
 */
export async function fetchMangaHereChapterImages(
  mangaSlug: string,
  chapterSlug: string,
): Promise<string[]> {
  const url = `${MANGAHERE_BASE}/manga/${mangaSlug}/${chapterSlug}/1.html`
  const res = await fetch(url, {
    headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36' },
  })
  if (!res.ok) {
    throw new Error(`MangaHere chapter ${res.status} for ${mangaSlug}/${chapterSlug}`)
  }
  const html = await res.text()

  // Extract store ID from cover image URL: store/manga/{storeId}/cover.jpg
  const storeMatch = html.match(/store\/manga\/(\d+)/)
  const storeId = storeMatch?.[1]
  if (!storeId) {
    throw new Error(`Could not extract store ID from ${url}`)
  }

  // Extract chapter folder from chapter slug: "c001" → "001", "c200.5" → "200.5"
  const chapterFolder = chapterSlug.replace(/^c/, '').padStart(3, '0')

  // Extract image filenames from obfuscated JavaScript.
  // Pattern: {letter}{date}_{time}_{number} e.g. h20181105_144325_927
  const filenameRegex = /([a-z]\d{8}_\d{6}_[a-z0-9]+)/gi
  const filenames = new Set<string>()
  let m
  while ((m = filenameRegex.exec(html)) !== null) {
    filenames.add(m[1])
  }

  if (filenames.size === 0) {
    throw new Error(`No image filenames found in ${url}`)
  }

  // Construct full CDN URLs
  const imageUrls = Array.from(filenames).map(
    (fn) =>
      `${MANGAHERE_CDN}/store/manga/${storeId}/${chapterFolder}.0/compressed/${fn}.jpg`,
  )

  return imageUrls
}

/**
 * Download a single MangaHere image to disk.
 * CRITICAL: MangaHere CDN requires `Referer: https://www.mangahere.cc/` header.
 */
export async function downloadMangaHereImage(
  imageUrl: string,
  destPath: string,
): Promise<void> {
  const res = await fetch(imageUrl, {
    headers: {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
      Referer: `${MANGAHERE_BASE}/`,
      Accept: 'image/*',
    },
  })
  if (!res.ok) {
    throw new Error(`MangaHere image download ${res.status}: ${imageUrl}`)
  }
  const buf = Buffer.from(await res.arrayBuffer())
  await fs.writeFile(destPath, buf)
}

/**
 * Get the extension from a filename, e.g. "x01.jpg" -> ".jpg".
 */
export function extFromFilename(filename: string): string {
  const m = filename.match(/\.(jpe?g|png|webp|gif)$/i)
  return m ? `.${m[1].toLowerCase()}` : '.jpg'
}

// --- FanFox (fanfox.net) — same CMS as MangaHere, different CDN ---

const FANFOX_BASE = 'https://fanfox.net'
const FANFOX_CDN = 'https://fmcdn.mfcdn.net'

export async function fetchFanFoxChapters(
  mangaSlug: string,
  chapterLimit: number,
): Promise<
  Array<{
    mangadexId: string
    chapterNum: string | null
    title: string | null
    language: string
    pageCount: number
    external: boolean
  }>
> {
  const url = `${FANFOX_BASE}/manga/${mangaSlug}/`
  const res = await fetch(url, {
    headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36' },
  })
  if (!res.ok) {
    throw new Error(`FanFox chapters ${res.status} for ${mangaSlug}`)
  }
  const html = await res.text()

  const chapters: Array<{
    mangadexId: string
    chapterNum: string | null
    title: string | null
    language: string
    pageCount: number
    external: boolean
  }> = []
  const seen = new Set<string>()
  const chapterRegex = new RegExp(
    `href="/manga/${mangaSlug}/(c[0-9.]+)/1\\.html"`,
    'gi',
  )
  let match
  while ((match = chapterRegex.exec(html)) !== null) {
    const chapSlug = match[1]
    if (seen.has(chapSlug)) continue
    seen.add(chapSlug)
    const chapterNum = chapSlug.replace(/^c0*/, '').replace(/^0+/, '') || '0'
    chapters.push({
      mangadexId: chapSlug,
      chapterNum,
      title: null,
      language: 'en',
      pageCount: 0,
      external: false,
    })
  }
  chapters.reverse()
  return chapterLimit > 0 ? chapters.slice(0, chapterLimit) : chapters
}

export async function fetchFanFoxChapterImages(
  mangaSlug: string,
  chapterSlug: string,
): Promise<string[]> {
  const url = `${FANFOX_BASE}/manga/${mangaSlug}/${chapterSlug}/1.html`
  const res = await fetch(url, {
    headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36' },
  })
  if (!res.ok) {
    throw new Error(`FanFox chapter ${res.status} for ${mangaSlug}/${chapterSlug}`)
  }
  const html = await res.text()

  const storeMatch = html.match(/store\/manga\/(\d+)/)
  const storeId = storeMatch?.[1]
  if (!storeId) {
    throw new Error(`Could not extract store ID from ${url}`)
  }
  const chapterFolder = chapterSlug.replace(/^c/, '').padStart(3, '0')

  const filenameRegex = /([a-z]\d{8}_\d{6}_[a-z0-9]+)/gi
  const filenames = new Set<string>()
  let m
  while ((m = filenameRegex.exec(html)) !== null) {
    filenames.add(m[1])
  }

  if (filenames.size === 0) {
    throw new Error(`No image filenames found in ${url}`)
  }

  return Array.from(filenames).map(
    (fn) =>
      `${FANFOX_CDN}/store/manga/${storeId}/${chapterFolder}.0/compressed/${fn}.jpg`,
  )
}

export async function downloadFanFoxImage(
  imageUrl: string,
  destPath: string,
): Promise<void> {
  const res = await fetch(imageUrl, {
    headers: {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
      Referer: `${FANFOX_BASE}/`,
      Accept: 'image/*',
    },
  })
  if (!res.ok) {
    throw new Error(`FanFox image download ${res.status}: ${imageUrl}`)
  }
  const buf = Buffer.from(await res.arrayBuffer())
  await fs.writeFile(destPath, buf)
}

// --- Webtoons (webtoons.com) — official manhwa/webtoons ---

const WEBTOONS_BASE = 'https://www.webtoons.com'

export async function fetchWebtoonsChapters(
  titleNo: number,
  chapterLimit: number,
): Promise<
  Array<{
    mangadexId: string
    chapterNum: string | null
    title: string | null
    language: string
    pageCount: number
    external: boolean
  }>
> {
  const res = await fetch(
    `${WEBTOONS_BASE}/en/fantasy/_/list?title_no=${titleNo}`,
    {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
        'Accept-Language': 'en-US,en;q=0.9',
      },
      redirect: 'follow',
    },
  )
  if (!res.ok) {
    throw new Error(`Webtoons chapters ${res.status} for title_no=${titleNo}`)
  }
  const html = await res.text()

  const chapters: Array<{
    mangadexId: string
    chapterNum: string | null
    title: string | null
    language: string
    pageCount: number
    external: boolean
  }> = []
  const seen = new Set<number>()
  const regex = /href="([^"]*\/viewer\?title_no=\d+&episode_no=(\d+))"/gi
  let match
  while ((match = regex.exec(html)) !== null) {
    const epNo = parseInt(match[2], 10)
    if (seen.has(epNo)) continue
    seen.add(epNo)
    chapters.push({
      mangadexId: `ep-${epNo}`,
      chapterNum: String(epNo),
      title: null,
      language: 'en',
      pageCount: 0,
      external: false,
    })
  }
  chapters.reverse()
  return chapterLimit > 0 ? chapters.slice(0, chapterLimit) : chapters
}

export async function fetchWebtoonsChapterImages(
  titleNo: number,
  episodeNo: number,
): Promise<string[]> {
  // Find the viewer URL from the list page.
  const listRes = await fetch(
    `${WEBTOONS_BASE}/en/fantasy/_/list?title_no=${titleNo}`,
    {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
        'Accept-Language': 'en-US,en;q=0.9',
      },
      redirect: 'follow',
    },
  )
  if (!listRes.ok) {
    throw new Error(`Webtoons list ${listRes.status}`)
  }
  const listHtml = await listRes.text()

  const viewerRegex = new RegExp(
    `href="([^"]*episode_no=${episodeNo})"`,
    'i',
  )
  const viewerMatch = listHtml.match(viewerRegex)
  if (!viewerMatch) {
    throw new Error(`Episode ${episodeNo} not found for title_no=${titleNo}`)
  }
  const viewerUrl = viewerMatch[1].startsWith('http')
    ? viewerMatch[1]
    : `${WEBTOONS_BASE}${viewerMatch[1]}`

  const res = await fetch(viewerUrl, {
    headers: {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
      'Accept-Language': 'en-US,en;q=0.9',
      Referer: `${WEBTOONS_BASE}/`,
    },
  })
  if (!res.ok) {
    throw new Error(`Webtoons viewer ${res.status}`)
  }
  const html = await res.text()

  // Webtoons embeds image URLs in data-url attributes.
  const images: string[] = []
  const dataUrlRegex = /data-url="(https:\/\/webtoon-phinf\.pstatic\.net\/[^"]+)"/gi
  let m
  while ((m = dataUrlRegex.exec(html)) !== null) {
    images.push(m[1])
  }

  // Fallback: try src attributes.
  if (images.length === 0) {
    const srcRegex = /src="(https:\/\/webtoon-phinf\.pstatic\.net\/[^"]+)"/gi
    while ((m = srcRegex.exec(html)) !== null) {
      images.push(m[1])
    }
  }

  return images
}

export async function downloadWebtoonsImage(
  imageUrl: string,
  destPath: string,
): Promise<void> {
  const res = await fetch(imageUrl, {
    headers: {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
      Referer: `${WEBTOONS_BASE}/`,
      Accept: 'image/*',
    },
  })
  if (!res.ok) {
    throw new Error(`Webtoons image download ${res.status}: ${imageUrl}`)
  }
  const buf = Buffer.from(await res.arrayBuffer())
  await fs.writeFile(destPath, buf)
}

// --- Unified dispatchers ---

export async function fetchChaptersForSource(
  source: ScraperSource,
  mangaId: string,
  chapterLimit: number,
) {
  const slug = getSlugFromId(mangaId)
  switch (source) {
    case 'mangahere':
      return fetchMangaHereChapters(slug, chapterLimit)
    case 'fanfox':
      return fetchFanFoxChapters(slug, chapterLimit)
    case 'webtoons':
      return fetchWebtoonsChapters(parseInt(slug, 10), chapterLimit)
  }
}

export async function fetchImagesForSource(
  source: ScraperSource,
  mangaId: string,
  chapterSlug: string,
): Promise<string[]> {
  const slug = getSlugFromId(mangaId)
  switch (source) {
    case 'mangahere':
      return fetchMangaHereChapterImages(slug, chapterSlug)
    case 'fanfox':
      return fetchFanFoxChapterImages(slug, chapterSlug)
    case 'webtoons':
      return fetchWebtoonsChapterImages(
        parseInt(slug, 10),
        parseInt(chapterSlug.replace(/^ep-/, ''), 10),
      )
  }
}

export async function downloadImageForSource(
  source: ScraperSource,
  imageUrl: string,
  destPath: string,
): Promise<void> {
  switch (source) {
    case 'mangahere':
      return downloadMangaHereImage(imageUrl, destPath)
    case 'fanfox':
      return downloadFanFoxImage(imageUrl, destPath)
    case 'webtoons':
      return downloadWebtoonsImage(imageUrl, destPath)
  }
}

// ---------------------------------------------------------------------------
// VLM helper — generates per-chapter English summaries from scraped images.
// ---------------------------------------------------------------------------

let zaiPromise: Promise<unknown> | null = null

async function getZai() {
  // Lazy-load so the service can boot even if the SDK has issues at first run.
  if (!zaiPromise) {
    zaiPromise = (async () => {
      const ZAI = (await import('z-ai-web-dev-sdk')).default
      return await ZAI.create()
    })()
  }
  return await zaiPromise
}

/**
 * Generate an English narrative summary for a chapter by sampling up to 9
 * images (first 3, middle 3, last 3) and asking the VLM to describe them.
 *
 * Falls back to a minimal summary on any error so the pipeline never blocks.
 * NOTE: This is the OLD chapter-level summary. Prefer generateImageNarrations
 * for per-image narration that stays in sync with the video frames.
 */
export async function generateChapterSummary(
  imagePaths: string[],
): Promise<string> {
  if (imagePaths.length === 0) {
    return 'The chapter continues the story.'
  }

  // Pick up to 9 sample images: first 3, middle 3, last 3.
  const sample = pickSampleImages(imagePaths, 9)

  try {
    const zai = await getZai()

    // Build content array: text prompt + each sample image as a base64 data URL.
    const content: Array<
      | { type: 'text'; text: string }
      | { type: 'image_url'; image_url: { url: string } }
    > = [
      {
        type: 'text',
        text:
          'You are summarizing a manhwa/manga chapter for a recap video. ' +
          'Look at these panel images (ordered from the beginning, middle, and end of the chapter) ' +
          'and write a detailed ENGLISH narrative summary of what happens: the events, ' +
          'character actions, key dialogue, and emotional beats. ' +
          'Write 3 to 6 sentences in third person, present tense, as if narrating a story. ' +
          'Do not mention chapter numbers. Do not mention that you are looking at images. ' +
          'Output only the summary text.',
      },
    ]

    for (const p of sample) {
      const buf = await fs.readFile(p)
      const b64 = buf.toString('base64')
      const mime = p.toLowerCase().endsWith('.png') ? 'image/png' : 'image/jpeg'
      content.push({
        type: 'image_url',
        image_url: { url: `data:${mime};base64,${b64}` },
      })
    }

    const zaiAny = zai as {
      chat: {
        completions: {
          createVision: (opts: {
            messages: Array<{ role: string; content: typeof content }>
            thinking: { type: string }
          }) => Promise<{
            choices?: Array<{ message?: { content?: string } }>
          }>
        }
      }
    }

    const resp = await zaiAny.chat.completions.createVision({
      messages: [{ role: 'user', content }],
      thinking: { type: 'disabled' },
    })

    const text = resp?.choices?.[0]?.message?.content?.trim()
    if (text && text.length > 0) {
      return text
    }
    return 'The chapter continues the story.'
  } catch (err) {
    console.error('[VLM] summary generation failed:', err)
    return 'The chapter continues the story.'
  }
}

/**
 * Generate per-image narrations: send each image to the VLM individually and
 * get 2-4 sentences of narration describing exactly what's in that image.
 * This produces perfect sync — when the video shows image N, the narration
 * describes image N.
 *
 * Processes images with limited concurrency (3 at a time) to balance speed
 * and API load. Falls back to a generic sentence per image on any error so
 * the pipeline never blocks.
 *
 * Returns an array of { image, text } in the same order as imagePaths.
 */
export async function generateImageNarrations(
  imagePaths: string[],
  onProgress?: (done: number, total: number) => void,
): Promise<Array<{ image: string; text: string }>> {
  if (imagePaths.length === 0) {
    return []
  }

  const results: Array<{ image: string; text: string }> = new Array(imagePaths.length)
  const CONCURRENCY = 3

  // Process in batches of CONCURRENCY.
  for (let i = 0; i < imagePaths.length; i += CONCURRENCY) {
    const batch = imagePaths.slice(i, i + CONCURRENCY)
    const texts = await Promise.all(
      batch.map(async (imgPath, batchIdx) => {
        const globalIdx = i + batchIdx
        try {
          const text = await narrateSingleImage(imgPath)
          return text
        } catch (err) {
          console.error(`[VLM] image ${globalIdx + 1} narration failed:`, err)
          return 'The scene continues to unfold.'
        }
      }),
    )
    for (let j = 0; j < batch.length; j++) {
      const globalIdx = i + j
      results[globalIdx] = {
        image: path.basename(imagePaths[globalIdx]),
        text: texts[j],
      }
    }
    if (onProgress) {
      onProgress(Math.min(i + CONCURRENCY, imagePaths.length), imagePaths.length)
    }
  }

  return results
}

/**
 * Send a single image to the VLM and get back the actual dialogue/caption
 * text from its speech bubbles, thought bubbles, and caption boxes —
 * transcribed as-is (translated to English), not narrated or paraphrased.
 */
async function narrateSingleImage(imgPath: string): Promise<string> {
  const zai = await getZai()

  const buf = await fs.readFile(imgPath)
  const b64 = buf.toString('base64')
  const ext = path.extname(imgPath).toLowerCase()
  const mime = ext === '.png' ? 'image/png' : ext === '.webp' ? 'image/webp' : 'image/jpeg'

  const content: Array<
    | { type: 'text'; text: string }
    | { type: 'image_url'; image_url: { url: string } }
  > = [
    {
      type: 'text',
      text:
        'You are a precise transcriber for a webtoon/manhwa panel, not a narrator. ' +
        'Look at this single panel and transcribe ONLY the actual text you can see inside ' +
        'speech bubbles, thought bubbles, and caption/narration boxes — in the order a reader ' +
        'would naturally read them (top to bottom, left to right within the panel). ' +
        'Translate it into natural English if it is not already in English, preserving the ' +
        'original meaning and tone as closely as possible.\n\n' +
        'Guidelines:\n' +
        '1. Output the text VERBATIM (translated) — do not paraphrase, summarize, embellish, or ' +
        'add descriptive narration around it. Do not invent dialogue that is not actually written.\n' +
        '2. Do not describe the artwork, action, or characters\' expressions — only transcribe ' +
        'written text that literally appears in the image.\n' +
        '3. If multiple bubbles/boxes are present, join them in reading order as separate ' +
        'sentences, preserving punctuation like "..." and "!" as written.\n' +
        '4. Sound effect text (e.g. "BOOM", "CRASH") can be included briefly if it is the only ' +
        'text present, otherwise skip pure onomatopoeia in favor of actual dialogue/captions.\n' +
        '5. Never mention chapter numbers, page numbers, panels, or that you are looking at an image.\n' +
        '6. If the panel has NO readable text at all (a purely visual/action panel with no bubbles ' +
        'or captions), output nothing at all — an empty response. Do not invent narration to fill it.\n' +
        '7. Output ONLY the transcribed (translated) text — no preamble, no headers, no markdown, ' +
        'no notes about what you did.',
    },
    {
      type: 'image_url',
      image_url: { url: `data:${mime};base64,${b64}` },
    },
  ]

  const zaiAny = zai as {
    chat: {
      completions: {
        createVision: (opts: {
          messages: Array<{ role: string; content: typeof content }>
          thinking: { type: string }
        }) => Promise<{
          choices?: Array<{ message?: { content?: string } }>
        }>
      }
    }
  }

  const resp = await zaiAny.chat.completions.createVision({
    messages: [{ role: 'user', content }],
    thinking: { type: 'disabled' },
  })

  const text = resp?.choices?.[0]?.message?.content?.trim()
  // No filler fallback here on purpose: a panel with no bubbles/captions is a
  // real "silent" panel (pure action/scenery), and the rest of the pipeline
  // already handles empty narration correctly by holding the frame briefly
  // with silence instead of narrating something that was never written.
  return text ?? ''
}

/**
 * Pick up to `maxCount` sample images from a sorted list: first N, middle N, last N.
 */
function pickSampleImages(paths: string[], maxCount: number): string[] {
  if (paths.length <= maxCount) return paths.slice()
  const n = Math.floor(maxCount / 3)
  const first = paths.slice(0, n)
  const midStart = Math.floor(paths.length / 2) - Math.floor(n / 2)
  const middle = paths.slice(midStart, midStart + n)
  const last = paths.slice(paths.length - n)
  // Dedupe in case of overlap on small arrays.
  const seen = new Set<string>()
  const out: string[] = []
  for (const p of [...first, ...middle, ...last]) {
    if (!seen.has(p)) {
      seen.add(p)
      out.push(p)
    }
  }
  return out.slice(0, maxCount)
}
