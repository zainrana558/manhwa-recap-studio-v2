/**
 * index.ts — Master Recap Pipeline mini-service (port 3001).
 *
 * Responsibilities:
 *  1. socket.io server on path `/` (required by Caddy gateway).
 *  2. HTTP internal endpoints for the Next.js API to trigger/cancel jobs.
 *  3. Job queue (one-at-a-time processing) that:
 *       a) scrapes ALL chapter images from MangaDex (rate-limited, with Referer header)
 *       b) generates per-chapter English summaries using the z-ai-web-dev-sdk VLM
 *       c) spawns the Python master_pipeline.py as a subprocess
 *       d) polls progress.json and streams progress over socket.io
 *
 * The frontend connects via `io("/?XTransformPort=3001")`.
 * The Next.js API triggers via `POST http://localhost:3001/internal/start`.
 */

import { createServer, IncomingMessage, ServerResponse } from 'http'
import { Server, Socket } from 'socket.io'
import { spawn, ChildProcess } from 'child_process'
import { promises as fs } from 'fs'
import path from 'path'

import {
  db,
  ensureDir,
  chapterDir,
  datasetDir,
  workDir,
  outputDir,
  outputVideoPath,
  progressFilePath,
  jobDir,
  PIPELINE_SCRIPT,
  PYTHON_BIN,
  getSourceFromId,
  fetchChaptersForSource,
  fetchImagesForSource,
  downloadImageForSource,
  extFromFilename,
  generateChapterSummary,
  generateImageNarrations,
  sleep,
  fileExists,
} from './lib'
import { isR2Configured, uploadFileToR2 } from './r2'

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const PORT = 3001

// ---------------------------------------------------------------------------
// HTTP server + socket.io
//
// IMPORTANT: socket.io is configured with `path: '/'` (required by the Caddy
// gateway — the frontend connects via `io("/?XTransformPort=3001")`). With
// path `/`, engine.io's attach() wrapper claims ALL HTTP requests, including
// our `/internal/*` endpoints. To work around this, we install an engine.io
// middleware that intercepts `/internal/*` requests and routes them to our
// HTTP handler before engine.io processes them.
// ---------------------------------------------------------------------------

async function httpHandler(req: IncomingMessage, res: ServerResponse) {
  // CORS pre-flight
  res.setHeader('Access-Control-Allow-Origin', '*')
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS')
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type')
  if (req.method === 'OPTIONS') {
    res.writeHead(204)
    res.end()
    return
  }

  const url = (req.url || '/').split('?')[0]

  // Collect request body for POSTs.
  const body = await readBody(req)

  if (req.method === 'GET' && url === '/internal/health') {
    sendJson(res, 200, { ok: true, port: PORT, queue: queueState() })
    return
  }

  if (req.method === 'POST' && url === '/internal/start') {
    const { jobId } = body as { jobId?: string }
    if (!jobId) {
      sendJson(res, 400, { error: 'jobId required' })
      return
    }
    const job = await db.job.findUnique({ where: { id: jobId } })
    if (!job) {
      sendJson(res, 404, { error: 'job not found' })
      return
    }
    enqueueJob(jobId)
    sendJson(res, 202, { ok: true, jobId, queued: true })
    return
  }

  if (req.method === 'POST' && url === '/internal/cancel') {
    const { jobId } = body as { jobId?: string }
    if (!jobId) {
      sendJson(res, 400, { error: 'jobId required' })
      return
    }
    await cancelJob(jobId)
    sendJson(res, 200, { ok: true, jobId, cancelled: true })
    return
  }

  sendJson(res, 404, { error: 'not found' })
}

const httpServer = createServer((req, res) => {
  // This listener only runs if socket.io's engine.io middleware doesn't
  // intercept first. In practice, engine.io claims everything (path "/"),
  // so this fallback is only hit if engine.io is bypassed. We keep it as a
  // safety net.
  void httpHandler(req, res)
})

const io = new Server(httpServer, {
  path: '/',
  cors: { origin: '*', methods: ['GET', 'POST', 'OPTIONS'] },
  pingTimeout: 60000,
  pingInterval: 25000,
})

// Intercept /internal/* requests BEFORE engine.io processes them, since
// `path: '/'` makes engine.io claim every URL.
io.engine.use((req: any, res: any, next: any) => {
  const reqUrl: string = req.url || '/'
  const urlPath = reqUrl.split('?')[0]
  if (urlPath.startsWith('/internal/')) {
    void httpHandler(req, res)
    // Do NOT call next() — we handled it.
    return
  }
  next()
})

