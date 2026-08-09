import fs from "node:fs/promises";
import path from "node:path";
import { DeepSeekBrowserAdapter } from "./browser-adapter.mjs";
import { buildFrameManifest, chooseSamplingInterval, planOverviewWindows } from "./video.mjs";
import { compileArbitrationPrompt, compileFollowupPrompt, compilePrompt } from "./prompts.mjs";
import { buildConsensus, compareClaims, extractArbitrationDecisions, extractClaimsFromVisibleText, makeEvidencePacket, shouldRequestThirdRound, validateStaticVideoArbitration, validateStaticVideoLedger } from "./evidence.mjs";
import { sha256, stableId, validateClaim, validateVideoRequest, validateVisionRequest } from "./contracts.mjs";
import { mapToGeometry, normalizedBoxToPixels, normalizedToMeasurableAnchor } from "./coordinates.mjs";
import { canonicalConversationUrl, SessionRegistry } from "./session-registry.mjs";

const ACTIONS = new Set(["analyze", "followup", "sessions", "compare", "video", "map", "health", "calibrate"]);

export class DsVisionEngine {
  constructor(options = {}) {
    this.dataDirectory = path.resolve(options.dataDirectory || process.env.DS_VISION_DATA_DIR || ".ds-vision");
    this.profileDirectory = path.join(this.dataDirectory, "profile");
    this.traceFile = path.join(this.dataDirectory, "runs.jsonl");
    this.registry = new SessionRegistry(path.join(this.dataDirectory, "sessions"));
    this.browserFactory = options.browserFactory || ((browserOptions) => new DeepSeekBrowserAdapter(browserOptions));
  }

  async handle(request = {}) {
    const action = request.action || "analyze";
    if (!ACTIONS.has(action)) throw new Error("Unsupported DS-VISION action: " + action);
    if (action === "analyze") return this.analyze(request);
    if (action === "followup") return this.followup(request);
    if (action === "compare") return this.compare(request);
    if (action === "video") return this.video(request);
    if (action === "map") return this.map(request);
    if (action === "sessions") return this.sessions(request);
    if (action === "calibrate") return this.calibrate(request);
    return this.health();
  }

  async analyze(request) {
    const validated = validateVisionRequest(request);
    return this.runVisualRequest(validated, { comparison: false, videoDiscrete: false });
  }

  async compare(request) {
    const validated = validateVisionRequest({ ...request, stage: request.stage || "inspect" });
    if (validated.inputs.length < 2) throw new Error("COMPARE_REQUIRES_AT_LEAST_TWO_MEDIA");
    return this.runVisualRequest(validated, { comparison: true, videoDiscrete: false });
  }

  async followup(request) {
    const sessionId = String(request.session || request.session_id || "").trim();
    const question = String(request.question || request.objective || "").trim();
    if (!sessionId || sessionId === "auto" || sessionId === "new") throw new Error("FOLLOWUP_REQUIRES_SESSION_ID");
    if (!question) throw new Error("FOLLOWUP_REQUIRES_QUESTION");
    const session = await this.registry.describe(sessionId);
    if (!session || session.state !== "active") throw new Error("FOLLOWUP_SESSION_NOT_AVAILABLE");
    const run = this.beginRun("followup", { session_id: sessionId, question });
    const browser = this.createBrowser();
    try {
      await browser.open();
      await browser.verifyLogin();
      if (!session.task_id || !session.media_fingerprint || !session.last_response_fingerprint
        || !isConversationIdentity(session.conversation_identity) || !isOriginConversationIdentity(session.origin_conversation_identity)) {
        throw new Error("SESSION_MISMATCH");
      }
      const reopened = await browser.openConversation(session.conversation_url);
      let expectedConversationUrl;
      let reopenedConversationUrl;
      try {
        expectedConversationUrl = canonicalConversationUrl(session.conversation_url);
        reopenedConversationUrl = canonicalConversationUrl(reopened?.conversation_url);
      } catch {
        throw new Error("SESSION_MISMATCH");
      }
      if (reopenedConversationUrl !== expectedConversationUrl
        || reopened.last_response_fingerprint !== session.last_response_fingerprint
        || !sameConversationIdentity(reopened.conversation_identity, session.conversation_identity)
        || !sameOriginConversationIdentity(reopened.conversation_identity, session.origin_conversation_identity)) {
        throw new Error("SESSION_MISMATCH");
      }
      await browser.ensureModes();
      const prompt = compileFollowupPrompt(question, request.prior_claims || []);
      const response = await browser.sendAndCapture(prompt);
      let responseConversationUrl;
      try {
        responseConversationUrl = canonicalConversationUrl(response.conversation_url);
      } catch {
        throw new Error("SESSION_MISMATCH");
      }
      if (responseConversationUrl !== expectedConversationUrl) throw new Error("SESSION_MISMATCH");
      const packet = makeEvidencePacket({
        task_id: run.task_id,
        session_id: sessionId,
        round_id: run.run_id,
        prompt_hash: sha256(prompt),
        final_text: response.final_text,
      });
      if (!isConversationIdentity(response.conversation_identity)
        || !sameOriginConversationIdentity(response.conversation_identity, session.origin_conversation_identity)) throw new Error("SESSION_MISMATCH");
      await this.registry.upsert({
        ...session,
        conversation_url: response.conversation_url,
        state: "active",
        last_response_fingerprint: sha256(response.final_text),
        conversation_identity: response.conversation_identity,
        origin_conversation_identity: session.origin_conversation_identity,
      });
      const result = {
        action: "followup",
        task_id: run.task_id,
        run_id: run.run_id,
        session_id: sessionId,
        final_text: response.final_text,
        evidence_packet: packet,
        boundary: evidenceBoundary(),
      };
      await this.writeRun({ ...run, outcome: "completed", response_hash: packet.final_text_hash });
      return result;
    } catch (error) {
      await this.writeRun({ ...run, outcome: "failed", error_code: errorCode(error) });
      throw error;
    } finally {
      await browser.close();
    }
  }

