import { promises as fs } from "fs";
import path from "path";

/**
 * Root data directory for all pipeline jobs.
 * Each job lives under DATA_DIR/jobs/{jobId}/
 *   - dataset/chapter_XXX/001.jpg ... summary.txt
 *   - work/ (pipeline temp files)
 *   - output/master_recap.mp4
 */
export const DATA_DIR = path.join(process.cwd(), "data");

export function jobDir(jobId: string) {
  return path.join(DATA_DIR, "jobs", jobId);
}

export function datasetDir(jobId: string) {
  return path.join(jobDir(jobId), "dataset");
}

export function workDir(jobId: string) {
  return path.join(jobDir(jobId), "work");
}

export function outputDir(jobId: string) {
  return path.join(jobDir(jobId), "output");
}

export function chapterDir(jobId: string, index: number) {
  return path.join(datasetDir(jobId), `chapter_${String(index).padStart(3, "0")}`);
}

export function outputVideoPath(jobId: string, filename = "master_recap.mp4") {
  return path.join(outputDir(jobId), filename);
}

export async function ensureDir(p: string) {
  await fs.mkdir(p, { recursive: true });
}

export async function fileExists(p: string) {
  try {
    await fs.access(p);
    return true;
  } catch {
    return false;
  }
}

/** Path to the Python pipeline script. */
export const PIPELINE_SCRIPT = path.join(process.cwd(), "pipeline", "master_pipeline.py");

/** Path to the Python interpreter. */
export const PYTHON_BIN = process.env.PYTHON_BIN || "python3";

export const PIPELINE_SERVICE_PORT = 3001;
