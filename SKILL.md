---
name: ds-vision-v3
description: Use DS-VISION to turn supplied images and PTS-indexed video frames into auditable visual evidence for a coding agent without native vision.
---

# DS-VISION V3

将 `/DS-VISION` 设为唯一的宿主斜杠别名，并通过它调用视觉证据服务。将用户的自然语言目标、图片或已提取的视频帧交给服务；让服务返回另一名无视觉 Agent 可直接使用的可见事实、边界、不确定项与最小核验动作。

## 1. 任务定位

把 DS-VISION 用于界面理解、文本转写、空间关系、视觉缺陷定位、视觉复刻锚点、验收、多图比较和离散视频帧检查。它为代码 Agent 提供受证据约束的视觉输入，不替代浏览器测量、DOM 查询、源码阅读、网络检查或业务判断。

先保留用户的目标、优先级和允许的行动范围。不要把服务输出当作对实现、交互、运行状态或原因的无条件断言。

## 2. 唯一入口与动作路由

仅向使用者展示 `/DS-VISION`。不要创建或提示任何额外的全局斜杠命令。MCP stdio 配置本身没有斜杠命令注册字段；在宿主提供别名配置时，只把 `/DS-VISION` 映射到本 Skill，且在部署后由宿主核验该映射。

MCP 仅注册 `ds_vision` 一个工具。工具的 `action` 参数在同一入口内路由下列能力：

- `analyze`：图片的概览、细查、定位、复刻或验收。
- `followup`：对已保存会话提出受限追问。
- `compare`：在各自 `media_id` 下比较两张或更多图片。
- `video`：根据时长和 PTS manifest 制定或执行离散帧检查。
- `map`：在完整测量链存在时转换坐标或匹配几何候选。
- `sessions`：列出、读取或关闭本地会话记录。
- `health`：报告本地服务目录、唯一 MCP 工具和请求的宿主别名，不验证宿主别名是否已注册。
- `calibrate`：记录浏览器控件定位信息，不生成视觉结论。

把动作视为内部路由，不把动作名写成新的用户命令。

## 3. 输入与会话

为图片任务提供：`objective`、一个或多个本地图片路径或受支持的图片 data URL，以及可选的 `stage`、`evidence_mode`、`rounds`、`language`、`detail` 与 `session`。远程 URL 不会由服务下载；先由调用 Agent 在授权范围内取得本地文件。data URL 仅接受 PNG、JPEG、WebP、GIF 或 BMP，且不得超过 20 MiB。

独立任务默认执行 A、B 两次隔离的新对话观察，使用相同媒体与提示；不向 B 泄露 A 的回答。出现重要 claim 的冲突、唯一覆盖、未知项、低质量或视频风险时，执行携带原图和候选命题清单的第 3 次仲裁。若调用 Agent 判断一次观察已足够，可显式传 `rounds: 1`。只有在确需同一上下文追问时，保存返回的 `session_id`，再以 `followup` 使用它；服务恢复时核验对话 URL、最新可见上下文、不可覆盖的原始任务/媒体指纹和最后可见回答指纹，不匹配即返回 `SESSION_MISMATCH`。不要把无关任务混入同一会话。

为视频任务提供 `objective`，以及视频时长或含实际 `capture_pts_seconds` 的帧 manifest。若尚无帧 manifest，先让 `video` 返回固定时间目标；使用外部提帧器生成对应截图并写入实际 PTS 后再提交。不要要求无视觉 Agent 根据未见视频内容自行决定截图间隔。

详见 [操作与会话约定](references/operations.md) 和 [视频帧约定](references/video.md)。

## 4. 证据状态

要求每个重要结论标注以下之一：

- `visible_fact`：当前消息中直接可见的文字、颜色、形状、空间关系或静态画面事实。
- `image_candidate`：来自图像的候选定位、对应或视觉判断；尚未被运行时几何或其他证据确认。
- `runtime_measurement_required`：需要 DOM、浏览器、样式、可访问性树、网络、文件或运行时测量才能回答。
- `unknown`：当前材料不足、不可辨认，或处于未观察的时间区间。

逐字转写可读文字、数字、标点和截断；看不清就写 `uncertain` 或 `unknown`。实体、状态、所有者和指标只在同一可见行、卡片或明确连线的局部单元内绑定。

详见 [证据约定](references/evidence-contract.md)。

## 5. 坐标与代码边界

只在定位、裁剪、点击前核验、轨迹或复刻锚点确有需要时请求坐标。图像坐标默认使用整数归一化空间 `image_normalized_0_999`，并标为 `image_candidate`。根据已知源图尺寸计算出的 `source_image_pixels` 仅是同一图像候选的投影，不能独立成为页面或代码锚点。

坐标是图像与代码之间的桥梁，但不是自动映射。图像坐标不能直接成为页面坐标、DOM 节点、SVG/canvas/3D 对象、点击点、源码位置、网络请求或隐藏状态。

只有提供了具名的完整几何链（源图尺寸、裁剪、渲染尺寸、DPR、视口、滚动、目标空间等）时，才使用 `map` 生成 `measurable_anchor`。映射结果仍是待运行时确认的几何候选，不是代码定位结论。