// ---------------------------------------------------------------------------
// Socket.io connection handling
// ---------------------------------------------------------------------------

io.on('connection', (socket: Socket) => {
  console.log(`[io] connected ${socket.id}`)

  socket.on('subscribe', async (payload: unknown) => {
    const jobId = extractJobId(payload)
    if (!jobId) return
    const room = `job:${jobId}`
    await socket.join(room)
    socket.emit('subscribed', { type: 'subscribed', jobId })
    // Immediately emit current status + recent logs.
    await emitStatus(jobId)
    await emitRecentLogs(jobId, socket)
  })

  socket.on('unsubscribe', async (payload: unknown) => {
    const jobId = extractJobId(payload)
    if (!jobId) return
    await socket.leave(`job:${jobId}`)
  })

  socket.on('cancel', async (payload: unknown) => {
    const jobId = extractJobId(payload)
    if (!jobId) return
    await cancelJob(jobId)
  })

  socket.on('disconnect', () => {
    // rooms are auto-cleaned
  })
})

function extractJobId(payload: unknown): string | null {
  if (!payload) return null
  if (typeof payload === 'string') return payload
  if (typeof payload === 'object') {
    const p = payload as { jobId?: string }
    if (typeof p.jobId === 'string') return p.jobId
  }
  return null
}

// ---------------------------------------------------------------------------
// Emit helpers
// ---------------------------------------------------------------------------

async function emitStatus(jobId: string): Promise<void> {
  const job = await loadJobSummary(jobId)
  if (!job) return
  io.to(`job:${jobId}`).emit('status', { type: 'status', job })
}

async function emitLog(
  jobId: string,
  level: 'info' | 'warn' | 'error' | 'success',
  stage: string | null,
  message: string,
): Promise<void> {
  const log = await db.jobLog.create({
    data: { jobId, level, stage, message },
  })
  const entry = {
    id: log.id,
    jobId: log.jobId,
    level: log.level as 'info' | 'warn' | 'error' | 'success',
    stage: log.stage,
    message: log.message,
    createdAt: log.createdAt.toISOString(),
  }
  io.to(`job:${jobId}`).emit('log', { type: 'log', log: entry })

  // Also update Job.message so subscribers get it on next status poll.
  await db.job.update({
    where: { id: jobId },
    data: { message: message.slice(0, 500), stage: stage ?? undefined },
  }).catch(() => undefined)
}

async function emitProgress(
  jobId: string,
  fields: {
    progress: number
    doneChapters: number
    totalChapters: number
    doneImages: number
    totalImages: number
    stage: string
    message: string
  },
): Promise<void> {
  await db.job.update({
    where: { id: jobId },
    data: {
      progress: Math.max(0, Math.min(100, Math.round(fields.progress))),
      doneChapters: fields.doneChapters,
      totalChapters: fields.totalChapters,
      doneImages: fields.doneImages,
      totalImages: fields.totalImages,
      stage: fields.stage,
      message: fields.message.slice(0, 500),
    },
  }).catch(() => undefined)

  io.to(`job:${jobId}`).emit('progress', {
    type: 'progress',
    jobId,
    progress: Math.max(0, Math.min(100, Math.round(fields.progress))),
    doneChapters: fields.doneChapters,
    totalChapters: fields.totalChapters,
    doneImages: fields.doneImages,
    totalImages: fields.totalImages,
    stage: fields.stage,
    message: fields.message,
  })
}

async function emitChapter(jobId: string, chapter: {
  id: string
  jobId: string
  index: number
  mangadexId: string
  chapterNum: string | null
  title: string | null
  language: string
  pageCount: number
  translated: boolean
  summarized: boolean
  rendered: boolean
  folder: string
  status: string
  error: string | null
}): Promise<void> {
  io.to(`job:${jobId}`).emit('chapter', {
    type: 'chapter',
    jobId,
    chapter: {
      index: chapter.index,
      mangadexId: chapter.mangadexId,
      chapterNum: chapter.chapterNum,
      title: chapter.title,
      language: chapter.language,
      pageCount: chapter.pageCount,
      translated: chapter.translated,
      summarized: chapter.summarized,
      rendered: chapter.rendered,
      status: chapter.status,
      error: chapter.error,
    },
  })
}

