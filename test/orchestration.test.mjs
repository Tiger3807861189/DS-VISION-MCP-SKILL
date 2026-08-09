import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { DsVisionEngine } from "../scripts/engine.mjs";
import { sha256 } from "../scripts/contracts.mjs";

test("auto runs two isolated observations and a conditional third arbitration", async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "ds-vision-rounds-"));
  const browser = new FakeBrowser([
    "visible_fact: A sees a blue marker",
    "visible_fact: B sees a red marker",
    "visible_fact: C cannot confirm either marker",
  ]);
  try {
    const engine = new DsVisionEngine({ dataDirectory: directory, browserFactory: () => browser });
    const result = await engine.handle({ action: "analyze", inputs: "frame.png", objective: "检查标记", rounds: "auto" });
    assert.equal(result.rounds.length, 3);
    assert.equal(browser.newConversationCount, 3);
    assert.equal(browser.uploadCount, 3);
    assert.equal(new Set(result.round_session_ids).size, 3);
    assert.equal(result.consensus.total_rounds, 3);
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});

test("followup accepts the returned session_id field", async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "ds-vision-followup-"));
  try {
    const engine = new DsVisionEngine({ dataDirectory: directory, browserFactory: () => new FakeBrowser(["visible_fact: followup"]) });
    engine.registry.describe = async (sessionId) => {
      assert.equal(sessionId, "session_from_result");
      return null;
    };
    await assert.rejects(
      () => engine.handle({ action: "followup", session_id: "session_from_result", question: "继续" }),
      /FOLLOWUP_SESSION_NOT_AVAILABLE/,
    );
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});

test("followup stops before sending when the reopened conversation identity differs", async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "ds-vision-followup-mismatch-"));
  const browser = new FakeBrowser(["visible_fact: should not be sent"]);
  browser.openConversation = async () => ({
    conversation_url: "https://chat.deepseek.com/c/expected",
    last_response_fingerprint: "expected-fingerprint",
    conversation_identity: {
      task_fingerprint: "wrong-task", media_fingerprint: "expected-media", media_count: 1,
      origin_task_fingerprint: "expected-origin-task", origin_media_fingerprint: "expected-origin-media", origin_media_count: 1,
    },
  });
  try {
    const engine = new DsVisionEngine({ dataDirectory: directory, browserFactory: () => browser });
    engine.registry.describe = async () => ({
      session_id: "session_expected",
      conversation_url: "https://chat.deepseek.com/c/expected",
      state: "active",
      task_id: "task_expected",
      media_fingerprint: "media-fingerprint",
      last_response_fingerprint: "expected-fingerprint",
      conversation_identity: {
        task_fingerprint: "expected-task", media_fingerprint: "expected-media", media_count: 1,
        origin_task_fingerprint: "expected-origin-task", origin_media_fingerprint: "expected-origin-media", origin_media_count: 1,
      },
      origin_conversation_identity: { origin_task_fingerprint: "expected-origin-task", origin_media_fingerprint: "expected-origin-media", origin_media_count: 1 },
    });
    await assert.rejects(
      () => engine.handle({ action: "followup", session_id: "session_expected", question: "继续" }),
      /SESSION_MISMATCH/,
    );
    assert.equal(browser.sendCount, 0);
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});

test("a second followup preserves and verifies the immutable original media identity", async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "ds-vision-followup-origin-"));
  const browser = new FakeBrowser(["visible_fact: first followup"]);
  const origin = { origin_task_fingerprint: "origin-task", origin_media_fingerprint: "origin-media", origin_media_count: 1 };
  let reopenCount = 0;
  browser.openConversation = async () => {
    reopenCount += 1;
    if (reopenCount === 1) {
      return {
        conversation_url: "https://chat.deepseek.com/c/expected",
        last_response_fingerprint: "initial-answer",
        conversation_identity: { task_fingerprint: "original-task", media_fingerprint: "original-media", media_count: 1, ...origin },
      };
    }
    return {
      conversation_url: "https://chat.deepseek.com/c/expected",
      last_response_fingerprint: sha256("visible_fact: first followup"),
      conversation_identity: {
        task_fingerprint: "first-question", media_fingerprint: "no-media", media_count: 0,
        origin_task_fingerprint: "wrong-origin-task", origin_media_fingerprint: "wrong-origin-media", origin_media_count: 0,
      },
    };
  };
  browser.sendAndCapture = async () => {
    browser.sendCount += 1;
    return {
      final_text: "visible_fact: first followup",
      conversation_url: "https://chat.deepseek.com/c/expected",
      conversation_identity: { task_fingerprint: "first-question", media_fingerprint: "no-media", media_count: 0, ...origin },
    };
  };
  try {
    const engine = new DsVisionEngine({ dataDirectory: directory, browserFactory: () => browser });
    let current = {
      session_id: "session_expected", conversation_url: "https://chat.deepseek.com/c/expected", state: "active",
      task_id: "task_expected", media_fingerprint: "registry-media", last_response_fingerprint: "initial-answer",
      conversation_identity: { task_fingerprint: "original-task", media_fingerprint: "original-media", media_count: 1, ...origin },
      origin_conversation_identity: origin,
    };
    engine.registry.describe = async () => current;
    engine.registry.upsert = async (value) => { current = value; return value; };
    await engine.handle({ action: "followup", session_id: "session_expected", question: "第一条追问" });
    await assert.rejects(
      () => engine.handle({ action: "followup", session_id: "session_expected", question: "第二条追问" }),
      /SESSION_MISMATCH/,
    );
    assert.equal(browser.sendCount, 1);
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});

