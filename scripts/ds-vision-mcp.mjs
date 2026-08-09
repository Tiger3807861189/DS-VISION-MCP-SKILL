#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { ACTIONS, DsVisionEngine } from "./engine.mjs";

const engine = new DsVisionEngine();
const server = new McpServer({ name: "DS-VISION", version: "3.0.0" });

server.registerTool(
  "ds_vision",
  {
    title: "DS-VISION",
    description: "The single DS-VISION entry. Route visual evidence, follow-up, video-frame planning, coordinate mapping, sessions, health, and calibration through action.",
    inputSchema: {
      action: z.enum([...ACTIONS]).optional().describe("Internal action routed by the single DS-VISION entry."),
      inputs: z.union([z.string(), z.array(z.string())]).optional().describe("One local image path/data URL or an array of them for visible-material analysis."),
      input: z.union([z.string(), z.array(z.string())]).optional().describe("Video source reference for a video request."),
      objective: z.string().optional(),
      question: z.string().optional(),
      stage: z.enum(["auto", "overview", "inspect", "localize", "reproduce", "verify", "trace"]).optional(),
      evidence_mode: z.enum(["auto", "text", "boxes", "points", "trajectory", "mixed"]).optional(),
      session: z.string().optional(),
      session_id: z.string().optional(),
      rounds: z.union([z.literal(1), z.literal(2), z.literal("auto")]).optional(),
      language: z.enum(["zh", "en"]).optional(),
      detail: z.enum(["concise", "full"]).optional(),
      sampling: z.enum(["auto", "1.5s", "1s", "0.5s", "0.2s", "0.1s"]).optional(),
      mode: z.enum(["overview", "inspect", "localize", "reproduce", "verify", "track"]).optional(),
      segment: z.object({ start_ms: z.number(), end_ms: z.number() }).optional(),
      max_frames_per_batch: z.number().int().min(1).max(50).optional(),
      duration_ms: z.number().positive().optional(),
      frame_manifest: z.any().optional(),
      manifest: z.any().optional(),
      execute: z.boolean().optional(),
      operation: z.string().optional(),
      box: z.array(z.number()).optional(),
      source_width: z.number().positive().optional(),
      source_height: z.number().positive().optional(),
      geometry_manifest: z.any().optional(),
      coordinate_chain: z.any().optional(),
      anchor: z.any().optional(),
      target_space: z.string().optional(),
      prior_claims: z.array(z.any()).optional(),
      claims: z.array(z.any()).optional(),
    },
  },
  async (request) => {
    try {
      const result = await engine.handle(request);
      return {
        content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
        structuredContent: result,
      };
    } catch (error) {
      const diagnostic = describeError(error);
      return {
        isError: true,
        content: [{ type: "text", text: JSON.stringify({ error: diagnostic }, null, 2) }],
      };
    }
  },
);

await server.connect(new StdioServerTransport());

function describeError(error) {
  const message = String(error?.message || "DS_VISION_ERROR");
  const code = /^[A-Z0-9_]+$/.test(message) ? message : "DS_VISION_ERROR";
  const manualAction = errorAction(code);
  return { code, message, manual_action: manualAction };
}

function errorAction(code) {
  if (code === "BROWSER_PROFILE_LOCKED") return "Wait for the active DS-VISION request to finish, then retry.";
  if (/LOGIN|COMPOSER/.test(code)) return "Open the persistent DS-VISION browser profile, complete login, and retry.";
  if (/VISION_MODE|DEEP_THINK/.test(code)) return "Confirm the required visual mode and DeepThink controls are visible and enabled, then retry.";
  if (/UPLOAD/.test(code)) return "Confirm the supplied media is supported and its attachment preview appears before retrying.";
  if (/RESPONSE/.test(code)) return "Wait for a visible completed response or start a fresh request after checking the page state.";
  if (/VIDEO_EVIDENCE_BOUNDARY/.test(code)) return "Request a corrected static frame ledger bound to frame_index and capture_pts_seconds.";
  if (/REMOTE_URL_INPUT/.test(code)) return "Download the permitted image to a local path or provide an allowed image data URL, then retry.";
  if (/INLINE_IMAGE/.test(code)) return "Provide a supported image data URL within the configured size limit, or use a local image file.";
  if (/SESSION/.test(code)) return "Use an active session_id returned by DS-VISION or start a new analysis.";
  return "Review the request fields and the returned evidence boundary, then retry with the smallest required correction.";
}
