import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { outputVideoPath } from "@/lib/paths";
import { isR2Configured, getR2Url } from "@/lib/r2";
import { promises as fs, createReadStream } from "fs";
import { Readable } from "stream";

export const dynamic = "force-dynamic";
export const maxDuration = 300; // Allow up to 5 minutes for large video streaming

interface RangeSpec {
  start: number;
  end: number;
}

function parseRange(rangeHeader: string, fileSize: number): RangeSpec | null {
  const match = /^bytes=(\d*)-(\d*)$/.exec(rangeHeader.trim());
  if (!match) return null;

  const startStr = match[1];
  const endStr = match[2];

  let start: number;
  let end: number;

  if (startStr === "" && endStr === "") {
    return null;
  }
  if (startStr === "") {
    // suffix range: last N bytes
    const suffixLen = parseInt(endStr, 10);
    if (!Number.isFinite(suffixLen) || suffixLen <= 0) return null;
    start = Math.max(0, fileSize - suffixLen);
    end = fileSize - 1;
  } else {
    start = parseInt(startStr, 10);
    end = endStr === "" ? fileSize - 1 : parseInt(endStr, 10);
    if (!Number.isFinite(start) || !Number.isFinite(end)) return null;
    if (start < 0 || start >= fileSize) return null;
    if (end >= fileSize) end = fileSize - 1;
    if (end < start) return null;
  }

  return { start, end };
}

/** GET /api/download/{id} — stream the final MP4 with Range support. */
export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id } = await params;
    if (!id) {
      return NextResponse.json({ error: "Job id is required." }, { status: 400 });
    }

    const job = await db.job.findUnique({
      where: { id },
      select: { id: true, status: true, outputVideo: true, mangaTitle: true, r2Key: true },
    });
    if (!job) {
      return NextResponse.json({ error: "Job not found." }, { status: 404 });
    }

    if (job.status !== "done") {
      return NextResponse.json(
        { error: `Job is not done (status: ${job.status}).` },
        { status: 409 }
      );
    }

    const filename = job.outputVideo || "master_recap.mp4";
    const filePath = outputVideoPath(id, filename);

    let stat;
    try {
      stat = await fs.stat(filePath);
    } catch {
      // Local copy is gone — this happens once the pipeline-service has
      // uploaded the finished video to R2 and freed local disk space.
      // Redirect the browser straight to R2 instead of 404'ing; R2 serves
      // Range requests natively so in-browser seeking still works.
      if (job.r2Key && isR2Configured()) {
        const url = await getR2Url(job.r2Key);
        return NextResponse.redirect(url, { status: 302 });
      }
      return NextResponse.json(
        { error: "Output video file not found on disk." },
        { status: 404 }
      );
    }

    if (!stat.isFile()) {
      return NextResponse.json(
        { error: "Output path is not a file." },
        { status: 404 }
      );
    }

    const fileSize = stat.size;
    const rangeHeader = req.headers.get("range");
    const range = rangeHeader ? parseRange(rangeHeader, fileSize) : null;

    // Build a friendly download filename using the manga title.
    const safeTitle = (job.mangaTitle || "recap")
      .replace(/[^\w\-]+/g, "_")
      .slice(0, 60);
    const downloadName = `${safeTitle}_recap.mp4`;

    if (range) {
      const { start, end } = range;
      const chunkSize = end - start + 1;

      const nodeStream = createReadStream(filePath, { start, end });
      const webStream = Readable.toWeb(nodeStream) as ReadableStream<Uint8Array>;

      return new Response(webStream, {
        status: 206,
        headers: {
          "content-type": "video/mp4",
          "content-length": String(chunkSize),
          "content-range": `bytes ${start}-${end}/${fileSize}`,
          "accept-ranges": "bytes",
          "content-disposition": `inline; filename="${downloadName}"`,
          "cache-control": "no-store",
        },
      });
    }

    // Full file response.
    const nodeStream = createReadStream(filePath);
    const webStream = Readable.toWeb(nodeStream) as ReadableStream<Uint8Array>;

    return new Response(webStream, {
      status: 200,
      headers: {
        "content-type": "video/mp4",
        "content-length": String(fileSize),
        "accept-ranges": "bytes",
        "content-disposition": `inline; filename="${downloadName}"`,
        "cache-control": "no-store",
      },
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown error";
    return NextResponse.json(
      { error: `Failed to stream video: ${message}` },
      { status: 500 }
    );
  }
}