test("analysis rejects a reused session so new media cannot be mislabeled as uploaded", async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "ds-vision-session-mismatch-"));
  try {
    const engine = new DsVisionEngine({ dataDirectory: directory, browserFactory: () => new FakeBrowser([]) });
    await assert.rejects(
      () => engine.handle({ action: "analyze", session: "session_from_history", inputs: "new.png", objective: "新媒体" }),
      /ANALYZE_SESSION_REQUIRES_FOLLOWUP/,
    );
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});

test("video execution rejects continuous-process language instead of completing", async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "ds-vision-video-boundary-"));
  const browser = new FakeBrowser(["frame_index=1; capture_pts_seconds=0.0; visible_fact: The car is moving between frames."]);
  try {
    const engine = new DsVisionEngine({ dataDirectory: directory, browserFactory: () => browser });
    await assert.rejects(
      () => engine.handle({
        action: "video", objective: "静态 ledger", execute: true, rounds: 1,
        frame_manifest: { media_id: "video", duration_ms: 1, sampling: "1s", frames: [{ media_id: "f1", frame_index: 1, capture_pts_seconds: 0, source: "f1.png" }] },
      }),
      /VIDEO_EVIDENCE_BOUNDARY_REJECTED/,
    );
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});

test("a video batch rejects when an earlier independent round crosses the frame boundary", async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "ds-vision-video-earlier-round-"));
  const browser = new FakeBrowser([
    "frame_index=1; capture_pts_seconds=0.0; visible_fact: object is moving",
    "frame_index=1; capture_pts_seconds=0.0; visible_fact: blue object",
    "frame_index=1; capture_pts_seconds=0.0; visible_fact: blue object",
  ]);
  try {
    const engine = new DsVisionEngine({ dataDirectory: directory, browserFactory: () => browser });
    await assert.rejects(
      () => engine.handle({
        action: "video", objective: "静态 ledger", execute: true, rounds: "auto",
        frame_manifest: { media_id: "video", duration_ms: 1, sampling: "1s", frames: [{ media_id: "f1", frame_index: 1, capture_pts_seconds: 0, source: "f1.png" }] },
      }),
      /VIDEO_EVIDENCE_BOUNDARY_REJECTED/,
    );
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});

test("video execution accepts a complete static atomic ledger", async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "ds-vision-video-static-"));
  const browser = new FakeBrowser([staticLedger(1, 0, "blue")]);
  try {
    const engine = new DsVisionEngine({ dataDirectory: directory, browserFactory: () => browser });
    const result = await engine.handle({
      action: "video", objective: "静态 ledger", execute: true, rounds: 1,
      frame_manifest: { media_id: "video", duration_ms: 1, sampling: "1s", frames: [{ media_id: "f1", frame_index: 1, capture_pts_seconds: 0, source: "f1.png" }] },
    });
    assert.equal(result.status, "completed");
    assert.equal(result.batches[0].result.rounds[0].claims[0].media_id, "f1");
    assert.equal(result.batches[0].result.verification_mode, "single_static_observation");
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});