  async video(request) {
    const validated = validateVideoRequest(request);
    const durationMs = Number(request.duration_ms || request.frame_manifest?.duration_ms || 0);
    const frameManifestInput = request.frame_manifest || request.manifest || null;
    if (!frameManifestInput) {
      if (!Number.isFinite(durationMs) || durationMs <= 0) throw new Error("VIDEO_REQUIRES_DURATION_OR_FRAME_MANIFEST");
      const intervalMs = chooseSamplingInterval(durationMs, validated.sampling);
      return {
        action: "video",
        status: "frame_manifest_required",
        sampling_interval_ms: intervalMs,
        target_capture_pts_seconds: buildTargetPts(durationMs, intervalMs, validated.segment),
        required_manifest_fields: ["frame_index", "capture_pts_seconds", "media_id", "source"],
        boundary: "DS-VISION chooses fixed-time targets from supplied duration. It does not infer an interval from unseen video content.",
      };
    }
    const manifest = buildFrameManifest(frameManifestInput);
    const plan = planOverviewWindows(manifest, {
      sampling: validated.sampling,
      start_ms: validated.segment?.start_ms,
      end_ms: validated.segment?.end_ms,
      max_frames_per_batch: validated.max_frames_per_batch,
    });
    if (request.execute !== true) {
      return {
        action: "video",
        status: "planned",
        frame_manifest: manifest,
        plan,
        boundary: "Each listed frame is an isolated PTS observation. Inter-frame process remains unknown unless a denser supplied manifest is separately observed.",
      };
    }
    const batches = [];
    for (const window of plan.windows) {
      const sources = window.frames.map((frame) => frame.source).filter(Boolean);
      if (sources.length !== window.frames.length) throw new Error("VIDEO_EXECUTION_REQUIRES_FRAME_SOURCE_PATHS");
      const batchRequest = {
        inputs: sources,
        objective: validated.objective,
        stage: "trace",
        evidence_mode: validated.evidence_mode,
        session: "new",
        rounds: validated.rounds,
        language: validated.language,
        detail: validated.detail,
      };
      const result = await this.runVisualRequest(validateVisionRequest(batchRequest), {
        comparison: false,
        videoDiscrete: true,
        mediaMetadata: window.frames,
      });
      batches.push({ batch_index: window.batch_index, result });
    }
    return {
      action: "video",
      status: "completed",
      frame_manifest: manifest,
      plan,
      batches,
      boundary: "Batch conclusions remain bound to the supplied PTS frames; no batch establishes an unobserved continuous process.",
    };
  }

