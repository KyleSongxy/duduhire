# DuduHire product film technical QA

Source: `/Users/xiangyusong/Dropbox/Mac/Documents/ChatGPT/AI Marketplace/tools/duduhire-product-motion/outputs/duduhire-product-motion-preview-v1.mp4`

Technical status: **PASS**.

Human motion review: **NOT PERFORMED BY THIS SCRIPT**. Contact sheets and numeric metrics do not certify normal-speed playback, reading time, UI truthfulness, or final visual acceptance.

| Check | Actual | Expected | Result |
|---|---|---|---|
| video_streams | 1 | 1 | PASS |
| resolution | [1920, 1080] | [1920, 1080] | PASS |
| average_fps | 30.0 | 30.0 | PASS |
| nominal_fps | 30.0 | 30.0 | PASS |
| decoded_frame_count_ffprobe | 1320 | 1320 | PASS |
| video_duration_seconds | 44.0 | 44.0 | PASS |
| audio_streams | 0 | 0 | PASS |
| container_duration_seconds | 44.0 | 44.0 | PASS |
| complete_ffmpeg_decode | 0 | 0 | PASS |
| metric_decode_frame_count | 1320 | 1320 | PASS |

## Visual-review candidates

Uniform near-black / near-white and brightness jumps are manual-review candidates, never automatic design failures. Large white surfaces are expected in this film.

- Uniform near-black intervals: 0.
- Uniform near-white intervals: 0.
- Abrupt mean-brightness changes: 0.
- Last 3 seconds conservative stability: **PASS**; maximum adjacent-frame MAD 0.073542, changed pixel fraction 0.000000, mean-luma span 0.023680.

Details and exact candidate frame ranges are in `report.json`; all frame measurements are in `frame-metrics.csv`.

| Scene | Time | Mean luma | Min / max luma | Max frame difference |
|---|---|---|---|---|
| 1: brand / two entrances | 0.00–4.00 s | 201.535 | 181.541 / 235.826 | 19.864 |
| 2: demand input | 4.00–10.00 s | 234.526 | 184.419 / 238.328 | 21.269 |
| 3: demand structure | 10.00–16.00 s | 238.016 | 236.199 / 239.617 | 6.730 |
| 4: experience input | 16.00–21.00 s | 236.206 | 231.459 / 238.852 | 6.817 |
| 5: capability and evidence | 21.00–28.00 s | 205.404 | 202.449 / 229.928 | 10.686 |
| 6: user confirmation | 28.00–34.00 s | 236.411 | 224.349 / 238.037 | 6.132 |
| 7: related information | 34.00–40.00 s | 198.878 | 196.019 / 234.442 | 5.833 |
| 8: brand ending | 40.00–44.00 s | 230.870 | 207.930 / 232.544 | 4.097 |

## Time-ordered contact sheets

87 samples: every second, final frame, and positions before / at / after planned scene boundaries. Thumbnail labels are drawn with Pillow.

- [contact-sheet-01.jpg](contact-sheet-01.jpg)
- [contact-sheet-02.jpg](contact-sheet-02.jpg)
- [contact-sheet-03.jpg](contact-sheet-03.jpg)
- [contact-sheet-04.jpg](contact-sheet-04.jpg)
- [contact-sheet-05.jpg](contact-sheet-05.jpg)
- [contact-sheet-06.jpg](contact-sheet-06.jpg)
- [contact-sheet-07.jpg](contact-sheet-07.jpg)
- [contact-sheet-08.jpg](contact-sheet-08.jpg)

## Remaining manual checks

- Inspect the render at 960×540 equivalent viewing size for Chinese text, labels, occlusion, and sustained reading time.
- Inspect each complete transition in time order, including motion continuity and text changes.
- Verify demand / capability examples, unknown facts, source references, user confirmation, and non-contactable example boundaries.
- Inspect the final 3 seconds and final frame for stable branding and sufficient reading time.
- Record separately whether continuous normal-speed playback was actually observed. If only sampled or frame-by-frame inspection is available, state that limitation.

## Independent sampled visual review

See [visual-review.md](visual-review.md). All 87 time-ordered samples and six 960x540 frames were inspected; no delivery-blocking issue was observed in those samples. Continuous normal-speed playback remains a separate lead-reviewer check.
