import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { compareClaims, extractClaimsFromVisibleText, makeEvidencePacket, shouldRequestThirdRound } from "../scripts/evidence.mjs";

const directory = path.join(path.dirname(fileURLToPath(import.meta.url)), "fixtures");
const parseFixtures = JSON.parse(await fs.readFile(path.join(directory, "answer-parse-fixtures.json"), "utf8"));
const consensusFixtures = JSON.parse(await fs.readFile(path.join(directory, "consensus-fixtures.json"), "utf8"));

test("40 fixed answer parsing fixtures cover primitives, states, and video boundaries", () => {
  assert.equal(parseFixtures.length, 40);
  for (const fixture of parseFixtures) {
    const packet = makeEvidencePacket({ task_id: fixture.id, session_id: "s", round_id: "r", prompt_hash: "p", final_text: fixture.text, videoDiscrete: fixture.videoDiscrete === true });
    const claims = extractClaimsFromVisibleText(fixture.text, "r", [{ media_id: "m" }]);
    assert.equal(packet.visual_primitives.boxes.length, fixture.boxes, fixture.id + " boxes");
    assert.equal(packet.visual_primitives.points.length, fixture.points, fixture.id + " points");
    assert.equal(claims.length, fixture.claims, fixture.id + " claims");
    if (fixture.videoDiscrete) assert.equal(packet.warnings.length, fixture.warnings, fixture.id + " warnings");
  }
});

test("20 fixed consensus fixtures cover agreement, gaps, conflict candidates, and unknown", () => {
  assert.equal(consensusFixtures.length, 20);
  for (const fixture of consensusFixtures) {
    const rounds = fixture.rounds.map((statements, index) => ({
      round_id: "r" + (index + 1),
      claims: statements.map((statement, claimIndex) => ({
        claim_id: fixture.id + "-" + index + "-" + claimIndex,
        statement,
        evidence_state: fixture.unknown && statement.startsWith("unknown:") ? "unknown" : "visible_fact",
      })),
    }));
    const comparison = compareClaims(rounds);
    assert.equal(shouldRequestThirdRound(comparison), fixture.third, fixture.id);
  }
});
