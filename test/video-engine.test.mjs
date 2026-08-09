import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { DsVisionEngine } from "../scripts/engine.mjs";
import { buildFrameManifest, planOverviewWindows, refineInterval } from "../scripts/video.mjs";

test("video planner selects actual PTS frames and retains discrete boundary", () => {
  const manifest = buildFrameManifest({
    media_id: "video_1", source_hash: "abc", duration_ms: 3000, sampling: "1s",
    frames: [
      { media_id: "f0", frame_index: 0, capture_pts_seconds: 0, source: "f0.png" },
      { media_id: "f1", frame_index: 1, capture_pts_seconds: 1.02, source: "f1.png" },
      { media_id: "f2", frame_index: 2, capture_pts_seconds: 2.04, source: "f2.png" },
      { media_id: "f3", frame_index: 3, capture_pts_seconds: 3.0, source: "f3.png" },
    ],
  });
  const plan = planOverviewWindows(manifest, { sampling: "1s", max_frames_per_batch: 2 });
  assert.equal(plan.windows.length, 2);
  assert.match(plan.boundary, /listed PTS observations/);
  assert.deepEqual(refineInterval(manifest, { start_frame_index: 1, end_frame_index: 2, reason: "small target" }).start_pts_seconds, 1.02);
});

test("video selection and batches remain in ascending actual PTS order", () => {
  const manifest = buildFrameManifest({
    media_id: "video_2", source_hash: "def", duration_ms: 2000, sampling: "1s",
    frames: [
      { media_id: "late-index", frame_index: 99, capture_pts_seconds: 0, source: "a.png" },
      { media_id: "early-index", frame_index: 1, capture_pts_seconds: 1, source: "b.png" },
      { media_id: "middle-index", frame_index: 2, capture_pts_seconds: 2, source: "c.png" },
    ],
  });
  const plan = planOverviewWindows(manifest, { sampling: "1s" });
  assert.deepEqual(plan.windows[0].frames.map((frame) => frame.capture_pts_seconds), [0, 1, 2]);
  assert.throws(() => buildFrameManifest({ media_id: "empty", frames: [] }), /at least one frame/);
  assert.throws(() => buildFrameManifest({ media_id: "duplicate", frames: [{ media_id: "a", frame_index: 1, capture_pts_seconds: 0, source: "a.png" }, { media_id: "b", frame_index: 1, capture_pts_seconds: 1, source: "b.png" }] }), /frame_index values must be unique/);
  assert.throws(() => buildFrameManifest({ media_id: "missing-source", frames: [{ media_id: "a", frame_index: 1, capture_pts_seconds: 0 }] }), /media_id, and source/);
  assert.throws(() => buildFrameManifest({ media_id: "outside", duration_ms: 100, frames: [{ media_id: "a", frame_index: 1, capture_pts_seconds: 1, source: "a.png" }] }), /within duration_ms/);
});

test("video planning retains all 10, 25, and 50 supplied PTS frames within controlled batches", () => {
  for (const count of [10, 25, 50]) {
    const manifest = buildFrameManifest({
      media_id: "scale-" + count,
      duration_ms: (count - 1) * 1000,
      sampling: "1s",
      frames: Array.from({ length: count }, (_, index) => ({
        media_id: "f" + index,
        frame_index: index,
        capture_pts_seconds: index,
        source: "f" + index + ".png",
      })),
    });
    const plan = planOverviewWindows(manifest, { sampling: "1s", max_frames_per_batch: 10 });
    assert.equal(plan.windows.flatMap((window) => window.frames).length, count);
    assert.ok(plan.windows.every((window) => window.frames.length <= 10));
    assert.deepEqual(plan.windows.flatMap((window) => window.frames).map((frame) => frame.capture_pts_seconds), Array.from({ length: count }, (_, index) => index));
  }
});

test("engine health and coordinate map work without opening a browser", async () => {
  const temporary = await fs.mkdtemp(path.join(os.tmpdir(), "ds-vision-test-"));
  try {
    const engine = new DsVisionEngine({ dataDirectory: temporary });
    const health = await engine.handle({ action: "health" });
    assert.equal(health.requested_host_alias, "/DS-VISION");
    const mapped = await engine.handle({ action: "map", operation: "normalized_to_source", box: [0, 0, 999, 999], source_width: 10, source_height: 20 });
    assert.deepEqual(mapped.source_pixel_projection.value, [0, 0, 10, 20]);
    const coordinate_chain = {
      media_id: "media_001",
      source_image: { width: 100, height: 100 },
      coordinate_image: { width: 100, height: 100, crop_from_source: { x: 0, y: 0, width: 100, height: 100 } },
      render: { source_rect: { x: 0, y: 0, width: 100, height: 100 }, css_width: 50, css_height: 50, device_pixel_ratio: 2 },
      viewport: { x_css: 5, y_css: 6 },
      page: { scroll_x_css: 7, scroll_y_css: 8 },
      target_geometry: { manifest_id: "geometry", space: "page_css_pixels" },
    };
    const anchor = await engine.handle({ action: "map", operation: "normalized_to_measurable_anchor", box: [0, 0, 999, 999], coordinate_chain });
    const candidates = await engine.handle({
      action: "map", operation: "anchor_to_geometry_candidates", anchor,
      geometry_manifest: { manifest_id: "geometry", targets: [{ target_id: "target", space: "page_css_pixels", rect: anchor.coordinate }] },
    });
    assert.equal(candidates.candidates[0].target_id, "target");
    await assert.rejects(
      () => engine.handle({ action: "map", operation: "anchor_to_geometry_candidates", anchor, geometry_manifest: { manifest_id: "other", targets: [] } }),
      /GEOMETRY_MANIFEST_ID_MISMATCH/,
    );
    await assert.rejects(
      () => engine.handle({ action: "map", operation: "anchor_to_geometry_candidates", anchor: { ...anchor, media_id: "other-media" }, geometry_manifest: { manifest_id: "geometry", targets: [] } }),
      /media_id must match/,
    );
    await assert.rejects(
      () => engine.handle({ action: "map", operation: "anchor_to_geometry_candidates", anchor, target_space: "svg_user_space", geometry_manifest: { manifest_id: "geometry", targets: [] } }),
      /GEOMETRY_TARGET_SPACE_MISMATCH/,
    );
  } finally {
    await fs.rm(temporary, { recursive: true, force: true });
  }
});
