import { EVIDENCE_MODES } from "./constants.mjs";

const CORE_ZH = [
  "你是无视觉代码 Agent 的视觉证据伙伴。",
  "只依据当前消息提供的图片、帧序列和明确附带的测量或 manifest 工作。",
  "不要把静态像素当成 DOM、CSS、事件、网络、后端、源码、代码位置或不可见状态的事实。",
  "保留用户原始目标；交付可供另一名 Agent 行动的可见事实、不确定项和最小下一核验，不输出草稿或内部思维。",
  "重要结论标明 visible_fact、image_candidate、runtime_measurement_required 或 unknown。",
  "逐字转写文字、数字、标点和截断；看不清写 uncertain。实体、状态、所有者或指标只在同一可见行、卡片或明确连线的局部单元内绑定。",
  "仅在定位、比较、裁剪、点击前核验、轨迹或复刻锚点确有需要时给坐标。图像坐标默认是 image_candidate，使用 image_normalized_0_999；只有附带完整测量链时才给 measurable_anchor，并写明具名坐标空间和单位。",
  "图像坐标不是页面、DOM、SVG、canvas、3D 对象、点击或代码位置。缺少尺寸、裁剪、缩放、DPR、滚动或几何链时，写 runtime_measurement_required、image_candidate 或 unknown。",
  "帧序列只说明已列 frame_index 和实际 PTS 的画面；未观察区间写 unknown，不把端点差异叙述为连续镜头、轨迹、速度、原因、持续状态、同步或精确变化时刻。",
].join("\n");

const STAGE_MODULES_ZH = Object.freeze({
  overview: "先概括任务相关的场景、层级、前景背景或已采样时间范围。未知图片或视频先给可复刻的 1:1 自然语言场景图；无定位需要时写 coordinate_status: none。",
  inspect: "按用户目标检查可见对象、文字、空间关系和异常。把视觉事实与需要浏览器、DOM、样式或代码测量的事项分开。",
  localize: "只为被请求的可见目标提供紧凑坐标。每个坐标绑定 media_id、对象身份、coordinate_status、coordinate_basis、单位和边界不确定性。",
  reproduce: "描述可见布局、层级、空间关系、文字、颜色、形状、排版和复刻锚点。实现建议必须标记为 runtime_measurement_required 或 implementation_hypothesis，不能伪装成像素事实。",
  verify: "给出 pass、fail 或 unknown 的视觉检查。每个 fail 说明可见症状、证据锚点和最小 DOM、CSS、浏览器或几何核验。",
  trace: "逐帧绑定 frame_index 与 capture_pts_seconds。对同一可识别目标才建立稀疏时间坐标记录；身份、帧或时间不足时写 unknown。",
});

const MODE_MODULES_ZH = Object.freeze({
  boxes: "仅给任务需要的紧凑框，格式为 [x1,y1,x2,y2]，整数范围 0 到 999。",
  points: "仅给任务需要的可见地标中心点，格式为 [x,y]，整数范围 0 到 999。",
  trajectory: "每个轨迹样本同时给 frame_index、capture_pts_seconds、对象身份、坐标和置信度；缺失样本保留 gap=unknown。",
  mixed: "为每个目标选择最少的点、框或轨迹表达，不为格式完整性追加装饰性坐标。",
  text: "优先可见文字、层级和空间关系；没有定位需要时不输出坐标。",
});

const STATIC_VIDEO_ATOMS_ZH = [
  "[V05 静态原子标签]",
  "只输出下列严格 schema 行，不写标题、概览、解释、完整句子、Markdown 或额外说明：",
  "frame=<n>|pts=<实际值>|atoms=[TEXT=<逐字文字>;COLOR=<颜色>;SHAPE=<形状>;OBJECT=<静态物体名词>;POSITION=<静态位置>]",
  "endpoint=[A(frame=<n>,pts=<实际值>,atoms=TEXT=<逐字文字>;COLOR=<颜色>;SHAPE=<形状>;OBJECT=<静态物体名词>;POSITION=<静态位置>)|B(frame=<n>,pts=<实际值>,atoms=TEXT=<逐字文字>;COLOR=<颜色>;SHAPE=<形状>;OBJECT=<静态物体名词>;POSITION=<静态位置>)|unobserved_interval=unknown]",
  "coordinate_status=none",
  "refine_interval=none",
  "每个输入帧恰好一行，frame 和 pts 必须逐项使用媒体清单中的实际值。atoms 至少一个、最多二十个；每个 atom 只用 TEXT、COLOR、SHAPE、OBJECT 或 POSITION，且只描述该行单帧。",
  "atom 值中的反斜杠、等号、分号、方括号或圆括号必须分别写为 `\\\\`、`\\=`、`\\;`、`\\[`、`\\]`、`\\(`、`\\)`；服务按此可逆规则还原逐字 TEXT。其他反斜杠转义无效。",
  "对于结构上方的云状、羽状或团状可见区域，只用 COLOR、SHAPE 和 POSITION 原子。不得写排放、燃烧、飘散、移动、持续或活动。",
  "最终回答内不得出现：冒、喷、飘、行走、正在、仍然、变为、发生、保持、场景、镜头、视角、移动、切换、转场、过程、变化、转换、速度、轨迹、动画；也不得出现 occurred、happened、explosion、moving、trajectory、speed、camera、transition、zoom、smoke、emission、burning、spreading、continuing。",
  "endpoint 的 A 与 B 分别绑定本批最早和最晚实际 PTS；未观察区间只能为 unobserved_interval=unknown。",
].join("\n");

