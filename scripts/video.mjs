import { sha256 } from "./contracts.mjs";

const INTERVAL_MS = Object.freeze({
  "1.5s": 1500,
  "1s": 1000,
  "0.5s": 500,
  "0.2s": 200,
  "0.1s": 100,
});

export function chooseSamplingInterval(durationMs, mode = "auto") {
  if (mode !== "auto") return INTERVAL_MS[mode];
  if (!Number.isFinite(durationMs) || durationMs <= 0) throw new Error("durationMs must be positive");
  return Math.max(1500, Math.ceil(durationMs / 50 / 100) * 100);
}

export function buildFrameManifest(input) {
  const frames = [...(input.frames || [])].map(normalizeFrame).sort((a, b) => a.capture_pts_seconds - b.capture_pts_seconds);
  if (!frames.length) throw new Error("frame manifest requires at least one frame");
  validateMonotonicFrames(frames);
  const indexes = new Set();
  const mediaIds = new Set();
  for (const frame of frames) {
    if (indexes.has(frame.frame_index)) throw new Error("frame_index values must be unique");
    if (mediaIds.has(frame.media_id)) throw new Error("frame media_id values must be unique");
    indexes.add(frame.frame_index);
    mediaIds.add(frame.media_id);
  }
  if (input.duration_ms != null && frames.some((frame) => frame.capture_pts_seconds * 1000 > input.duration_ms)) {
    throw new Error("frame PTS must stay within duration_ms");
  }
  const manifest = {
    schema_version: 1,
    media_id: input.media_id,
    source_hash: input.source_hash,
    source_type: input.source_type || "video",
    duration_ms: input.duration_ms ?? null,
    sampling: input.sampling,
    frames,
  };
  return { ...manifest, manifest_hash: sha256(JSON.stringify(manifest)) };
}

export function selectFramesByTargets(frames, targetMs) {
  const list = [...frames].map(normalizeFrame);
  validateMonotonicFrames(list);
  const selected = new Map();
  for (const target of targetMs) {
    const closest = list.reduce((best, frame) => {
      const distance = Math.abs(frame.capture_pts_seconds * 1000 - target);
      return !best || distance < best.distance ? { frame, distance } : best;
    }, null);
    selected.set(closest.frame.frame_index, closest.frame);
  }
  return [...selected.values()].sort((a, b) => a.capture_pts_seconds - b.capture_pts_seconds);
}

export function planOverviewWindows(manifest, options = {}) {
  const maxFrames = options.max_frames_per_batch || 50;
  if (!Number.isInteger(maxFrames) || maxFrames < 1 || maxFrames > 50) throw new Error("max_frames_per_batch must be 1..50");
  const interval = chooseSamplingInterval(manifest.duration_ms || lastPtsMs(manifest.frames), options.sampling || "auto");
  const start = options.start_ms || 0;
  const end = options.end_ms || manifest.duration_ms || lastPtsMs(manifest.frames);
  if (start < 0 || end < start || (manifest.duration_ms && end > manifest.duration_ms)) {
    throw new Error("video window must stay within the supplied duration");
  }
  const targets = [];
  for (let value = start; value <= end; value += interval) targets.push(value);
  if (targets.at(-1) !== end) targets.push(end);
  const selected = selectFramesByTargets(manifest.frames, targets);
  const windows = [];
  for (let index = 0; index < selected.length; index += maxFrames) {
    windows.push(selected.slice(index, index + maxFrames));
  }
  return {
    sampling_interval_ms: interval,
    windows: windows.map((frames, index) => ({ batch_index: index, frames })),
    boundary: "Frames support only listed PTS observations and explicitly requested intervals.",
  };
}

export function refineInterval(manifest, request) {
  if (!request || !Number.isInteger(request.start_frame_index) || !Number.isInteger(request.end_frame_index)) {
    throw new Error("refine request requires start_frame_index and end_frame_index");
  }
  const start = manifest.frames.find((frame) => frame.frame_index === request.start_frame_index);
  const end = manifest.frames.find((frame) => frame.frame_index === request.end_frame_index);
  if (!start || !end || start.capture_pts_seconds >= end.capture_pts_seconds) {
    throw new Error("refine interval endpoints are invalid");
  }
  return {
    start_frame_index: start.frame_index,
    start_pts_seconds: start.capture_pts_seconds,
    end_frame_index: end.frame_index,
    end_pts_seconds: end.capture_pts_seconds,
    requested_interval_seconds: request.requested_interval_seconds || 0.5,
    reason: String(request.reason || "explicit visual uncertainty"),
  };
}

function normalizeFrame(frame) {
  if (!frame || !Number.isInteger(frame.frame_index) || frame.frame_index < 0 || !Number.isFinite(frame.capture_pts_seconds) || frame.capture_pts_seconds < 0 || !frame.media_id || typeof frame.source !== "string" || !frame.source.trim()) {
    throw new Error("frame requires non-negative frame_index/PTS, media_id, and source");
  }
  return { ...frame };
}

function validateMonotonicFrames(frames) {
  for (let index = 1; index < frames.length; index += 1) {
    if (frames[index - 1].capture_pts_seconds >= frames[index].capture_pts_seconds) {
      throw new Error("frame PTS must be strictly increasing");
    }
  }
}

function lastPtsMs(frames) {
  return frames.at(-1)?.capture_pts_seconds * 1000 || 0;
}
