import assert from "node:assert/strict";
import test from "node:test";
import { mapToGeometry, normalizedBoxToPixels, normalizedToMeasurableAnchor, sourcePixelsToViewport, viewportToPage } from "../scripts/coordinates.mjs";
import { buildConsensus, compareClaims, extractArbitrationDecisions, extractClaimsFromVisibleText, makeEvidencePacket, validateStaticVideoArbitration, validateStaticVideoClaims, validateStaticVideoLedger } from "../scripts/evidence.mjs";

test("evidence packet extracts normalized primitives and warns for dynamic discrete-frame language", () => {
  const packet = makeEvidencePacket({
    task_id: "t", session_id: "s", round_id: "r", prompt_hash: "p",
    final_text: "对象正在移动 [[1,2,30,40]]，点 [[9,8]]",
    videoDiscrete: true,
  });
  assert.equal(packet.visual_primitives.boxes.length, 1);
  assert.equal(packet.visual_primitives.points.length, 1);
  assert.equal(packet.warnings[0].code, "VIDEO_CONTINUITY_LANGUAGE");
});

test("coordinate mapping preserves explicit spaces without source-code inference", () => {
  const source = normalizedBoxToPixels([0, 0, 999, 999], 1200, 800);
  assert.deepEqual(source.source_pixel_projection.value, [0, 0, 1200, 800]);
  const viewport = sourcePixelsToViewport(source.source_pixel_projection.value, {
    source_width: 1200, source_height: 800, render_width_css: 600, render_height_css: 400, viewport_x_css: 10, viewport_y_css: 20,
  });
  const page = viewportToPage(viewport.value, { scroll_x_css: 50, scroll_y_css: 60 });
  const mapped = mapToGeometry(page.value, { targets: [{ target_id: "candidate", space: "page_css", rect: page.value }] });
  assert.equal(mapped.status, "candidate_mapping");
  assert.match(mapped.note, /not source-code locations/);
});

test("complete named coordinate chain is required for measurable anchors", () => {
  assert.throws(() => normalizedToMeasurableAnchor([0, 0, 999, 999], { media_id: "m" }), /complete coordinate chain/);
  const chain = {
    media_id: "m", source_image: { width: 1200, height: 800 },
    coordinate_image: { width: 1200, height: 800, crop_from_source: { x: 0, y: 0, width: 1200, height: 800 } },
    render: { source_rect: { x: 0, y: 0, width: 1200, height: 800 }, css_width: 600, css_height: 400, device_pixel_ratio: 2 },
    viewport: { x_css: 10, y_css: 20 }, page: { scroll_x_css: 30, scroll_y_css: 40 },
    target_geometry: { manifest_id: "geometry-1", space: "page_css_pixels" },
  };
  const anchor = normalizedToMeasurableAnchor([0, 0, 999, 999], chain);
  assert.equal(anchor.coordinate_status, "measurable_anchor");
  assert.deepEqual(anchor.value, [40, 60, 640, 460]);
  assert.deepEqual(anchor.coordinate, anchor.value);
  assert.throws(() => normalizedToMeasurableAnchor([0, 0, 999, 999], { ...chain, render: { ...chain.render, source_rect: { x: -1, y: 0, width: 1200, height: 800 } } }), /must stay within source image/);
});

test("video claims preserve and verify per-line media, frame, and PTS anchors", () => {
  const media = [
    { media_id: "f1", frame_index: 1, capture_pts_seconds: 0, name: "f1.png" },
    { media_id: "f2", frame_index: 2, capture_pts_seconds: 1, name: "f2.png" },
  ];
  const claims = extractClaimsFromVisibleText(
    "frame=1|pts=0|atoms=[COLOR=blue;SHAPE=square]\nframe=2|pts=1|atoms=[COLOR=red;SHAPE=square]",
    "r1", media,
  );
  assert.deepEqual(claims.map((claim) => [claim.media_id, claim.frame_index, claim.capture_pts_seconds]), [["f1", 1, 0], ["f2", 2, 1]]);
  assert.doesNotThrow(() => validateStaticVideoClaims(claims, media));
  assert.throws(() => validateStaticVideoClaims([{ ...claims[0], capture_pts_seconds: 0.5 }], media), /VIDEO_LEDGER_MANIFEST_MISMATCH/);
});

