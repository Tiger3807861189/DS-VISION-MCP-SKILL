import crypto from "node:crypto";
import path from "node:path";
import {
  COORDINATE_STATUSES,
  DEFAULTS,
  EVIDENCE_MODES,
  EVIDENCE_STATES,
  STAGES,
  VIDEO_SAMPLING,
} from "./constants.mjs";

export function stableId(prefix, seed = crypto.randomUUID()) {
  const digest = crypto.createHash("sha256").update(String(seed)).digest("hex").slice(0, 16);
  return prefix + "_" + digest;
}

export function sha256(value) {
  return crypto.createHash("sha256").update(value).digest("hex");
}

export function assertEnum(value, allowed, field) {
  if (!allowed.has(value)) {
    throw new Error(field + " must be one of: " + [...allowed].join(", "));
  }
  return value;
}

export function assertNonEmptyString(value, field) {
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(field + " must be a non-empty string");
  }
  return value.trim();
}

export function normalizeInputs(inputs) {
  const list = Array.isArray(inputs) ? inputs : [inputs];
  if (!list.length || list.some((item) => typeof item !== "string" || !item.trim())) {
    throw new Error("inputs must contain at least one non-empty string");
  }
  if (list.some((item) => /^https?:\/\//i.test(item.trim()))) {
    throw new Error("REMOTE_URL_INPUT_UNSUPPORTED");
  }
  return list.map((item, index) => ({
    media_id: "media_" + String(index + 1).padStart(3, "0"),
    source: item.trim(),
    name: item.startsWith("data:") ? "inline-" + (index + 1) : path.basename(item),
  }));
}

export function validateVisionRequest(request) {
  const input = request || {};
  const stage = input.stage || "auto";
  const evidenceMode = input.evidence_mode || "auto";
  const rounds = input.rounds || "auto";
  assertEnum(stage, STAGES, "stage");
  assertEnum(evidenceMode, EVIDENCE_MODES, "evidence_mode");
  if (![1, 2, "auto"].includes(rounds)) {
    throw new Error("rounds must be 1, 2, or auto");
  }
  if (input.claims != null && !Array.isArray(input.claims)) {
    throw new Error("claims must be an array when provided");
  }
  const inputs = normalizeInputs(input.inputs);
  if (inputs.length > DEFAULTS.maxImagesPerMessage) {
    throw new Error("inputs must contain at most " + DEFAULTS.maxImagesPerMessage + " items");
  }
  return {
    inputs,
    objective: assertNonEmptyString(input.objective, "objective"),
    stage,
    evidence_mode: evidenceMode,
    session: input.session || "auto",
    rounds,
    language: input.language === "en" ? "en" : "zh",
    detail: input.detail === "full" ? "full" : "concise",
    claims: input.claims == null ? [] : input.claims,
  };
}

export function validateVideoRequest(request) {
  const input = request || {};
  const sampling = input.sampling || "auto";
  assertEnum(sampling, VIDEO_SAMPLING, "sampling");
  const sourceInputs = input.input || input.inputs;
  const base = sourceInputs ? validateVisionRequest({
    inputs: sourceInputs,
    objective: input.objective,
    stage: input.mode === "track" ? "trace" : (input.mode || "overview"),
    evidence_mode: input.evidence_mode || "auto",
    session: input.session,
    rounds: input.rounds,
    language: input.language,
    detail: input.detail,
    claims: input.claims,
  }) : {
    inputs: [],
    objective: assertNonEmptyString(input.objective, "objective"),
    stage: input.mode === "track" ? "trace" : (input.mode || "overview"),
    evidence_mode: input.evidence_mode || "auto",
    session: input.session || "auto",
    rounds: input.rounds || "auto",
    language: input.language === "en" ? "en" : "zh",
    detail: input.detail === "full" ? "full" : "concise",
    claims: input.claims == null ? [] : input.claims,
  };
  assertEnum(base.stage, STAGES, "stage");
  assertEnum(base.evidence_mode, EVIDENCE_MODES, "evidence_mode");
  if (![1, 2, "auto"].includes(base.rounds)) throw new Error("rounds must be 1, 2, or auto");
  if (!Array.isArray(base.claims)) throw new Error("claims must be an array when provided");
  return {
    ...base,
    sampling,
    segment: normalizeSegment(input.segment),
    max_frames_per_batch: normalizeMaxFrames(input.max_frames_per_batch),
  };
}

function normalizeSegment(value) {
  if (value == null) return null;
  if (typeof value !== "object") throw new Error("segment must be an object");
  const start = Number(value.start_ms);
  const end = Number(value.end_ms);
  if (!Number.isFinite(start) || !Number.isFinite(end) || start < 0 || end <= start) {
    throw new Error("segment requires 0 <= start_ms < end_ms");
  }
  return { start_ms: Math.round(start), end_ms: Math.round(end) };
}

function normalizeMaxFrames(value) {
  if (value == null) return 50;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > 50) {
    throw new Error("max_frames_per_batch must be an integer from 1 to 50");
  }
  return parsed;
}

