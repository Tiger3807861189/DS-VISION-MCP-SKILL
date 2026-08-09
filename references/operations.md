# DS-VISION 操作与会话约定

## 浏览器顺序

一次视觉请求按以下顺序执行：打开持久浏览器档案、核验编辑器、准备新对话或已保存对话、核验视觉模式、核验 DeepThink、上传媒体并确认预览、发送提示词、等待生成控件恢复且新出现的可见最终回答稳定、保存会话元数据。

任一步未能明确核验就停止。常见错误包括 `BROWSER_PROFILE_LOCKED`、`LOGIN_OR_COMPOSER_NOT_VERIFIED`、`VISION_MODE_NOT_VERIFIED_ENABLED`、`DEEP_THINK_NOT_VERIFIED_ENABLED`、`UPLOAD_CONTROL_NOT_FOUND`、`RESPONSE_FINAL_TEXT_TIMEOUT`、`SESSION_NOT_AVAILABLE`、`SESSION_CONTEXT_NOT_VERIFIED` 与 `SESSION_MISMATCH`。

## 上传

服务优先使用页面中的 `input[type=file]`。若页面只暴露上传控件，服务聚焦该控件并用 Enter 触发文件选择器。data URL 在内存中转为 Playwright 文件载荷，不写入浏览器档案。路径不存在、文件格式不支持、附件预览未出现或上传控件不可用时，服务不会把媒体标为已上传。

比较任务以独立 `media_id` 保存每个输入，并依次上传它们。不要拼接图片后再把拼接坐标当作原图坐标基础。

## 会话

`analyze` 与 `compare` 默认创建 A、B 两个独立新对话，并仅在 claim 冲突、唯一覆盖、未知项或风险触发时创建携带原图的第 3 次仲裁对话；每轮都返回可追溯 `session_id`。`rounds: 1` 可由调用 Agent 显式选择一次观察。`followup` 需要活跃的 `session_id`，且只询问该对话中已可见的材料。服务为最新可见用户消息和原始含附件用户消息分别建立上下文指纹；原始任务/媒体指纹不可被后续追问覆盖。恢复时服务核验规范化对话 URL、原任务标识、原始媒体、当前会话上下文和最后可见回答指纹；任一项无法匹配即返回 `SESSION_MISMATCH`，不会发送追问或更新记录。`sessions` 可以列出、读取或关闭本地记录。关闭记录不会删除浏览器对话。

浏览器档案设置文件锁，防止并发请求写入同一档案。会话注册表采用临时文件和原子重命名；解析失败的注册表会保留带时间戳的副本，再建立空注册表。

## 可见最终回答

只读取 `.ds-markdown.ds-assistant-message-main-content` 中在请求后出现的文本。只有生成控件已恢复且文本连续稳定时才接受最终回答；未出现新文本或持续变化超过超时时间时返回 `RESPONSE_FINAL_TEXT_TIMEOUT`。不读取任何思维面板、隐藏节点或中间响应。