async function emitRecentLogs(jobId: string, socket: Socket): Promise<void> {
  const logs = await db.jobLog.findMany({
    where: { jobId },
    orderBy: { createdAt: 'desc' },
    take: 50,
  })
  for (const log of logs.reverse()) {
    socket.emit('log', {
      type: 'log',
      log: {
        id: log.id,
        jobId: log.jobId,
        level: log.level as 'info' | 'warn' | 'error' | 'success',
        stage: log.stage,
        message: log.message,
        createdAt: log.createdAt.toISOString(),
      },
    })
  }
}

// ---------------------------------------------------------------------------
// DB -> JobSummary mapping
// ---------------------------------------------------------------------------

async function loadJobSummary(jobId: string) {
  const job = await db.job.findUnique({
    where: { id: jobId },
    include: { chapters: { orderBy: { index: 'asc' } } },
  })
  if (!job) return null
  return {
    id: job.id,
    mangaId: job.mangaId,
    mangaTitle: job.mangaTitle,
    coverUrl: job.coverUrl,
    language: job.language,
    sourceLang: job.sourceLang,
    status: job.status as any,
    progress: job.progress,
    stage: job.stage,
    message: job.message,
    totalChapters: job.totalChapters,
    doneChapters: job.doneChapters,
    totalImages: job.totalImages,
    doneImages: job.doneImages,
    outputDir: job.outputDir,
    outputVideo: job.outputVideo,
    error: job.error,
    voice: job.voice,
    chapterLimit: job.chapterLimit,
    translate: job.translate,
    createdAt: job.createdAt.toISOString(),
    updatedAt: job.updatedAt.toISOString(),
    chapters: job.chapters.map((c) => ({
      index: c.index,
      mangadexId: c.mangadexId,
      chapterNum: c.chapterNum,
      title: c.title,
      language: c.language,
      pageCount: c.pageCount,
      translated: c.translated,
      summarized: c.summarized,
      rendered: c.rendered,
      status: c.status,
      error: c.error,
    })),
  }
}

// ---------------------------------------------------------------------------
// Job queue (one at a time)
// ---------------------------------------------------------------------------

const queue: string[] = []
let currentlyRunning: string | null = null
const childProcesses = new Map<string, ChildProcess>()
const cancelledJobs = new Set<string>()

function queueState() {
  return {
    queueLength: queue.length,
    currentlyRunning,
    cancelled: Array.from(cancelledJobs),
  }
}

function enqueueJob(jobId: string) {
  if (queue.includes(jobId) || currentlyRunning === jobId) return
  queue.push(jobId)
  void processQueue()
}

async function processQueue() {
  if (currentlyRunning) return
  const next = queue.shift()
  if (!next) return
  currentlyRunning = next
  try {
    await processJob(next)
  } catch (err) {
    console.error(`[queue] processJob threw for ${next}:`, err)
    try {
      await db.job.update({
        where: { id: next },
        data: {
          status: 'error',
          error: err instanceof Error ? err.message : String(err),
        },
      })
      io.to(`job:${next}`).emit('error', {
        type: 'error',
        jobId: next,
        error: err instanceof Error ? err.message : String(err),
      })
    } catch {
      // ignore
    }
  } finally {
    currentlyRunning = null
    cancelledJobs.delete(next)
    // Process the next queued job (if any).
    void processQueue()
  }
}

// ---------------------------------------------------------------------------
// Cancel
// ---------------------------------------------------------------------------

async function cancelJob(jobId: string): Promise<void> {
  cancelledJobs.add(jobId)
  const child = childProcesses.get(jobId)
  if (child) {
    try {
      child.kill('SIGTERM')
      // Force-kill after 3s if still alive.
      setTimeout(() => {
        try {
          child.kill('SIGKILL')
        } catch {
          // ignore
        }
      }, 3000)
    } catch {
      // ignore
    }
  }
  await db.job.update({
    where: { id: jobId },
    data: { status: 'cancelled', stage: 'cancelled', message: 'Cancelled by user' },
  }).catch(() => undefined)
  await emitLog(jobId, 'warn', 'cancel', 'Job cancelled by user.')
  io.to(`job:${jobId}`).emit('cancelled', { type: 'cancelled', jobId })
  await emitStatus(jobId)
}

// ---------------------------------------------------------------------------
// The core job pipeline
// ---------------------------------------------------------------------------

