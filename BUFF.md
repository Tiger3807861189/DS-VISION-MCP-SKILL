# DS-VISION BUFF — 像素级证据补强层

DS-VISION（DeepSeek 网页端视觉服务）擅长：整体场景识别、文字逐字转写、大结构布局、明暗/色调对比。
它不可靠：精确坐标、小角度细节、小面积元素、精确颜色。

BUFF 是补强层：用 Playwright 像素测量与决定性 DOM 实验，把模型读数钉死在真实像素上。
**用法：DS-VISION 给结构与文字（可信）→ BUFF 验证几何与颜色（权威）→ 决策。**

## 命令速查

```bash
node scripts/ds-vision-buff.mjs <command> <img> [options]
```
坐标一律归一化 0..1；颜色 hex 不带 `#`。输出 JSON。

| 命令 | 用途 | 示例 |
|---|---|---|
| `size <img>` | 尺寸/宽高比（复刻画布第一步） | `size p1.jpg` → `{w:1734,h:868,aspect:1.998}` |
| `color <img> nx,ny... [--grid CxR]` | 单点/网格采样真实颜色（验证模型颜色估计） | `color p1.jpg 0.5,0.45 0.48,0.55` |
| `mask <img> --hex RRGGBB [--tol N] [--row-band y0,y1]` | 颜色掩码：区域 bbox（始终返回）+ 逐行 x 范围 | `mask p1.jpg --hex 8f7954` |
| `textlines <img> [--region x0,y0,x1,y1] [--dark 75]` | 暗像素行聚类 → 文字行位置/宽度（**region 必须限定在目标区域内部，避开深色边框**） | `textlines p1.jpg --region 0.33,0.25,0.67,0.82` |
| `trapezoid <img> --hex RRGGBB [--tol N]` | 梯形测量：上下边缘斜率 + 左右高度比（判断透视方向/角度） | `trapezoid p1.jpg --hex 8f7954` |
| `diff <imgA> <imgB> [--grid CxR] [--tol N]` | 网格级颜色差异 → 差异热点区域 | `diff p1.jpg replica.png --grid 10x6` |
| `tilt-test <angle>` | 决定性实验：CSS rotateY(正/负) 哪边靠镜头 | `tilt-test 14` |

## 实战判读规则

- **trapezoid 的 `ratioLeftOverRight > 1`** = 左边缘更高 = 左边更靠镜头（rotateY(+) 方向）。
  原图告示牌实测 `ratio 1.098`、`topSlope +0.05`、`botSlope -0.127` → 用它做复刻调参目标。
- **textlines 的 peakY** 是每行文字的垂直中心（面板相对坐标），直接喂给 CSS 布局。
- **mask --row-band** 给出每行目标颜色的 x 范围 → 面板左右边缘、元素边界。
- **diff 的 biggest** 列出差异最大的网格单元 → 优先检查这些区域。

## 本次任务的实证结论（2026-08-09）

| 项目 | DS-VISION 读数 | BUFF 像素实测 |
|---|---|---|
| 面板范围 | x 0.15–0.80, y 0.10–0.85（偏大 2 倍） | x 0.315–0.689, y 0.24–0.836 |
| 面板颜色 | #EFEAD8（米白） | #8f7954（深卡其，差很远） |
| 倾斜方向 | 两次读反、一次读成"零" | ratio 1.098 左近右远（与用户观察一致） |
| 屋顶有无 | 三次翻转 | （用户裁定：无，后面是山） |
| 文字 5 行 | 转写全对 | textlines 检出 5 个 band，peakY 与测量一致 |

## 注意事项

- **trapezoid 按"告示牌场景"硬编码扫描**：5 列固定 x 0.35–0.65，上边缘带 y 0.20–0.34、
  下边缘带 y 0.75–0.90。目标元素位置不同时需自行改脚本常量。
- **textlines 会丢弃 peakY ≥ 0.80 的 band**（防地面暗像素污染），且 `--region` 默认
  0.33,0.25,0.67,0.82（避开告示牌深色边框），换图时按需调整；
  输出中 peak < 0.3 的 band 多为边缘/纹理噪声，可忽略。
- mask/trapezoid 的 tol 默认 28，目标色有光照渐变时调大到 34。
- 涉及 CSS 3D 的几何（rotateY 方向、梯形）优先用 `tilt-test` / 数学投影验证，
  不要依赖模型对小角度的判断。
- 所有命令都通过 `data:` URL 注入像素，无需本地服务器。
