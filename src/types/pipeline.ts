// Shared types for the Master Recap Pipeline app

export type JobStatus =
  | "pending"
  | "scraping"
  | "summarizing"
  | "translating"
  | "rendering"
  | "merging"
  | "done"
  | "error"
  | "cancelled";

export type Stage =
  | "search"
  | "scrape"
  | "summarize"
  | "translate"
  | "slice"
  | "narrate"
  | "tts"
  | "captions"
  | "render"
  | "merge"
  | "bgm"
  | "done";

export type MangaSource = "mangahere" | "fanfox" | "webtoons" | "mal" | "anilist";

export interface MangadexManga {
  id: string;
  title: string;
  description: string;
  coverUrl: string | null;
  status: string | null;
  year: number | null;
  originalLanguage: string | null;
  availableTranslatedLanguages: string[];
  tags: string[];
  contentRating: string | null;
  lastChapter: string | null;
  /** Where this result came from. Defaults to "mangadex" for backward compat. */
  source?: MangaSource;
  /** Link to the original source page (MAL/AniList URL) for non-MangaDex results. */
  externalUrl?: string | null;
}

export interface MangaSearchResult {
  manga: MangadexManga[];
  total: number;
}

export interface ChapterInfo {
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
}

export interface JobSummary {
  id: string;
  mangaId: string;
  mangaTitle: string;
  coverUrl: string | null;
  language: string;
  sourceLang: string | null;
  status: JobStatus;
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
  voice: string;
  chapterLimit: number;
  translate: boolean;
  bgmPath: string | null;
  useBgm: boolean;
  createdAt: string;
  updatedAt: string;
  chapters: ChapterInfo[];
}

export interface JobLogEntry {
  id: string;
  jobId: string;
  level: "info" | "warn" | "error" | "success";
  stage: string | null;
  message: string;
  createdAt: string;
}

// WebSocket events (client -> server)
export type ClientEvent =
  | { type: "subscribe"; jobId: string }
  | { type: "unsubscribe"; jobId: string }
  | { type: "cancel"; jobId: string };

// WebSocket events (server -> client)
export type ServerEvent =
  | { type: "subscribed"; jobId: string }
  | { type: "status"; job: JobSummary }
  | { type: "log"; log: JobLogEntry }
  | { type: "progress"; jobId: string; progress: number; doneChapters: number; totalChapters: number; doneImages: number; totalImages: number; stage: string; message: string }
  | { type: "chapter"; jobId: string; chapter: ChapterInfo }
  | { type: "done"; jobId: string; outputVideo: string | null }
  | { type: "error"; jobId: string; error: string }
  | { type: "cancelled"; jobId: string };

export interface CreateJobInput {
  mangaId: string;
  mangaTitle: string;
  coverUrl: string | null;
  language: string; // requested language code, e.g. "en", "ko", "ja"
  chapterLimit: number; // 0 = all
  voice: string;
  translate: boolean;
  groqKey?: string;
  openaiKey?: string;
  bgmPath?: string | null; // BGM filename (relative to data/bgm/), null = default
  useBgm?: boolean; // whether to overlay BGM
}

export interface BgmTrack {
  name: string;
  size: number;
  isDefault: boolean;
}

export interface AppSettings {
  groqKey: string;
  openaiKey: string;
  defaultVoice: string;
  defaultLanguage: string;
  defaultChapterLimit: number;
}