test("high-risk video arbitration accepts only a complete decision ledger", async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "ds-vision-video-arbitration-"));
  const browser = new FakeBrowser([
    staticLedger(1, 0, "blue"),
    staticLedger(1, 0, "blue"),
    "decision=C1:confirmed\ndecision=C2:confirmed",
  ]);
  try {
    const engine = new DsVisionEngine({ dataDirectory: directory, browserFactory: () => browser });
    const result = await engine.handle({
      action: "video", objective: "静态 ledger", execute: true, rounds: "auto",
      frame_manifest: { media_id: "video", duration_ms: 1, sampling: "1s", frames: [{ media_id: "f1", frame_index: 1, capture_pts_seconds: 0, source: "f1.png" }] },
    });
    assert.equal(result.batches[0].result.rounds.length, 3);
    assert.equal(result.batches[0].result.consensus.confirmed.length, 1);
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});

test("a 50-frame batch preserves every PTS record and all 100 A/B arbitration candidates", async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "ds-vision-video-50-"));
  const frames = Array.from({ length: 50 }, (_, index) => ({ media_id: "f" + index, frame_index: index, capture_pts_seconds: index, source: "f" + index + ".png" }));
  const browser = new FakeBrowser([
    staticBatchLedger(frames),
    staticBatchLedger(frames),
    Array.from({ length: 100 }, (_, index) => "decision=C" + (index + 1) + ":confirmed").join("\n"),
  ]);
  try {
    const engine = new DsVisionEngine({ dataDirectory: directory, browserFactory: () => browser });
    const result = await engine.handle({
      action: "video", objective: "静态 ledger", execute: true, rounds: "auto", sampling: "1s", max_frames_per_batch: 50,
      frame_manifest: { media_id: "video", duration_ms: 49000, sampling: "1s", frames },
    });
    const batch = result.batches[0].result;
    assert.equal(batch.rounds.length, 3);
    assert.equal(batch.consensus.confirmed.length, 50);
    assert.equal(batch.verification_mode, "independent_ab_static_arbitration");
    assert.equal(browser.uploadCount, 150);
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});

function staticLedger(frame, pts, color) {
  return [
    "frame=" + frame + "|pts=" + pts + "|atoms=[COLOR=" + color + ";SHAPE=square;POSITION=center]",
    "endpoint=[A(frame=" + frame + ",pts=" + pts + ",atoms=COLOR=" + color + ";SHAPE=square;POSITION=center)|B(frame=" + frame + ",pts=" + pts + ",atoms=COLOR=" + color + ";SHAPE=square;POSITION=center)|unobserved_interval=unknown]",
    "coordinate_status=none",
    "refine_interval=none",
  ].join("\n");
}

function staticBatchLedger(frames) {
  const atom = (frame) => "COLOR=blue;OBJECT=marker;POSITION=center";
  const first = frames[0];
  const last = frames.at(-1);
  return [
    ...frames.map((frame) => "frame=" + frame.frame_index + "|pts=" + frame.capture_pts_seconds + "|atoms=[" + atom(frame) + "]"),
    "endpoint=[A(frame=" + first.frame_index + ",pts=" + first.capture_pts_seconds + ",atoms=" + atom(first) + ")|B(frame=" + last.frame_index + ",pts=" + last.capture_pts_seconds + ",atoms=" + atom(last) + ")|unobserved_interval=unknown]",
    "coordinate_status=none",
    "refine_interval=none",
  ].join("\n");
}

class FakeBrowser {
  constructor(responses) {
    this.responses = [...responses];
    this.newConversationCount = 0;
    this.uploadCount = 0;
    this.sendCount = 0;
  }

  async open() {}
  async close() {}
  async verifyLogin() { return { verified: true }; }
  async ensureModes() { return { vision: true, deep_think: true }; }
  async upload() { this.uploadCount += 1; return { uploaded_count: 1 }; }
  async prepareConversation() {
    this.newConversationCount += 1;
    return { conversation_url: "https://chat.deepseek.com/c/" + this.newConversationCount };
  }
  async visibleMessageTexts() {
    // P13: returns empty array to simulate fresh conversation with no messages
    return [];
  }
  async openConversation(url) { return { conversation_url: url }; }
  async sendAndCapture() {
    this.sendCount += 1;
    const finalText = this.responses.shift() || "visible_fact: fallback";
    return {
      final_text: finalText,
      conversation_url: "https://chat.deepseek.com/c/" + this.newConversationCount,
      conversation_identity: {
        task_fingerprint: "task-" + this.sendCount, media_fingerprint: "media", media_count: 0,
        origin_task_fingerprint: "origin-task", origin_media_fingerprint: "origin-media", origin_media_count: 1,
      },
    };
  }
}
