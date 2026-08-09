# DS-VISION V3

[English](README.en.md) | **简体中文**

作者：

1. [Tiger3807861189](https://github.com/Tiger3807861189)（第一作者）——负责项目的主要方案、提示词实验、工程实现、测试、文档与交付工作。
2. [7067567g](https://github.com/7067567g)（共同作者）——提出并启动通过官方网页端视觉能力为 Agent 提供视觉证据的思路。

DS-VISION 为没有原生视觉能力的代码 Agent 提供可审计的视觉证据。它使用已登录的浏览器视觉服务读取用户提供的图片或 PTS 索引视频帧，并把可见事实、不确定项、坐标边界与最小核验动作交给调用 Agent。

## 使用入口

全局只使用一个斜杠命令：`/DS-VISION`。

例如：

```text
/DS-VISION 分析这张界面截图的可见层级、逐字转写报错文字，并标出需要浏览器测量才能确认的内容。
```

服务内部使用一个 MCP 工具 `ds_vision`，并用 `action` 路由图片分析、追问、比较、视频帧规划、坐标映射、会话、健康检查和校准。动作名不是额外的使用者命令。

## 适用任务

- 界面结构、文字、颜色、形状与静态空间关系。
- 图片复刻需要的视觉锚点。
- 视觉验收、缺陷描述与多图并列比较。
- 经过 PTS 标记的离散视频截图检查。
- 图像归一化坐标到已测量几何空间的显式转换。

## 安装与配置

在本目录安装运行依赖：

```powershell
npm install
```

将 [mcp-config.example.json](mcp-config.example.json) 的绝对路径替换为实际路径，然后在 MCP 宿主中添加该服务器。该 MCP 配置只定义 stdio 服务，不包含宿主斜杠命令注册字段；在宿主支持别名时，只将 `/DS-VISION` 映射到 `$ds-vision-v3`，不要创建其他全局别名。部署完成后在宿主中实际核验该唯一映射。

首次使用会启动持久浏览器档案。请在该浏览器窗口中完成登录；服务不会索取或记录登录凭据。可选环境变量 `DS_VISION_DATA_DIR` 指定浏览器档案、会话和运行记录所在的私有目录。

图片输入使用本地路径或不超过 20 MiB 的 PNG、JPEG、WebP、GIF、BMP data URL。远程 URL 不由服务下载；先在调用 Agent 的授权范围内取得本地文件。

## MCP 请求示例

图片分析：

```json
{
  "action": "analyze",
  "inputs": ["C:\\work\\screen.png"],
  "objective": "转写可见报错，描述布局，并列出需要 DOM 核验的项目",
  "stage": "inspect",
  "evidence_mode": "text",
  "rounds": 1,
  "language": "zh"
}
```

多图比较：

```json
{
  "action": "compare",
  "inputs": ["C:\\work\\before.png", "C:\\work\\after.png"],
  "objective": "分别描述两张图的可见状态，并只报告各自图像内可确认的差异",
  "stage": "inspect"
}
```

视频提帧规划：

```json
{
  "action": "video",
  "objective": "建立逐帧静态观察 ledger",
  "duration_ms": 92000,
  "sampling": "auto"
}
```

返回的固定时间目标需要由外部提帧器转换为截图。每张截图随后必须带有实际 `frame_index` 与 `capture_pts_seconds` 的 manifest，才可执行视觉检查。`objective` 始终是必填项；执行视觉检查时 manifest 还必须给每帧可上传的 `source`。

## 证据与坐标

每个重要结论必须属于 `visible_fact`、`image_candidate`、`runtime_measurement_required` 或 `unknown`。文字按可见内容逐字转写；看不清时明确标为不确定。

坐标使用 `image_normalized_0_999` 时只表示图像候选位置。已知源图尺寸换算出的源像素也是图像候选投影；它们都不是 DOM、点击点、页面坐标、源码位置或隐藏状态。只有完整、具名的几何测量链存在时，`map` 才生成需要运行时确认的 `measurable_anchor`。

## 视频边界

离散帧只支持其列出的 PTS 时刻。执行时，服务要求逐帧静态原子账本：`frame=<n>|pts=<实际值>|atoms=[TEXT=...;COLOR=...;SHAPE=...;OBJECT=...;POSITION=...]`，并要求端点行保留 `unobserved_interval=unknown`。服务以实际 `frame` 与 `pts` 匹配 manifest，生成带 `media_id` 的结构化 claim；atom 中的反斜杠、等号、分号、方括号与圆括号使用 `\\`、`\=`、`\;`、`\[`、`\]`、`\(`、`\)` 可逆转义。默认结果标为 `independent_ab_static_arbitration`；显式 `rounds: 1` 标为 `single_static_observation`，不产生 A/B 一致性或仲裁确认。任何不符合账本 schema、不能匹配 manifest 或含过程性语言的批次都会以 `VIDEO_EVIDENCE_BOUNDARY_REJECTED` 拒绝，不能作为完成的视觉结论交付。

## 本地校验

```powershell
npm run validate
npm test
```

`npm run health` 只报告本地目录、唯一 MCP 工具和请求的宿主别名；它不验证宿主中的实际别名注册，也不替代登录、视觉模式或 DeepThink 核验。每个视觉请求都会重新核验这些运行时状态。

详细使用规范见 [SKILL.md](SKILL.md)。

## 后记

这份交付以可复查的工程证据作为质量依据，而不以未执行的线上结果代替验证：保留了阶段 1 的 36 + 4 条观察及其冻结记录，整理了原论文、V2 归档和全部执行计划的可追溯关系，并将可复用的浏览器与 MCP 思路重构为当前契约。

实现和调试覆盖持久浏览器锁、顺序上传与 data URL、可见最终回答稳定性、会话根身份、独立 A/B 观察与条件仲裁、完整坐标测量链、PTS 帧 manifest，以及 P13-A 静态视频账本。正式包包含 8 份用户/实现文档、16 个脚本、40 条自动化测试、40 条回答解析夹具和 20 条共识夹具。三轮独立审查后的修订和最终一致性审计均保存在仓库的开发记录中；`npm run check` 可重复执行当前校验。

这些记录说明本项目的质量控制是可检查、可重跑且有明确失败边界的。它们不替代部署者在实际宿主中核验 `/DS-VISION` 映射、登录状态、视觉模式、DeepThink 状态和具体任务结果。

## 参考文献

1. DeepSeek-AI. *Thinking with Visual Primitives*（2026）。点、框和视觉引用关系为图像原语与局部核验提供研究启发；该论文不构成本项目的线上性能声明。
2. Model Context Protocol. [Protocol Specification](https://modelcontextprotocol.io/specification/2024-11-05/basic)。MCP 消息、生命周期和工具接口的规范参考。
3. Microsoft. [Playwright Library Documentation](https://playwright.dev/docs/library)。持久浏览器与页面自动化实现参考。
4. Model Context Protocol. [TypeScript SDK](https://github.com/modelcontextprotocol/typescript-sdk)。本项目 stdio MCP 服务所依赖 SDK 的公开实现参考。
