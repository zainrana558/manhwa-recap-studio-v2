#!/usr/bin/env python3
"""
master_pipeline.py
===================
Production-grade CLI pipeline that converts a local dataset of webtoon/manhwa
chapter images (dataset/chapter_001/, dataset/chapter_002/, ...) into a single
master recap video with narration, word-level captions, and background music.

INPUT ASSUMPTION: You already own/control the source images and text summaries
and have placed them locally under --input-dir. This script does NOT fetch
content from third-party websites — point it at a folder you already have.

Expected folder layout:

    <input-dir>/
        chapter_001/
            001.jpg
            002.jpg
            ...
            summary.txt      (raw text describing what happens in the chapter)
        chapter_002/
            ...

Pipeline stages (each resumable / skippable if output already exists):
    1. Ingestion         -> discover + sort chapter folders and panel images
    2. Canvas slicing    -> slice tall strips into uniform 1920x1080 frames
    3a. Translation      -> Groq (OpenAI-compatible endpoint) translates non-English
                             chapter text to English before rewriting
    3b. Narrative rewrite-> OpenAI rephrase with cross-chapter continuity
    4. Narration TTS     -> each source panel's full narration is voiced with ONE
                             continuous edge-tts call (no per-word chopping/seams);
                             real word timestamps from that clip then decide how
                             long each sliced frame stays on screen
    5. Captions          -> faster-whisper word timestamps grouped into short
                             phrase-level .ass subtitles (not one flashing word
                             at a time), offset to the merged chapter audio
    6. Chapter render    -> static-panel video per chapter, each frame's
                             on-screen duration derived from real narration timing
    7. Merge + BGM       -> ffmpeg concat (stream copy) + background music mix

Run `python master_pipeline.py --help` for CLI usage.
"""

from __future__ import annotations

import argparse
import json
import logging
import os
import re
import shutil
import subprocess
import sys
import time
from dataclasses import dataclass, field
from pathlib import Path
from typing import List, Optional

# ---------------------------------------------------------------------------
# Third-party deps are imported lazily inside the functions that need them,
# so `--help` and argument validation work even if a dep isn't installed yet.
# See requirements.txt for the full list.
# ---------------------------------------------------------------------------

IMAGE_EXTS = {".jpg", ".jpeg", ".png", ".webp"}
CANVAS_W, CANVAS_H = 1920, 1080
OVERLAP_RATIO = 0.15
FPS = 24  # YouTube-standard 30fps for smoother motion
AUDIO_SAMPLE_RATE = 44100
AUDIO_BITRATE = "192k"  # higher quality audio for narration
SILENT_FRAME_DURATION = 1.4  # seconds a frame holds on screen if it has no narration text
GROQ_BASE_URL = "https://api.groq.com/openai/v1"

# Phase 3: Audio post-processing targets (YouTube standard)
TARGET_LOUDNESS_LUFS = -14  # YouTube's standard loudness target
BGM_DUCK_DB = -18  # BGM sidechain-ducked by 18dB when voice is active

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s | %(levelname)-7s | %(message)s",
    datefmt="%H:%M:%S",
)
log = logging.getLogger("master_pipeline")


# ---------------------------------------------------------------------------
# Config
# ---------------------------------------------------------------------------

@dataclass
class PipelineConfig:
    input_dir: Path
    output_path: Path
    total_chapters: Optional[int]
    bgm_path: Optional[Path]
    work_dir: Path
    voice: str = "en-US-AndrewNeural"
    openai_model: str = "gpt-4o-mini"
    openai_api_key: Optional[str] = None
    keep_temp: bool = False
    groq_api_key: Optional[str] = None
    groq_model: str = "llama-3.3-70b-versatile"
    translate: bool = True
    narration_provider: str = "auto"  # auto|openai|groq|none
    narration_model: Optional[str] = None  # override model for narration
    skip_captions: bool = False
    progress_file: Optional[Path] = None  # JSON file the Node service polls

    @property
    def temp_audio_dir(self) -> Path:
        return self.work_dir / "temp_audio"

    @property
    def temp_captions_dir(self) -> Path:
        return self.work_dir / "temp_captions"

    @property
    def temp_chapters_dir(self) -> Path:
        return self.work_dir / "temp_chapters"

    @property
    def temp_slices_dir(self) -> Path:
        return self.work_dir / "temp_slices"

    @property
    def temp_scripts_dir(self) -> Path:
        return self.work_dir / "temp_scripts"

    @property
    def state_file(self) -> Path:
        return self.work_dir / "pipeline_state.json"

    def ensure_dirs(self) -> None:
        for d in (
            self.temp_audio_dir,
            self.temp_captions_dir,
            self.temp_chapters_dir,
            self.temp_slices_dir,
            self.temp_scripts_dir,
        ):
            d.mkdir(parents=True, exist_ok=True)

    def write_progress(self, stage: str, chapter_index: int, total_chapters: int,
                       message: str, status: str = "running") -> None:
        """Write a small JSON status file the Node orchestrator polls."""
        if not self.progress_file:
            return
        try:
            pct = int(round((chapter_index / max(1, total_chapters)) * 100)) if total_chapters else 0
            payload = {
                "stage": stage,
                "chapter_index": chapter_index,
                "total_chapters": total_chapters,
                "progress": pct,
                "message": message,
                "status": status,
                "updated_at": time.time(),
            }
            tmp = self.progress_file.with_suffix(".tmp")
            tmp.write_text(json.dumps(payload), encoding="utf-8")
            tmp.replace(self.progress_file)
        except Exception:
            pass


@dataclass
class Chapter:
    index: int
    name: str
    folder: Path
    panel_paths: List[Path] = field(default_factory=list)
    summary_text: str = ""  # backward compat (from summary.txt)
    image_narrations: dict = field(default_factory=dict)  # filename -> narration text (from narration.json)

    @property
    def tag(self) -> str:
        return f"chap_{self.index:03d}"


# ---------------------------------------------------------------------------
# 1. INGESTION
# ---------------------------------------------------------------------------

def natural_sort_key(p: Path):
    return [int(t) if t.isdigit() else t.lower() for t in re.split(r"(\d+)", p.stem)]


def discover_chapters(cfg: PipelineConfig) -> List[Chapter]:
    """Scan input_dir for chapter_XXX folders, sort numerically, load panels + summary."""
    if not cfg.input_dir.exists():
        raise FileNotFoundError(f"Input directory not found: {cfg.input_dir}")

    chapter_dirs = sorted(
        [d for d in cfg.input_dir.iterdir() if d.is_dir()],
        key=natural_sort_key,
    )
    if not chapter_dirs:
        raise FileNotFoundError(f"No chapter subfolders found in {cfg.input_dir}")

    if cfg.total_chapters:
        chapter_dirs = chapter_dirs[: cfg.total_chapters]

    chapters: List[Chapter] = []
    for i, d in enumerate(chapter_dirs, start=1):
        panels = sorted(
            [p for p in d.iterdir() if p.suffix.lower() in IMAGE_EXTS],
            key=natural_sort_key,
        )
        if not panels:
            log.warning("Chapter folder %s has no images — skipping", d.name)
            continue

        # Load per-image narrations if available (preferred), else fall back to summary.txt.
        narration_file = d / "narration.json"
        summary_text = ""
        image_narrations: dict = {}
        if narration_file.exists():
            try:
                narr_data = json.loads(narration_file.read_text(encoding="utf-8"))
                if isinstance(narr_data, list):
                    for item in narr_data:
                        if isinstance(item, dict) and "image" in item and "text" in item:
                            image_narrations[item["image"]] = item["text"]
                    log.info("[%s] loaded %d per-image narrations from narration.json", d.name, len(image_narrations))
            except Exception as e:
                log.warning("[%s] failed to parse narration.json: %s", d.name, e)

        if not image_narrations:
            summary_file = d / "summary.txt"
            summary_text = summary_file.read_text(encoding="utf-8").strip() if summary_file.exists() else ""
            if not summary_text:
                log.warning(
                    "No narration.json or summary.txt in %s — narrative rewrite will run on empty text",
                    d.name,
                )

        chapters.append(
            Chapter(
                index=i, name=d.name, folder=d, panel_paths=panels,
                summary_text=summary_text, image_narrations=image_narrations,
            )
        )

    log.info("Discovered %d chapters (%d total panel images)", len(chapters), sum(len(c.panel_paths) for c in chapters))
    return chapters


