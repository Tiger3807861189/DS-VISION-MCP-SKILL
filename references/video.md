# DS-VISION 视频帧约定

## 固定时间采样

无视觉 Agent 无法从未见视频内容决定合理间隔。DS-VISION 仅根据提供的时长和选择的固定采样档位生成目标时间；自动档按时长生成覆盖性间隔，且不会短于 1.5 秒。用户或调用 Agent 可以明确请求 1.5 秒、1 秒、0.5 秒、0.2 秒或 0.1 秒。

先以固定间隔覆盖目标片段，再针对明确的视觉不确定性、对象细节或任务风险请求加密指定区间。不要因为端点看起来不同而直接假定中间发生了连续过程。

## manifest

每个帧必须有：

- `frame_index`：整数帧序号。
- `capture_pts_seconds`：实际捕获 PTS，严格递增。
- `media_id`：该图片在当前任务中的标识。
- `source`：可上传的帧文件路径。

可选字段包含源视频哈希、时长、采样档位、提帧器版本和裁剪信息。任何视觉结论必须引用 `media_id`；需要时间结论时同时引用 `frame_index` 与 `capture_pts_seconds`。

## 静态 ledger

执行时，A、B 观察的完整可见输出只能由下列行构成，不接受标题、概览、解释、完整句子、Markdown 或额外行：

```text
frame=<n>|pts=<实际值>|atoms=[TEXT=<逐字文字>;COLOR=<颜色>;SHAPE=<形状>;OBJECT=<静态物体名词>;POSITION=<静态位置>]
endpoint=[A(frame=<n>,pts=<实际值>,atoms=TEXT=<逐字文字>;COLOR=<颜色>;SHAPE=<形状>;OBJECT=<静态物体名词>;POSITION=<静态位置>)|B(frame=<n>,pts=<实际值>,atoms=TEXT=<逐字文字>;COLOR=<颜色>;SHAPE=<形状>;OBJECT=<静态物体名词>;POSITION=<静态位置>)|unobserved_interval=unknown]
coordinate_status=none
refine_interval=none
```

每个输入帧恰好一条 `frame` 行；`frame` 和 `pts` 必须与 manifest 中的实际值精确匹配。服务用该二元组查回对应 `media_id`，并把它写入结构化 claim。`atoms` 至少一项、最多二十项；每项仅可使用 `TEXT`、`COLOR`、`SHAPE`、`OBJECT` 或 `POSITION`，且只描述当前单帧。`endpoint` 的 A、B 分别为本批最早和最晚的实际 PTS；若本批只有一帧，两端可指向同一帧。

`TEXT` 逐字保留可见内容。为保持一行 schema，任一 atom 值中的反斜杠、等号、分号、方括号或圆括号必须依次写成 `\\`、`\=`、`\;`、`\[`、`\]`、`\(`、`\)`；服务按该可逆规则还原文本。除这些字符外不得使用反斜杠转义。该规则同样适用于端点中的 atom 值。

对于云状、羽状或团状像素，只用颜色、形状和位置原子。不得把它写成排放、燃烧、飘散、移动、持续、事件或跨帧变化。输出不得包含过程性中文词，也不得包含 `occurred`、`happened`、`explosion`、`moving`、`trajectory`、`speed`、`camera`、`transition`、`zoom`、`smoke`、`emission`、`burning`、`spreading` 或 `continuing`。

离散视频默认进行 A、B 两次独立静态观察和第 3 次仲裁，并以 `verification_mode: independent_ab_static_arbitration` 标记结果。显式 `rounds: 1` 仅执行一次静态观察，返回 `verification_mode: single_static_observation`，不产生 A/B 一致性或仲裁确认。仲裁只输出每个候选的一行 `decision=C编号:confirmed|rejected|corrected|unknown`，不输出原子以外的叙述，也不复述候选。任何账本 schema、原子、端点未知区间、帧覆盖或 manifest 匹配不符合要求的批次，均以 `VIDEO_EVIDENCE_BOUNDARY_REJECTED` 拒绝，不作为完成的视觉结果返回。