export function chooseStage(request) {
  if (request.stage !== "auto") return request.stage;
  const objective = String(request.objective || "").toLowerCase();
  if (/video|frame|动画|视频|帧|轨迹/.test(objective)) return "trace";
  if (/复刻|reproduce|replicate|还原/.test(objective)) return "reproduce";
  if (/坐标|定位|locate|点击|crop|裁剪/.test(objective)) return "localize";
  if (/检查|验收|verify|bug|异常|错误/.test(objective)) return "verify";
  if (/细查|inspect|文字|转写/.test(objective)) return "inspect";
  return "overview";
}

export function chooseEvidenceMode(request, stage) {
  if (request.evidence_mode !== "auto") return request.evidence_mode;
  if (stage === "localize") return "boxes";
  if (stage === "trace") return "trajectory";
  return "text";
}

export function compilePrompt(request, mediaManifest = [], options = {}) {
  const stage = chooseStage(request);
  const evidenceMode = chooseEvidenceMode(request, stage);
  if (!EVIDENCE_MODES.has(evidenceMode)) throw new Error("unsupported evidence mode");
  const mediaLines = mediaManifest.map((item) => {
    const frame = item.frame_index == null ? "" : "; frame_index=" + item.frame_index;
    const pts = item.capture_pts_seconds == null ? "" : "; capture_pts_seconds=" + item.capture_pts_seconds;
    return "- media_id=" + item.media_id + "; name=" + item.name + frame + pts;
  });
  const lines = [
    CORE_ZH,
    "",
    "[当前任务]",
    String(request.objective),
    "",
    "[阶段模块]",
    STAGE_MODULES_ZH[stage],
    MODE_MODULES_ZH[evidenceMode] || "",
  ];
  if (options.staticVideoAtoms) lines.push(STATIC_VIDEO_ATOMS_ZH);
  if (mediaLines.length) lines.push("", "[媒体清单]", ...mediaLines);
  lines.push("", "只输出最终可见交付。");
  return {
    prompt: lines.filter(Boolean).join("\n"),
    stage,
    evidence_mode: evidenceMode,
    prompt_protocol: options.staticVideoAtoms ? "v3-core-static-frame-ledger" : "v3-core",
  };
}

export function compileFollowupPrompt(question, priorClaims = []) {
  const anchors = priorClaims.slice(0, 12).map((claim) => {
    return "- claim_id=" + claim.claim_id + "; statement=" + claim.statement;
  });
  return [
    CORE_ZH,
    "",
    "[历史追问]",
    "只核验当前会话中可见的下列 claim。若材料未在当前会话可见，写 unknown；如修正，写 corrected 并说明替换的 claim_id。",
    ...anchors,
    "",
    "[问题]",
    String(question),
    "",
    "只输出最终可见交付。",
  ].join("\n");
}

export function compileArbitrationPrompt(candidates, options = {}) {
  const visibleCandidates = options.staticVideoAtoms ? candidates : candidates.slice(0, 24);
  const lines = visibleCandidates.map((claim, index) => {
    return "C" + String(index + 1) + ": " + claim.statement + "；来源=" + claim.source_round_id;
  });
  if (options.staticVideoAtoms) {
    return [
      CORE_ZH,
      "",
      "[离散帧静态复核]",
      "下列是候选静态原子记录，不是事实。重新查看当前消息中的原始帧后，只对每个候选输出一行 `decision=C编号:confirmed|rejected|corrected|unknown`。不得复述候选、不得写原子外的文字、不得输出过程或跨帧结论。每个 C 编号必须恰好出现一次。",
      ...lines,
      "",
      "只输出最终可见交付。",
    ].join("\n");
  }
  return [
    CORE_ZH,
    "",
    "[独立复核任务]",
    "下列是两次独立观察得到的候选命题，不是事实。请重新查看当前消息中的原始图片，逐条以 `C编号: confirmed|rejected|corrected|unknown` 开始，并在同一行写 `visible_fact`、`image_candidate`、`runtime_measurement_required` 或 `unknown` 及最小可见证据锚点。不要复述隐藏推理，不要把候选命题当成已确认结论。",
    ...lines,
    "",
    "只输出最终可见交付。",
  ].join("\n");
}

export { CORE_ZH, STATIC_VIDEO_ATOMS_ZH };