# ---------------------------------------------------------------------------
# 2. UNIFORM CANVAS SLICING ENGINE (gutter-aware + inpainting)
# ---------------------------------------------------------------------------

# Inpainting toggle — disabled by default to avoid OOM on large webtoon strips.
# The VLM narration focuses on describing the scene rather than reading dialogue,
# which achieves a similar effect without the memory cost of CV2 inpainting.
INPAINT_BUBBLES = False
INPAINT_MIN_BUBBLE_AREA = 800   # px² — ignore tiny text fragments
INPAINT_MAX_BUBBLE_AREA = 150000  # px² — ignore huge regions (whole panels)


def _detect_panel_gutters(img_gray, y_offset: int = 0) -> List[int]:
    """Detect horizontal gutter lines (panel separators) in a webtoon strip.

    Uses OpenCV to find rows that are predominantly a solid, uniform band
    (a blank white gap or a thin black border between panels). Returns a
    sorted list of ABSOLUTE y-coordinates (relative to the original image,
    offset by y_offset) where the strip should be cut into individual panels.

    Uses an adaptive, percentile-based flatness threshold rather than a fixed
    one, since JPEG compression noise can push an otherwise-blank row's
    std-dev above any single fixed cutoff — a fixed threshold that's too
    strict is exactly what let multiple distinct panels slip through as one
    oversized "segment" and get crammed into a single video frame together.
    """
    import cv2
    import numpy as np

    h, w = img_gray.shape
    if h < 10:
        return []

    row_stds = np.std(img_gray, axis=1).astype(np.float32)
    # Smooth to avoid single-row noise spikes, but keep the kernel small
    # enough not to blur out genuinely thin (a few px) panel borders.
    kernel = max(1, min(5, h // 500))
    if kernel > 1:
        row_stds = cv2.blur(row_stds.reshape(-1, 1), (kernel, 1)).flatten()

    # Adaptive threshold: the flattest ~20% of rows in THIS strip, capped to
    # a sane absolute ceiling so busy art doesn't get treated as a gutter.
    gutter_threshold = float(min(14.0, max(6.0, np.percentile(row_stds, 20))))
    is_gutter = row_stds < gutter_threshold

    cuts: List[int] = []
    run_start = None
    min_gutter_height = max(2, h // 800)  # allow thin (a few px) borders, not just wide gaps
    for i, g in enumerate(is_gutter):
        if g and run_start is None:
            run_start = i
        elif not g and run_start is not None:
            if i - run_start >= min_gutter_height:
                cuts.append(y_offset + (run_start + i) // 2)
            run_start = None
    if run_start is not None and h - run_start >= min_gutter_height:
        cuts.append(y_offset + (run_start + h) // 2)
    return cuts


def _split_into_panel_segments(img_gray, max_segment_height: int) -> List[tuple]:
    """Return a list of (top, bottom) panel boundaries for a webtoon strip,
    guaranteeing no returned segment is taller than max_segment_height
    without at least attempting a second, more lenient detection pass on it.

    A single video frame is only allowed to hold ONE segment's worth of
    content when that segment fits inside the canvas — so any segment left
    oversized after the first pass would otherwise mean multiple story
    panels get composited into a single frame together. This recursively
    re-scans oversized segments (once) with a more lenient threshold before
    giving up and treating them as one large panel/splash-page image.
    """
    import numpy as np

    h, w = img_gray.shape
    gutter_cuts = _detect_panel_gutters(img_gray)
    boundaries = [0] + gutter_cuts + [h]
    segments = []
    for i in range(len(boundaries) - 1):
        top, bot = boundaries[i], boundaries[i + 1]
        if bot - top < 50:  # skip tiny slivers (likely detection noise)
            continue
        segments.append((top, bot))
    if not segments:
        segments = [(0, h)]

    # Second pass: any segment still much taller than one frame is suspicious
    # — either a genuine full-page splash panel, or missed gutters. Re-scan
    # just that sub-region with a more lenient (higher) threshold to try to
    # recover any gutters the first pass missed.
    refined: List[tuple] = []
    for top, bot in segments:
        seg_h = bot - top
        if seg_h > max_segment_height * 1.5:
            sub = img_gray[top:bot, :]
            sub_stds = np.std(sub, axis=1).astype(np.float32)
            lenient_threshold = float(min(22.0, max(10.0, np.percentile(sub_stds, 30))))
            is_gutter = sub_stds < lenient_threshold
            sub_cuts: List[int] = []
            run_start = None
            min_h = max(2, seg_h // 800)
            for i, g in enumerate(is_gutter):
                if g and run_start is None:
                    run_start = i
                elif not g and run_start is not None:
                    if i - run_start >= min_h:
                        sub_cuts.append(top + (run_start + i) // 2)
                    run_start = None
            if run_start is not None and seg_h - run_start >= min_h:
                sub_cuts.append(top + (run_start + seg_h) // 2)

            if sub_cuts:
                sub_boundaries = [top] + sub_cuts + [bot]
                for j in range(len(sub_boundaries) - 1):
                    st, sb = sub_boundaries[j], sub_boundaries[j + 1]
                    if sb - st >= 50:
                        refined.append((st, sb))
                continue
        refined.append((top, bot))

    return refined


def _inpaint_bubbles(img) -> "object":
    """Detect and inpaint speech bubbles/text in a panel image.

    Uses OpenCV to find text regions (light blobs with borders), then fills
    them with surrounding pixels via OpenCV's inpainting (Telea algorithm —
    a free, fast content-aware fill that reconstructs background art).
    """
    import cv2
    import numpy as np
    from PIL import Image

    arr = np.array(img)  # RGB
    gray = cv2.cvtColor(arr, cv2.COLOR_RGB2GRAY)

    # Detect text/bubbles: white-ish blobs (speech bubbles are usually white).
    # Threshold to find bright regions.
    _, bright = cv2.threshold(gray, 240, 255, cv2.THRESH_BINARY)
    # Morphological close to merge nearby text into blob masks.
    kernel = cv2.getStructuringElement(cv2.MORPH_RECT, (15, 15))
    bright = cv2.morphologyEx(bright, cv2.MORPH_CLOSE, kernel)
    # Find contours that look like text/bubbles (area in range).
    contours, _ = cv2.findContours(bright, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)
    mask = np.zeros(gray.shape, dtype=np.uint8)
    for c in contours:
        area = cv2.contourArea(c)
        if INPAINT_MIN_BUBBLE_AREA < area < INPAINT_MAX_BUBBLE_AREA:
            cv2.drawContours(mask, [c], -1, 255, -1)
            # Dilate the mask slightly so inpainting covers edges cleanly.
    if mask.any():
        mask = cv2.dilate(mask, kernel, iterations=2)
        # Inpaint using the Telea algorithm (fast, free, content-aware).
        arr = cv2.inpaint(arr, mask, 5, cv2.INPAINT_TELEA)
    return Image.fromarray(arr)


def slice_chapter_panels(cfg: PipelineConfig, chapter: Chapter) -> List[tuple]:
    """
    Slice each tall webtoon strip into CANVAS_W x CANVAS_H frames.

    Phase 1 of the production pipeline:
      1. Gutter detection: scan each strip for horizontal panel separators
         (solid color bands) and cut at those coordinates to isolate panels.
      2. Inpainting (optional): detect speech bubbles/text and erase them
         using OpenCV's Telea inpainting (free content-aware fill).
      3. Frame compositing: each detected panel is centered on a blurred
         1920x1080 canvas. Panels taller than the canvas are split with
         overlap so no content is lost.

    Returns list of (frame_path, source_panel_index) tuples in order.
    Resumable: if the chapter's slice folder has a manifest, reuse it.
    """
    from PIL import Image, ImageFilter

    out_dir = cfg.temp_slices_dir / chapter.tag
    manifest_path = out_dir / "manifest.json"
    if manifest_path.exists():
        try:
            data = json.loads(manifest_path.read_text())
            frames = data["frames"]
            sources = data.get("sources")
            if sources and len(sources) == len(frames):
                log.info("[%s] slices already exist (%d frames) — skipping", chapter.tag, len(frames))
                return [(Path(f), s) for f, s in zip(frames, sources)]
            log.info("[%s] old manifest format — re-slicing", chapter.tag)
        except Exception:
            pass

    out_dir.mkdir(parents=True, exist_ok=True)
    frame_data: List[tuple] = []
    frame_counter = 0

    slice_height = CANVAS_H
    step = int(slice_height * (1 - OVERLAP_RATIO))

    for panel_idx, panel_path in enumerate(chapter.panel_paths):
        with Image.open(panel_path) as img:
            img = img.convert("RGB")
            w, h = img.size

            # Scale to canvas width.
            if w != CANVAS_W:
                scale = CANVAS_W / w
                new_h = max(1, int(h * scale))
                img = img.resize((CANVAS_W, new_h), Image.LANCZOS)
                w, h = img.size

            # Phase 1a: Gutter detection — find panel boundaries. Uses an
            # adaptive threshold + a recursive re-scan on any oversized
            # segment, so multiple distinct story panels never get merged
            # into a single video frame together.
            import cv2
            import numpy as np
            gray = cv2.cvtColor(np.array(img), cv2.COLOR_RGB2GRAY)
            segments = _split_into_panel_segments(gray, max_segment_height=CANVAS_H)
            log.debug("[%s] img %d: split into %d panel segment(s)", chapter.tag, panel_idx, len(segments))

            # Phase 1b: Inpaint speech bubbles.
            if INPAINT_BUBBLES:
                try:
                    img = _inpaint_bubbles(img)
                except Exception as e:
                    log.debug("[%s] inpainting skipped for img %d: %s", chapter.tag, panel_idx, e)

            # Slice each segment into canvas-height frames with overlap.
            for seg_top, seg_bot in segments:
                seg_h = seg_bot - seg_top
                if seg_h <= CANVAS_H:
                    crop = img.crop((0, seg_top, w, seg_bot))
                    frame = _compose_canvas(crop, ImageFilter=ImageFilter)
                    fp = out_dir / f"frame_{frame_counter:05d}.jpg"
                    frame.save(fp, quality=92)
                    frame_data.append((fp, panel_idx))
                    frame_counter += 1
                else:
                    y = seg_top
                    while y < seg_bot:
                        crop_bottom = min(y + slice_height, seg_bot)
                        crop = img.crop((0, y, w, crop_bottom))
                        frame = _compose_canvas(crop, ImageFilter=ImageFilter)
                        fp = out_dir / f"frame_{frame_counter:05d}.jpg"
                        frame.save(fp, quality=92)
                        frame_data.append((fp, panel_idx))
                        frame_counter += 1
                        if crop_bottom >= seg_bot:
                            break
                        y += step

    manifest_path.write_text(json.dumps({
        "frames": [str(f) for f, _ in frame_data],
        "sources": [s for _, s in frame_data],
    }, indent=2))
    log.info("[%s] sliced %d source panels into %d uniform frames (gutter-aware + inpainted)",
             chapter.tag, len(chapter.panel_paths), len(frame_data))
    return frame_data


def _compose_canvas(crop, ImageFilter):
    """Center `crop` on a fixed 1920x1080 canvas, filling empty space with a
    Gaussian-blurred, darkened version of the crop itself (no hard letterboxing)."""
    from PIL import Image, ImageEnhance

    cw, ch = crop.size

    # Background: cover-fit blur of the same crop, darkened.
    bg_scale = max(CANVAS_W / cw, CANVAS_H / ch)
    bg = crop.resize((max(1, int(cw * bg_scale)), max(1, int(ch * bg_scale))), Image.LANCZOS)
    bg = bg.filter(ImageFilter.GaussianBlur(15))
    bg = ImageEnhance.Brightness(bg).enhance(0.45)
    # Center-crop the blurred bg to canvas size.
    bx = (bg.width - CANVAS_W) // 2
    by = (bg.height - CANVAS_H) // 2
    bg = bg.crop((bx, by, bx + CANVAS_W, by + CANVAS_H))

    canvas = Image.new("RGB", (CANVAS_W, CANVAS_H))
    canvas.paste(bg, (0, 0))

    # Foreground: fit crop inside canvas preserving aspect ratio, centered.
    fg_scale = min(CANVAS_W / cw, CANVAS_H / ch)
    fw, fh = max(1, int(cw * fg_scale)), max(1, int(ch * fg_scale))
    fg = crop.resize((fw, fh), Image.LANCZOS)
    fx = (CANVAS_W - fw) // 2
    fy = (CANVAS_H - fh) // 2
    canvas.paste(fg, (fx, fy))

    return canvas


# ---------------------------------------------------------------------------
# 3a. TRANSLATION (Groq, OpenAI-compatible endpoint)
# ---------------------------------------------------------------------------

TRANSLATE_SYSTEM_PROMPT = (
    "You are a professional translator. If the given text is already in English, "
    "return it completely unchanged. Otherwise, translate it into natural, fluent "
    "English, preserving names, tone, and meaning as closely as possible. "
    "Output ONLY the resulting English text — no preamble, no notes, no language labels."
)


def translate_text(cfg: PipelineConfig, text: str, cache_tag: str) -> str:
    """Translate a block of text to English via Groq. Cached by cache_tag.
    Any API error falls back to raw text so the pipeline never crashes."""
    out_path = cfg.temp_scripts_dir / f"{cache_tag}_translated.txt"
    if out_path.exists():
        return out_path.read_text(encoding="utf-8")

    if not text:
        out_path.write_text("", encoding="utf-8")
        return ""

    if not cfg.translate or not cfg.groq_api_key:
        log.info("[%s] translation disabled/no Groq key — using raw text as-is", cache_tag)
        out_path.write_text(text, encoding="utf-8")
        return text

    try:
        from openai import OpenAI

        client = OpenAI(api_key=cfg.groq_api_key, base_url=GROQ_BASE_URL)
        resp = client.chat.completions.create(
            model=cfg.groq_model,
            messages=[
                {"role": "system", "content": TRANSLATE_SYSTEM_PROMPT},
                {"role": "user", "content": text},
            ],
            temperature=0.2,
            timeout=60,
        )
        translated = resp.choices[0].message.content.strip()
        if not translated:
            translated = text
        out_path.write_text(translated, encoding="utf-8")
        log.info("[%s] translated text cached (%d chars)", cache_tag, len(translated))
        return translated
    except Exception as e:
        log.warning("[%s] Groq translation failed (%s) — using raw text as-is", cache_tag, e)
        out_path.write_text(text, encoding="utf-8")
        return text


def translate_chapter_text(cfg: PipelineConfig, chapter: Chapter) -> str:
    """Backward-compat wrapper: translate the chapter-level summary text."""
    return translate_text(cfg, chapter.summary_text, chapter.tag)


# ---------------------------------------------------------------------------
# 3b. SEAMLESS NARRATIVE REPHRASER (OpenAI)
# ---------------------------------------------------------------------------

FORBIDDEN_PATTERNS = [
    r"\bchapter\s*\d*\b",
    r"\bwelcome back\b",
    r"\bin this (chapter|episode|part)\b",
    r"\b(chapter|episode)\s*(title|recap)\b",
    r"^\s*(chapter|episode)\s*\d+",
]

SYSTEM_PROMPT = (
    "You are a dramatic audiobook narrator for a martial arts (Murim) fantasy story. "
    "Convert the provided raw webtoon scene notes into a continuous, third-person "
    "narrative script ready for text-to-speech.\n\n"
    "Guidelines:\n"
    "1. Never use meta-phrases like 'In this panel...', 'The character says...', "
    "'we see', or 'this image shows'. Narrate as if the story is unfolding live.\n"
    "2. Use active, visceral verbs — e.g. 'His qi flared with blue sparks' instead of "
    "'He used energy'; 'She drove her blade through the beast's skull' instead of "
    "'She attacked the monster'.\n"
    "3. Maintain dramatic pacing — short, impactful sentences for action beats; "
    "longer flowing sentences for atmosphere and emotion.\n"
    "4. Convey emotion through body language and sensation: 'His jaw clenched', "
    "'A cold sweat traced down her spine', 'The air itself seemed to shudder'.\n"
    "5. Never mention chapter numbers, episode titles, or recap labels.\n"
    "6. Output ONLY the narration text — no preamble, no headers, no markdown tags. "
    "Pure prose ready to be spoken aloud.\n"
    "7. If given previous context, continue the tone and momentum smoothly, as if "
    "the story never paused."
)


def _strip_forbidden(text: str) -> str:
    cleaned = text
    for pat in FORBIDDEN_PATTERNS:
        cleaned = re.sub(pat, "", cleaned, flags=re.IGNORECASE | re.MULTILINE)
    return re.sub(r"\s{2,}", " ", cleaned).strip()


def rephrase_text(cfg: PipelineConfig, text: str, cache_tag: str, prev_tail: str) -> str:
    """Call an LLM to rewrite (already-English) text into narration, chained with
    prev_tail for continuity. Cached by cache_tag.
    Provider selection (cfg.narration_provider):
      - auto: prefer OpenAI if key set, else Groq if key set, else none
      - openai/groq/none: explicit
    Any API error falls back to the raw text verbatim."""
    out_path = cfg.temp_scripts_dir / f"{cache_tag}.txt"
    if out_path.exists():
        log.info("[%s] narration script already exists — skipping rewrite", cache_tag)
        return out_path.read_text(encoding="utf-8")

    if not text:
        log.warning("[%s] no text available, writing empty placeholder script", cache_tag)
        out_path.write_text("", encoding="utf-8")
        return ""

    # Resolve which provider + key + base_url + model to actually use.
    provider = cfg.narration_provider
    openai_key = cfg.openai_api_key or os.environ.get("OPENAI_API_KEY")
    if provider == "auto":
        if openai_key:
            provider = "openai"
        elif cfg.groq_api_key:
            provider = "groq"
        else:
            provider = "none"

    if provider == "none":
        log.info("[%s] narration provider=none — using text verbatim", cache_tag)
        narration = _strip_forbidden(text)
        out_path.write_text(narration, encoding="utf-8")
        return narration

    from openai import OpenAI

    if provider == "openai":
        if not openai_key:
            log.error("[%s] narration provider=openai but no OPENAI_API_KEY — falling back to verbatim", cache_tag)
            narration = _strip_forbidden(text)
            out_path.write_text(narration, encoding="utf-8")
            return narration
        client = OpenAI(api_key=openai_key)
        model = cfg.narration_model or cfg.openai_model
    elif provider == "groq":
        if not cfg.groq_api_key:
            log.error("[%s] narration provider=groq but no GROQ_API_KEY — falling back to verbatim", cache_tag)
            narration = _strip_forbidden(text)
            out_path.write_text(narration, encoding="utf-8")
            return narration
        client = OpenAI(api_key=cfg.groq_api_key, base_url=GROQ_BASE_URL)
        model = cfg.narration_model or cfg.groq_model
    else:
        narration = _strip_forbidden(text)
        out_path.write_text(narration, encoding="utf-8")
        return narration

    user_prompt = text
    if prev_tail:
        user_prompt = (
            f"[Continue smoothly from this prior narration excerpt, do not repeat it]\n"
            f"...{prev_tail}\n\n"
            f"[Raw material for the next portion of the story]\n{text}"
        )

    try:
        resp = client.chat.completions.create(
            model=model,
            messages=[
                {"role": "system", "content": SYSTEM_PROMPT},
                {"role": "user", "content": user_prompt},
            ],
            temperature=0.8,
            timeout=90,
        )
        narration = resp.choices[0].message.content.strip()
        if not narration:
            narration = text
        narration = _strip_forbidden(narration)
    except Exception as e:
        log.warning("[%s] narration API call failed via %s (%s) — using text verbatim", cache_tag, provider, e)
        narration = _strip_forbidden(text)

    out_path.write_text(narration, encoding="utf-8")
    log.info("[%s] narration script written via %s/%s (%d chars)", cache_tag, provider, model, len(narration))
    return narration


def rephrase_chapter(cfg: PipelineConfig, chapter: Chapter, translated_text: str, prev_tail: str) -> str:
    """Backward-compat wrapper: rephrase the chapter-level translated text."""
    return rephrase_text(cfg, translated_text, chapter.tag, prev_tail)


def last_sentences(text: str, n: int = 2) -> str:
    sentences = re.split(r"(?<=[.!?])\s+", text.strip())
    sentences = [s for s in sentences if s]
    return " ".join(sentences[-n:])


def split_into_segments(text: str, n: int) -> List[str]:
    """Split narration text into n roughly-equal word chunks, one per frame,
    so every sliced image gets its own narration segment for tight sync.
    If there are fewer words than frames, trailing frames get an empty
    segment and simply hold silently for SILENT_FRAME_DURATION."""
    words = text.split()
    if n <= 0:
        return []
    if not words:
        return [""] * n

    segments: List[str] = []
    idx = 0
    total = len(words)
    for i in range(n):
        remaining_slots = n - i
        remaining_words = total - idx
        if remaining_words <= 0:
            segments.append("")
            continue
        seg_len = max(1, round(remaining_words / remaining_slots))
        segments.append(" ".join(words[idx: idx + seg_len]))
        idx += seg_len
    return segments


# ---------------------------------------------------------------------------
# 4. CONTINUOUS NEURAL TEXT-TO-SPEECH (edge-tts)
# ---------------------------------------------------------------------------
# NOTE: narration used to be synthesized one tiny word-chunk at a time (one
# edge-tts call per sliced frame) and then concatenated. edge-tts inserts a
# short natural pause at the start/end of every call it makes, so stitching
# dozens of these clips back-to-back produced an audible "stop" after every
# few words. Fixed by synthesizing each *panel's* full narration as a single
# continuous speech clip, then using the actual word-level timestamps from
# that one clip to divide it across frames — no re-synthesis, no seams.

def get_audio_duration(path: Path) -> float:
    """Probe an audio file's duration in seconds via ffprobe."""
    result = subprocess.run(
        [
            "ffprobe", "-v", "error", "-show_entries", "format=duration",
            "-of", "default=noprint_wrappers=1:nokey=1", str(path),
        ],
        stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True,
    )
    try:
        return float(result.stdout.strip())
    except ValueError:
        raise RuntimeError(f"ffprobe could not read duration of {path}: {result.stderr}")


def _generate_silence(path: Path, duration: float) -> None:
    run_ffmpeg(
        [
            "ffmpeg", "-y", "-f", "lavfi",
            "-i", f"anullsrc=r={AUDIO_SAMPLE_RATE}:cl=mono",
            "-t", f"{duration:.3f}",
            "-b:a", AUDIO_BITRATE,
            str(path),
        ]
    )


def synthesize_segment_audio(cfg: PipelineConfig, chapter: Chapter, tag: str, text: str) -> Path:
    """Generate ONE continuous narration clip (or silence) for a whole segment
    (a single source panel, or the whole chapter in legacy mode). Resumable
    per segment. This is the only place edge-tts is invoked per chapter run,
    so the resulting speech has none of the artificial start/end pauses that
    per-word synthesis introduced."""
    seg_audio_dir = cfg.temp_audio_dir / chapter.tag
    seg_audio_dir.mkdir(parents=True, exist_ok=True)
    final_path = seg_audio_dir / f"{tag}.mp3"
    if final_path.exists():
        return final_path

    text = text.strip()
    if not text:
        _generate_silence(final_path, SILENT_FRAME_DURATION)
        return final_path

    import asyncio
    import edge_tts

    raw_path = seg_audio_dir / f"{tag}_raw.mp3"

    async def _run():
        communicate = edge_tts.Communicate(text, cfg.voice)
        await communicate.save(str(raw_path))

    asyncio.run(_run())

    run_ffmpeg(
        [
            "ffmpeg", "-y", "-i", str(raw_path),
            "-ar", str(AUDIO_SAMPLE_RATE), "-b:a", AUDIO_BITRATE,
            str(final_path),
        ]
    )
    raw_path.unlink(missing_ok=True)
    return final_path


def build_chapter_audio_track(cfg: PipelineConfig, chapter: Chapter, segment_audio_paths: List[Path]) -> Path:
    """Concatenate per-segment (per-panel) audio clips into one continuous
    chapter audio track, then apply Phase 3 audio post-processing:
      1. Compressor (fast attack, 3:1 ratio) to even out spoken volume.
      2. EQ boost (+2dB at 80-120Hz) for deep narrative gravitas.
      3. Loudness normalization to -14 LUFS (YouTube standard).
    Because each input clip is now a full continuous utterance (not a lone
    word), the only joins left are the natural breath-like gaps between
    panels/scenes — not mid-sentence chops. Resumable."""
    out_path = cfg.temp_audio_dir / f"{chapter.tag}.mp3"
    if out_path.exists():
        log.info("[%s] chapter audio track already assembled — skipping", chapter.tag)
        return out_path

    concat_list = cfg.temp_audio_dir / f"{chapter.tag}_audio_concat.txt"
    with concat_list.open("w", encoding="utf-8") as f:
        for p in segment_audio_paths:
            f.write(f"file '{p.resolve().as_posix()}'\n")

    # First: raw concat (stream copy).
    raw_path = cfg.temp_audio_dir / f"{chapter.tag}_raw.mp3"
    run_ffmpeg(
        [
            "ffmpeg", "-y", "-f", "concat", "-safe", "0",
            "-i", str(concat_list),
            "-c", "copy",
            str(raw_path),
        ]
    )

    # Second: audio post-processing — compressor + EQ + loudnorm.
    # acompressor: fast attack (5ms), 3:1 ratio, moderate threshold for even voice.
    # bass: +2dB low-shelf boost at 100Hz for narrative gravitas.
    # loudnorm: EBU R128 normalization to -14 LUFS (YouTube standard).
    #
    # NOTE: if a chapter has no narration at all (every segment fell back to
    # silence — narration.json entries all empty, or narrative rewrite
    # returned nothing), raw_path is pure digital silence end-to-end.
    # loudnorm's gain boost on an absolutely-zero signal trips a real
    # libmp3lame bug (psymodel.c calc_energy: Assertion 'el >= 0' failed,
    # verified locally), which crashes ffmpeg outright. There's nothing to
    # compress/normalize in silence anyway, so on that failure we just copy
    # the raw (silent) track through untouched instead of crashing the job.
    af = (
        "acompressor=attack=5:release=80:ratio=3:threshold=-20dB:makeup=2,"
        "bass=gain=2:frequency=100:width=80,"
        f"loudnorm=I={TARGET_LOUDNESS_LUFS}:TP=-1.5:LRA=11"
    )
    try:
        run_ffmpeg(
            [
                "ffmpeg", "-y", "-i", str(raw_path),
                "-af", af,
                "-ar", str(AUDIO_SAMPLE_RATE), "-b:a", AUDIO_BITRATE, "-ac", "1",
                str(out_path),
            ]
        )
    except RuntimeError as e:
        log.warning(
            "[%s] audio post-processing failed (%s) — falling back to raw (unprocessed) audio track",
            chapter.tag, e,
        )
        shutil.copy2(raw_path, out_path)
    raw_path.unlink(missing_ok=True)
    log.info("[%s] assembled + post-processed chapter audio (compressor+EQ+loudnorm) -> %s", chapter.tag, out_path.name)
    return out_path


# ---------------------------------------------------------------------------
# 4b. FRAME TIMING FROM REAL WORD TIMESTAMPS (no re-synthesis, no seams)
# ---------------------------------------------------------------------------

_whisper_model = None


def _get_whisper_model():
    global _whisper_model
    if _whisper_model is None:
        from faster_whisper import WhisperModel
        log.info("Loading faster-whisper model (base.en)...")
        _whisper_model = WhisperModel("base.en", compute_type="int8")
    return _whisper_model


def transcribe_words(audio_path: Path) -> List[tuple]:
    """Transcribe one continuous audio clip and return a flat list of
    (word_text, start, end) tuples in clip-local seconds. Empty list on any
    failure so callers can fall back to a proportional split."""
    try:
        model = _get_whisper_model()
        segments, _info = model.transcribe(str(audio_path), word_timestamps=True)
    except Exception as e:
        log.warning("whisper transcription failed for %s (%s)", audio_path.name, e)
        return []

    words: List[tuple] = []
    for seg in segments:
        for w in getattr(seg, "words", None) or []:
            text = w.word.strip()
            if text:
                words.append((text, float(w.start), float(w.end)))
    return words


def split_frame_timings(text: str, positions: List[int], duration: float, words: List[tuple]) -> dict:
    """Given a segment's full narration text, the frame positions it spans,
    the segment's total audio duration, and (optionally) real word-level
    timestamps for that audio, return {position: (start, end)} clip-local
    timing for each frame so the image swap lines up with what's actually
    being spoken. Falls back to a proportional word-count split if
    transcription isn't available."""
    frame_texts = split_into_segments(text, len(positions))
    word_counts = [len(t.split()) for t in frame_texts]
    total_words = sum(word_counts)

    timings: dict = {}

    if words and total_words > 0 and len(words) >= total_words:
        # Walk the real transcribed words in order, assigning the same count
        # to each frame that split_into_segments gave it textually.
        cursor = 0
        prev_end = 0.0
        for pos, count in zip(positions, word_counts):
            if count <= 0:
                timings[pos] = (prev_end, prev_end)
                continue
            chunk = words[cursor: cursor + count]
            cursor += count
            start = prev_end if pos == positions[0] else chunk[0][1]
            end = chunk[-1][2]
            timings[pos] = (start, end)
            prev_end = end
        # Make sure the final frame's end reaches the true clip end so audio
        # and video durations line up exactly (captures trailing breath/pause).
        last_pos = positions[-1]
        s, _ = timings[last_pos]
        timings[last_pos] = (s, duration)
    else:
        # Fallback: proportional split by word count (or even split if no words at all).
        cursor = 0.0
        if total_words > 0:
            for pos, count in zip(positions, word_counts):
                span = duration * (count / total_words) if total_words else 0.0
                timings[pos] = (cursor, cursor + span)
                cursor += span
        else:
            span = duration / max(1, len(positions))
            for pos in positions:
                timings[pos] = (cursor, cursor + span)
                cursor += span
        last_pos = positions[-1]
        s, _ = timings[last_pos]
        timings[last_pos] = (s, duration)

    return timings


# ---------------------------------------------------------------------------
# 5. PHRASE-LEVEL CAPTION GENERATOR (faster-whisper)
# ---------------------------------------------------------------------------
# Captions are grouped into short natural phrases (not one word flashing at a
# time) so they read like normal subtitles instead of a rapid-fire karaoke
# effect on screen.

CAPTION_WORDS_PER_LINE = 5  # group words into short phrases, not single flashes


def _ass_timestamp(t: float) -> str:
    h = int(t // 3600)
    m = int((t % 3600) // 60)
    s = t % 60
    return f"{h:d}:{m:02d}:{s:05.2f}"


ASS_HEADER = """[Script Info]
ScriptType: v4.00+
PlayResX: 1920
PlayResY: 1080
WrapStyle: 0
ScaledBorderAndShadow: yes

[V4+ Styles]
Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding
Style: Default,Arial,58,&H00FFFFFF,&H000000FF,&H00000000,&H80000000,0,0,0,0,100,100,0,0,1,3,1.5,2,80,80,80,1

[Events]
Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text
"""


def generate_captions(
    cfg: PipelineConfig,
    chapter: Chapter,
    segment_words: List[tuple],
) -> Optional[Path]:
    """Build one chapter-level .ass file from pre-transcribed, chapter-offset
    (word, start, end) tuples, grouping consecutive words into short phrases
    instead of showing one word at a time. `segment_words` is built once per
    chapter in run_pipeline from the same word timestamps already produced
    for frame-timing, so nothing is transcribed twice."""
    out_path = cfg.temp_captions_dir / f"{chapter.tag}.ass"
    if out_path.exists():
        log.info("[%s] captions already exist — skipping", chapter.tag)
        return out_path

    if cfg.skip_captions:
        log.info("[%s] --skip-captions set — skipping caption generation", chapter.tag)
        return None

    if not segment_words:
        log.warning("[%s] no transcribed words available — skipping captions", chapter.tag)
        return None

    lines = [ASS_HEADER]
    for i in range(0, len(segment_words), CAPTION_WORDS_PER_LINE):
        chunk = segment_words[i: i + CAPTION_WORDS_PER_LINE]
        if not chunk:
            continue
        start = _ass_timestamp(chunk[0][1])
        end = _ass_timestamp(chunk[-1][2])
        text = " ".join(w for w, _s, _e in chunk).strip()
        if not text:
            continue
        lines.append(f"Dialogue: 0,{start},{end},Default,,0,0,0,,{text}\n")

    out_path.write_text("".join(lines), encoding="utf-8")
    log.info("[%s] phrase-level captions written -> %s", chapter.tag, out_path.name)
    return out_path


# ---------------------------------------------------------------------------
# 6. CHAPTER RENDERER (static frames, memory-efficient per-segment ffmpeg)
# ---------------------------------------------------------------------------

def render_chapter(
    cfg: PipelineConfig,
    chapter: Chapter,
    frame_paths: List[Path],
    frame_durations: List[float],
    audio_path: Optional[Path],
    caption_path: Optional[Path],
) -> Optional[Path]:
    """Render a chapter's static panel frames + per-frame narration + burned
    captions into an MP4.

    Memory-efficient approach: renders each frame as a short static-image video
    segment via a separate ffmpeg process (one at a time), then concatenates
    all segments with stream copy. This avoids loading all frames into RAM
    simultaneously (which caused OOM with moviepy's concatenate_videoclips).

    Each frame is held on screen for exactly its own audio segment's duration
    (frame_durations), so image swaps line up precisely with the narration.
    RESUME: skip entirely if chap_XXX.mp4 already exists on disk."""
    out_path = cfg.temp_chapters_dir / f"{chapter.tag}.mp4"
    if out_path.exists():
        log.info("[%s] chapter video already rendered — skipping (resume)", chapter.tag)
        return out_path

    if not frame_paths:
        log.warning("[%s] no frames to render — skipping chapter", chapter.tag)
        return None

    segment_dir = cfg.temp_chapters_dir / chapter.tag
    segment_dir.mkdir(parents=True, exist_ok=True)

    # Render each frame as a short static-image video segment.
    # One ffmpeg process per frame = low memory (unlike moviepy which loads all).
    segment_paths: List[Path] = []
    min_dur = 1.0 / FPS

    for i, (fp, d) in enumerate(zip(frame_paths, frame_durations)):
        seg_path = segment_dir / f"seg_{i:05d}.mp4"
        if not seg_path.exists():
            duration = max(d, min_dur)
            # Use -loop 1 to repeat the image, -t for duration (not -frames:v
            # which doesn't work with single-image inputs without -loop).
            cmd = [
                "ffmpeg", "-y",
                "-loop", "1", "-i", str(fp),
                "-vf", f"scale={CANVAS_W}:{CANVAS_H}:force_original_aspect_ratio=increase,crop={CANVAS_W}:{CANVAS_H}",
                "-t", f"{duration:.3f}",
                "-c:v", "libx264", "-preset", "ultrafast", "-pix_fmt", "yuv420p",
                "-r", str(FPS),
                "-an",
                str(seg_path),
            ]
            result = subprocess.run(cmd, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True)
            if result.returncode != 0:
                log.warning("[%s] segment %d render failed: %s", chapter.tag, i, result.stdout[-200:])
                continue
        segment_paths.append(seg_path)

    log.info("[%s] rendered %d static segments", chapter.tag, len(segment_paths))

    if not segment_paths:
        log.error("[%s] no segments rendered — skipping chapter", chapter.tag)
        return None

    # Concatenate all segments via ffmpeg concat demuxer (stream copy, fast, low memory).
    concat_list = segment_dir / "concat_list.txt"
    with concat_list.open("w", encoding="utf-8") as f:
        for sp in segment_paths:
            f.write(f"file '{sp.resolve().as_posix()}'\n")

    silent_path = cfg.temp_chapters_dir / f"{chapter.tag}_nosubs.mp4"
    run_ffmpeg([
        "ffmpeg", "-y", "-f", "concat", "-safe", "0",
        "-i", str(concat_list),
        "-c", "copy",
        str(silent_path),
    ])

    # Mux audio + burn captions in a single ffmpeg pass.
    if audio_path and audio_path.exists():
        cmd = [
            "ffmpeg", "-y",
            "-i", str(silent_path),
            "-i", str(audio_path),
            "-map", "0:v", "-map", "1:a",
            "-c:v", "libx264", "-preset", "ultrafast",
            "-c:a", "aac", "-b:a", AUDIO_BITRATE, "-ar", str(AUDIO_SAMPLE_RATE),
            "-shortest",
        ]
        if caption_path and caption_path.exists():
            cmd[-1:-1] = ["-vf", f"ass={_ffmpeg_escape_path(caption_path)}"]
        cmd.append(str(out_path))
        run_ffmpeg(cmd)
    else:
        if caption_path and caption_path.exists():
            run_ffmpeg([
                "ffmpeg", "-y", "-i", str(silent_path),
                "-vf", f"ass={_ffmpeg_escape_path(caption_path)}",
                "-c:v", "libx264", "-preset", "ultrafast",
                "-c:a", "aac", "-b:a", AUDIO_BITRATE, "-ar", str(AUDIO_SAMPLE_RATE),
                str(out_path),
            ])
        else:
            shutil.copy2(silent_path, out_path)

    silent_path.unlink(missing_ok=True)

    log.info("[%s] chapter video rendered -> %s", chapter.tag, out_path.name)
    return out_path


def _ffmpeg_escape_path(p: Path) -> str:
    # ffmpeg's ass filter needs escaped colons/backslashes on some platforms.
    s = str(p).replace("\\", "/")
    s = s.replace(":", r"\:")
    return s


# ---------------------------------------------------------------------------
# 7. FFMPEG ZERO-REENCODE STREAM MERGER & BGM OVERLAY
# ---------------------------------------------------------------------------

def run_ffmpeg(cmd: List[str]) -> None:
    log.debug("Running: %s", " ".join(cmd))
    result = subprocess.run(cmd, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True)
    if result.returncode != 0:
        log.error("ffmpeg command failed:\n%s", result.stdout)
        raise RuntimeError(f"ffmpeg failed (exit {result.returncode}): {' '.join(cmd)}")


def merge_chapters(cfg: PipelineConfig, chapter_videos: List[Path]) -> Path:
    """Zero-reencode concat of all chapter mp4s via ffmpeg's concat demuxer."""
    concat_list = cfg.work_dir / "concat_list.txt"
    with concat_list.open("w", encoding="utf-8") as f:
        for cv in chapter_videos:
            f.write(f"file '{cv.resolve().as_posix()}'\n")

    merged_path = cfg.work_dir / "master_merged.mp4"
    if merged_path.exists():
        log.info("Merged master file already exists — skipping merge step (resume)")
        return merged_path

    log.info("Merging %d chapter videos via ffmpeg stream copy...", len(chapter_videos))
    run_ffmpeg(
        [
            "ffmpeg", "-y", "-f", "concat", "-safe", "0",
            "-i", str(concat_list),
            "-c", "copy",
            str(merged_path),
        ]
    )
    log.info("Merge complete -> %s", merged_path.name)
    return merged_path


def overlay_bgm(cfg: PipelineConfig, merged_path: Path) -> Path:
    """Loop BGM under the narration with SIDECHAIN COMPRESSION so the music
    automatically ducks by 18dB whenever the narrator is speaking, then rises
    back up during pauses. This is the Phase 3 sound design technique used by
    professional recap channels.

    Filter chain:
      1. BGM is looped and low-passed slightly so it sits behind the voice.
      2. sidechaincompress uses the narration track as the sidechain input:
         when voice is active, BGM is compressed (ducked); when silent, BGM
         returns to full volume.
      3. The ducked BGM is mixed with the narration at full volume.
    """
    if not cfg.bgm_path:
        log.info("No --bgm provided — copying merged file directly to final output")
        shutil.copy2(merged_path, cfg.output_path)
        return cfg.output_path

    log.info("Overlaying BGM with sidechain ducking (voice-activated -18dB)...")

    # sidechaincompress parameters:
    #   threshold=-30dB (duck starts when voice exceeds this)
    #   ratio=8 (heavy duck)
    #   attack=20ms (fast duck when voice starts)
    #   release=300ms (smooth recovery when voice stops)
    #   makeup=1 (minimum — no boost on BGM; range is 1-64)
    # Use -stream_loop -1 on the BGM input (input-level looping) instead of
    # the aloop filter, which is more reliable for long videos.
    filter_complex = (
        f"[1:a]volume=0.6,"
        f"sidechaincompress=threshold=-30dB:ratio=8:attack=20:release=300:makeup=1[bgm];"
        f"[0:a][bgm]amix=inputs=2:duration=first:dropout_transition=2,"
        f"loudnorm=I={TARGET_LOUDNESS_LUFS}:TP=-1.5:LRA=11[aout]"
    )
    run_ffmpeg(
        [
            "ffmpeg", "-y",
            "-i", str(merged_path),
            "-stream_loop", "-1", "-i", str(cfg.bgm_path),
            "-filter_complex", filter_complex,
            "-map", "0:v", "-map", "[aout]",
            "-c:v", "copy",
            "-c:a", "aac", "-b:a", AUDIO_BITRATE, "-ar", str(AUDIO_SAMPLE_RATE),
            "-shortest",
            str(cfg.output_path),
        ]
    )
    log.info("Final master video with sidechain-ducked BGM written -> %s", cfg.output_path)
    return cfg.output_path


# ---------------------------------------------------------------------------
# CLEANUP
# ---------------------------------------------------------------------------

def cleanup_temp(cfg: PipelineConfig) -> None:
    if cfg.keep_temp:
        log.info("--keep-temp set: leaving working directory at %s", cfg.work_dir)
        return
    log.info("Cleaning up temporary working directory: %s", cfg.work_dir)
    shutil.rmtree(cfg.work_dir, ignore_errors=True)


# ---------------------------------------------------------------------------
# ORCHESTRATION
# ---------------------------------------------------------------------------

def run_pipeline(cfg: PipelineConfig) -> None:
    start = time.time()
    cfg.ensure_dirs()

    chapters = discover_chapters(cfg)
    total = len(chapters)
    chapter_videos: List[Path] = []
    prev_tail = ""

    cfg.write_progress("render", 0, total, f"Starting pipeline over {total} chapters")

    for chapter in chapters:
        t0 = time.time()
        log.info("=== Chapter %d/%d (%s) ===", chapter.index, total, chapter.name)
        cfg.write_progress("render", chapter.index - 1, total, f"Chapter {chapter.index}/{total}: {chapter.name}")

        existing_video = cfg.temp_chapters_dir / f"{chapter.tag}.mp4"
        if existing_video.exists():
            log.info("[%s] fully rendered already — resuming past this chapter", chapter.tag)
            chapter_videos.append(existing_video)
            # Keep narrative continuity even when resuming: pull tail from cached script.
            script_cache = cfg.temp_scripts_dir / f"{chapter.tag}.txt"
            if script_cache.exists():
                prev_tail = last_sentences(script_cache.read_text(encoding="utf-8"))
            continue

        # Slice returns [(frame_path, source_panel_index), ...] so we can map
        # each frame to its source image's narration for perfect sync.
        frame_data = slice_chapter_panels(cfg, chapter)
        frame_paths = [fp for fp, _ in frame_data]
        frame_sources = [si for _, si in frame_data]

        # Build an ordered list of (tag, text, frame_positions) "segments" —
        # each one gets exactly ONE continuous edge-tts synthesis call, then
        # real word timestamps from that single clip drive per-frame timing.
        # This is what eliminates the audible stop-after-every-word chop:
        # previously every one of these frame positions triggered its own
        # separate edge-tts call.
        segments: List[tuple] = []  # (tag, text, positions)

        if chapter.image_narrations:
            # PER-IMAGE NARRATION MODE (preferred): each source image has its own
            # VLM-generated narration, so what you hear matches what you see.
            log.info("[%s] per-image narration mode: %d images, %d frames",
                     chapter.tag, len(chapter.panel_paths), len(frame_paths))

            # Translate + rephrase each image's narration individually.
            panel_narrations: dict = {}  # panel_index -> narration text
            for idx, panel_path in enumerate(chapter.panel_paths):
                raw_text = chapter.image_narrations.get(panel_path.name, "")
                img_tag = f"{chapter.tag}_img{idx + 1:03d}"
                translated = translate_text(cfg, raw_text, img_tag)
                rephrased = rephrase_text(cfg, translated, img_tag, prev_tail)
                panel_narrations[idx] = rephrased
                if rephrased:
                    prev_tail = last_sentences(rephrased)

            # Group frame positions by source panel (preserving timeline order).
            from collections import defaultdict as _dd
            panel_frame_positions = _dd(list)  # panel_index -> [frame_positions]
            for pos, si in enumerate(frame_sources):
                panel_frame_positions[si].append(pos)

            for si, positions in panel_frame_positions.items():
                narr = panel_narrations.get(si, "")
                segments.append((f"img{si + 1:03d}", narr, positions))
        else:
            # CHAPTER-LEVEL NARRATION MODE (backward compat for old jobs without
            # narration.json): one continuous narration clip for the whole
            # chapter, sliced across all frames by real word timing.
            log.info("[%s] chapter-level narration mode (no narration.json)", chapter.tag)
            translated_text = translate_chapter_text(cfg, chapter)
            narration = rephrase_chapter(cfg, chapter, translated_text, prev_tail)
            prev_tail = last_sentences(narration) if narration else prev_tail
            segments.append(("chapter", narration, list(range(len(frame_paths)))))

        # Synthesize one continuous clip per segment, transcribe it once, and
        # derive per-frame timing + chapter-offset caption words from it.
        frame_timing = [None] * len(frame_paths)  # position -> (start, end) clip-local to its segment
        segment_audio_paths: List[Path] = []
        segment_words: List[tuple] = []  # (word, chapter_offset_start, chapter_offset_end)
        chapter_offset = 0.0

        for tag, text, positions in segments:
            audio_path_seg = synthesize_segment_audio(cfg, chapter, tag, text)
            duration = get_audio_duration(audio_path_seg)
            words = transcribe_words(audio_path_seg) if text.strip() else []
            timings = split_frame_timings(text, positions, duration, words)
            for pos in positions:
                frame_timing[pos] = timings[pos]
            for w_text, w_start, w_end in words:
                segment_words.append((w_text, chapter_offset + w_start, chapter_offset + w_end))
            segment_audio_paths.append(audio_path_seg)
            chapter_offset += duration

        min_dur = 1.0 / FPS
        frame_durations = [max(min_dur, end - start) for start, end in frame_timing]

        audio_path = build_chapter_audio_track(cfg, chapter, segment_audio_paths) if segment_audio_paths else None
        caption_path = generate_captions(cfg, chapter, segment_words)
        video_path = render_chapter(cfg, chapter, frame_paths, frame_durations, audio_path, caption_path)

        if video_path:
            chapter_videos.append(video_path)

        log.info("[%s] done in %.1fs", chapter.tag, time.time() - t0)
        cfg.write_progress("render", chapter.index, total, f"Chapter {chapter.index}/{total} rendered")

    if not chapter_videos:
        cfg.write_progress("render", total, total, "No chapter videos produced", status="error")
        raise RuntimeError("No chapter videos were produced — nothing to merge.")

    cfg.write_progress("merge", total, total, "Merging chapter videos")
    merged = merge_chapters(cfg, chapter_videos)
    cfg.write_progress("bgm", total, total, "Finalizing output")
    overlay_bgm(cfg, merged)
    cleanup_temp(cfg)

    elapsed = time.time() - start
    cfg.write_progress("done", total, total, f"Pipeline complete in {elapsed/60:.1f} min", status="done")
    log.info("PIPELINE COMPLETE in %.1f minutes. Output: %s", elapsed / 60, cfg.output_path)


# ---------------------------------------------------------------------------
# CLI
# ---------------------------------------------------------------------------

def parse_args(argv: Optional[List[str]] = None) -> PipelineConfig:
    parser = argparse.ArgumentParser(
        description="Convert local webtoon/manhwa chapter folders into a single master recap video."
    )
    parser.add_argument(
        "--input-dir", required=True, type=Path,
        help="Root dataset folder containing chapter_001/, chapter_002/, ... subfolders.",
    )
    parser.add_argument(
        "--total-chapters", type=int, default=None,
        help="Limit processing to the first N chapters (default: process all found).",
    )
    parser.add_argument(
        "--bgm", type=Path, default=None,
        help="Path to a background_music.mp3 file to loop under the narration at -20dB.",
    )
    parser.add_argument(
        "--output", type=Path, default=Path("master_recap.mp4"),
        help="Final output video path (default: ./master_recap.mp4).",
    )
    parser.add_argument(
        "--work-dir", type=Path, default=Path("./_pipeline_work"),
        help="Working directory for temp files (default: ./_pipeline_work). Reuse the same "
             "path across runs to resume an interrupted pipeline.",
    )
    parser.add_argument(
        "--voice", default="en-US-AndrewNeural",
        help="edge-tts voice name (default: en-US-AndrewNeural).",
    )
    parser.add_argument(
        "--openai-model", default="gpt-4o-mini",
        help="OpenAI model for narrative rewriting (default: gpt-4o-mini).",
    )
    parser.add_argument(
        "--openai-api-key", default=os.environ.get("OPENAI_API_KEY"),
        help="OpenAI API key for narrative rewriting (or set OPENAI_API_KEY env var).",
    )
    parser.add_argument(
        "--narration-provider", default="auto", choices=["auto", "openai", "groq", "none"],
        help="LLM provider for narrative rewriting (default: auto = prefer OpenAI, fall back to Groq, else none).",
    )
    parser.add_argument(
        "--narration-model", default=None,
        help="Override the narration model name (default: openai_model or groq_model depending on provider).",
    )
    parser.add_argument(
        "--skip-captions", action="store_true",
        help="Skip faster-whisper caption generation entirely (faster, no model download).",
    )
    parser.add_argument(
        "--progress-file", type=Path, default=None,
        help="JSON file path to write progress updates to (polled by the Node orchestrator).",
    )
    parser.add_argument(
        "--groq-api-key", default=os.environ.get("GROQ_API_KEY"),
        help="Groq API key used to translate non-English chapter text to English "
             "before narration rewriting (or set GROQ_API_KEY env var). "
             "If omitted, translation is skipped and raw text is used as-is.",
    )
    parser.add_argument(
        "--groq-model", default="llama-3.3-70b-versatile",
        help="Groq model used for translation (default: llama-3.3-70b-versatile).",
    )
    parser.add_argument(
        "--no-translate", action="store_true",
        help="Disable the translation step even if a Groq key is available.",
    )
    parser.add_argument(
        "--keep-temp", action="store_true",
        help="Do not delete the working directory after a successful run.",
    )
    parser.add_argument(
        "-v", "--verbose", action="store_true", help="Enable debug logging.",
    )

    args = parser.parse_args(argv)
    if args.verbose:
        log.setLevel(logging.DEBUG)

    if args.bgm and not args.bgm.exists():
        parser.error(f"--bgm file not found: {args.bgm}")

    return PipelineConfig(
        input_dir=args.input_dir,
        output_path=args.output,
        total_chapters=args.total_chapters,
        bgm_path=args.bgm,
        work_dir=args.work_dir,
        voice=args.voice,
        openai_model=args.openai_model,
        openai_api_key=args.openai_api_key,
        keep_temp=args.keep_temp,
        groq_api_key=args.groq_api_key,
        groq_model=args.groq_model,
        translate=not args.no_translate,
        narration_provider=args.narration_provider,
        narration_model=args.narration_model,
        skip_captions=args.skip_captions,
        progress_file=args.progress_file,
    )


def check_dependencies() -> None:
    """Fail fast with a clear message if ffmpeg isn't on PATH."""
    if shutil.which("ffmpeg") is None:
        log.error("ffmpeg not found on PATH. Install it (e.g. `apt install ffmpeg` / `brew install ffmpeg`).")
        sys.exit(1)


def main() -> None:
    cfg = parse_args()
    check_dependencies()
    try:
        run_pipeline(cfg)
    except Exception as e:
        log.error("Pipeline failed: %s", e)
        log.info(
            "Progress is saved under %s — rerun the same command to resume "
            "from the last completed chapter.",
            cfg.work_dir,
        )
   
if __name__ == "__main__":
    main()