export function validateClaim(claim) {
  const item = claim || {};
  assertNonEmptyString(item.claim_id, "claim_id");
  assertNonEmptyString(item.statement, "statement");
  assertEnum(item.evidence_state, EVIDENCE_STATES, "evidence_state");
  const coordinateStatus = item.coordinate_status || "none";
  assertEnum(coordinateStatus, COORDINATE_STATUSES, "coordinate_status");
  if (coordinateStatus === "measurable_anchor") {
    assertMeasurableAnchor(item);
  }
  if (coordinateStatus === "image_candidate" && !["image_normalized_0_999", "source_image_pixels"].includes(item.coordinate_basis)) {
    throw new Error("image_candidate requires image_normalized_0_999 or source_image_pixels basis");
  }
  return { ...item, coordinate_status: coordinateStatus };
}

function assertMeasurableAnchor(item) {
  if (!item.coordinate_basis || !item.unit || !item.media_id) {
    throw new Error("measurable_anchor requires coordinate_basis, unit, and media_id");
  }
  if (!Array.isArray(item.coordinate) || ![2, 4].includes(item.coordinate.length) || item.coordinate.some((value) => !Number.isFinite(Number(value)))) {
    throw new Error("measurable_anchor requires numeric coordinate values");
  }
  const chain = item.coordinate_chain;
  if (!chain || typeof chain !== "object") throw new Error("measurable_anchor requires coordinate_chain");
  const source = chain.source_image;
  const coordinateImage = chain.coordinate_image;
  const render = chain.render;
  const viewport = chain.viewport;
  const page = chain.page;
  const target = chain.target_geometry;
  if (!positiveSize(source?.width, source?.height) || !positiveSize(coordinateImage?.width, coordinateImage?.height)) {
    throw new Error("coordinate_chain requires source_image and coordinate_image dimensions");
  }
  if (!finiteRect(coordinateImage?.crop_from_source) || !finiteRect(render?.source_rect) || !positiveSize(render?.css_width, render?.css_height) || !Number.isFinite(render?.device_pixel_ratio) || render.device_pixel_ratio <= 0) {
    throw new Error("coordinate_chain requires crop, rendered source rect, CSS size, and DPR");
  }
  if (!rectWithin(coordinateImage.crop_from_source, source) || !rectWithin(render.source_rect, source)) {
    throw new Error("coordinate_chain crop and render source rect must stay within source_image");
  }
  if (!Number.isFinite(viewport?.x_css) || !Number.isFinite(viewport?.y_css) || !Number.isFinite(page?.scroll_x_css) || !Number.isFinite(page?.scroll_y_css) || !target?.manifest_id || !target?.space) {
    throw new Error("coordinate_chain requires viewport, page scroll, and target geometry manifest");
  }
  if (item.media_id !== chain.media_id) throw new Error("measurable_anchor media_id must match coordinate_chain.media_id");
  if (item.coordinate_basis !== "page_css_pixels" || target.space !== item.coordinate_basis) {
    throw new Error("measurable_anchor requires page_css_pixels target geometry in the current coordinate chain");
  }
}

function positiveSize(width, height) {
  return Number.isFinite(width) && width > 0 && Number.isFinite(height) && height > 0;
}

function finiteRect(rect) {
  return rect && Number.isFinite(rect.x) && Number.isFinite(rect.y) && positiveSize(rect.width, rect.height);
}

function rectWithin(rect, bounds) {
  return rect.x >= 0 && rect.y >= 0 && rect.x + rect.width <= bounds.width && rect.y + rect.height <= bounds.height;
}