test("static video ledger requires only atomic frame records and unknown inter-frame interval", () => {
  const media = [
    { media_id: "f1", frame_index: 1, capture_pts_seconds: 0, name: "f1.png" },
    { media_id: "f2", frame_index: 2, capture_pts_seconds: 1, name: "f2.png" },
  ];
  const valid = [
    "frame=1|pts=0|atoms=[COLOR=blue;SHAPE=square;POSITION=left]",
    "frame=2|pts=1|atoms=[COLOR=red;SHAPE=square;POSITION=right]",
    "endpoint=[A(frame=1,pts=0,atoms=COLOR=blue;SHAPE=square;POSITION=left)|B(frame=2,pts=1,atoms=COLOR=red;SHAPE=square;POSITION=right)|unobserved_interval=unknown]",
    "coordinate_status=none",
    "refine_interval=none",
  ].join("\n");
  assert.doesNotThrow(() => validateStaticVideoLedger(valid, media));
  assert.throws(() => validateStaticVideoLedger(valid.replace("COLOR=blue", "OBJECT=explosion occurred"), media), /VIDEO_STATIC_ATOMS_ONLY/);
  assert.throws(() => validateStaticVideoLedger(valid.replace("unobserved_interval=unknown", "unobserved_interval=continuous"), media), /VIDEO_STATIC_LEDGER_SCHEMA_REQUIRED/);
  assert.throws(() => validateStaticVideoLedger(valid.replace("B(frame=2,pts=1,atoms=COLOR=red", "B(frame=2,pts=1,atoms=COLOR=blue"), media), /VIDEO_STATIC_LEDGER_SCHEMA_REQUIRED/);

  const literal = [
    "frame=1|pts=0|atoms=[TEXT=x\\=1\\;\\[Error\\]\\(A\\);COLOR=blue]",
    "frame=2|pts=1|atoms=[TEXT=中英文\\[OK\\];COLOR=red]",
    "endpoint=[A(frame=1,pts=0,atoms=TEXT=x\\=1\\;\\[Error\\]\\(A\\);COLOR=blue)|B(frame=2,pts=1,atoms=TEXT=中英文\\[OK\\];COLOR=red)|unobserved_interval=unknown]",
    "coordinate_status=none",
    "refine_interval=none",
  ].join("\n");
  assert.doesNotThrow(() => validateStaticVideoLedger(literal, media));
  assert.equal(extractClaimsFromVisibleText(literal, "r", media)[0].statement, "TEXT=x=1;[Error](A); COLOR=blue");
});

test("static video arbitration requires one decision for every candidate", () => {
  const candidates = Array.from({ length: 26 }, (_, index) => ({ candidate_id: "C" + (index + 1), claim_id: "claim-" + index }));
  const decisions = candidates.map((candidate, index) => "decision=" + candidate.candidate_id + ":" + (index % 2 ? "unknown" : "confirmed")).join("\n");
  assert.doesNotThrow(() => validateStaticVideoArbitration(decisions, candidates));
  assert.throws(() => validateStaticVideoArbitration("decision=C1:confirmed", candidates), /VIDEO_STATIC_ARBITRATION_REQUIRED/);
  assert.throws(() => validateStaticVideoArbitration("C1: confirmed visible_fact", candidates), /VIDEO_STATIC_ARBITRATION_REQUIRED/);
});

test("unknown and rejected arbitration decisions cannot create confirmed consensus", () => {
  const rounds = [
    { round_id: "r1", claims: [{ claim_id: "a", statement: "blue marker", evidence_state: "visible_fact" }] },
    { round_id: "r2", claims: [{ claim_id: "b", statement: "blue marker", evidence_state: "unknown" }] },
  ];
  const comparison = compareClaims(rounds);
  const unknown = buildConsensus(rounds, comparison, []);
  assert.equal(unknown.claims[0].status, "unresolved");
  const rejected = buildConsensus(rounds, comparison, [{ candidate_id: "C1", claim_id: "a", decision: "rejected", source_round_id: "r3" }]);
  assert.equal(rejected.claims[0].status, "rejected");
  assert.deepEqual(extractArbitrationDecisions("C1: confirmed visible_fact: blue marker", [{ candidate_id: "C1", claim_id: "a" }], "r3")[0].decision, "confirmed");
});
