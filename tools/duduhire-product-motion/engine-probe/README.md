# Blender 本地渲染可行性探针

2026-09-08。本目录只验证引擎、透明 PNG 与渲染速度，不是影片、正式画质验收或网站验收。

## 已验证结果

本机 `/Applications/Blender.app/Contents/MacOS/Blender` 4.0.0 可以使用 Eevee 后台渲染 1920×1080 PNG。场景包含正交相机、轻微倾斜的薄卡片、透明 UI 图层、面积光、AO 与背景；`probe.blend` 已打包测试图层。

启动使用 `--factory-startup --background`。第一次未加 `--factory-startup` 时载入了本机用户插件并产生插件注销警告；后续正式记录均使用工厂启动，未更改用户配置。

| 设置 | 第 1 帧 | 后续帧 | 说明 |
| --- | ---: | ---: | --- |
| 32 samples，首次冷启动 | 7.318 s | 1.145 / 1.222 s | 首帧包含初次着色器等准备 |
| 32 samples，最终工厂启动 | 1.462 s | 1.241 / 1.137 s | 见 `report.json` |
| 8 samples | 1.048 s | 0.400 s | 见 `sample-comparison.json` |
| 16 samples | 0.627 s | 0.669 s | 同一进程、同一场景 |
| 8 samples，透明 film 且隐藏地面 | — | 0.352 s | 保留白卡和 UI，无独立阴影接收层 |

所有时间包含 PNG 写盘；PNG 为 RGBA、8 bit、压缩级别 15。仅以热帧外推，1,320 帧约为：8 samples 9 分钟、16 samples 14 分钟、32 samples 26 分钟。实际影片的纹理数量、透明叠层、透视运动与同时负载会改变耗时，不能据此承诺正式渲染时长。

## 画面检查

已通过 `view_image` 打开 8/16 samples 原尺寸输出、透明输出与中灰背景透明度检查图。

- 8 samples 的界面文字和卡片边缘在本探针中清楚；面积光的大软影有明显多重条带。16 samples 条带减轻但仍可见，不能作为成片柔影质量通过。
- 8 samples 适合自发光 UI 与另行制作的柔影、背景合成方案；是否采用由正式场景画面检查决定。没有切换 Workbench、Cycles 或静默降低输出尺寸。
- `alpha-on-gray-08.png` 隐藏白色卡底，把透明文字直接叠在中灰背景上；未见明显白边。`transparent-08.png` 验证透明 film 输出，但隐藏地面后不会包含地面投影。
- 初版卡片曾在倾斜时与背景平面相交，已把卡片 rig 提升至 z=1.4 并重新渲染。正式透视场景也要按整个面板的最大倾斜幅度保留深度间距。

## 透明 UI 材质

采用 `material.blend_method = 'BLEND'`，图像 `alpha_mode = 'STRAIGHT'`，Linear 纹理插值；将纹理 Color 接入 Emission，将 Alpha 作为 Transparent BSDF 与 Emission 的混合系数。`show_transparent_back = False`。没有使用 HASHED。

显示变换为 Standard、Look None、Exposure 0、Gamma 1。多个透明图层需要稳定的前后顺序及足够深度间距；此探针只有一张透明 UI，未验证复杂交叠排序。

## 文件

- `probe.py` / `probe.blend` / `probe.png`：基础场景、打包工程与 32 samples 首帧。
- `report.json` / `blender.log`：最终基础探针事实。
- `compare-samples.py` / `sample-comparison.json`：8/16 samples 两帧比较及透明 film 单帧。
- `samples-08-02.png` / `samples-16-02.png`：相同姿态的直接比较。
- `alpha-check.py` / `alpha-on-gray-08.png`：透明文字中灰背景检查。

运行示例（仓库根目录）：

```bash
/Applications/Blender.app/Contents/MacOS/Blender --factory-startup --background --python tools/duduhire-product-motion/engine-probe/probe.py
/Applications/Blender.app/Contents/MacOS/Blender --factory-startup --background --python tools/duduhire-product-motion/engine-probe/compare-samples.py
```

所有产物写在本目录；没有修改网站、控制浏览器或调用外部生成服务。
