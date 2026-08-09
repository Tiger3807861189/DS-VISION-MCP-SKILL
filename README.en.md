# DS-VISION V3

**English** | [简体中文](README.md)

Authors:

1. [Tiger3807861189](https://github.com/Tiger3807861189) (lead author) — responsible for the principal project design, prompt experiments, engineering implementation, testing, documentation, and delivery.
2. [7067567g](https://github.com/7067567g) (co-author) — proposed and initiated the approach of providing agents with visual evidence through the official web-based vision capability.

DS-VISION provides auditable visual evidence to coding agents that do not have native vision. It uses an already signed-in browser-based vision service to inspect user-provided images or PTS-indexed video frames, then returns visible facts, uncertainty, coordinate boundaries, and the minimum follow-up verification required from the calling agent.

## Entry Point

Use exactly one global slash command: `/DS-VISION`.

For example:

```text
/DS-VISION Analyze the visible hierarchy of this UI screenshot, transcribe the error text exactly, and identify anything that requires browser measurement to confirm.
```

Internally, the service exposes one MCP tool, `ds_vision`. Its `action` parameter routes image analysis, follow-up, comparison, video-frame planning, coordinate mapping, sessions, health checks, and calibration. Action names are not additional user commands.

## Suitable Tasks

- UI structure, text, color, shape, and static spatial relationships.
- Visual anchors needed to reproduce an image.
- Visual acceptance checks, defect descriptions, and side-by-side image comparison.
- Discrete inspection of video screenshots that carry PTS metadata.
- Explicit conversion from normalized image coordinates into an already measured geometry space.

## Installation and Configuration

Install the runtime dependencies in this directory:

```powershell
npm install
```

Replace the absolute-path placeholder in [mcp-config.example.json](mcp-config.example.json), then add the server in your MCP host. The example defines only a stdio server; it does not contain a universal slash-command registration field. If the host supports aliases, map only `/DS-VISION` to `$ds-vision-v3` and create no other global aliases. Verify that one mapping in the host after deployment.

The first use opens a persistent browser profile. Sign in in that browser window; the service never requests or stores login credentials. The optional `DS_VISION_DATA_DIR` environment variable selects a private location for the browser profile, sessions, and run records.

Image inputs must be local paths or PNG, JPEG, WebP, GIF, or BMP data URLs no larger than 20 MiB. The service does not download remote URLs. Obtain a local file first, within the calling agent's authorization scope.

## MCP Request Examples

Image analysis:

```json
{
  "action": "analyze",
  "inputs": ["C:\\work\\screen.png"],
  "objective": "Transcribe the visible error, describe the layout, and list items that need DOM verification.",
  "stage": "inspect",
  "evidence_mode": "text",
  "rounds": 1,
  "language": "en"
}
```

Multi-image comparison:

```json
{
  "action": "compare",
  "inputs": ["C:\\work\\before.png", "C:\\work\\after.png"],
  "objective": "Describe each image independently and report only differences that are visually confirmable within the respective images.",
  "stage": "inspect"
}
```

Video frame-planning:

```json
{
  "action": "video",
  "objective": "Build a frame-by-frame static observation ledger.",
  "duration_ms": 92000,
  "sampling": "auto"
}
```

An external frame extractor must turn the returned fixed-time targets into screenshots. Every screenshot must then receive a manifest with its actual `frame_index` and `capture_pts_seconds` before visual inspection can run. `objective` is always required. When visual inspection is requested, the manifest must also provide an uploadable `source` for every frame.

## Evidence and Coordinates

Every important conclusion must be one of `visible_fact`, `image_candidate`, `runtime_measurement_required`, or `unknown`. Text is transcribed from what is visible; unreadable content is explicitly marked uncertain.

Coordinates in `image_normalized_0_999` represent only a candidate location in the image. Source pixels derived from known image dimensions are also image-candidate projections. Neither is a DOM location, click target, page coordinate, source-code location, or hidden state. Only a complete, named geometric measurement chain allows `map` to create a `measurable_anchor`, which still requires runtime confirmation.

## Pixel-Level Backstop (BUFF)

The visual service reports coordinates as model estimates (`image_candidate`
grade); small angles, fine details and exact colors need runtime confirmation.
The repo ships a browser-independent pixel-evidence tool,
[scripts/ds-vision-buff.mjs](scripts/ds-vision-buff.mjs), which decodes images
with Playwright and prints JSON the agent can consume directly:

```bash
node scripts/ds-vision-buff.mjs size <img>                 # dimensions / aspect
node scripts/ds-vision-buff.mjs color <img> 0.5,0.45       # real colors (points/grid)
node scripts/ds-vision-buff.mjs mask <img> --hex 8f7954    # color-region bbox / row spans
node scripts/ds-vision-buff.mjs textlines <img>            # text-line positions
node scripts/ds-vision-buff.mjs trapezoid <img> --hex ...  # perspective trapezoid metrics
node scripts/ds-vision-buff.mjs diff <a> <b>               # grid diff hotspots
node scripts/ds-vision-buff.mjs tilt-test <angle>          # decisive rotateY direction test
```

Recommended workflow: let the visual service supply structure and verbatim
transcriptions (trustworthy), then let BUFF pin down geometry and colors
(authoritative) before deciding. See [BUFF.md](BUFF.md) for the method notes
and [scripts/tune-tilt.mjs](scripts/tune-tilt.mjs) for tilt calibration.

## Video Boundary

Discrete-frame inspection is limited to the listed PTS instants. Execution requires a per-frame static atomic ledger:

```text
frame=<n>|pts=<actual value>|atoms=[TEXT=...;COLOR=...;SHAPE=...;OBJECT=...;POSITION=...]
```

Endpoint rows must retain `unobserved_interval=unknown`. The service matches actual `frame` and `pts` values to the manifest and creates structured claims carrying `media_id`. Within an atom, backslash, equals sign, semicolon, square brackets, and parentheses use reversible `\\`, `\=`, `\;`, `\[`, `\]`, `\(`, and `\)` escapes.

The default result is labelled `independent_ab_static_arbitration`. Explicit `rounds: 1` is labelled `single_static_observation`; it does not claim A/B agreement or arbitration confirmation. Any batch that violates the ledger schema, cannot match the manifest, or contains process language is rejected with `VIDEO_EVIDENCE_BOUNDARY_REJECTED` and is not delivered as a completed visual conclusion.

## Local Validation

```powershell
npm run validate
npm test
```

`npm run health` reports only the local directory, the one MCP tool, and the requested host alias. It does not verify the alias registration in a host, and it does not replace login, vision-mode, or DeepThink checks. Every visual request rechecks those runtime states.

See [SKILL.md](SKILL.md) for the complete operating instructions.

## Engineering Afterword

This delivery grounds its quality in reviewable engineering evidence rather than in unperformed online claims. It preserves the 36 + 4 Phase 1 observations and their freeze records, traces the original paper, the V2 archive, and the execution plans, and rebuilds reusable browser and MCP ideas into the current contract.

Implementation and debugging covered the persistent browser lock, sequential uploads and data URLs, stable visible-final-response capture, immutable session-root identity, independent A/B observations with conditional arbitration, complete coordinate measurement chains, PTS frame manifests, and the P13-A static video ledger. The formal package contains eight user and implementation documents, sixteen scripts, 40 automated tests, 40 answer-parsing fixtures, and 20 consensus fixtures. Three independent review rounds, the resulting corrections, and the final consistency audit are retained in the repository's development record. Run `npm run check` to repeat the current validation.

These records show that the quality controls are inspectable, repeatable, and bounded by explicit failure conditions. They do not replace deployment-time verification of the `/DS-VISION` mapping, login state, vision mode, DeepThink state, or the result of a particular task in the target host.

## References

1. DeepSeek-AI. *Thinking with Visual Primitives* (2026). Its treatment of points, boxes, and visual reference relationships informed the image-primitive and local-verification approach; it is not a claim of this project's online performance.
2. Model Context Protocol. [Protocol Specification](https://modelcontextprotocol.io/specification/2024-11-05/basic). Reference for MCP messages, lifecycle, and tool interfaces.
3. Microsoft. [Playwright Library Documentation](https://playwright.dev/docs/library). Reference for the persistent-browser and page-automation implementation.
4. Model Context Protocol. [TypeScript SDK](https://github.com/modelcontextprotocol/typescript-sdk). Public implementation reference for the SDK used by this stdio MCP service.
