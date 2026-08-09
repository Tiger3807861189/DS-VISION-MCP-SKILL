#!/usr/bin/env node
// Direct E2E test runner (engine-level, bypass MCP protocol)
import path from "node:path";
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import { DsVisionEngine } from "./engine.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SKILL_DIR = path.join(__dirname, "..");
const DATA_DIR = process.env.DS_VISION_DATA_DIR || path.join(SKILL_DIR, ".ds-vision");
const TEST_MEDIA = path.join(DATA_DIR, "test-media");

fs.mkdirSync(DATA_DIR, { recursive: true });

const engine = new DsVisionEngine({ dataDirectory: DATA_DIR });
let failures = 0;

function fail(name, err) {
  failures++;
  console.log(`FAIL ${name}: ${err.message}`);
}

async function run() {
  const args = process.argv.slice(2);
  const testName = args[0] || "all";

  console.log("=".repeat(60));
  console.log("DS-VISION V3 Direct E2E Tests");
  console.log("Data dir:", DATA_DIR);
  console.log("=".repeat(60));

  if (testName === "all" || testName === "calibrate") {
    console.log("\n--- calibrate ---");
    try {
      const r = await engine.handle({ action: "calibrate" });
      console.log("✓ calibrate passed");
      console.log(`  Composer: ${r.calibration.selectors.composer ? "found" : "MISSING"}`);
      console.log(`  Vision: ${r.calibration.selectors.vision ? "found" : "MISSING"}`);
      console.log(`  DeepThink: ${r.calibration.selectors.deep_think ? "found" : "MISSING"}`);
      console.log(`  Upload: ${r.calibration.selectors.upload ? "found" : "MISSING"}`);
    } catch (err) { fail("calibrate", err); }
  }

  if (testName === "all" || testName === "analyze-single") {
    console.log("\n--- analyze (single round) ---");
    const img = path.join(TEST_MEDIA, "test-card-1.png");
    try {
      console.log(`  Input: ${img}, exists: ${fs.existsSync(img)}`);
      const r = await engine.handle({
        action: "analyze",
        inputs: [img],
        objective: "Describe all visible colors and shapes in this generated test card image.",
        rounds: 1,
        language: "en",
        detail: "concise",
      });
      console.log("✓ analyze-single passed");
      console.log(`  Rounds: ${r.rounds.length}`);
      console.log(`  Verification: ${r.verification_mode}`);
      console.log(`  Final text length: ${r.final_text?.length || 0}`);
      console.log(`  Final text preview: ${(r.final_text || "").slice(0, 150)}...`);
      console.log(`  Evidence packet hash: ${r.evidence_packet?.final_text_hash?.slice(0, 16)}...`);
    } catch (err) { fail("analyze-single", err); }
  }

  if (testName === "all" || testName === "analyze-ab") {
    console.log("\n--- analyze (A/B + arbitration) ---");
    const img = path.join(TEST_MEDIA, "test-card-2.png");
    try {
      console.log(`  Input: ${img}, exists: ${fs.existsSync(img)}`);
      const r = await engine.handle({
        action: "analyze",
        inputs: [img],
        objective: "Describe the UI layout, all visible elements, and colors in this generated UI mockup image.",
        rounds: "auto",
        language: "en",
        detail: "concise",
      });
      console.log("✓ analyze-ab passed");
      console.log(`  Rounds: ${r.rounds.length}`);
      console.log(`  Verification: ${r.verification_mode}`);
      console.log(`  Consensus total: ${r.consensus?.total_rounds}`);
      console.log(`  Confirmed: ${r.consensus?.confirmed?.length || 0}`);
      console.log(`  Final text length: ${r.final_text?.length || 0}`);
      if (r.rounds) {
        r.rounds.forEach((rd, i) => {
          console.log(`  Round ${i + 1}: arb=${rd.is_arbitration}, claims=${rd.claims?.length || 0}, text=${(rd.final_text || "").slice(0, 80)}...`);
        });
      }
    } catch (err) { fail("analyze-ab", err); }
  }

  if (testName === "all" || testName === "compare") {
    console.log("\n--- compare (2 images) ---");
    const img1 = path.join(TEST_MEDIA, "test-card-1.png");
    const img2 = path.join(TEST_MEDIA, "test-card-2.png");
    try {
      const r = await engine.handle({
        action: "compare",
        inputs: [img1, img2],
        objective: "Compare these two images and identify all differences.",
        rounds: 1,
        language: "en",
        detail: "concise",
      });
      console.log("✓ compare passed");
      console.log(`  Rounds: ${r.rounds.length}`);
      console.log(`  Final text length: ${r.final_text?.length || 0}`);
    } catch (err) { fail("compare", err); }
  }

  if (testName === "all" || testName === "video-manifest") {
    console.log("\n--- video manifest ---");
    try {
      const r = await engine.handle({
        action: "video",
        objective: "Check static elements in video",
        duration_ms: 3000,
        sampling: "1s",
      });
      console.log("✓ video-manifest passed");
      console.log(`  Status: ${r.status}`);
      console.log(`  Sampling interval: ${r.sampling_interval_ms}ms`);
      console.log(`  Target PTS count: ${r.target_capture_pts_seconds?.length}`);
    } catch (err) { fail("video-manifest", err); }
  }

  if (testName === "all" || testName === "video-execute") {
    console.log("\n--- video execute ---");
    const frames = [
      { media_id: "f0", frame_index: 0, capture_pts_seconds: 0, source: path.join(TEST_MEDIA, "test-card-1.png") },
      { media_id: "f1", frame_index: 1, capture_pts_seconds: 1, source: path.join(TEST_MEDIA, "test-card-2.png") },
      { media_id: "f2", frame_index: 2, capture_pts_seconds: 2, source: path.join(TEST_MEDIA, "test-card-3.png") },
    ];
    try {
      const r = await engine.handle({
        action: "video",
        objective: "Check static visible elements per frame",
        execute: true,
        rounds: 1,
        frame_manifest: { media_id: "test-video", duration_ms: 2000, sampling: "1s", frames },
      });
      console.log("✓ video-execute passed");
      console.log(`  Status: ${r.status}`);
      console.log(`  Batches: ${r.batches?.length || 0}`);
      if (r.batches?.[0]) {
        console.log(`  Batch 0 rounds: ${r.batches[0].result?.rounds?.length}`);
        console.log(`  Verification: ${r.batches[0].result?.verification_mode}`);
      }
    } catch (err) { fail("video-execute", err); }
  }

  if (testName === "all" || testName === "sessions") {
    console.log("\n--- sessions ---");
    try {
      const list = await engine.handle({ action: "sessions", operation: "list" });
      console.log("✓ sessions list passed");
      console.log(`  Sessions: ${list.sessions?.length || 0}`);
    } catch (err) { fail("sessions", err); }
  }

  console.log("\n" + "=".repeat(60));
  console.log(`E2E tests done. Failures: ${failures}`);
  console.log("=".repeat(60));
}

run().catch((err) => {
  console.error("E2E direct runner failed:", err.message);
  process.exit(1);
}).then(() => {
  if (failures > 0) process.exit(1);
});
