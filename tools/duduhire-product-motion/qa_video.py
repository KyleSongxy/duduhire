#!/usr/bin/env python3
"""Produce technical checks and visual-review evidence for the 44 s DuduHire film.

Usage: python3 qa_video.py path/to/film.mp4 path/to/qa-output
Dependencies: ffmpeg, ffprobe and Pillow. No browser, drawtext, or NumPy needed.
An exit code of 0 means technical checks passed, not that human motion review did.
"""

import argparse
import csv
import json
import math
import shutil
import subprocess
import sys
from fractions import Fraction
from pathlib import Path
from typing import Any, Dict, List, Optional, Sequence, Tuple

from PIL import Image, ImageChops, ImageDraw, ImageFont, ImageStat


EXPECTED_SECONDS = 44.0
EXPECTED_FPS = 30.0
EXPECTED_FRAMES = 1320
SCENE_BOUNDARIES = [0.0, 4.0, 10.0, 16.0, 21.0, 28.0, 34.0, 40.0, 44.0]
SCENE_NAMES = [
    "brand / two entrances", "demand input", "demand structure", "experience input",
    "capability and evidence", "user confirmation", "related information", "brand ending",
]
METRIC_SIZE = (160, 90)
THUMB_SIZE = (640, 360)


def execute(command: Sequence[str]) -> subprocess.CompletedProcess:
    return subprocess.run(command, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)


def number(value: Any, default: float = 0.0) -> float:
    try:
        return float(value)
    except (ValueError, TypeError):
        return default


def frame_rate(value: Any) -> float:
    try:
        return float(Fraction(str(value)))
    except (ValueError, ZeroDivisionError):
        return 0.0


def scene_at(seconds: float, boundaries: List[float]) -> int:
    for index, boundary in enumerate(boundaries[1:]):
        if seconds < boundary:
            return index
    return len(boundaries) - 2


def ranges(indices: List[int], fps: float) -> List[Dict[str, Any]]:
    """Group consecutive frame candidates, retaining exact frame positions."""
    if not indices:
        return []
    result = []
    start = previous = indices[0]
    for current in indices[1:] + [indices[-1] + 2]:
        if current != previous + 1:
            result.append({
                "start_frame": start, "end_frame_inclusive": previous,
                "start_seconds": round(start / fps, 4),
                "end_seconds_exclusive": round((previous + 1) / fps, 4),
            })
            start = current
        previous = current
    return result


