import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { mapJob, mapLog } from "@/lib/serialize";

export const dynamic = "force-dynamic";

const PIPELINE_SERVICE_URL = "http://localhost:3001";

async function notifyPipeline(
  path: string,
  body: Record<string, unknown>
): Promise<void> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 5000);
  try {
    await fetch(`${PIPELINE_SERVICE_URL}${path}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
  } catch {
    // ignore — best-effort cancel signal
  } finally {
    clearTimeout(timeout);
  }
}

/** GET /api/jobs/{id} — full job detail with chapters + recent logs. */
export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id } = await params;
    if (!id) {
      return NextResponse.json({ error: "Job id is required." }, { status: 400 });
    }

    const job = await db.job.findUnique({
      where: { id },
      include: {
        chapters: { orderBy: { index: "asc" } },
        logs: {
          orderBy: { createdAt: "desc" },
          take: 50,
        },
      },
    });

    if (!job) {
      return NextResponse.json({ error: "Job not found." }, { status: 404 });
    }

    const summary = mapJob(job);
    const logs = job.logs.map(mapLog).reverse(); // newest last for streaming display

    return NextResponse.json({ job: summary, logs });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown error";
    return NextResponse.json(
      { error: `Failed to load job: ${message}` },
      { status: 500 }
    );
  }
}

const ACTIVE_STATUSES = new Set([
  "pending",
  "scraping",
  "summarizing",
  "translating",
  "rendering",
  "merging",
]);

/**
 * DELETE /api/jobs/{id} — remove a job from the recent jobs list.
 *
 * - If the job is still active (running/queued) and `?force=true` was not
 *   passed, it is cancelled first (existing behavior) so the pipeline stops
 *   cleanly; the row is left in place as "cancelled".
 * - If the job is already terminal (done/error/cancelled), or `?force=true`
 *   is passed, the job row (and its chapters/logs, via cascade) is
 *   permanently deleted from the database.
 */
export async function DELETE(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id } = await params;
    if (!id) {
      return NextResponse.json({ error: "Job id is required." }, { status: 400 });
    }

    const force = req.nextUrl.searchParams.get("force") === "true";

    const job = await db.job.findUnique({ where: { id } });
    if (!job) {
      return NextResponse.json({ error: "Job not found." }, { status: 404 });
    }

    const isActive = ACTIVE_STATUSES.has(job.status);

    if (isActive && !force) {
      // Cancel a running job first — pipeline needs a chance to stop.
      await db.job.update({
        where: { id },
        data: {
          status: "cancelled",
          message: "Cancellation requested by user.",
        },
      });

      await db.jobLog.create({
        data: {
          jobId: id,
          level: "warn",
          stage: job.stage ?? null,
          message: "Cancellation requested by user.",
        },
      });

      // Best-effort: tell the running pipeline to stop.
      void notifyPipeline("/internal/cancel", { jobId: id });

      return NextResponse.json({ ok: true, cancelled: true, deleted: false });
    }

    if (isActive && force) {
      // Force-deleting a running job: still ping the pipeline so it doesn't
      // keep writing to an output dir whose DB row is about to vanish.
      void notifyPipeline("/internal/cancel", { jobId: id });
    }

    // Terminal job (or forced): permanently remove it. Chapters + logs are
    // deleted automatically via onDelete: Cascade in the Prisma schema.
    await db.job.delete({ where: { id } });

    return NextResponse.json({ ok: true, cancelled: false, deleted: true });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown error";
    return NextResponse.json(
      { error: `Failed to delete job: ${message}` },
      { status: 500 }
    );
  }
}
