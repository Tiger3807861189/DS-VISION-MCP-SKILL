import { sha256, stableId, validateClaim } from "./contracts.mjs";

const BOX_RE = /\[\[\s*(\d{1,4})\s*,\s*(\d{1,4})\s*,\s*(\d{1,4})\s*,\s*(\d{1,4})\s*\]\]/g;
const POINT_RE = /\[\[\s*(\d{1,4})\s*,\s*(\d{1,4})\s*\]\]/g;
const DYNAMIC_VIDEO_RE = /(镜头|平移|推进|轨迹|速度|飞行|持续|同步|转场|动画|发生变化|正在|行走|冒烟|移动|变快|变慢|穿过|经过|导致|因为|moving|moves|moved|travels?|trajectory|speed|accelerat\w*|camera\s+pan\w*|zoom\w*|transition\w*|continues?|between\s+frames?|over\s+time|caused\s+by)/i;
const EVIDENCE_STATE_RE = /\b(visible_fact|image_candidate|runtime_measurement_required|unknown)\b/i;
const STATIC_FRAME_RE = /^frame=(\d+)\|pts=(-?\d+(?:\.\d+)?)\|atoms=\[((?:\\.|[^\]\r\n])+)\]$/;
const STATIC_ENDPOINT_RE = /^endpoint=\[A\(frame=(\d+),pts=(-?\d+(?:\.\d+)?),atoms=((?:\\.|[^()\[\]\r\n])+)\)\|B\(frame=(\d+),pts=(-?\d+(?:\.\d+)?),atoms=((?:\\.|[^()\[\]\r\n])+)\)\|unobserved_interval=unknown\]$/;
const STATIC_ATOM_KEYS = new Set(["TEXT", "COLOR", "SHAPE", "OBJECT", "POSITION"]);
const STATIC_VIDEO_FORBIDDEN_RE = /(冒|喷|飘|行走|正在|仍然|变为|发生|保持|场景|镜头|视角|移动|切换|转场|过程|变化|转换|速度|轨迹|动画|occur(?:red|s|ring)?|happen(?:ed|s|ing)?|explod(?:e|ed|es|ing|ion)|mov(?:e|ed|es|ing)|travel(?:ed|s|ing)?|trajectory|speed|accelerat\w*|camera|transition|zoom|smoke|emission|burn(?:ed|ing)?|spread(?:ing)?|continu(?:e|ed|es|ing))/i;
const STATIC_ARBITRATION_RE = /^decision=(C\d+):(confirmed|rejected|corrected|unknown)$/i;

export function extractNormalizedBoxes(text) {
  const boxes = [];
  for (const match of String(text || "").matchAll(BOX_RE)) {
    const value = match.slice(1).map(Number);
    if (value.every((n) => n >= 0 && n <= 999) && value[0] < value[2] && value[1] < value[3]) {
      boxes.push({ kind: "box", value });
    }
  }
  return boxes;
}

export function extractNormalizedPoints(text) {
  const points = [];
  for (const match of String(text || "").matchAll(POINT_RE)) {
    const value = match.slice(1).map(Number);
    if (value.every((n) => n >= 0 && n <= 999)) points.push({ kind: "point", value });
  }
  return points;
}

export function buildClaim(input) {
  const claim = {
    claim_id: input.claim_id || stableId("claim", [input.statement, input.source_round_id].join("|")),
    statement: input.statement,
    evidence_state: input.evidence_state || "visible_fact",
    evidence_anchor: input.evidence_anchor || null,
    confidence: input.confidence || "medium",
    next_check: input.next_check || null,
    coordinate_status: input.coordinate_status || "none",
    coordinate_basis: input.coordinate_basis || null,
    coordinate: input.coordinate || null,
    media_id: input.media_id || null,
    frame_index: input.frame_index ?? null,
    capture_pts_seconds: input.capture_pts_seconds ?? null,
    source_round_id: input.source_round_id || null,
  };
  return validateClaim(claim);
}