  async map(request) {
    const operation = request.operation;
    if (operation === "normalized_to_source") {
      return normalizedBoxToPixels(request.box, Number(request.source_width), Number(request.source_height));
    }
    if (operation === "normalized_to_measurable_anchor") return normalizedToMeasurableAnchor(request.box, request.coordinate_chain);
    if (operation === "anchor_to_geometry_candidates") {
      const supplied = request.anchor || {};
      const anchor = validateClaim({
        ...supplied,
        claim_id: supplied.claim_id || "map_anchor",
        statement: supplied.statement || "coordinate mapping anchor",
        evidence_state: supplied.evidence_state || "runtime_measurement_required",
      });
      if (anchor.coordinate_status !== "measurable_anchor") throw new Error("GEOMETRY_CANDIDATES_REQUIRE_MEASURABLE_ANCHOR");
      if (!request.geometry_manifest?.manifest_id || request.geometry_manifest.manifest_id !== anchor.coordinate_chain.target_geometry.manifest_id) {
        throw new Error("GEOMETRY_MANIFEST_ID_MISMATCH");
      }
      const targetSpace = request.target_space || anchor.coordinate_basis;
      if (targetSpace !== anchor.coordinate_basis || targetSpace !== anchor.coordinate_chain.target_geometry.space) {
        throw new Error("GEOMETRY_TARGET_SPACE_MISMATCH");
      }
      return mapToGeometry(anchor.coordinate, request.geometry_manifest, targetSpace);
    }
    throw new Error("MAP_OPERATION_UNSUPPORTED");
  }

  async sessions(request) {
    const operation = request.operation || "list";
    if (operation === "list") return { action: "sessions", sessions: await this.registry.list() };
    if (operation === "describe") return { action: "sessions", session: await this.registry.describe(String(request.session_id || "")) };
    if (operation === "close") {
      return { action: "sessions", session: await this.registry.mark(String(request.session_id || ""), "closed", "closed by DS-VISION request") };
    }
    throw new Error("SESSIONS_OPERATION_UNSUPPORTED");
  }

  async calibrate() {
    const run = this.beginRun("calibrate", {});
    const browser = this.createBrowser();
    try {
      await browser.open();
      await browser.verifyLogin();
      const calibration = await browser.calibrate();
      await this.writeCalibration(calibration);
      await this.writeRun({ ...run, outcome: "completed" });
      return { action: "calibrate", calibration };
    } catch (error) {
      await this.writeRun({ ...run, outcome: "failed", error_code: errorCode(error) });
      throw error;
    } finally {
      await browser.close();
    }
  }

  async health() {
    await fs.mkdir(this.dataDirectory, { recursive: true });
    return {
      action: "health",
      service: "DS-VISION",
      version: "3.0.0",
      data_directory: this.dataDirectory,
      session_registry: this.registry.file,
      browser_profile: this.profileDirectory,
      registered_mcp_tool: "ds_vision",
      requested_host_alias: "/DS-VISION",
      local_ready: true,
      host_alias_verified: false,
      note: "Health reports DS-VISION local paths and the single MCP tool. It does not verify or register a host slash-command alias. Browser login and mode activation are verified per visual request.",
    };
  }

