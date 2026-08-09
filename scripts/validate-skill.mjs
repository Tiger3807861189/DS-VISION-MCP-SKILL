import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const required = [
  "SKILL.md",
  "README.md",
  "agents/openai.yaml",
  "mcp-config.example.json",
  "scripts/ds-vision-mcp.mjs",
  "scripts/engine.mjs",
  "scripts/browser-adapter.mjs",
  "references/command-contract.md",
  "references/architecture.md",
  "references/evidence-contract.md",
  "references/operations.md",
  "references/video.md",
];
const formalDocuments = [
  "SKILL.md",
  "README.md",
  "references/command-contract.md",
  "references/architecture.md",
  "references/evidence-contract.md",
  "references/operations.md",
  "references/video.md",
];

const errors = [];
for (const relative of required) {
  try {
    await fs.access(path.join(root, relative));
  } catch {
    errors.push("Missing required artifact: " + relative);
  }
}

const skill = await read("SKILL.md");
if (!/^---\nname: ds-vision-v3\ndescription: .+\n---\n/m.test(skill)) {
  errors.push("SKILL.md frontmatter must contain only name and description in the required order");
}
if (skill.split(/\r?\n/).length > 500) errors.push("SKILL.md must stay within 500 lines");
if (!skill.includes("/DS-VISION") || !skill.includes("`ds_vision`")) {
  errors.push("SKILL.md must document the single /DS-VISION entry and ds_vision tool");
}

const agentYaml = await read("agents/openai.yaml");
if (!agentYaml.includes('display_name: "DS-VISION V3"') || !agentYaml.includes("/DS-VISION")) {
  errors.push("agents/openai.yaml must use DS-VISION V3 and the single entry");
}

const mcp = await read("scripts/ds-vision-mcp.mjs");
if ((mcp.match(/registerTool\s*\(/g) || []).length !== 1 || !mcp.includes('"ds_vision"')) {
  errors.push("MCP server must register exactly one ds_vision tool");
}

for (const relative of formalDocuments) {
  const text = await read(relative);
  if (/\b(?:TODO|TBD|TBC)\b/.test(text)) errors.push(relative + " contains unfinished placeholder text");
  if (/DS-Vision/.test(text)) errors.push(relative + " contains non-uppercase DS-VISION spelling");
  if (/(旧版|新版|老版|升级前|升级后|相较|相比|改进了|前代|历史版本)/.test(text)) {
    errors.push(relative + " contains a prohibited version-comparison expression");
  }
}

if (!errors.length) {
  process.stdout.write("DS-VISION skill validation passed.\n");
} else {
  for (const error of errors) process.stderr.write("Validation error: " + error + "\n");
  process.exitCode = 1;
}

async function read(relative) {
  return fs.readFile(path.join(root, relative), "utf8");
}
