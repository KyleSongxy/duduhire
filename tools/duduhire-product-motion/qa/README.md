# 成片 QA

运行：

```sh
python3 tools/duduhire-product-motion/qa_video.py /absolute/path/to/film.mp4 tools/duduhire-product-motion/qa/final
```

脚本依赖本机 `ffmpeg`、`ffprobe` 和 Python Pillow，不使用浏览器或 `drawtext`。默认按已确认分镜核对 44 秒、1920×1080、30 fps、1320 帧、无音轨；执行完整视频解码，保存逐帧缩小灰度统计，并生成每秒和镜头边界前后的带时间分页缩略图。

`report.md` 便于阅读，`report.json` 保留检查结果与异常候选的准确帧号，`frame-metrics.csv` 包含全部帧的亮度与帧差。近白、近黑画面和亮度突变只标为复核候选；本片白底设计不能仅凭亮度判断失败。片尾 3 秒的稳定性采用保守像素阈值，仍需核对主要信息是否稳定、是否可读。

脚本退出码 0 只表示技术检查通过。人工审查须另行记录中文阅读、画面遮挡、来源与确认状态、镜头运动衔接、片尾，以及是否实际连续正常速度观看。只看缩略图或局部逐帧检查时，应明确写出检查范围，不能记录为正常速度播放通过。