async function processJob(jobId: string): Promise<void> {
  console.log(`[job:${jobId}] starting`)
  cancelledJobs.delete(jobId)

  const job = await db.job.findUnique({
    where: { id: jobId },
    include: { chapters: { orderBy: { index: 'asc' } } },
  })
  if (!job) {
    console.error(`[job:${jobId}] not found`)
    return
  }
  if (job.status === 'cancelled') {
    console.log(`[job:${jobId}] already cancelled, skipping`)
    return
  }

  // Prepare filesystem.
  await ensureDir(jobDir(jobId))
  await ensureDir(datasetDir(jobId))
  await ensureDir(workDir(jobId))
  await ensureDir(outputDir(jobId))

  // -----------------------------
  // Phase 1: SCRAPE
  // -----------------------------
  await db.job.update({
    where: { id: jobId },
    data: { status: 'scraping', stage: 'scrape', message: 'Starting scrape' },
  })
  await emitStatus(jobId)
  await emitLog(jobId, 'info', 'scrape', `Starting scrape for "${job.mangaTitle}"`)

  // If the API route did not pre-create Chapter rows, fetch them now.
  let chapters = job.chapters
  if (!chapters || chapters.length === 0) {
    const source = getSourceFromId(job.mangaId)
    if (!source) {
      throw new Error(`Cannot determine scraping source from manga ID: ${job.mangaId}`)
    }
    await emitLog(jobId, 'info', 'scrape', `Fetching chapter list from ${source}`)
    const fetched = await fetchChaptersForSource(source, job.mangaId, job.chapterLimit)
    if (fetched.length === 0) {
      throw new Error(`No chapters found for manga ${job.mangaId} on ${source}`)
    }
    // Create Chapter rows.
    for (let i = 0; i < fetched.length; i++) {
      const c = fetched[i]
      await db.chapter.create({
        data: {
          jobId,
          index: i + 1,
          mangadexId: c.mangadexId,
          chapterNum: c.chapterNum,
          title: c.title,
          language: c.language,
          pageCount: 0,
          folder: `chapter_${String(i + 1).padStart(3, '0')}`,
          status: 'pending',
        },
      })
    }
    chapters = await db.chapter.findMany({
      where: { jobId },
      orderBy: { index: 'asc' },
    })
    await db.job.update({
      where: { id: jobId },
      data: {
        totalChapters: chapters.length,
        sourceLang: chapters[0]?.language ?? job.language,
      },
    })
  } else {
    await db.job.update({
      where: { id: jobId },
      data: {
        totalChapters: chapters.length,
        sourceLang: chapters[0]?.language ?? job.language,
      },
    })
  }

  await emitLog(jobId, 'info', 'scrape', `Found ${chapters.length} chapters to scrape`)

  // Track total image counts.
  let totalImages = 0
  let doneImages = 0

  // Scrape each chapter sequentially (rate-limit friendly).
  for (const ch of chapters) {
    if (cancelledJobs.has(jobId)) {
      await emitLog(jobId, 'warn', 'scrape', 'Cancelled during scrape')
      return
    }
    try {
      const cDir = chapterDir(jobId, ch.index)
      await ensureDir(cDir)

      const source = getSourceFromId(job.mangaId)
      if (!source) {
        throw new Error(`Cannot determine scraping source from manga ID: ${job.mangaId}`)
      }
      const imageUrls = await fetchImagesForSource(source, job.mangaId, ch.mangadexId)
      if (imageUrls.length === 0) {
        await emitLog(jobId, 'warn', 'scrape', `Chapter ${ch.index} has 0 pages, skipping`)
        await db.chapter.update({
          where: { id: ch.id },
          data: { status: 'error', error: 'No pages' },
        })
        continue
      }

      let downloaded = 0
      for (let i = 0; i < imageUrls.length; i++) {
        if (cancelledJobs.has(jobId)) {
          await emitLog(jobId, 'warn', 'scrape', 'Cancelled mid-chapter')
          return
        }
        const destName = `${String(i + 1).padStart(3, '0')}.jpg`
        const destPath = path.join(cDir, destName)
        // Skip if already downloaded (resumable).
        if (await fileExists(destPath)) {
          downloaded++
          continue
        }
        try {
          await downloadImageForSource(source, imageUrls[i], destPath)
          downloaded++
          doneImages++
          // Rate limit: 300ms between images.
          await sleep(300)
        } catch (err) {
          await emitLog(
            jobId,
            'warn',
            'scrape',
            `Failed image ${i + 1} of chapter ${ch.index}: ${err instanceof Error ? err.message : String(err)}`,
          )
        }
        totalImages++
        // Emit progress every few images.
        if (i % 3 === 0 || i === imageUrls.length - 1) {
          await emitProgress(jobId, {
            progress: 5 + (doneImages / Math.max(1, totalImages + (imageUrls.length - i - 1))) * 25,
            doneChapters: 0,
            totalChapters: chapters.length,
            doneImages,
            totalImages,
            stage: 'scrape',
            message: `Scraping chapter ${ch.index}/${chapters.length}: image ${i + 1}/${imageUrls.length}`,
          })
        }
      }

      // Recount totalImages for this chapter to keep counts accurate.
      totalImages = Math.max(totalImages, doneImages)

      const updated = await db.chapter.update({
        where: { id: ch.id },
        data: {
          pageCount: downloaded,
          status: 'scraped',
          folder: `chapter_${String(ch.index).padStart(3, '0')}`,
        },
      })
      await db.job.update({
        where: { id: jobId },
        data: { doneImages, totalImages },
      })
      await emitChapter(jobId, updated)
      await emitLog(
        jobId,
        'success',
        'scrape',
        `Chapter ${ch.index}/${chapters.length} scraped: ${downloaded} images`,
      )
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      await emitLog(jobId, 'error', 'scrape', `Chapter ${ch.index} scrape failed: ${msg}`)
      const updated = await db.chapter.update({
        where: { id: ch.id },
        data: { status: 'error', error: msg },
      })
      await emitChapter(jobId, updated)
    }
  }

  // Finalize scrape counts.
  await db.job.update({
    where: { id: jobId },
    data: { totalImages, doneImages, doneChapters: 0 },
  })
  await emitLog(
    jobId,
    'success',
    'scrape',
    `Scrape complete: ${doneImages} images across ${chapters.length} chapters`,
  )

  if (cancelledJobs.has(jobId)) return

  // -----------------------------
  // Phase 2: SUMMARIZE (VLM) — per-image narration for frame-accurate sync
  // -----------------------------
  await db.job.update({
    where: { id: jobId },
    data: { status: 'summarizing', stage: 'summarize', message: 'Generating per-image narrations with VLM' },
  })
  await emitStatus(jobId)
  await emitLog(jobId, 'info', 'summarize', 'Generating per-image narrations with VLM (one narration per image for perfect sync)')

  // Reload chapters to get the latest state.
  const scrapedChapters = await db.chapter.findMany({
    where: { jobId, status: 'scraped' },
    orderBy: { index: 'asc' },
  })

  let summarizedCount = 0
  for (const ch of scrapedChapters) {
    if (cancelledJobs.has(jobId)) {
      await emitLog(jobId, 'warn', 'summarize', 'Cancelled during summarize')
      return
    }
    const cDir = chapterDir(jobId, ch.index)
    // List images in the chapter dir (sorted).
    let imageFiles: string[] = []
    try {
      const entries = await fs.readdir(cDir)
      imageFiles = entries
        .filter((f) => /\.(jpe?g|png|webp|gif)$/i.test(f))
        .sort()
        .map((f) => path.join(cDir, f))
    } catch {
      // no images, skip
      continue
    }
    if (imageFiles.length === 0) {
      // Still write a minimal summary so the Python pipeline has something.
      await fs.writeFile(path.join(cDir, 'summary.txt'), 'The chapter continues the story.', 'utf8')
      const updated = await db.chapter.update({
        where: { id: ch.id },
        data: { status: 'summarized', summarized: true },
      })
      await emitChapter(jobId, updated)
      summarizedCount++
      continue
    }

    // Skip if narration.json already exists (resume support).
    const narrationFile = path.join(cDir, 'narration.json')
    if (await fileExists(narrationFile)) {
      await emitLog(jobId, 'info', 'summarize', `Chapter ${ch.index} narrations already cached — skipping`)
      const updated = await db.chapter.update({
        where: { id: ch.id },
        data: { status: 'summarized', summarized: true },
      })
      await emitChapter(jobId, updated)
      summarizedCount++
      continue
    }

    try {
      await emitLog(jobId, 'info', 'summarize', `Chapter ${ch.index}: narrating ${imageFiles.length} images...`)
      const narrations = await generateImageNarrations(imageFiles, (done, total) => {
        // Per-image progress within this chapter.
        void emitLog(jobId, 'info', 'summarize', `Chapter ${ch.index}: ${done}/${total} images narrated`)
      })
      // Save per-image narrations as narration.json (consumed by the Python pipeline).
      await fs.writeFile(narrationFile, JSON.stringify(narrations, null, 2), 'utf8')
      // Also save a chapter-level summary.txt for backward compat (concatenation of all narrations).
      const chapterSummary = narrations.map((n) => n.text).join(' ')
      await fs.writeFile(path.join(cDir, 'summary.txt'), chapterSummary, 'utf8')

      const updated = await db.chapter.update({
        where: { id: ch.id },
        data: { status: 'summarized', summarized: true },
      })
      summarizedCount++
      await emitChapter(jobId, updated)
      await emitLog(
        jobId,
        'success',
        'summarize',
        `Chapter ${ch.index} narrated: ${narrations.length} images, ${chapterSummary.length} total chars`,
      )
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      await emitLog(jobId, 'error', 'summarize', `Chapter ${ch.index} summarize failed: ${msg}`)
      // Write a fallback summary so the pipeline can still proceed.
      await fs.writeFile(path.join(cDir, 'summary.txt'), 'The chapter continues the story.', 'utf8')
      const updated = await db.chapter.update({
        where: { id: ch.id },
        data: { status: 'summarized', summarized: true },
      })
      await emitChapter(jobId, updated)
    }

    await emitProgress(jobId, {
      progress: 30 + (summarizedCount / Math.max(1, scrapedChapters.length)) * 15,
      doneChapters: summarizedCount,
      totalChapters: chapters.length,
      doneImages,
      totalImages,
      stage: 'summarize',
      message: `Summarizing chapter ${ch.index}/${scrapedChapters.length}`,
    })
  }

  await db.job.update({
    where: { id: jobId },
    data: { doneChapters: summarizedCount },
  })
  await emitLog(
    jobId,
    'success',
    'summarize',
    `Summarize complete: ${summarizedCount}/${scrapedChapters.length} chapters`,
  )

  if (cancelledJobs.has(jobId)) return

  // -----------------------------
  // Phase 3: RENDER (Python pipeline)
  // -----------------------------
  await db.job.update({
    where: { id: jobId },
    data: { status: 'rendering', stage: 'render', message: 'Running master_pipeline.py' },
  })
  await emitStatus(jobId)
  await emitLog(jobId, 'info', 'render', 'Spawning Python master_pipeline.py')

  const outFile = outputVideoPath(jobId)
  const progressFile = progressFilePath(jobId)
  // Reset the progress file so we don't read stale data.
  try {
    await fs.unlink(progressFile)
  } catch {
    // ignore
  }

  const args: string[] = [
    PIPELINE_SCRIPT,
    '--input-dir', datasetDir(jobId),
    '--output', outFile,
    '--work-dir', workDir(jobId),
    '--voice', job.voice,
    '--narration-provider', 'none',
    '--skip-captions',
    '--progress-file', progressFile,
    '--keep-temp',
  ]
  if (job.groqKey) {
    args.push('--groq-api-key', job.groqKey)
  }
  if (job.openaiKey) {
    args.push('--openai-api-key', job.openaiKey)
  }
  if (!job.translate) {
    args.push('--no-translate')
  }
  // BGM overlay: use the job's custom BGM if provided, else the default cinematic track.
  if (job.useBgm) {
    const BGM_DIR = path.join('/home/z/my-project/data/bgm')
    let bgmFile: string | null = null
    if (job.bgmPath) {
      const customPath = path.join(BGM_DIR, job.bgmPath)
      if (await fileExists(customPath)) {
        bgmFile = customPath
      }
    }
    if (!bgmFile) {
      const defaultPath = path.join(BGM_DIR, 'default_cinematic.mp3')
      if (await fileExists(defaultPath)) {
        bgmFile = defaultPath
      }
    }
    if (bgmFile) {
      args.push('--bgm', bgmFile)
      await emitLog(jobId, 'info', 'render', `BGM: ${path.basename(bgmFile)} will be overlaid at -20dB`)
    }
  }

  // Log the command but redact API keys so they never appear in the UI log.
  const redactedArgs = args.map((a) => {
    if (/^(gsk_|sk-)/.test(a)) return a.slice(0, 8) + '***REDACTED***'
    return a
  })
  await emitLog(jobId, 'info', 'render', `CMD: ${PYTHON_BIN} ${redactedArgs.join(' ')}`)

  // Ensure the cwd exists before spawning — prevents uv_cwd ENOENT crashes
  // if the job directory was cleaned up or not yet created.
  const spawnCwd = jobDir(jobId)
  try {
    await fs.mkdir(spawnCwd, { recursive: true })
  } catch {
    // fall back to the repo root if the job dir can't be created
  }

  const child = spawn(PYTHON_BIN, args, {
    cwd: spawnCwd,
    env: { ...process.env, PYTHONUNBUFFERED: '1' },
  })
  childProcesses.set(jobId, child)

  // Poll the progress file every 1s while the process runs.
  const pollTimer = setInterval(async () => {
    try {
      const raw = await fs.readFile(progressFile, 'utf8')
      const prog = JSON.parse(raw) as {
        stage: string
        chapter_index: number
        total_chapters: number
        progress: number
        message: string
        status: string
        updated_at: number
      }
      let pct = 45
      let stage = 'render'
      if (prog.stage === 'render') {
        pct = 45 + (prog.chapter_index / Math.max(1, prog.total_chapters)) * 50
        stage = 'render'
      } else if (prog.stage === 'merge') {
        pct = 95
        stage = 'merge'
      } else if (prog.stage === 'bgm') {
        pct = 97
        stage = 'bgm'
      } else if (prog.stage === 'done') {
        pct = 100
        stage = 'done'
      }
      await emitProgress(jobId, {
        progress: pct,
        doneChapters: summarizedCount,
        totalChapters: chapters.length,
        doneImages,
        totalImages,
        stage,
        message: prog.message || `${stage} phase`,
      })
    } catch {
      // progress file not yet written — ignore
    }
  }, 1000)

  // Stream stdout/stderr line-by-line into JobLog.
  const lineBuffers: { stdout: string; stderr: string } = { stdout: '', stderr: '' }

  child.stdout?.on('data', (chunk: Buffer) => {
    lineBuffers.stdout += chunk.toString('utf8')
    let idx: number
    while ((idx = lineBuffers.stdout.indexOf('\n')) >= 0) {
      const line = lineBuffers.stdout.slice(0, idx).trim()
      lineBuffers.stdout = lineBuffers.stdout.slice(idx + 1)
      if (line) void emitLog(jobId, 'info', 'render', line)
    }
  })
  child.stderr?.on('data', (chunk: Buffer) => {
    lineBuffers.stderr += chunk.toString('utf8')
    let idx: number
    while ((idx = lineBuffers.stderr.indexOf('\n')) >= 0) {
      const line = lineBuffers.stderr.slice(0, idx).trim()
      lineBuffers.stderr = lineBuffers.stderr.slice(idx + 1)
      if (line) void emitLog(jobId, 'warn', 'render', line)
    }
  })

  const exitCode: number = await new Promise((resolve) => {
    child.on('exit', (code) => resolve(code ?? -1))
    child.on('error', (err) => {
      void emitLog(jobId, 'error', 'render', `spawn error: ${err.message}`)
      resolve(-1)
    })
  })

  clearInterval(pollTimer)
  childProcesses.delete(jobId)

  // Flush any remaining buffered output.
  if (lineBuffers.stdout.trim()) {
    await emitLog(jobId, 'info', 'render', lineBuffers.stdout.trim())
  }
  if (lineBuffers.stderr.trim()) {
    await emitLog(jobId, 'warn', 'render', lineBuffers.stderr.trim())
  }

  if (cancelledJobs.has(jobId)) {
    await emitLog(jobId, 'warn', 'render', 'Cancelled during render')
    return
  }

  if (exitCode === 0) {
    // Verify the output file actually exists before marking as done.
    const outputExists = await fileExists(outFile)
    if (!outputExists) {
      const msg = `Pipeline exited 0 but output file is missing: ${outFile}`
      await emitLog(jobId, 'error', 'render', msg)
      await db.job.update({
        where: { id: jobId },
        data: { status: 'error', error: msg, stage: 'render' },
      })
      await emitStatus(jobId)
      io.to(`job:${jobId}`).emit('error', { type: 'error', jobId, error: msg })
      return
    }
    const outName = path.basename(outFile)

    // -----------------------------
    // Reclaim disk space: intermediate work/ (sliced frames, per-panel
    // audio, per-chapter renders) and dataset/ (raw scraped chapter images)
    // are never needed again once the final video exists. For a large job
    // (e.g. 200 chapters) these dwarf the final compressed video, so this
    // alone is the biggest single win for disk usage.
    // -----------------------------
    for (const dir of [workDir(jobId), datasetDir(jobId)]) {
      try {
        await fs.rm(dir, { recursive: true, force: true })
      } catch (e) {
        await emitLog(jobId, 'warn', 'done', `Could not clean up ${dir}: ${e instanceof Error ? e.message : e}`)
      }
    }
    await emitLog(jobId, 'info', 'done', 'Cleaned up intermediate work/dataset files')

    // -----------------------------
    // Offload the final video to Cloudflare R2, then free the local copy
    // too, so completed jobs don't keep accumulating local disk usage.
    // Only deletes the local file after the upload is verified to have
    // landed — if R2 isn't configured, or the upload fails, the local
    // file is left in place so the job is never left without a copy.
    // -----------------------------
    let r2Key: string | null = null
    if (isR2Configured()) {
      const key = `jobs/${jobId}/${outName}`
      try {
        await uploadFileToR2(outFile, key)
        await fs.rm(outFile, { force: true })
        r2Key = key
        await emitLog(jobId, 'success', 'done', `Uploaded output to R2 (${key}) and freed local copy`)
      } catch (e) {
        await emitLog(
          jobId,
          'warn',
          'done',
          `R2 upload failed, keeping local copy: ${e instanceof Error ? e.message : e}`,
        )
      }
    }

    await db.job.update({
      where: { id: jobId },
      data: {
        status: 'done',
        progress: 100,
        stage: 'done',
        message: 'Pipeline complete',
        outputDir: outputDir(jobId),
        outputVideo: outName,
        r2Key,
      },
    })
    await emitLog(jobId, 'success', 'done', `Pipeline complete. Output: ${outName}`)
    io.to(`job:${jobId}`).emit('done', { type: 'done', jobId, outputVideo: outName })
    await emitStatus(jobId)
    console.log(`[job:${jobId}] done`)
  } else {
    const err = `master_pipeline.py exited with code ${exitCode}`
    await db.job.update({
      where: { id: jobId },
      data: { status: 'error', stage: 'render', error: err, message: err },
    })
    await emitLog(jobId, 'error', 'render', err)
    io.to(`job:${jobId}`).emit('error', { type: 'error', jobId, error: err })
    await emitStatus(jobId)
    console.error(`[job:${jobId}] failed: ${err}`)
  }
}

