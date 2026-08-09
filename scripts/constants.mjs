export const EVIDENCE_STATES = new Set([
  "visible_fact",
  "image_candidate",
  "runtime_measurement_required",
  "unknown",
]);

export const COORDINATE_STATUSES = new Set([
  "none",
  "image_candidate",
  "measurable_anchor",
]);

export const STAGES = new Set([
  "auto",
  "overview",
  "inspect",
  "localize",
  "reproduce",
  "verify",
  "trace",
]);

export const EVIDENCE_MODES = new Set([
  "auto",
  "text",
  "boxes",
  "points",
  "trajectory",
  "mixed",
]);

export const VIDEO_SAMPLING = new Set([
  "auto",
  "1.5s",
  "1s",
  "0.5s",
  "0.2s",
  "0.1s",
]);

export const SESSION_STATES = new Set([
  "active",
  "recoverable",
  "stale",
  "missing",
  "closed",
]);

export const RUN_STATES = Object.freeze({
  INIT: "INIT",
  BROWSER_READY: "BROWSER_READY",
  LOGIN_VERIFIED: "LOGIN_VERIFIED",
  VISION_MODE_VERIFIED: "VISION_MODE_VERIFIED",
  DEEP_THINK_VERIFIED: "DEEP_THINK_VERIFIED",
  CONVERSATION_READY: "CONVERSATION_READY",
  UPLOAD_COMPLETE: "UPLOAD_COMPLETE",
  PROMPT_READY: "PROMPT_READY",
  GENERATING: "GENERATING",
  RESPONSE_COMPLETE: "RESPONSE_COMPLETE",
});

export const DEFAULTS = Object.freeze({
  browserUrl: "https://chat.deepseek.com/",
  maxImagesPerMessage: 50,
  responseTimeoutMs: 300000,
  responseStablePolls: 3,
  responsePollMs: 1200,
  profileIdleMs: 300000,
  registryVersion: 1,
});
