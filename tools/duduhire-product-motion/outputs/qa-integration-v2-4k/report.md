# 工作方式页高清与自动播放检查

日期：2026-09-09。目标：http://127.0.0.1:5173/how-it-works 。本次为本地预览接入。

## 交付

- 网页视频：apps/web/public/images/how-it-works-product-motion-v2-4k.mp4（47,773,180 字节）。
- 网页封面：apps/web/public/images/how-it-works-product-motion-poster-v2-4k.jpg（351,240 字节）。
- 源 MP4 / 封面与网页资源 SHA-256 相同；版本化文件名避免复用旧资源缓存。MP4 moov 在 mdat 前，支持逐步加载。
- 3840×2160、30 fps、44 秒、1320 帧、无音轨；UI 和标题 3 倍原生重绘。完整解码通过，无均匀黑白异常候选；片尾稳定性检查通过。
- 播放器明确 autoPlay、muted、playsInline、preload=auto，保留原生控件。监听首次可播、pageshow 和可见性恢复；手动暂停后不因 canplay 强制恢复。系统减少动态效果偏好仍默认暂停、允许手动播放。

## 浏览器实际结果

- 本地预览服务曾停止并返回 ERR_CONNECTION_REFUSED；已恢复 Vite 后重新执行以下检查。
- 新页面确认 currentSrc 为 v2-4k，videoWidth=3840、videoHeight=2160、duration=44、muted=true、autoplay=true、paused=false。
- 启动后 18.583 秒读取到 currentTime=18.511344，readyState=4；后续读到 currentTime=44、ended=true、paused=true，完整到达片尾。
- 页面中已查看实际播放画面，并保存桌面截图 desktop.png。用户面板画幅为 646×363.375，桌面画幅为 1216×684，均保持 16:9；桌面无横向溢出。
- 4K 片尾按 Space 可从头重播，随后按 Space 可暂停。浏览器读数记录于 browser-checks.json。
- 自动播放逻辑修改后、4K 替换前，额外实测暂停在 11.966996 秒且后续保持；点击首页再浏览器返回后，time=0、paused=false。返回检查未区分浏览器实际采用 BFCache 还是重新加载。
- 前端 lint、build 通过，现有 15 项测试全部通过。制作 Python 文件通过语法检查，高清重现脚本通过 bash 语法检查。

## 证据边界

本轮未切换系统减少动态效果偏好，也未接受移动端原生全屏或对外部署。窄屏视口设置未在目标测试标签得到可确认的新尺寸，未计入本轮 390 px 验收；既有 16:9 样式没有进一步改变。本轮未取得浏览器掉帧计数，不将播放进度和抽样截图称为逐帧运动验收。最终压缩视频的全部 87 张抽样及 4 张原始 4K 关键帧另有独立视觉复查。
