import type {
  ChapterInfo,
  JobLogEntry,
  JobSummary,
  JobStatus,
} from "@/types/pipeline";

type ChapterRow = {
  id: string;
  index: number;
  mangadexId: string;
  chapterNum: string | null;
  title: string | null;
  language: string;
  pageCount: number;
  translated: boolean;
  summarized: boolean;
  rendered: boolean;
  status: string;
  error: string | null;
};

type JobRow = {
  id: string;
  mangaId: string;
  mangaTitle: string;
  coverUrl: string | null;
  language: string;
  sourceLang: string | null;
  status: string;
  progress: number;
  stage: string | null;
  message: string | null;
  totalChapters: number;
  doneChapters: number;
  totalImages: number;
  doneImages: number;
  outputDir: string | null;
  outputVideo: string | null;
  error: string | null;
  groqKey: string | null;
  openaiKey: string | null;
  voice: string;
  chapterLimit: number;
  translate: boolean;
  bgmPath: string | null;
  useBgm: boolean;
  createdAt: Date;
  updatedAt: Date;
  chapters?: ChapterRow[];
};

export function mapChapter(c: ChapterRow): ChapterInfo {
  return {
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
  };
}

export function mapJob(job: JobRow): JobSummary {
  return {
    id: job.id,
    mangaId: job.mangaId,
    mangaTitle: job.mangaTitle,
    coverUrl: job.coverUrl,
    language: job.language,
    sourceLang: job.sourceLang,
    status: job.status as JobStatus,
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
    bgmPath: job.bgmPath ?? null,
    useBgm: job.useBgm ?? true,
    createdAt: job.createdAt.toISOString(),
    updatedAt: job.updatedAt.toISOString(),
    chapters: (job.chapters ?? []).map(mapChapter),
  };
}

export function mapLog(log: {
  id: string;
  jobId: string;
  level: string;
  stage: string | null;
  message: string;
  createdAt: Date;
}): JobLogEntry {
  return {
    id: log.id,
    jobId: log.jobId,
    level: log.level as JobLogEntry["level"],
    stage: log.stage,
    message: log.message,
    createdAt: log.createdAt.toISOString(),
  };
}