  async runVisualRequest(validated, options) {
    const run = this.beginRun(options.comparison ? "compare" : "analyze", {
      objective: validated.objective,
      media_count: validated.inputs.length,
    });
    if (validated.session && !["auto", "new"].includes(validated.session)) {
      throw new Error("ANALYZE_SESSION_REQUIRES_FOLLOWUP");
    }
    const browser = this.createBrowser();
    try {
      await browser.open();
      await browser.verifyLogin();
      const mediaManifest = validated.inputs.map((input, index) => ({
        ...input,
        ...(options.mediaMetadata?.[index] || {}),
      }));
      const compiled = compilePrompt(validated, mediaManifest, { staticVideoAtoms: options.videoDiscrete });
      const rounds = [];
      const usedConversationUrls = new Set();
      const requestedRounds = validated.rounds === 1 ? 1 : 2;
      const first = await this.captureIndependentRound(browser, {
        run, roundNumber: 1, prompt: compiled.prompt, media: validated.inputs, mediaManifest,
        usedConversationUrls, staticVideoAtoms: options.videoDiscrete,
      });
      rounds.push(first);
      if (requestedRounds === 2) {
        rounds.push(await this.captureIndependentRound(browser, {
          run, roundNumber: 2, prompt: compiled.prompt, media: validated.inputs, mediaManifest, usedConversationUrls, staticVideoAtoms: options.videoDiscrete,
        }));
      }
      let comparison = compareClaims(rounds);
      let arbitrationCandidates = [];
      if (requestedRounds === 2 && shouldRequestThirdRound(comparison, { highRisk: options.videoDiscrete })) {
        arbitrationCandidates = rounds.flatMap((round) => round.claims).map((claim, index) => ({ ...claim, candidate_id: "C" + String(index + 1) }));
        const arbitrationPrompt = compileArbitrationPrompt(arbitrationCandidates, { staticVideoAtoms: options.videoDiscrete });
        rounds.push(await this.captureIndependentRound(browser, {
          run, roundNumber: 3, prompt: arbitrationPrompt, media: validated.inputs, mediaManifest, usedConversationUrls, arbitrationCandidates, staticVideoAtoms: options.videoDiscrete,
        }));
        comparison = compareClaims(rounds.slice(0, 2));
      }
      const last = rounds.at(-1);
      const sessionId = first.session_id;
      if (options.videoDiscrete) {
        for (const round of rounds) {
          if (round.is_arbitration) validateStaticVideoArbitration(round.final_text, arbitrationCandidates);
          else validateStaticVideoLedger(round.final_text, mediaManifest);
        }
      }
      const packet = makeEvidencePacket({
        task_id: run.task_id,
        session_id: sessionId,
        round_id: last.round_id,
        prompt_hash: last.prompt_hash,
        media: mediaManifest.map(publicMediaRecord),
        final_text: last.final_text,
        claims: [...validated.claims, ...rounds.flatMap((round) => round.claims)],
        videoDiscrete: options.videoDiscrete && !last.is_arbitration,
      });
      const consensus = buildConsensus(rounds, comparison, rounds.flatMap((round) => round.arbitration_decisions || []));
      const result = {
        action: options.comparison ? "compare" : "analyze",
        task_id: run.task_id,
        run_id: run.run_id,
        session_id: sessionId,
        round_session_ids: rounds.map((round) => round.session_id),
        stage: compiled.stage,
        evidence_mode: compiled.evidence_mode,
        rounds,
        consensus,
        verification_mode: options.videoDiscrete
          ? (requestedRounds === 1 ? "single_static_observation" : "independent_ab_static_arbitration")
          : (requestedRounds === 1 ? "single_observation" : "independent_ab_with_conditional_arbitration"),
        final_text: last.final_text,
        evidence_packet: packet,
        boundary: evidenceBoundary(),
      };
      await this.writeRun({ ...run, outcome: "completed", response_hash: packet.final_text_hash, session_id: sessionId });
      return result;
    } catch (error) {
      const rejected = options.videoDiscrete && /^VIDEO_(?:STATIC|LEDGER|UNOBSERVED)/.test(errorCode(error));
      const failure = rejected ? new Error("VIDEO_EVIDENCE_BOUNDARY_REJECTED", { cause: error }) : error;
      await this.writeRun({ ...run, outcome: "failed", error_code: errorCode(failure) });
      throw failure;
    } finally {
      await browser.close();
    }
  }

  async captureIndependentRound(browser, input) {
    const conversation = await browser.prepareConversation("new");
    const hasNoMessages = (await browser.visibleMessageTexts()).length === 0;
    if (!conversation.conversation_url || (input.usedConversationUrls.has(conversation.conversation_url) && !hasNoMessages)) {
      throw new Error("NEW_CONVERSATION_NOT_VERIFIED");
    }
    input.usedConversationUrls.add(conversation.conversation_url);
    await browser.ensureModes();
    for (const media of input.media) await browser.upload([media]);
    const response = await browser.sendAndCapture(input.prompt);
    const roundId = input.run.run_id + "-r" + input.roundNumber;
    const sessionId = stableId("session", response.conversation_url);
    const claims = input.staticVideoAtoms && input.arbitrationCandidates
      ? []
      : extractClaimsFromVisibleText(response.final_text, roundId, input.mediaManifest);
    const arbitrationDecisions = input.arbitrationCandidates
      ? extractArbitrationDecisions(response.final_text, input.arbitrationCandidates, roundId)
      : [];
    if (!isConversationIdentity(response.conversation_identity)) throw new Error("SESSION_CONTEXT_NOT_VERIFIED");
    await this.registry.upsert({
      session_id: sessionId,
      conversation_url: response.conversation_url,
      state: "active",
      task_id: input.run.task_id,
      objective_hash: sha256(String(input.run.detail.objective || "")),
      media_fingerprint: sha256(input.mediaManifest.map((item) => [item.media_id, item.name, item.source || "", item.frame_index ?? "", item.capture_pts_seconds ?? ""]).join("|")),
      last_response_fingerprint: sha256(response.final_text),
      conversation_identity: response.conversation_identity,
      origin_conversation_identity: originConversationIdentity(response.conversation_identity),
      prompt_protocol: input.roundNumber === 3 ? "v3-arbitration" : "v3-core",
      media_count: input.mediaManifest.length,
      round_id: roundId,
    });
    return {
      round_id: roundId,
      session_id: sessionId,
      final_text: response.final_text,
      prompt_hash: sha256(input.prompt),
      claims,
      arbitration_decisions: arbitrationDecisions,
      is_arbitration: Boolean(input.arbitrationCandidates),
    };
  }

