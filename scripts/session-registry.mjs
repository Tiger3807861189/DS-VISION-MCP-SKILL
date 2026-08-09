import fs from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";
import { DEFAULTS, SESSION_STATES } from "./constants.mjs";

export class SessionRegistry {
  constructor(directory) {
    this.directory = directory;
    this.file = path.join(directory, "sessions.json");
    this.lock = path.join(directory, "sessions.lock");
  }

  async initialize() {
    await fs.mkdir(this.directory, { recursive: true });
    try {
      await fs.access(this.file);
    } catch {
      await this.write({ schema_version: DEFAULTS.registryVersion, sessions: {} });
    }
  }

  async list() {
    const data = await this.read();
    return Object.values(data.sessions).sort((a, b) => String(b.last_used_at).localeCompare(String(a.last_used_at)));
  }

  async describe(sessionId) {
    const data = await this.read();
    return data.sessions[sessionId] || null;
  }

  async upsert(session) {
    if (!session?.session_id || !session?.conversation_url) throw new Error("session_id and conversation_url are required");
    if (!SESSION_STATES.has(session.state || "active")) throw new Error("invalid session state");
    return this.withLock(async () => {
      const data = await this.read({ locked: true });
      const existing = data.sessions[session.session_id] || {};
      const value = {
        ...existing,
        ...session,
        conversation_url: canonicalConversationUrl(session.conversation_url),
        state: session.state || existing.state || "active",
        last_used_at: new Date().toISOString(),
      };
      data.sessions[value.session_id] = value;
      await this.write(data);
      return value;
    });
  }

  async mark(sessionId, state, note = null) {
    if (!SESSION_STATES.has(state)) throw new Error("invalid session state");
    return this.withLock(async () => {
      const data = await this.read({ locked: true });
      const existing = data.sessions[sessionId];
      if (!existing) throw new Error("unknown session");
      const value = { ...existing, state, note, last_used_at: new Date().toISOString() };
      data.sessions[sessionId] = value;
      await this.write(data);
      return value;
    });
  }

  async read(options = {}) {
    await this.initialize();
    let raw;
    try {
      raw = await readRegistryFile(this.file);
    } catch (error) {
      throw new Error("SESSION_REGISTRY_IO_ERROR: " + String(error.code || error.message));
    }
    try {
      const parsed = JSON.parse(raw);
      if (parsed.schema_version !== DEFAULTS.registryVersion || !parsed.sessions || typeof parsed.sessions !== "object") {
        throw new Error("invalid registry schema");
      }
      return parsed;
    } catch {
      if (options.locked) return this.recoverCorrupt();
      return this.withLock(() => this.recoverAfterLock());
    }
  }

  async recoverAfterLock() {
    const raw = await readRegistryFile(this.file);
    try {
      const parsed = JSON.parse(raw);
      if (parsed.schema_version === DEFAULTS.registryVersion && parsed.sessions && typeof parsed.sessions === "object") return parsed;
    } catch {}
    return this.recoverCorrupt();
  }

  async recoverCorrupt() {
    const backup = this.file + ".corrupt-" + Date.now();
    await fs.rename(this.file, backup);
    const fresh = { schema_version: DEFAULTS.registryVersion, sessions: {} };
    await this.write(fresh);
    return fresh;
  }

  async write(data) {
    await fs.mkdir(this.directory, { recursive: true });
    const temporary = this.file + ".tmp-" + process.pid + "-" + Date.now();
    const handle = await fs.open(temporary, "w");
    try {
      await handle.writeFile(JSON.stringify(data, null, 2) + "\n", "utf8");
      await handle.sync();
    } finally {
      await handle.close();
    }
    await fs.rename(temporary, this.file);
  }

  async withLock(action) {
    await fs.mkdir(this.directory, { recursive: true });
    let handle;
    try {
      handle = await fs.open(this.lock, "wx");
      const record = JSON.stringify({ owner: crypto.randomUUID(), pid: process.pid, created_at: new Date().toISOString() });
      await handle.writeFile(record, "utf8");
      await handle.sync();
    } catch (error) {
      if (error?.code === "EEXIST" && await removeStaleLock(this.lock)) return this.withLock(action);
      throw new Error("SESSION_REGISTRY_LOCKED");
    }
    try {
      return await action();
    } finally {
      await handle.close().catch(() => {});
      await fs.unlink(this.lock).catch(() => {});
    }
  }
}

export function canonicalConversationUrl(value) {
  let url;
  try {
    url = new URL(value);
  } catch {
    throw new Error("INVALID_DEEPSEEK_CONVERSATION_URL");
  }
  if (url.protocol !== "https:" || url.hostname !== "chat.deepseek.com") throw new Error("INVALID_DEEPSEEK_CONVERSATION_URL");
  url.username = "";
  url.password = "";
  url.search = "";
  url.hash = "";
  return url.toString();
}

async function readRegistryFile(file) {
  let lastError;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      return await fs.readFile(file, "utf8");
    } catch (error) {
      lastError = error;
      if (!["EBUSY", "EPERM", "EAGAIN"].includes(error?.code) || attempt === 2) throw error;
      await new Promise((resolve) => setTimeout(resolve, 50 * (attempt + 1)));
    }
  }
  throw lastError;
}

async function removeStaleLock(file) {
  const raw = await fs.readFile(file, "utf8").catch(() => null);
  if (!raw) return false;
  let record;
  try {
    record = JSON.parse(raw);
  } catch {
    return false;
  }
  if (!Number.isInteger(record.pid) || isProcessAlive(record.pid)) return false;
  await fs.unlink(file).catch(() => {});
  return true;
}

function isProcessAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code !== "ESRCH";
  }
}
