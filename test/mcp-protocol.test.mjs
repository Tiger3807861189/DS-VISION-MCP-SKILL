import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

test("MCP server exposes one DS-VISION tool and routes health", async () => {
  const temporary = await fs.mkdtemp(path.join(os.tmpdir(), "ds-vision-mcp-"));
  const child = spawn(process.execPath, ["scripts/ds-vision-mcp.mjs"], {
    cwd: root,
    env: { ...process.env, DS_VISION_DATA_DIR: temporary },
    stdio: ["pipe", "pipe", "pipe"],
  });
  try {
    const health = await exchange(child, { action: "health" });
    assert.equal(health.service, "DS-VISION");
    assert.equal(health.requested_host_alias, "/DS-VISION");
    assert.equal(health.host_alias_verified, false);
  } finally {
    child.kill();
    await fs.rm(temporary, { recursive: true, force: true });
  }
});

test("MCP accepts scalar inputs and returns structured actionable errors", async () => {
  const temporary = await fs.mkdtemp(path.join(os.tmpdir(), "ds-vision-mcp-error-"));
  const child = spawn(process.execPath, ["scripts/ds-vision-mcp.mjs"], {
    cwd: root,
    env: { ...process.env, DS_VISION_DATA_DIR: temporary },
    stdio: ["pipe", "pipe", "pipe"],
  });
  try {
    const result = await exchange(child, { action: "analyze", inputs: "one.png", objective: "" });
    assert.equal(result.error.code, "DS_VISION_ERROR");
    assert.match(result.error.message, /objective must be a non-empty string/);
    assert.match(result.error.manual_action, /Review the request fields/);
  } finally {
    child.kill();
    await fs.rm(temporary, { recursive: true, force: true });
  }
});

function exchange(child, toolArguments) {
  return new Promise((resolve, reject) => {
    let buffer = "";
    const timer = setTimeout(() => reject(new Error("MCP handshake timed out")), 8000);
    const finish = (value, error) => {
      clearTimeout(timer);
      if (error) reject(error);
      else resolve(value);
    };
    const send = (message) => child.stdin.write(JSON.stringify(message) + "\n");
    child.once("error", (error) => finish(null, error));
    child.stderr.on("data", (data) => finish(null, new Error(String(data))));
    child.stdout.on("data", (data) => {
      buffer += String(data);
      let newline;
      while ((newline = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, newline);
        buffer = buffer.slice(newline + 1);
        if (!line) continue;
        let message;
        try {
          message = JSON.parse(line);
        } catch (error) {
          finish(null, error);
          return;
        }
        if (message.id === 1) {
          send({ jsonrpc: "2.0", method: "notifications/initialized" });
          send({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} });
        } else if (message.id === 2) {
          const tools = message.result?.tools || [];
          if (tools.length !== 1 || tools[0].name !== "ds_vision") {
            finish(null, new Error("MCP did not expose exactly one ds_vision tool"));
            return;
          }
          send({ jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "ds_vision", arguments: toolArguments } });
        } else if (message.id === 3) {
          try {
            finish(JSON.parse(message.result.content[0].text));
          } catch (error) {
            finish(null, error);
          }
        }
      }
    });
    send({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: "2025-11-25",
        capabilities: {},
        clientInfo: { name: "ds-vision-test", version: "1.0.0" },
      },
    });
  });
}
