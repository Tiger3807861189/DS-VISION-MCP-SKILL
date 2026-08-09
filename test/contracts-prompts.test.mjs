import assert from "node:assert/strict";
import test from "node:test";
import { validateClaim, validateVideoRequest, validateVisionRequest } from "../scripts/contracts.mjs";
import { compileArbitrationPrompt, compileFollowupPrompt, compilePrompt } from "../scripts/prompts.mjs";

test("vision request retains optional explicit claims and validates controlled fields", () => {
  const request = validateVisionRequest({
    inputs: ["C:/work/a.png"],
    objective: "检查可见布局",
    stage: "inspect",
    evidence_mode: "text",
    claims: [],
  });
  assert.equal(request.inputs[0].media_id, "media_001");
  assert.equal(request.stage, "inspect");
  assert.deepEqual(request.claims, []);
  assert.equal(validateVisionRequest({ inputs: "C:/work/one.png", objective: "单图" }).inputs.length, 1);
  assert.throws(() => validateVisionRequest({ inputs: "https://example.invalid/a.png", objective: "远程图" }), /REMOTE_URL_INPUT_UNSUPPORTED/);
  assert.throws(() => validateVisionRequest({ inputs: ["a.png"], objective: "x", claims: {} }), /claims must be an array/);
});

test("measurable anchors require a named basis and image candidates use normalized basis", () => {
  assert.throws(() => validateClaim({ claim_id: "c1", statement: "x", evidence_state: "visible_fact", coordinate_status: "measurable_anchor" }), /coordinate_basis/);
  assert.throws(() => validateClaim({ claim_id: "c2", statement: "x", evidence_state: "visible_fact", coordinate_status: "image_candidate", coordinate_basis: "page_css_pixels" }), /image_normalized_0_999/);
  assert.equal(validateClaim({ claim_id: "c3", statement: "x", evidence_state: "image_candidate", coordinate_status: "image_candidate", coordinate_basis: "image_normalized_0_999" }).coordinate_status, "image_candidate");
});

test("prompt compiler keeps visual, coordinate, and discrete-frame boundaries", () => {
  const compiled = compilePrompt({ objective: "逐帧检查视频", stage: "trace", evidence_mode: "trajectory" }, [{ media_id: "f1", name: "f1.png", frame_index: 1, capture_pts_seconds: 0 }], { staticVideoAtoms: true });
  assert.match(compiled.prompt, /不要把静态像素当成 DOM/);
  assert.match(compiled.prompt, /未观察区间写 unknown/);
  assert.match(compiled.prompt, /frame_index=1/);
  assert.match(compileFollowupPrompt("复核文字").toString(), /历史追问/);
  const candidates = Array.from({ length: 26 }, (_, index) => ({ statement: "OBJECT=item" + index, source_round_id: "r" }));
  assert.match(compileArbitrationPrompt(candidates, { staticVideoAtoms: true }), /C26:/);
  assert.doesNotMatch(compileArbitrationPrompt(candidates), /C25:/);
});

test("video request accepts source input and an explicit segment", () => {
  const request = validateVideoRequest({ input: "C:/work/clip.mp4", objective: "静态 ledger", duration_ms: 5000, segment: { start_ms: 100, end_ms: 900 } });
  assert.equal(request.inputs[0].name, "clip.mp4");
  assert.deepEqual(request.segment, { start_ms: 100, end_ms: 900 });
});

test("video planning accepts a manifest-driven request without an original video path", () => {
  const request = validateVideoRequest({ objective: "静态 ledger", frame_manifest: { frames: [] } });
  assert.deepEqual(request.inputs, []);
});
