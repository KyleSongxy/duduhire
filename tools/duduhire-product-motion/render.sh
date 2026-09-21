#!/usr/bin/env bash
# Rebuild the approved, standalone 44-second film. Never updates website assets.
set -euo pipefail
cd "$(dirname "$0")"
BLENDER_BIN="${DUDUHIRE_BLENDER_BIN:-/Applications/Blender.app/Contents/MacOS/Blender}"
BUILD_DIR=".generated/v1"
OUTPUT_DIR="outputs"
mkdir -p "$BUILD_DIR" "$OUTPUT_DIR"
python3 build_assets.py
python3 motion_graphics.py
"$BLENDER_BIN" --factory-startup --background --python-exit-code 1 --python create_scene.py > "$BUILD_DIR/scene.log" 2>&1
"$BLENDER_BIN" --factory-startup --background "$BUILD_DIR/duduhire-product-motion.blend" -s 1 -e 1320 -a > "$BUILD_DIR/render.log" 2>&1
ffmpeg -hide_banner -loglevel error -y -framerate 30 -start_number 1 -i "$BUILD_DIR/frames/frame_%04d.png" \
  -frames:v 1320 -an -c:v libx264 -preset slow -crf 18 -pix_fmt yuv420p \
  -movflags +faststart -color_primaries bt709 -color_trc bt709 -colorspace bt709 \
  "$OUTPUT_DIR/duduhire-product-motion-preview-v1.mp4"
ffmpeg -hide_banner -loglevel error -y -ss 24.5 -i "$OUTPUT_DIR/duduhire-product-motion-preview-v1.mp4" \
  -frames:v 1 -q:v 2 "$OUTPUT_DIR/duduhire-product-motion-poster-v1.jpg"
python3 qa_video.py "$OUTPUT_DIR/duduhire-product-motion-preview-v1.mp4" "$OUTPUT_DIR/qa-v1"
"$BLENDER_BIN" --factory-startup --background "$BUILD_DIR/duduhire-product-motion.blend" \
  --python-exit-code 1 --python pack_project.py > "$BUILD_DIR/pack.log" 2>&1
