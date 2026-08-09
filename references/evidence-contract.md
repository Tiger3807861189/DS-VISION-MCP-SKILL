# DS-VISION 证据约定

## 证据状态

| 状态 | 可以写入 | 不可以写入 |
| --- | --- | --- |
| `visible_fact` | 当前图像或列出帧中直接可见的文字、颜色、形状和局部空间关系 | 不可见 DOM、代码、网络、业务原因 |
| `image_candidate` | 归一化图像中的候选框、点、视觉对应，以及由已知源图尺寸换算出的源像素投影 | 已确认的点击对象、页面元素、源码位置 |
| `runtime_measurement_required` | 需要浏览器、DOM、样式、运行时、文件或网络检查的事项 | 假装已从像素核验 |
| `unknown` | 模糊内容、缺失材料、未观察区间 | 用猜测补齐的事实 |

## 文本、实体与关系

逐字转写可见文字、数字、标点和截断。无法辨认的字符用 `uncertain` 标记。只在同一可见行、卡片或明确连线的局部视觉单元内绑定实体、状态、所有者或指标；同页出现不构成关系或因果。

## 坐标链

默认坐标空间是 `image_normalized_0_999`，整数范围 0 到 999。它的 `coordinate_status` 必须是 `image_candidate`。按已知图像尺寸换算的 `source_image_pixels` 保留为该图像候选的投影，不能单独升级为锚点。

`measurable_anchor` 需要可复核的具名链，且服务强制要求 `media_id`、数值坐标、单位、源图尺寸、坐标图尺寸、从源图裁剪矩形、渲染源矩形、渲染 CSS 尺寸、DPR、视口位置、页面滚动和目标几何 manifest 标识。链如下：

```text
image_normalized_0_999
  -> source_image_pixels (源图宽高)
  -> viewport_css_pixels (渲染尺寸、视口位置、DPR)
  -> page_css_pixels (滚动偏移)
  -> runtime geometry candidates (目标几何 manifest)
```

任一环缺少时停止转换，返回 `runtime_measurement_required`、`image_candidate` 或 `unknown`。当前完整链只结束于 `page_css_pixels`：anchor 的 `media_id` 必须等于链中的 `media_id`，anchor 的坐标基准、链中的目标空间和映射请求的目标空间必须都是 `page_css_pixels`。`anchor_to_geometry_candidates` 的 `geometry_manifest.manifest_id` 必须与坐标链中的 `target_geometry.manifest_id` 相同；任一项不相同即停止映射。几何候选必须在运行时确认，不能被称为 DOM、点击或源码事实。

## evidence packet

每个 packet 包含任务与轮次标识、提示词哈希、公开媒体标识、可见最终回答、回答哈希、调用方显式提交的 claim、从带证据状态的可见结论行提取的 claim、可见点框原语和边界告警。离散视频的严格静态 ledger 以 `frame` 与 `pts` 匹配 manifest 后生成带 `media_id`、`frame_index` 和 `capture_pts_seconds` 的 claim。未标记的自然语言不会被自动扩展为 claim。它不保存 DeepThink 隐藏推理或浏览器凭据。