export function makeEvidencePacket(input) {
  const finalText = String(input.final_text || "");
  const claims = (input.claims || []).map(buildClaim);
  const claimedBoxes = claims.filter((claim) => Array.isArray(claim.coordinate) && claim.coordinate.length === 4).map((claim) => ({
    kind: "box", value: claim.coordinate, media_id: claim.media_id, frame_index: claim.frame_index, capture_pts_seconds: claim.capture_pts_seconds,
  }));
  const claimedPoints = claims.filter((claim) => Array.isArray(claim.coordinate) && claim.coordinate.length === 2).map((claim) => ({
    kind: "point", value: claim.coordinate, media_id: claim.media_id, frame_index: claim.frame_index, capture_pts_seconds: claim.capture_pts_seconds,
  }));
  const boxes = claimedBoxes.length ? claimedBoxes : extractNormalizedBoxes(finalText);
  const points = claimedPoints.length ? claimedPoints : extractNormalizedPoints(finalText);
  const packet = {
    schema_version: 1,
    task_id: input.task_id,
    session_id: input.session_id,
    round_id: input.round_id,
    prompt_hash: input.prompt_hash,
    media: input.media || [],
    final_text: finalText,
    final_text_hash: sha256(finalText),
    claims,
    visual_primitives: { boxes, points },
    warnings: [],
  };
  if (input.videoDiscrete && DYNAMIC_VIDEO_RE.test(finalText)) {
    packet.warnings.push({
      code: "VIDEO_CONTINUITY_LANGUAGE",
      message: "Discrete-frame response contains language that may assert an unobserved process.",
    });
  }
  if (input.videoDiscrete && (!/(?:frame_index|frame)=/i.test(finalText) || !/(?:capture_pts_seconds|pts)=/i.test(finalText))) {
    packet.warnings.push({
      code: "VIDEO_STATIC_LEDGER_REQUIRED",
      message: "Discrete-frame response must bind static observations to frame_index and capture_pts_seconds.",
    });
  }
  return packet;
}

export function extractClaimsFromVisibleText(finalText, sourceRoundId, media = []) {
  const defaultMediaId = media.length === 1 ? media[0].media_id : null;
  const lines = String(finalText || "").split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  const claims = [];
  for (const line of lines) {
    const staticFrame = parseStaticFrameLine(line, media);
    if (staticFrame) {
      claims.push(buildClaim({
        statement: staticFrame.atoms.map((atom) => atom.key + "=" + atom.value).join("; "),
        evidence_state: "visible_fact",
        evidence_anchor: "static frame ledger line",
        source_round_id: sourceRoundId,
        media_id: staticFrame.media.media_id,
        frame_index: staticFrame.frame_index,
        capture_pts_seconds: staticFrame.capture_pts_seconds,
        coordinate_status: "none",
      }));
      continue;
    }
    if (/^(endpoint=|coordinate_status=|refine_interval=)/.test(line)) continue;
    const stateMatch = line.match(EVIDENCE_STATE_RE);
    if (!stateMatch) continue;
    const statement = line.replace(EVIDENCE_STATE_RE, "").replace(/^[-*\d.\s:：]+/, "").trim();
    if (!statement) continue;
    const metadata = extractLineMetadata(line, media);
    const box = extractNormalizedBoxes(line)[0]?.value || null;
    const point = !box ? extractNormalizedPoints(line)[0]?.value || null : null;
    claims.push(buildClaim({
      statement,
      evidence_state: stateMatch[1].toLowerCase(),
      evidence_anchor: "visible final response line",
      source_round_id: sourceRoundId,
      media_id: metadata.media_id || defaultMediaId,
      frame_index: metadata.frame_index,
      capture_pts_seconds: metadata.capture_pts_seconds,
      coordinate_status: box || point ? "image_candidate" : "none",
      coordinate_basis: box || point ? "image_normalized_0_999" : null,
      coordinate: box || point,
    }));
  }
  return claims;
}

export function validateStaticVideoClaims(claims, media) {
  if (!claims.length) throw new Error("VIDEO_STATIC_LEDGER_REQUIRED");
  const frames = new Map(media.map((item) => [item.media_id, item]));
  for (const claim of claims) {
    const frame = frames.get(claim.media_id);
    if (!frame || !Number.isInteger(claim.frame_index) || !Number.isFinite(claim.capture_pts_seconds)) {
      throw new Error("VIDEO_STATIC_LEDGER_REQUIRED");
    }
    if (frame.frame_index !== claim.frame_index || Math.abs(frame.capture_pts_seconds - claim.capture_pts_seconds) > 0.000001) {
      throw new Error("VIDEO_LEDGER_MANIFEST_MISMATCH");
    }
  }
}

