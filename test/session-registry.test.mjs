import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { SessionRegistry } from "../scripts/session-registry.mjs";

test("session registry stores, lists, and closes a session", async () => {
  const temporary = await fs.mkdtemp(path.join(os.tmpdir(), "ds-vision-sessions-"));
  try {
    const registry = new SessionRegistry(temporary);
    await registry.upsert({ session_id: "session_1", conversation_url: "https://chat.deepseek.com/a", state: "active" });
    assert.equal((await registry.list()).length, 1);
    assert.equal((await registry.mark("session_1", "closed")).state, "closed");
  } finally {
    await fs.rm(temporary, { recursive: true, force: true });
  }
});

test("corrupt session registry is retained as a diagnostic copy", async () => {
  const temporary = await fs.mkdtemp(path.join(os.tmpdir(), "ds-vision-sessions-corrupt-"));
  try {
    await fs.writeFile(path.join(temporary, "sessions.json"), "not json", "utf8");
    const registry = new SessionRegistry(temporary);
    assert.deepEqual(await registry.list(), []);
    const copies = await fs.readdir(temporary);
    assert.ok(copies.some((name) => name.startsWith("sessions.json.corrupt-")));
  } finally {
    await fs.rm(temporary, { recursive: true, force: true });
  }
});

test("session registry strips URL credentials, query, and fragments before persistence", async () => {
  const temporary = await fs.mkdtemp(path.join(os.tmpdir(), "ds-vision-sessions-url-"));
  try {
    const registry = new SessionRegistry(temporary);
    const session = await registry.upsert({ session_id: "safe", conversation_url: "https://chat.deepseek.com/c/1?token=secret#fragment", state: "active" });
    assert.equal(session.conversation_url, "https://chat.deepseek.com/c/1");
  } finally {
    await fs.rm(temporary, { recursive: true, force: true });
  }
});

test("a stale session lock from a dead process is safely recovered", async () => {
  const temporary = await fs.mkdtemp(path.join(os.tmpdir(), "ds-vision-sessions-stale-"));
  try {
    await fs.writeFile(path.join(temporary, "sessions.lock"), JSON.stringify({ owner: "dead", pid: 99999999 }), "utf8");
    const registry = new SessionRegistry(temporary);
    await registry.upsert({ session_id: "recovered", conversation_url: "https://chat.deepseek.com/c/2", state: "active" });
    assert.equal((await registry.describe("recovered")).state, "active");
  } finally {
    await fs.rm(temporary, { recursive: true, force: true });
  }
});
