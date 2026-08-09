#!/usr/bin/env node
import { DsVisionEngine } from "./engine.mjs";

const action = process.argv[2] || "health";
const raw = process.argv[3] || "{}";

try {
  const payload = JSON.parse(raw);
  const engine = new DsVisionEngine();
  const result = await engine.handle({ action, ...payload });
  process.stdout.write(JSON.stringify(result, null, 2) + "\n");
} catch (error) {
  process.stderr.write("DS-VISION error: " + String(error?.message || error) + "\n");
  process.exitCode = 1;
}