def probe_video(source: Path, output: Path, width: int = 1920, height: int = 1080) -> Tuple[Dict[str, Any], List[Dict[str, Any]], float, int]:
    command = ["ffprobe", "-v", "error", "-count_frames", "-show_streams", "-show_format", "-of", "json", str(source)]
    process = execute(command)
    (output / "ffprobe.stderr.txt").write_text(process.stderr, encoding="utf-8")
    if process.returncode:
        raise RuntimeError("ffprobe failed; see ffprobe.stderr.txt")
    metadata = json.loads(process.stdout)
    (output / "ffprobe.json").write_text(json.dumps(metadata, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")
    videos = [stream for stream in metadata.get("streams", []) if stream.get("codec_type") == "video"]
    audios = [stream for stream in metadata.get("streams", []) if stream.get("codec_type") == "audio"]
    if not videos:
        raise RuntimeError("Input has no video stream")
    video = videos[0]
    fps = frame_rate(video.get("avg_frame_rate"))
    count = int(number(video.get("nb_read_frames")))
    duration = number(video.get("duration"), number(metadata.get("format", {}).get("duration")))
    checks = []

    def check(name: str, actual: Any, expected: Any, passed: bool) -> None:
        checks.append({"name": name, "actual": actual, "expected": expected, "passed": bool(passed)})

    check("video_streams", len(videos), 1, len(videos) == 1)
    check("resolution", [video.get("width"), video.get("height")], [width, height], video.get("width") == width and video.get("height") == height)
    check("average_fps", fps, EXPECTED_FPS, abs(fps - EXPECTED_FPS) < 0.001)
    rate = frame_rate(video.get("r_frame_rate"))
    check("nominal_fps", rate, EXPECTED_FPS, abs(rate - EXPECTED_FPS) < 0.001)
    check("decoded_frame_count_ffprobe", count, EXPECTED_FRAMES, count == EXPECTED_FRAMES)
    check("video_duration_seconds", duration, EXPECTED_SECONDS, abs(duration - EXPECTED_SECONDS) <= 1.0 / EXPECTED_FPS)
    check("audio_streams", len(audios), 0, len(audios) == 0)
    format_duration = number(metadata.get("format", {}).get("duration"))
    check("container_duration_seconds", format_duration, EXPECTED_SECONDS, abs(format_duration - EXPECTED_SECONDS) <= 1.0 / EXPECTED_FPS)
    if fps <= 0 or count <= 0:
        raise RuntimeError("Cannot analyze a video without a positive frame rate and counted frames")
    return metadata, checks, fps, count


def decode_check(source: Path, output: Path) -> Dict[str, Any]:
    command = ["ffmpeg", "-hide_banner", "-v", "error", "-xerror", "-err_detect", "explode", "-i", str(source), "-map", "0:v:0", "-an", "-f", "null", "-"]
    process = execute(command)
    (output / "decode.stderr.txt").write_text(process.stderr, encoding="utf-8")
    return {"name": "complete_ffmpeg_decode", "actual": process.returncode, "expected": 0, "passed": process.returncode == 0, "command": command}


def read_exact(stream: Any, size: int) -> bytes:
    chunks = bytearray()
    while len(chunks) < size:
        block = stream.read(size - len(chunks))
        if not block:
            break
        chunks.extend(block)
    return bytes(chunks)


def collect_metrics(source: Path, output: Path, fps: float, boundaries: List[float]) -> List[Dict[str, Any]]:
    width, height = METRIC_SIZE
    size = width * height
    command = ["ffmpeg", "-hide_banner", "-v", "error", "-xerror", "-i", str(source), "-map", "0:v:0", "-an", "-vf", "scale=%d:%d:flags=area,format=gray" % (width, height), "-fps_mode", "passthrough", "-f", "rawvideo", "-pix_fmt", "gray", "pipe:1"]
    result = []
    previous = None
    with (output / "metrics.stderr.txt").open("wb") as error_file:
        process = subprocess.Popen(command, stdout=subprocess.PIPE, stderr=error_file)
        try:
            while True:
                data = read_exact(process.stdout, size)
                if not data:
                    break
                if len(data) != size:
                    raise RuntimeError("Incomplete raw frame in metric analysis")
                frame = Image.frombytes("L", METRIC_SIZE, data)
                statistics = ImageStat.Stat(frame)
                histogram = frame.histogram()
                difference = ImageChops.difference(previous, frame) if previous is not None else None
                difference_histogram = difference.histogram() if difference is not None else [size] + [0] * 255
                index = len(result)
                result.append({
                    "frame": index, "seconds": round(index / fps, 6),
                    "scene": scene_at(index / fps, boundaries) + 1,
                    "mean_luma": round(statistics.mean[0], 6), "stddev_luma": round(statistics.stddev[0], 6),
                    "dark_fraction_le_5": round(sum(histogram[:6]) / size, 6),
                    "white_fraction_ge_250": round(sum(histogram[250:]) / size, 6),
                    "previous_frame_mad": round(ImageStat.Stat(difference).mean[0], 6) if difference is not None else 0.0,
                    "changed_fraction_gt_8": round(sum(difference_histogram[9:]) / size, 6),
                })
                previous = frame
            returncode = process.wait()
            if returncode:
                raise RuntimeError("ffmpeg metric decode failed; see metrics.stderr.txt")
        except BaseException:
            process.kill()
            process.wait()
            raise
        finally:
            if process.stdout is not None:
                process.stdout.close()
    if not result:
        raise RuntimeError("No decoded frames available for analysis")
    with (output / "frame-metrics.csv").open("w", newline="", encoding="utf-8") as stream:
        writer = csv.DictWriter(stream, fieldnames=list(result[0]))
        writer.writeheader()
        writer.writerows(result)
    return result


def analyze_metrics(metrics: List[Dict[str, Any]], fps: float, boundaries: List[float]) -> Dict[str, Any]:
    black = [row["frame"] for row in metrics if row["dark_fraction_le_5"] >= 0.997 and row["stddev_luma"] < 1.5]
    white = [row["frame"] for row in metrics if row["white_fraction_ge_250"] >= 0.997 and row["stddev_luma"] < 1.5]
    brightness_jumps = []
    for previous, current in zip(metrics, metrics[1:]):
        delta = abs(current["mean_luma"] - previous["mean_luma"])
        if delta >= 25:
            brightness_jumps.append({
                "frame": current["frame"], "seconds": current["seconds"], "mean_luma_change": round(delta, 4),
                "near_planned_boundary": any(abs(current["seconds"] - value) <= 0.6 for value in boundaries),
            })
    scenes = []
    for index in range(len(boundaries) - 1):
        rows = [row for row in metrics if row["scene"] == index + 1]
        if rows:
            scenes.append({
                "scene": index + 1, "name": SCENE_NAMES[index] if index < len(SCENE_NAMES) else "custom scene",
                "start": boundaries[index], "end": boundaries[index + 1], "frames": len(rows),
                "mean_luma": round(sum(row["mean_luma"] for row in rows) / len(rows), 4),
                "min_luma": min(row["mean_luma"] for row in rows), "max_luma": max(row["mean_luma"] for row in rows),
                "max_previous_frame_mad": max(row["previous_frame_mad"] for row in rows),
            })
    tail_frame_count = max(1, round(3 * fps))
    tail = metrics[-tail_frame_count:]
    # Exclude the difference leading INTO the interval; inspect changes within it.
    tail_differences = tail[1:]
    max_mad = max((row["previous_frame_mad"] for row in tail_differences), default=0.0)
    max_changed = max((row["changed_fraction_gt_8"] for row in tail_differences), default=0.0)
    luma_span = max(row["mean_luma"] for row in tail) - min(row["mean_luma"] for row in tail)
    stable = len(tail) == tail_frame_count and max_mad <= 0.3 and max_changed <= 0.005 and luma_span <= 0.5
    return {
        "measurement": "Every decoded video frame, scaled to 160x90 grayscale; luma and absolute difference use a 0-255 scale.",
        "classification_policy": "Uniform near-black / near-white and brightness jumps are manual-review candidates, never automatic design failures. Large white surfaces are expected in this film.",
        "uniform_black_candidates": ranges(black, fps), "uniform_white_candidates": ranges(white, fps),
        "brightness_jump_candidates": brightness_jumps, "scene_metrics": scenes,
        "last_three_seconds": {
            "start_frame": tail[0]["frame"], "start_seconds": tail[0]["seconds"], "frames": len(tail),
            "max_frame_difference_mad": round(max_mad, 6), "max_changed_fraction_gt_8": round(max_changed, 6),
            "mean_luma_span": round(luma_span, 6), "conservative_stability_check_passed": stable,
            "thresholds": {"max_mad": 0.3, "max_changed_fraction": 0.005, "max_luma_span": 0.5},
            "interpretation": "Low-resolution stability is supporting evidence only; text legibility and stable main information still need visual review.",
        },
    }


def sample_frames(fps: float, frame_count: int, boundaries: List[float]) -> List[int]:
    sample = {0, frame_count - 1}
    for second in range(math.ceil(frame_count / fps)):
        sample.add(min(frame_count - 1, round(second * fps)))
    # Dense positions around cuts, including the exact frame immediately before/after.
    for boundary in boundaries[1:-1]:
        for offset in (-0.5, -0.25, -1.0 / fps, 0.0, 1.0 / fps, 0.25, 0.5):
            sample.add(min(frame_count - 1, max(0, round((boundary + offset) * fps))))
    return sorted(sample)


def label_font(size: int) -> Any:
    for candidate in (
        "/System/Library/Fonts/Supplemental/Arial.ttf",
        "/System/Library/Fonts/Supplemental/Helvetica.ttf",
        "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf",
    ):
        if Path(candidate).is_file():
            return ImageFont.truetype(candidate, size)
    return ImageFont.load_default()


def make_contact_sheets(source: Path, output: Path, fps: float, frame_count: int, boundaries: List[float]) -> Dict[str, Any]:
    indices = sample_frames(fps, frame_count, boundaries)
    thumbnails = output / "thumbnails"
    thumbnails.mkdir(exist_ok=True)
    selection = "+".join("eq(n\\,%d)" % index for index in indices)
    filtergraph = "select=%s,scale=640:360:force_original_aspect_ratio=decrease,pad=640:360:(ow-iw)/2:(oh-ih)/2:color=white" % selection
    command = ["ffmpeg", "-hide_banner", "-v", "error", "-xerror", "-i", str(source), "-map", "0:v:0", "-an", "-vf", filtergraph, "-fps_mode", "vfr", "-q:v", "2", "-y", str(thumbnails / "sample-%04d.jpg")]
    process = execute(command)
    (output / "thumbnail.stderr.txt").write_text(process.stderr, encoding="utf-8")
    if process.returncode:
        raise RuntimeError("Thumbnail extraction failed; see thumbnail.stderr.txt")
    files = [thumbnails / ("sample-%04d.jpg" % (index + 1)) for index in range(len(indices))]
    if not all(path.is_file() for path in files):
        raise RuntimeError("Thumbnail extraction returned fewer images than requested")
    columns, rows = 3, 4
    gap, header, caption, footer = 16, 70, 44, 42
    width = columns * THUMB_SIZE[0] + (columns + 1) * gap
    height = header + rows * (THUMB_SIZE[1] + caption + gap) + footer
    page_count = math.ceil(len(indices) / (columns * rows))
    sheets = []
    manifest = []
    for page in range(page_count):
        canvas = Image.new("RGB", (width, height), "#e8ebe8")
        draw = ImageDraw.Draw(canvas)
        draw.text((gap, 14), "DuduHire film QA | page %d / %d | %d fps" % (page + 1, page_count, round(fps)), fill="#173728", font=label_font(28))
        start = page * columns * rows
        for cell, global_index in enumerate(range(start, min(start + columns * rows, len(indices)))):
            frame = indices[global_index]
            seconds = frame / fps
            x = gap + (cell % columns) * (THUMB_SIZE[0] + gap)
            y = header + (cell // columns) * (THUMB_SIZE[1] + caption + gap)
            with Image.open(files[global_index]) as thumb:
                canvas.paste(thumb.convert("RGB"), (x, y))
            scene = scene_at(seconds, boundaries) + 1
            label = "%06.3fs | frame %04d | scene %d" % (seconds, frame, scene)
            draw.text((x + 4, y + THUMB_SIZE[1] + 8), label, fill="#181818", font=label_font(24))
            manifest.append({"frame": frame, "seconds": round(seconds, 6), "scene": scene, "thumbnail": str(files[global_index].relative_to(output)), "contact_sheet": "contact-sheet-%02d.jpg" % (page + 1)})
        draw.text((gap, height - 30), "Time ordered. Static evidence does not establish normal-speed playback or motion quality.", fill="#555555", font=label_font(18))
        path = output / ("contact-sheet-%02d.jpg" % (page + 1))
        canvas.save(path, quality=94, subsampling=0)
        sheets.append(str(path.relative_to(output)))
    (output / "sample-manifest.json").write_text(json.dumps(manifest, indent=2) + "\n", encoding="utf-8")
    return {"sample_count": len(indices), "contact_sheets": sheets, "manifest": "sample-manifest.json", "thumbnail_size": list(THUMB_SIZE)}


def write_report(report: Dict[str, Any], output: Path) -> None:
    (output / "report.json").write_text(json.dumps(report, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")
    lines = ["# DuduHire product film technical QA", "", "Source: `%s`" % report["source"], "", "Technical status: **%s**." % report["technical_status"], "", "Human motion review: **NOT PERFORMED BY THIS SCRIPT**. Contact sheets and numeric metrics do not certify normal-speed playback, reading time, UI truthfulness, or final visual acceptance.", "", "| Check | Actual | Expected | Result |", "|---|---|---|---|"]
    for check in report.get("checks", []):
        lines.append("| %s | %s | %s | %s |" % (check["name"], check["actual"], check["expected"], "PASS" if check["passed"] else "FAIL"))
    analysis = report.get("analysis")
    if analysis:
        tail = analysis["last_three_seconds"]
        lines += ["", "## Visual-review candidates", "", analysis["classification_policy"], "", "- Uniform near-black intervals: %d." % len(analysis["uniform_black_candidates"]), "- Uniform near-white intervals: %d." % len(analysis["uniform_white_candidates"]), "- Abrupt mean-brightness changes: %d." % len(analysis["brightness_jump_candidates"]), "- Last 3 seconds conservative stability: **%s**; maximum adjacent-frame MAD %.6f, changed pixel fraction %.6f, mean-luma span %.6f." % ("PASS" if tail["conservative_stability_check_passed"] else "REVIEW", tail["max_frame_difference_mad"], tail["max_changed_fraction_gt_8"], tail["mean_luma_span"]), "", "Details and exact candidate frame ranges are in `report.json`; all frame measurements are in `frame-metrics.csv`.", "", "| Scene | Time | Mean luma | Min / max luma | Max frame difference |", "|---|---|---|---|---|"]
        for scene in analysis["scene_metrics"]:
            lines.append("| %d: %s | %.2f–%.2f s | %.3f | %.3f / %.3f | %.3f |" % (scene["scene"], scene["name"], scene["start"], scene["end"], scene["mean_luma"], scene["min_luma"], scene["max_luma"], scene["max_previous_frame_mad"]))
    contact = report.get("contact_sheets", {})
    if contact:
        lines += ["", "## Time-ordered contact sheets", "", "%d samples: every second, final frame, and positions before / at / after planned scene boundaries. Thumbnail labels are drawn with Pillow." % contact["sample_count"], ""]
        lines += ["- [%s](%s)" % (name, name) for name in contact["contact_sheets"]]
    if report.get("errors"):
        lines += ["", "## Errors", ""] + ["- " + error for error in report["errors"]]
    lines += ["", "## Remaining manual checks", "", "- Inspect the render at 960×540 equivalent viewing size for Chinese text, labels, occlusion, and sustained reading time.", "- Inspect each complete transition in time order, including motion continuity and text changes.", "- Verify demand / capability examples, unknown facts, source references, user confirmation, and non-contactable example boundaries.", "- Inspect the final 3 seconds and final frame for stable branding and sufficient reading time.", "- Record separately whether continuous normal-speed playback was actually observed. If only sampled or frame-by-frame inspection is available, state that limitation.", ""]
    (output / "report.md").write_text("\n".join(lines), encoding="utf-8")


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("video", type=Path, help="MP4 to inspect")
    parser.add_argument("output", type=Path, help="Directory for reports, metrics and contact sheets")
    parser.add_argument("--width", type=int, default=1920, help="Expected video width")
    parser.add_argument("--height", type=int, default=1080, help="Expected video height")
    parser.add_argument("--boundaries", default=",".join(str(value) for value in SCENE_BOUNDARIES), help="Comma-separated scene edges in seconds (default: approved 44 s brief)")
    args = parser.parse_args()
    if not args.video.is_file():
        parser.error("Video does not exist: %s" % args.video)
    missing = [name for name in ("ffmpeg", "ffprobe") if not shutil.which(name)]
    if missing:
        parser.error("Required executable(s) missing: " + ", ".join(missing))
    try:
        boundaries = [float(value) for value in args.boundaries.split(",")]
        if len(boundaries) < 2 or not all(math.isfinite(value) for value in boundaries) or boundaries[0] != 0 or any(left >= right for left, right in zip(boundaries, boundaries[1:])):
            raise ValueError
    except ValueError:
        parser.error("Boundaries must be increasing finite seconds beginning at 0")
    source, output = args.video.resolve(), args.output.resolve()
    output.mkdir(parents=True, exist_ok=True)
    report = {"source": str(source), "technical_status": "ERROR", "checks": [], "errors": [], "human_motion_review": "not performed by script", "scene_boundaries_seconds": boundaries}
    try:
        _, checks, fps, frame_count = probe_video(source, output, args.width, args.height)
        report["checks"] = checks
        print("Metadata inspected; decoding full video...", flush=True)
        report["checks"].append(decode_check(source, output))
        print("Measuring every decoded frame...", flush=True)
        metrics = collect_metrics(source, output, fps, boundaries)
        report["checks"].append({"name": "metric_decode_frame_count", "actual": len(metrics), "expected": frame_count, "passed": len(metrics) == frame_count})
        report["analysis"] = analyze_metrics(metrics, fps, boundaries)
        print("Extracting time-ordered thumbnails and contact sheets...", flush=True)
        report["contact_sheets"] = make_contact_sheets(source, output, fps, frame_count, boundaries)
        report["technical_status"] = "PASS" if all(check["passed"] for check in report["checks"]) else "FAIL"
    except (RuntimeError, OSError, ValueError, subprocess.SubprocessError) as error:
        report["errors"].append(str(error))
    write_report(report, output)
    print("Technical status: %s. Report: %s" % (report["technical_status"], output / "report.md"), flush=True)
    print("Continuous playback / human motion review remains separate.", flush=True)
    return 0 if report["technical_status"] == "PASS" else 1


if __name__ == "__main__":
    sys.exit(main())