详见 [证据约定](references/evidence-contract.md)。

## 6. 浏览器和模式前置条件

每次视觉请求都在持久浏览器档案中核验：登录后的编辑器可用、视觉模式已启用、DeepThink 已启用、对话可用、上传预览已出现、生成已结束且新回答稳定。任一状态无法明确核验时停止并返回明确错误；不要降级为猜测。

只从 `.ds-markdown.ds-assistant-message-main-content` 获取新出现且稳定的可见最终回答。不要读取、提取、保存或返回隐藏推理节点、思维面板或内部中间内容。

上传优先使用真实文件输入控件；必要时聚焦上传控件并以 Enter 打开文件选择器。上传失败时保留原任务并报告错误，不伪造媒体已上传。

## 7. 提示词与结果处理

让服务按任务选择概览、细查、定位、复刻、验收或逐帧检查模块。保留 Agent 对语言、任务拆分、工具顺序、提问和停止条件的自主权；提示词只提供证据边界、输出要求和当前媒体清单。

把可见最终回答和其哈希写入 evidence packet。可以提取归一化点或框作为视觉原语，并从带证据状态标记的可见结论行或通过严格帧/PTS 校验的静态视频 ledger 行提取 claim；不要从其他未标记自然语言自动虚构实体、因果、DOM 或实现 claim。需要额外的正式 claim ledger 时，由调用 Agent 依据可见回答和明确锚点显式建立。

## 8. 离散视频

帧记录必须包含 `frame_index`、实际 `capture_pts_seconds`、`media_id` 与可上传的帧源。先用固定时间间隔覆盖全段，再仅因明确的视觉不确定性或任务需要而加密指定区间。

执行离散帧检查默认运行隔离 A、B 和第 3 次仲裁；结果以 `verification_mode: independent_ab_static_arbitration` 标记。调用 Agent 显式传入 `rounds: 1` 时，只执行一次静态观察，结果以 `verification_mode: single_static_observation` 标记，不产生 A/B 一致性或仲裁确认。A、B 观察必须只输出静态原子账本：每个输入帧一行 `frame=<n>|pts=<实际值>|atoms=[TEXT=...;COLOR=...;SHAPE=...;OBJECT=...;POSITION=...]`，随后恰好一行 `endpoint=[A(... )|B(... )|unobserved_interval=unknown]`、`coordinate_status=none` 与 `refine_interval=none`。原子只能是逐字文字、颜色、形状、静态物体名词或静态位置；服务以 `frame` 与 `pts` 的精确 manifest 匹配将其绑定回 `media_id`。atom 值内的反斜杠、等号、分号、方括号和圆括号使用 `\\`、`\=`、`\;`、`\[`、`\]`、`\(`、`\)` 可逆转义。第 3 次仲裁只允许逐项输出 `decision=C编号:confirmed|rejected|corrected|unknown`，不复述候选或输出额外的视频叙述。

不要从离散帧断言连续镜头、轨迹、速度、原因、持续状态、同步或精确变化时刻。服务拒绝任何不符合账本 schema、未覆盖本批全部帧、未保留 `unobserved_interval=unknown`、含过程词或不能匹配实际 PTS 的批次，并返回 `VIDEO_EVIDENCE_BOUNDARY_REJECTED`。

## 9. 错误、隐私与可恢复性

浏览器档案同一时间仅允许一个请求使用。遇到档案锁、登录/模式未核验、上传失败、会话不可用、最终回答超时、视频边界拒绝或不完整几何链时，返回 `{ code, message, manual_action }`，给出最小人工处理动作。

本地会话记录只保存会话标识、脱敏对话 URL、状态、任务标识、媒体指纹、提示词版本与可见回答指纹等服务元数据，不保存媒体原文、浏览器凭据或隐藏推理。运行记录不写浏览器凭据，不读取隐藏推理。将 `DS_VISION_DATA_DIR` 放在用户可管理的私有目录；需要清除本地记录时由用户显式删除该目录。

## 10. 调用后的行动

收到结果后：

1. 先按证据状态筛选可直接使用的 `visible_fact`。
2. 把 `image_candidate` 当作需要浏览器或几何核验的候选。
3. 为 `runtime_measurement_required` 调用合适的浏览器、DOM、代码或网络工具；像素级几何与颜色优先使用仓库自带的 [scripts/ds-vision-buff.mjs](scripts/ds-vision-buff.mjs)（方法见 [BUFF.md](BUFF.md)）。
4. 保留 `unknown`，不要用推测补齐。
5. 将视觉证据、运行时测量与代码证据分别记录，再决定实现或验收。

**特别注意**：DS-VISION 在大结构与文字转写上可信，但精确坐标、小角度细节、小面积元素、精确颜色不可靠。遇到后三者务必用 [BUFF 工具](scripts/ds-vision-buff.mjs) 做像素测量验证（方法见 [BUFF.md](BUFF.md)），不要直接用模型读数。

使用前阅读 [单一入口约定](references/command-contract.md)、[架构](references/architecture.md)、[证据约定](references/evidence-contract.md)、[操作与会话约定](references/operations.md)、[视频帧约定](references/video.md) 与 [像素补强方法](BUFF.md)。
