#!/usr/bin/env bash
# Rebuild native high-resolution UI and the 4K master without changing website references.
set -euo pipefail
cd "$(dirname "$0")"
BLENDER_BIN="${DUDUHIRE_BLENDER_BIN:-/Applications/Blender.app/Contents/MacOS/Blender}"
BUILD_DIR=".generated/v2-4k"
OUTPUT_DIR="outputs"
mkdir -p "$BUILD_DIR" "$OUTPUT_DIR"
python3 build_assets.py --output assets-hd --scale 3
python3 motion_graphics.py --assets assets-hd --output .generated/graphics-hd --scale 3
"$BLENDER_BIN" --factory-startup --background --python-exit-code 1 --python create_scene.py -- \
  --assets-dir assets-hd --graphics-dir .generated/graphics-hd --build-dir "$BUILD_DIR" \
  --resolution-scale 2 --samples 8 > "$BUILD_DIR/scene.log" 2>&1
"$BLENDER_BIN" --factory-startup --background "$BUILD_DIR/duduhire-product-motion.blend" \
  -s 1 -e 1320 -a > "$BUILD_DIR/render.log" 2>&1
ffmpeg -hide_banner -loglevel error -y -framerate 30 -start_number 1 \
  -i "$BUILD_DIR/frames/frame_%04d.png" -frames:v 1320 -an \
  -vf 'scale=out_color_matrix=bt709:out_range=tv,format=yuv420p' \
  -c:v libx264 -preset medium -crf 15 -profile:v high -level:v 5.1 \
  -movflags +faststart -color_primaries bt709 -color_trc bt709 -colorspace bt709 \
  "$OUTPUT_DIR/duduhire-product-motion-v2-4k.mp4"
ffmpeg -hide_banner -loglevel error -y -ss 24.5 \
  -i "$OUTPUT_DIR/duduhire-product-motion-v2-4k.mp4" -frames:v 1 -q:v 1 \
  "$OUTPUT_DIR/duduhire-product-motion-poster-v2-4k.jpg"
python3 qa_video.py "$OUTPUT_DIR/duduhire-product-motion-v2-4k.mp4" \
  "$OUTPUT_DIR/qa-v2-4k" --width 3840 --height 2160
"$BLENDER_BIN" --factory-startup --background "$BUILD_DIR/duduhire-product-motion.blend" \
  --python-exit-code 1 --python pack_project.py -- \
  --output "$OUTPUT_DIR/duduhire-product-motion-v2-4k.blend" > "$BUILD_DIR/pack.log" 2>&1
