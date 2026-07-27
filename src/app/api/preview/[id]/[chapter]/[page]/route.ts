import { NextRequest, NextResponse } from "next/server";
import { chapterDir } from "@/lib/paths";
import { promises as fs, createReadStream } from "fs";
import { Readable } from "stream";
import path from "path";

export const dynamic = "force-dynamic";

const CONTENT_TYPES: Record<string, string> = {
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".png": "image/png",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".bmp": "image/bmp",
  ".avif": "image/avif",
};

/** Reject any page name that looks like a path-traversal attempt. */
function isSafePageName(page: string): boolean {
  if (!page || page.length > 64) return false;
  if (page.includes("/") || page.includes("\\")) return false;
  if (page.includes("..")) return false;
  // Only allow simple filenames like "001.jpg", "10.png"
  return /^[A-Za-z0-9_\-.]+$/.test(page);
}

/** GET /api/preview/{id}/{chapter}/{page} — stream a scraped chapter image. */
export async function GET(
  _req: NextRequest,
  {
    params,
  }: {
    params: Promise<{ id: string; chapter: string; page: string }>;
  }
) {
  try {
    const { id, chapter, page } = await params;
    if (!id || !chapter || !page) {
      return NextResponse.json(
        { error: "id, chapter and page are required." },
        { status: 400 }
      );
    }

    const chapterNum = parseInt(chapter, 10);
    if (!Number.isFinite(chapterNum) || chapterNum < 1) {
      return NextResponse.json(
        { error: "chapter must be a positive integer." },
        { status: 400 }
      );
    }

    if (!isSafePageName(page)) {
      return NextResponse.json(
        { error: "Invalid page filename." },
        { status: 400 }
      );
    }

    const dir = chapterDir(id, chapterNum);
    const filePath = path.join(dir, page);

    // Final safety: ensure resolved path is still inside the chapter dir.
    const resolved = path.resolve(filePath);
    const resolvedDir = path.resolve(dir);
    if (!resolved.startsWith(resolvedDir + path.sep) && resolved !== resolvedDir) {
      return NextResponse.json(
        { error: "Invalid page path." },
        { status: 400 }
      );
    }

    let stat;
    try {
      stat = await fs.stat(resolved);
    } catch {
      return NextResponse.json(
        { error: "Image not found." },
        { status: 404 }
      );
    }

    if (!stat.isFile()) {
      return NextResponse.json(
        { error: "Requested path is not a file." },
        { status: 404 }
      );
    }

    const ext = path.extname(page).toLowerCase();
    const contentType = CONTENT_TYPES[ext] || "application/octet-stream";

    const nodeStream = createReadStream(resolved);
    const webStream = Readable.toWeb(nodeStream) as ReadableStream<Uint8Array>;

    return new Response(webStream, {
      status: 200,
      headers: {
        "content-type": contentType,
        "content-length": String(stat.size),
        "cache-control": "public, max-age=3600",
      },
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown error";
    return NextResponse.json(
      { error: `Failed to load preview image: ${message}` },
      { status: 500 }
    );
  }
}