export function validateStaticVideoLedger(finalText, media) {
  const expectedFrames = Array.isArray(media) ? media : [];
  if (!expectedFrames.length) throw new Error("VIDEO_STATIC_LEDGER_REQUIRED");
  const expectedByKey = new Map(expectedFrames.map((frame) => [frameKey(frame.frame_index, frame.capture_pts_seconds), frame]));
  if (expectedByKey.size !== expectedFrames.length) throw new Error("VIDEO_LEDGER_MANIFEST_MISMATCH");

  const lines = String(finalText || "").split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  const records = [];
  let endpoint = null;
  let coordinateStatusCount = 0;
  let refineIntervalCount = 0;
  for (const line of lines) {
    const parsed = parseStaticFrameLine(line, expectedFrames);
    if (parsed) {
      const key = frameKey(parsed.frame_index, parsed.capture_pts_seconds);
      if (!expectedByKey.has(key) || records.some((record) => record.key === key)) throw new Error("VIDEO_LEDGER_MANIFEST_MISMATCH");
      records.push({ ...parsed, key });
      continue;
    }
    const endpointMatch = STATIC_ENDPOINT_RE.exec(line);
    if (endpointMatch) {
      if (endpoint) throw new Error("VIDEO_STATIC_LEDGER_SCHEMA_REQUIRED");
      endpoint = {
        a: endpointRecord(endpointMatch[1], endpointMatch[2], endpointMatch[3]),
        b: endpointRecord(endpointMatch[4], endpointMatch[5], endpointMatch[6]),
      };
      continue;
    }
    if (line === "coordinate_status=none") {
      coordinateStatusCount += 1;
      continue;
    }
    if (line === "refine_interval=none") {
      refineIntervalCount += 1;
      continue;
    }
    throw new Error("VIDEO_STATIC_LEDGER_SCHEMA_REQUIRED");
  }
  if (records.length !== expectedFrames.length) throw new Error("VIDEO_STATIC_LEDGER_REQUIRED");
  if (!endpoint || coordinateStatusCount !== 1 || refineIntervalCount !== 1) throw new Error("VIDEO_STATIC_LEDGER_REQUIRED");
  validateEndpoint(endpoint, records, expectedByKey);
  return records;
}

export function validateStaticVideoArbitration(finalText, candidates) {
  const expected = Array.isArray(candidates) ? candidates : [];
  if (!expected.length) throw new Error("VIDEO_STATIC_ARBITRATION_REQUIRED");
  const known = new Map(expected.map((candidate) => [candidate.candidate_id.toLowerCase(), candidate]));
  const decisions = [];
  for (const line of String(finalText || "").split(/\r?\n/).map((item) => item.trim()).filter(Boolean)) {
    const match = STATIC_ARBITRATION_RE.exec(line);
    if (!match) throw new Error("VIDEO_STATIC_ARBITRATION_REQUIRED");
    const candidate = known.get(match[1].toLowerCase());
    if (!candidate || decisions.some((item) => item.candidate_id === candidate.candidate_id)) {
      throw new Error("VIDEO_STATIC_ARBITRATION_REQUIRED");
    }
    decisions.push({ candidate_id: candidate.candidate_id, claim_id: candidate.claim_id, decision: match[2].toLowerCase() });
  }
  if (decisions.length !== expected.length) throw new Error("VIDEO_STATIC_ARBITRATION_REQUIRED");
  return decisions;
}

export function extractArbitrationDecisions(finalText, candidates, sourceRoundId) {
  const decisions = [];
  const lines = String(finalText || "").split(/\r?\n/);
  for (const line of lines) {
    const strict = STATIC_ARBITRATION_RE.exec(line.trim());
    const matched = strict || /^\s*(C\d+)\s*[:：].*?\b(confirmed|rejected|corrected|unknown)\b/i.exec(line);
    if (!matched) continue;
    const candidate = candidates.find((item) => item.candidate_id.toLowerCase() === matched[1].toLowerCase());
    if (candidate) decisions.push({ candidate_id: candidate.candidate_id, claim_id: candidate.claim_id, decision: matched[2].toLowerCase(), source_round_id: sourceRoundId });
  }
  return decisions;
}