  createBrowser() {
    return this.browserFactory({ profileDirectory: this.profileDirectory });
  }

  beginRun(action, detail) {
    const taskId = stableId("task", [action, Date.now(), Math.random()].join("|"));
    return { task_id: taskId, run_id: stableId("run", taskId), action, started_at: new Date().toISOString(), detail };
  }

  async writeRun(record) {
    await fs.mkdir(this.dataDirectory, { recursive: true });
    await fs.appendFile(this.traceFile, JSON.stringify({ ...record, recorded_at: new Date().toISOString() }) + "\n", "utf8");
  }

  async writeCalibration(calibration) {
    await fs.mkdir(this.dataDirectory, { recursive: true });
    const target = path.join(this.dataDirectory, "calibration.json");
    const temporary = target + ".tmp-" + process.pid;
    await fs.writeFile(temporary, JSON.stringify(calibration, null, 2) + "\n", "utf8");
    await fs.rename(temporary, target);
  }
}

function publicMediaRecord(item) {
  return {
    media_id: item.media_id,
    name: item.name,
    frame_index: item.frame_index ?? null,
    capture_pts_seconds: item.capture_pts_seconds ?? null,
  };
}

function buildTargetPts(durationMs, intervalMs, segment) {
  const start = segment?.start_ms || 0;
  const end = segment?.end_ms || durationMs;
  const targets = [];
  for (let value = start; value <= end; value += intervalMs) targets.push(value / 1000);
  if (targets.at(-1) !== end / 1000) targets.push(end / 1000);
  return targets;
}

function evidenceBoundary() {
  return "Visible pixels and supplied PTS/manifests only. Image coordinates are not DOM, page, click, source-code, network, or hidden-state facts. Unobserved intervals remain unknown.";
}

function errorCode(error) {
  return String(error?.message || "DS_VISION_ERROR").slice(0, 160);
}

function isConversationIdentity(value) {
  return Boolean(value && typeof value.task_fingerprint === "string" && value.task_fingerprint
    && typeof value.media_fingerprint === "string" && value.media_fingerprint
    && Number.isInteger(value.media_count) && value.media_count >= 0
    && isOriginConversationIdentity(value));
}

function sameConversationIdentity(a, b) {
  return isConversationIdentity(a) && isConversationIdentity(b)
    && a.task_fingerprint === b.task_fingerprint
    && a.media_fingerprint === b.media_fingerprint
    && a.media_count === b.media_count;
}

function isOriginConversationIdentity(value) {
  return Boolean(value && typeof value.origin_task_fingerprint === "string" && value.origin_task_fingerprint
    && typeof value.origin_media_fingerprint === "string" && value.origin_media_fingerprint
    && Number.isInteger(value.origin_media_count) && value.origin_media_count >= 0);
}

function originConversationIdentity(value) {
  return {
    origin_task_fingerprint: value.origin_task_fingerprint,
    origin_media_fingerprint: value.origin_media_fingerprint,
    origin_media_count: value.origin_media_count,
  };
}

function sameOriginConversationIdentity(value, origin) {
  return isConversationIdentity(value) && isOriginConversationIdentity(origin)
    && value.origin_task_fingerprint === origin.origin_task_fingerprint
    && value.origin_media_fingerprint === origin.origin_media_fingerprint
    && value.origin_media_count === origin.origin_media_count;
}

export { ACTIONS };
