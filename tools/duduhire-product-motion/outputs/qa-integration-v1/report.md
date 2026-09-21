# 工作方式页视频替换检查

2026-09-09，目标 `http://127.0.0.1:5173/how-it-works`，用户已明确授权替换。

## 改动

- MP4：`/images/how-it-works-product-motion-v1.mp4`，10,932,061 字节，SHA-256 `01ee17460de1b5c8ffbaa0f913226462458f8f3115a5f4b34196c1726e007ece`，与已交付源文件一致。
- poster 与 CSS 背景同时改为 `/images/how-it-works-product-motion-poster-v1.jpg`，SHA-256 `51dbfb05f007016ad8e33ecd9c7764ab0000bf60df11e1be81e67b71eb7af67d`。
- 桌面旧 16/8.2 和移动端旧 4/3 裁切改为统一 16/9、object-fit: contain，移除旧黑色装饰渐变。
- 原生 controls、静音、行内播放、可访问名称；正常偏好自动播放一次。减少动态效果时禁用自动播放并暂停，保留封面和手动播放机会。
- 页面其他文案和模块不属于此次修改。

## 已观察到的浏览器结果

使用 Codex 内置浏览器访问本地页面，读取渲染 DOM 与截图。

- currentSrc 和 poster 均是新的产品动效资源；媒体时长 44 秒、1920×1080、error=null、muted=true、playsInline=true、controls=true。
- 正常偏好下自动播放，观察到 currentTime=33.965、paused=false，随后 currentTime=44、ended=true、paused=true。
- 使用原生播放器键盘控件重播，观察到回到 0 秒并播放；再次暂停时 currentTime=32.134、paused=true。
- 桌面：1280 px 页面，视频 1216×684，contain、16:9，文档宽度 1280，没有横向溢出。
- 390 px 页面：视频 358×201.375，完整 16:9，文档宽度 390。
- 320 px 页面：视频 288×162，完整 16:9，文档宽度 320；截图包含完整能力卡画面和底部示例标记。
- 已恢复默认浏览器尺寸，保留结果页。

截图：`desktop.png`、`mobile-390.png`、`mobile-320.png`。

## 检查边界

减少动态效果的监听、暂停和禁用自动播放逻辑已作代码检查；当前浏览器工具未提供该媒体偏好的模拟能力，因此未声称完成此分支的运行时验证。手机尺寸是响应式模拟，不是真机验收。

原生全屏入口能切换视频几何至全视口，但内置浏览器在窄视口覆盖下的全屏截图缩放异常；未据此宣称移动端全屏视觉通过，已退出并刷新恢复页面。`mobile-fullscreen.png` 仅保留该观察，不作为通过证据。

## 前端检查

- `npm run lint --workspace @duduhire/web`：通过。
- `npm run build --workspace @duduhire/web`：TypeScript、Vite 构建通过。
- `npm run test --workspace @duduhire/web`：现有 15 项测试通过。

本次为本地页面接入；未执行生产部署。