function parseStaticFrameLine(line, media) {
  const match = STATIC_FRAME_RE.exec(String(line || "").trim());
  if (!match) return null;
  const frameIndex = Number(match[1]);
  const pts = Number(match[2]);
  const atoms = parseStaticAtoms(match[3]);
  const frame = (media || []).find((item) => item.frame_index === frameIndex && samePts(item.capture_pts_seconds, pts));
  return {
    media: frame || { media_id: null },
    frame_index: frameIndex,
    capture_pts_seconds: pts,
    atoms,
  };
}

function parseStaticAtoms(value) {
  const rawAtoms = splitEscaped(String(value || ""), ";").map((item) => item.trim()).filter(Boolean);
  if (!rawAtoms.length || rawAtoms.length > 20) throw new Error("VIDEO_STATIC_ATOMS_ONLY");
  return rawAtoms.map((raw) => {
    const match = /^(TEXT|COLOR|SHAPE|OBJECT|POSITION)=(.+)$/.exec(raw);
    if (!match || !STATIC_ATOM_KEYS.has(match[1]) || hasUnescapedDelimiter(match[2])) {
      throw new Error("VIDEO_STATIC_ATOMS_ONLY");
    }
    const decoded = decodeStaticAtomValue(match[2]).trim();
    if (!decoded || STATIC_VIDEO_FORBIDDEN_RE.test(decoded)) throw new Error("VIDEO_STATIC_ATOMS_ONLY");
    return { key: match[1], value: decoded };
  });
}

function splitEscaped(value, delimiter) {
  const parts = [];
  let current = "";
  for (let index = 0; index < value.length; index += 1) {
    const character = value[index];
    if (character === "\\") {
      if (index + 1 >= value.length) throw new Error("VIDEO_STATIC_ATOMS_ONLY");
      current += character + value[index + 1];
      index += 1;
    } else if (character === delimiter) {
      parts.push(current);
      current = "";
    } else {
      current += character;
    }
  }
  parts.push(current);
  return parts;
}

function hasUnescapedDelimiter(value) {
  const reserved = new Set(["=", ";", "[", "]", "(", ")"]);
  for (let index = 0; index < value.length; index += 1) {
    if (value[index] === "\\") {
      index += 1;
      continue;
    }
    if (reserved.has(value[index])) return true;
  }
  return false;
}

function decodeStaticAtomValue(value) {
  let decoded = "";
  const allowedEscapes = new Set(["\\", "=", ";", "[", "]", "(", ")"]);
  for (let index = 0; index < value.length; index += 1) {
    const character = value[index];
    if (character !== "\\") {
      decoded += character;
      continue;
    }
    const escaped = value[index + 1];
    if (!escaped || !allowedEscapes.has(escaped)) throw new Error("VIDEO_STATIC_ATOMS_ONLY");
    decoded += escaped;
    index += 1;
  }
  return decoded;
}

function endpointRecord(frame, pts, atoms) {
  return { frame_index: Number(frame), capture_pts_seconds: Number(pts), atoms: parseStaticAtoms(atoms) };
}

function validateEndpoint(endpoint, records, expectedByKey) {
  const ordered = [...records].sort((a, b) => a.capture_pts_seconds - b.capture_pts_seconds);
  const first = ordered[0];
  const last = ordered.at(-1);
  for (const [record, expected] of [[endpoint.a, first], [endpoint.b, last]]) {
    const key = frameKey(record.frame_index, record.capture_pts_seconds);
    if (!expectedByKey.has(key) || key !== expected.key) throw new Error("VIDEO_LEDGER_MANIFEST_MISMATCH");
    if (!sameAtoms(record.atoms, expected.atoms)) throw new Error("VIDEO_STATIC_LEDGER_SCHEMA_REQUIRED");
  }
}