// ---------------------------------------------------------------------------
// HTTP helpers
// ---------------------------------------------------------------------------

async function readBody(req: IncomingMessage): Promise<any> {
  return await new Promise((resolve) => {
    const chunks: Buffer[] = []
    req.on('data', (c) => chunks.push(c as Buffer))
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8')
      if (!raw) {
        resolve({})
        return
      }
      try {
        resolve(JSON.parse(raw))
      } catch {
        resolve({})
      }
    })
    req.on('error', () => resolve({}))
  })
}

function sendJson(res: ServerResponse, code: number, body: unknown) {
  const json = JSON.stringify(body)
  res.writeHead(code, {
    'Content-Type': 'application/json',
    'Content-Length': Buffer.byteLength(json),
  })
  res.end(json)
}

// ---------------------------------------------------------------------------
// Boot + graceful shutdown
// ---------------------------------------------------------------------------

httpServer.listen(PORT, () => {
  console.log(`[pipeline-service] listening on port ${PORT} (socket.io path "/")`)
})

async function shutdown(signal: string) {
  console.log(`[pipeline-service] received ${signal}, shutting down`)
  // Kill any running subprocesses.
  for (const [jobId, child] of childProcesses.entries()) {
    try {
      child.kill('SIGTERM')
      console.log(`[pipeline-service] killed subprocess for job ${jobId}`)
    } catch {
      // ignore
    }
  }
  childProcesses.clear()
  // Close socket.io + HTTP server.
  io.close()
  httpServer.close(() => {
    console.log('[pipeline-service] http server closed')
    process.exit(0)
  })
  // Force-exit after 5s if close hangs.
  setTimeout(() => process.exit(0), 5000).unref()
}

process.on('SIGTERM', () => void shutdown('SIGTERM'))
process.on('SIGINT', () => void shutdown('SIGINT'))

// Handle uncaught errors so the service doesn't silently die.
process.on('uncaughtException', (err) => {
  console.error('[pipeline-service] uncaughtException:', err)
})
process.on('unhandledRejection', (err) => {
  console.error('[pipeline-service] unhandledRejection:', err)
})
