"""Pack rendered artwork into a portable copy of the editable Blender project."""
from pathlib import Path
import argparse
import sys
import bpy

root = Path(__file__).resolve().parent
parser = argparse.ArgumentParser()
parser.add_argument('--output', type=Path, default=root / 'outputs' / 'duduhire-product-motion-v1.blend')
args = parser.parse_args(sys.argv[sys.argv.index('--')+1:] if '--' in sys.argv else [])
target = args.output.resolve()
target.parent.mkdir(parents=True, exist_ok=True)
bpy.ops.file.pack_all()
missing = [image.name for image in bpy.data.images
           if image.source == 'FILE' and not image.packed_file]
if missing:
    raise RuntimeError('Unpacked artwork: ' + ', '.join(missing))
bpy.context.scene.render.filepath = '//frames/frame_'
bpy.ops.wm.save_as_mainfile(filepath=str(target))
print('PACKED_PROJECT', target, flush=True)
