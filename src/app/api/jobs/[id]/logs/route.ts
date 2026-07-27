import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { mapLog } from "@/lib/serialize";

export const dynamic = "force-dynamic";

/** GET /api/jobs/{id}/logs?limit=100 — newest logs first. */
export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id } = await params;
    if (!id) {
      return NextResponse.json({ error: "Job id is required." }, { status: 400 });
    }

    const { searchParams } = new URL(req.url);
    const limitParam = searchParams.get("limit");
    const limit = limitParam
      ? Math.min(Math.max(1, parseInt(limitParam, 10) || 100), 1000)
      : 100;

    const exists = await db.job.findUnique({ where: { id }, select: { id: true } });
    if (!exists) {
      return NextResponse.json({ error: "Job not found." }, { status: 404 });
    }

    const logs = await db.jobLog.findMany({
      where: { jobId: id },
      orderBy: { createdAt: "desc" },
      take: limit,
    });

    return NextResponse.json({ logs: logs.map(mapLog) });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown error";
    return NextResponse.json(
      { error: `Failed to load logs: ${message}` },
      { status: 500 }
    );
  }
}
