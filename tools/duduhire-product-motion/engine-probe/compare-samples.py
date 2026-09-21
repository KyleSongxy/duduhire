import bpy
import json
import math
import time
from pathlib import Path

probe_dir = Path(__file__).resolve().parent
bpy.ops.wm.open_mainfile(filepath=str(probe_dir / 'probe.blend'))
scene = bpy.context.scene
rig = bpy.data.objects['Card motion rig']
records = []
for samples in (8, 16):
    scene.eevee.taa_render_samples = samples
    for frame in (1, 2):
        scene.frame_set(frame)
        rig.rotation_euler.z = math.radians(-1 + (frame - 1) * 0.5)
        scene.render.filepath = str(probe_dir / f'samples-{samples:02d}-{frame:02d}.png')
        started = time.monotonic()
        bpy.ops.render.render(write_still=True)
        record = {'samples': samples, 'frame': frame, 'seconds_including_png_write': round(time.monotonic()-started, 3)}
        records.append(record)
        print('SAMPLE_COMPARISON', json.dumps(record), flush=True)

scene.eevee.taa_render_samples = 8
scene.render.film_transparent = True
bpy.data.objects['Matte background'].hide_render = True
scene.render.filepath = str(probe_dir / 'transparent-08.png')
started = time.monotonic()
bpy.ops.render.render(write_still=True)
records.append({'samples': 8, 'frame': 2, 'film_transparent_no_ground': True, 'seconds_including_png_write': round(time.monotonic()-started,3)})
mat = bpy.data.materials['Unlit transparent UI texture']
texture = next(node.image for node in mat.node_tree.nodes if node.type == 'TEX_IMAGE')
report = {
    'blender_version': bpy.app.version_string,
    'engine': scene.render.engine,
    'resolution': [scene.render.resolution_x,scene.render.resolution_y],
    'alpha': {
        'material_blend_method': mat.blend_method,
        'texture_alpha_mode': texture.alpha_mode,
        'texture_interpolation': 'Linear',
        'shader': 'Transparent BSDF / Emission mixed by texture Alpha',
        'show_transparent_back': mat.show_transparent_back,
        'film_transparent_test': 'Ground hidden; opaque white card and translucent UI remain; no separate shadow catcher',
    },
    'records': records,
    'scope': 'Same minimal local probe; no final scene throughput claim',
}
(probe_dir/'sample-comparison.json').write_text(json.dumps(report, indent=2)+'\n')
print('COMPARISON_FINISHED', json.dumps(report),flush=True)