function sameAtoms(a, b) {
  const left = (a || []).map((atom) => atom.key + "=" + atom.value).sort();
  const right = (b || []).map((atom) => atom.key + "=" + atom.value).sort();
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function frameKey(frameIndex, pts) {
  return String(frameIndex) + "|" + String(Number(pts));
}

function samePts(a, b) {
  return Number.isFinite(Number(a)) && Number.isFinite(Number(b)) && Math.abs(Number(a) - Number(b)) <= 0.000001;
}

export function compareClaims(rounds) {
  const byKey = new Map();
  for (const round of rounds) {
    for (const claim of round.claims || []) {
      const key = [claim.media_id || "", claim.frame_index ?? "", claim.capture_pts_seconds ?? "", claim.coordinate_basis || "", JSON.stringify(claim.coordinate || null), normalize(claim.statement)].join("|");
      const current = byKey.get(key) || [];
      current.push({ round_id: round.round_id, claim });
      byKey.set(key, current);
    }
  }
  const aligned = [...byKey.values()];
  const unique = aligned.filter((items) => items.length === 1);
  const unresolved = aligned.filter((items) => items.some((item) => item.claim.evidence_state === "unknown"));
  const missingClaimRounds = rounds.filter((round) => !(round.claims || []).length).map((round) => round.round_id);
  return {
    aligned_claim_groups: aligned,
    unique_claim_groups: unique,
    unresolved_claim_groups: unresolved,
    missing_claim_rounds: missingClaimRounds,
    requires_arbitration: unique.length > 0 || unresolved.length > 0 || missingClaimRounds.length > 0,
  };
}

function normalize(value) {
  return String(value || "").replace(/\s+/g, " ").trim().toLowerCase();
}

export function shouldRequestThirdRound(comparison, options = {}) {
  if (options.highRisk) return true;
  return comparison.requires_arbitration;
}

export function buildConsensus(rounds, comparison, arbitrationDecisions = []) {
  const totalRounds = rounds.length;
  const groups = comparison.aligned_claim_groups.map((group) => {
    const sources = group.map((item) => item.round_id);
    const claim = group[0].claim;
    const decisions = group.flatMap((item) => arbitrationDecisions.filter((decision) => decision.claim_id === item.claim.claim_id));
    const directUnknown = group.some((item) => item.claim.evidence_state === "unknown");
    const rejected = decisions.some((decision) => decision.decision === "rejected");
    const corrected = decisions.some((decision) => decision.decision === "corrected");
    const cUnknown = decisions.some((decision) => decision.decision === "unknown");
    const cConfirmed = decisions.some((decision) => decision.decision === "confirmed");
    const support = group.filter((item) => item.claim.evidence_state !== "unknown").length + (cConfirmed ? 1 : 0);
    const status = rejected ? "rejected" : ((directUnknown || corrected || cUnknown) ? "unresolved" : (support >= 2 ? "confirmed" : "needs_arbitration"));
    return {
      statement: claim.statement,
      evidence_state: claim.evidence_state,
      source_round_ids: sources,
      support_count: support,
      arbitration_decisions: decisions,
      status,
    };
  });
  return {
    total_rounds: totalRounds,
    claims: groups,
    confirmed: groups.filter((item) => item.status === "confirmed"),
    unresolved: groups.filter((item) => item.status !== "confirmed"),
    missing_claim_rounds: comparison.missing_claim_rounds,
  };
}

function extractLineMetadata(line, media) {
  const mediaMatch = /\bmedia_id\s*[=:]\s*([^;\s,]+)/i.exec(line);
  const frameMatch = /\bframe_index\s*[=:]\s*(\d+)/i.exec(line);
  const ptsMatch = /\bcapture_pts_seconds\s*[=:]\s*(-?\d+(?:\.\d+)?)/i.exec(line);
  const onlyMedia = media.length === 1 ? media[0] : null;
  return {
    media_id: mediaMatch?.[1] || onlyMedia?.media_id || null,
    frame_index: frameMatch ? Number(frameMatch[1]) : (onlyMedia?.frame_index ?? null),
    capture_pts_seconds: ptsMatch ? Number(ptsMatch[1]) : (onlyMedia?.capture_pts_seconds ?? null),
  };
}
