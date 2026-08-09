#!/usr/bin/env node
// Simple: open LOTR movie, capture 25 frames, save manifest
import { chromium } from "playwright";
import path from "node:path";
import fs from "node:fs";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SKILL_DIR = path.join(__dirname, "..");
const DATA_DIR = path.join(SKILL_DIR, ".ds-vision");
const LOTR_DIR = path.join(DATA_DIR, "lotr-frames");
fs.mkdirSync(LOTR_DIR, { recursive: true });

console.log("Opening LOTR movie...");

const context = await chromium.launchPersistentContext(
  path.join(DATA_DIR, "lotr-profile"),
  { headless: false, viewport: { width: 1280, height: 720 } }
);

const page = context.pages()[0] || await context.newPage();
await page.goto("https://karpathy.ai/lotr-movie/", { waitUntil: "domcontentloaded" });
await page.waitForSelector("canvas", { timeout: 10000 });

console.log("Capturing 25 frames at 600ms intervals...");
console.log("(Click play if the movie hasn't started)");

const TOTAL = 25;
const INTERVAL = 600; // ms
const frames = [];

for (let i = 0; i < TOTAL; i++) {
  if (i > 0) await page.waitForTimeout(INTERVAL);
  const fn = `lotr-frame-${String(i).padStart(3, "0")}.png`;
  const fp = path.join(LOTR_DIR, fn);
  await page.screenshot({ path: fp, fullPage: false });
  const sz = fs.statSync(fp).size;
  const pts = i * (INTERVAL / 1000);
  // NOTE: pts here is the capture schedule timestamp, not the video's actual playback PTS.
  // If the video playback lags or hasn't started, PTS values will not match real frame times.
  // For production use, extract frames with a tool that records actual PTS (e.g., ffmpeg).
  frames.push({ media_id: `lotr-f${i}`, frame_index: i, capture_pts_seconds: pts, source: fp });
  console.log(`Frame ${i}: ${fn} (${sz}B, pts=${pts}s)`);
}

fs.writeFileSync(path.join(LOTR_DIR, "frame-manifest.json"), JSON.stringify(frames, null, 2));
await context.close();

// Summary
const sizes = [...new Set(frames.map(f => fs.statSync(f.source).size))];
console.log(`\nDone. ${TOTAL} frames. Unique sizes: ${sizes.length}`);
console.log(`Manifest: ${path.join(LOTR_DIR, "frame-manifest.json")}`);
