import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import type { AppSettings } from "@/types/pipeline";

export const dynamic = "force-dynamic";

const DEFAULTS: AppSettings = {
  groqKey: "",
  openaiKey: "",
  defaultVoice: "en-US-AndrewNeural",
  defaultLanguage: "en",
  defaultChapterLimit: 5,
};

const KEYS: (keyof AppSettings)[] = [
  "groqKey",
  "openaiKey",
  "defaultVoice",
  "defaultLanguage",
  "defaultChapterLimit",
];

function isInt(v: unknown): v is number {
  return typeof v === "number" && Number.isFinite(v);
}

function parseValue(key: keyof AppSettings, raw: string): string | number {
  if (key === "defaultChapterLimit") {
    const n = parseInt(raw, 10);
    return Number.isFinite(n) ? n : DEFAULTS.defaultChapterLimit;
  }
  return raw;
}

async function readAllSettings(): Promise<AppSettings> {
  const rows = await db.setting.findMany({ where: { id: { in: KEYS } } });
  const map = new Map(rows.map((r) => [r.id as keyof AppSettings, r.value]));

  return {
    groqKey: map.get("groqKey") ?? DEFAULTS.groqKey,
    openaiKey: map.get("openaiKey") ?? DEFAULTS.openaiKey,
    defaultVoice: map.get("defaultVoice") ?? DEFAULTS.defaultVoice,
    defaultLanguage: map.get("defaultLanguage") ?? DEFAULTS.defaultLanguage,
    defaultChapterLimit:
      parseInt(map.get("defaultChapterLimit") ?? String(DEFAULTS.defaultChapterLimit), 10) ||
      DEFAULTS.defaultChapterLimit,
  };
}

/** GET /api/settings — read all settings (with defaults). */
export async function GET() {
  try {
    const settings = await readAllSettings();
    return NextResponse.json({ settings });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown error";
    return NextResponse.json(
      { error: `Failed to read settings: ${message}` },
      { status: 500 }
    );
  }
}

/** PUT /api/settings — upsert provided keys, return full updated settings. */
export async function PUT(req: NextRequest) {
  try {
    const body = (await req.json()) as Partial<AppSettings>;

    const updates: { id: string; value: string }[] = [];
    for (const key of KEYS) {
      const v = body[key];
      if (v === undefined) continue;

      let value: string;
      if (key === "defaultChapterLimit") {
        if (!isInt(v)) {
          return NextResponse.json(
            { error: `Invalid value for ${key}: expected number.` },
            { status: 400 }
          );
        }
        value = String(v);
      } else if (typeof v === "string") {
        value = v;
      } else {
        return NextResponse.json(
          { error: `Invalid value for ${key}.` },
          { status: 400 }
        );
      }
      updates.push({ id: key, value });
    }

    if (updates.length > 0) {
      await db.$transaction(
        updates.map((u) =>
          db.setting.upsert({
            where: { id: u.id },
            create: { id: u.id, value: u.value },
            update: { value: u.value },
          })
        )
      );
    }

    const settings = await readAllSettings();
    return NextResponse.json({ settings });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown error";
    return NextResponse.json(
      { error: `Failed to update settings: ${message}` },
      { status: 500 }
    );
  }
}
