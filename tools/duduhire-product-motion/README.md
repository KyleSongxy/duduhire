> 2026-09-14：当前页面使用 V2 4K 视频及海报。下方 V1 验收为历史记录。`.generated/*/frames` 已清理，render.sh / render-hd.sh 可重建；成片、工程、输入及 QA 保留。见 [清理记录](../../docs/maintenance/2026-09-14-cleanup.md)。

> 2026-09-21：已移除退役的 cinematic V3–V7 工具目录；现役制作需要的首页截图和探针纹理分别保留在 `reference/home-demand.png`、`engine-probe/concept-preview.png`，内容哈希未变。本工具不再依赖其他影片工具的生成缓存。历史 `engine-probe/report.json` 中的旧路径仅记录当时来源。

# DuduHire 平台产品动效片

用户已确认 [44 秒视觉方向与分镜](creative-brief.md)。独立预览 v1 已完成；2026-09-09 根据用户要求升级为 4K v2 并接入“工作方式”页，进入页面自动静音播放。

## v1 原始规格与内容范围

- 44 秒，1920×1080，30 fps，1320 帧，H.264 MP4，无音轨。
- DuduHire 现有 Logo、白/黑/森林绿/浅绿体系与网站视觉资产。
- 以同一组知识库示例讲解需求整理、经历提炼、来源依据和本人确认。
- 34–40 秒采用获批方案中的资料对照分支，标题为“看清工作与能力”。这段不是新生成的真实匹配结果。
- 界面图层按当前文案和组件关系为视频重排，持续标明“产品交互演示 · 示例内容”；不将它当作真实 AI 服务验收录屏。
- 独立预览完成后，用户于 2026-09-09 授权将本片接入“工作方式”页；网站接入记录见下方。

## 可复现制作

```bash
bash tools/duduhire-product-motion/render.sh
```

需要已有 Blender 4.0、FFmpeg 和 Python/Pillow。界面素材脚本所需 fontTools 依赖位于此目录 `assets/.deps/`（若不存在，按脚本报错处理，不自动请求外部生成服务）。中文实测使用本机 Heiti SC Medium/Light；网站 Noto Sans SC 子集解码后用于拉丁字形，系统未找到 PingFang。

制作文件：

- `build_assets.py`、`assets/manifest.json`：确定排版的独立透明图层及文案、坐标、来源。
- `motion_graphics.py`：标题、光标、品牌背景及确定的柔影。
- `card_rig.py`：可编辑的织物挂绳与金属夹。
- `create_scene.py`：Blender 摄影机、空间图层、动画曲线与 8 段时间线。
- `.generated/v1/duduhire-product-motion.blend`：可编辑工程；源图像路径留在同一目录内。
- `qa_video.py`：完整解码、规格、逐帧指标与标时缩略图检查。

Blender 采用 Eevee 8 samples、自发光 UI 图层与确定的柔影纹理。探针验证传统面积光软影会产生条带，故最终画面使用无阴影照明表现挂绳金属和织物，卡片柔影由独立图层构成。

## 输出

- `outputs/duduhire-product-motion-preview-v1.mp4`
- `outputs/duduhire-product-motion-poster-v1.jpg`
- `outputs/duduhire-product-motion-v1.blend`：可编辑工程，49 项图片已打包进文件
- `outputs/qa-v1/`：最终视频的技术与视觉检查证据

## 当前网页版本：v2-4k

v2-4k 的成片规格为 **3840×2160、30 fps、44 秒、1320 帧、无音轨**。界面图层与标题按逻辑尺寸的 3 倍原生重绘字形、线条和布局，分别保存到 `assets-hd/` 与 `.generated/graphics-hd/`，再由 Blender 渲染 4K 帧序列。首页内的现有网页截图仍受其 1280×720 原始素材限制，重绘外框不代表截图细节已经提高。

重现命令：

```bash
bash tools/duduhire-product-motion/render-hd.sh
```

该脚本使用独立的 `.generated/v2-4k/` 工程和帧序列，输出 `outputs/duduhire-product-motion-v2-4k.mp4`、对应封面、打包工程及 `outputs/qa-v2-4k/` 检查记录。默认 `render.sh` 保持 v1 的 1080p 制作路径与输出名称；高清脚本本身不修改网站的视频引用。

**4K 成片已接入本地网页。** 1320 帧完整解码、87 张最终视频抽样、4 张原始 4K 关键帧复查通过；网页确认 4K 文件从开头自动播放到 44 秒片尾。前端 lint、build 和现有 15 项测试通过。详见 [4K 页面检查](outputs/qa-integration-v2-4k/report.md)、[高清技术检查](outputs/qa-v2-4k/report.md) 与 [交付清单](outputs/delivery-manifest-v2-4k.json)。下方保留 v1 的历史检查记录。

## v1 检查结果

最终 MP4 为 44 秒、1920×1080、30 fps、1320 帧、无音轨，完整解码通过。独立检查已查看 87 张时间顺序抽样及 6 张 960×540 重点单帧；片尾最后 90 帧通过稳定性检查。

QuickTime 已设为“正常”速度，从 0 秒播放至 44 秒自动停止，并复看 20–34 秒的挂绳能力卡、职责依据和确认状态。播放器进度与墙钟时间一致，详细证据见 [播放器检查](outputs/qa-v1/player-review.md)。技术指标见 [技术报告](outputs/qa-v1/report.md)，最终画面复核见 [视觉报告](outputs/qa-v1/visual-review.md)。

以上为独立产品交互演示视频的制作结果，不代表真实 AI 服务验收。

## 工作方式页接入与后续升级

2026-09-09 按用户授权，将 MP4 和封面复制至 `apps/web/public/images/how-it-works-product-motion-v1.mp4` 与 `how-it-works-product-motion-poster-v1.jpg`，并更新 `/how-it-works` 页引用。公开素材与交付源文件 SHA-256 一致。

视频容器统一为 16:9、完整显示画面，移除旧黑色装饰渐变，提供原生播放控件；减少动态效果偏好下禁用自动播放并暂停，仍可手动播放。浏览器已验证当前源、44 秒时长、自动播放、片尾停止、暂停与重播，及桌面、390 px、320 px 画幅。前端 lint、build 与现有 15 项测试通过。

本轮补充自动播放生命周期：正常动态偏好下，进入或刷新页面即静音行内播放；通过浏览器往返缓存（BFCache）返回时从头播放；页面由隐藏变为可见时，仅对从未开始或已经结束的影片从头播放。首次可播事件允许重试，用户暂停后不会因后续 `canplay` 事件被强制恢复；不循环播放。视频明确设置自动播放意图及 `preload="auto"`，系统减少动态效果偏好仍默认不自动播放。

自动播放修复的浏览器实测：首次加载播放进度从 0 增至 11.89 秒，`paused=false`；按 Space 暂停在 11.966996 秒，后续读取时间未变且 `paused=true`；点击首页再通过浏览器返回“工作方式”页，进度归零且 `paused=false`。该修复的 lint 已通过；这些播放行为证据针对当前 v1 页面，不提前代表 v2-4k 的媒体验收。

随后将视频与封面引用升级为 `how-it-works-product-motion-v2-4k.mp4` 与 `how-it-works-product-motion-poster-v2-4k.jpg`；高清版加载、自动播放、播放到片尾与手动控制也已完成本地浏览器检查。

历史接入记录见 [v1 页面检查](outputs/qa-integration-v1/report.md)，当前范围及验证限制见 [4K 页面检查](outputs/qa-integration-v2-4k/report.md)。
