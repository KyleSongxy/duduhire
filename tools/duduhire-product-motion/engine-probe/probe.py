import bpy
import json
import math
import time
from pathlib import Path
from mathutils import Vector

probe_dir = Path(__file__).resolve().parent
texture_path = probe_dir / 'concept-preview.png'
start = time.monotonic()
bpy.ops.wm.read_factory_settings(use_empty=True)
scene = bpy.context.scene
scene.render.engine = 'BLENDER_EEVEE'
scene.eevee.taa_render_samples = 32
scene.eevee.use_gtao = True
scene.eevee.gtao_distance = 3
scene.eevee.gtao_factor = 0.85
scene.eevee.use_soft_shadows = True
scene.render.resolution_x = 1920
scene.render.resolution_y = 1080
scene.render.resolution_percentage = 100
scene.render.fps = 30
scene.render.image_settings.file_format = 'PNG'
scene.render.image_settings.color_mode = 'RGBA'
scene.render.image_settings.color_depth = '8'
scene.render.image_settings.compression = 15
scene.view_settings.view_transform = 'Standard'
scene.view_settings.look = 'None'
scene.view_settings.exposure = 0
scene.view_settings.gamma = 1
scene.render.film_transparent = False
scene.world = bpy.data.worlds.new('Warm white world')
scene.world.use_nodes = True
scene.world.node_tree.nodes['Background'].inputs['Color'].default_value = (0.8, 0.82, 0.79, 1)
scene.world.node_tree.nodes['Background'].inputs['Strength'].default_value = 0.65

def material(name, color):
    mat = bpy.data.materials.new(name)
    mat.diffuse_color = color
    mat.use_nodes = True
    bsdf = mat.node_tree.nodes.get('Principled BSDF')
    bsdf.inputs['Base Color'].default_value = color
    bsdf.inputs['Roughness'].default_value = 0.9
    bsdf.inputs['Specular IOR Level'].default_value = 0.12
    return mat

bpy.ops.mesh.primitive_plane_add(size=200, location=(0, 0, -0.25))
bpy.context.object.name = 'Matte background'
bpy.context.object.data.materials.append(material('Background material', (0.93, 0.94, 0.92, 1)))

bpy.ops.object.empty_add(type='PLAIN_AXES', location=(0, 0, 1.4))
rig = bpy.context.object
rig.name = 'Card motion rig'
rig.rotation_euler = (math.radians(4), math.radians(-7), math.radians(-1))

bpy.ops.mesh.primitive_cube_add(size=1, location=(0, 0, 0))
slab = bpy.context.object
slab.name = 'Rounded white card'
slab.dimensions = (12.5, 7.03125, 0.09)
bpy.ops.object.transform_apply(location=False, rotation=False, scale=True)
slab.data.materials.append(material('Card white', (0.98, 0.98, 0.98, 1)))
slab.data.use_auto_smooth = True
bevel = slab.modifiers.new('Soft card corners', 'BEVEL')
bevel.width = 0.14
bevel.segments = 8
slab.modifiers.new('Weighted normal', 'WEIGHTED_NORMAL')
slab.parent = rig

bpy.ops.mesh.primitive_plane_add(size=2, location=(0, 0, 0.052))
plane = bpy.context.object
plane.name = 'Transparent interface PNG'
plane.scale = (6.2, 3.4875, 1)
plane.parent = rig
ui_mat = bpy.data.materials.new('Unlit transparent UI texture')
ui_mat.use_nodes = True
ui_mat.blend_method = 'BLEND'
ui_mat.use_screen_refraction = False
ui_mat.use_backface_culling = False
ui_mat.show_transparent_back = False
ui_mat.use_nodes = True
nodes = ui_mat.node_tree.nodes
nodes.clear()
out = nodes.new('ShaderNodeOutputMaterial')
mix = nodes.new('ShaderNodeMixShader')
transparent = nodes.new('ShaderNodeBsdfTransparent')
emission = nodes.new('ShaderNodeEmission')
tex = nodes.new('ShaderNodeTexImage')
tex.image = bpy.data.images.load(str(texture_path))
tex.interpolation = 'Linear'
tex.image.pack()
ui_mat.node_tree.links.new(tex.outputs['Color'], emission.inputs['Color'])
ui_mat.node_tree.links.new(tex.outputs['Alpha'], mix.inputs[0])
ui_mat.node_tree.links.new(transparent.outputs[0], mix.inputs[1])
ui_mat.node_tree.links.new(emission.outputs[0], mix.inputs[2])
ui_mat.node_tree.links.new(mix.outputs[0], out.inputs[0])
plane.data.materials.append(ui_mat)

bpy.ops.object.light_add(type='AREA', location=(-3, 4, 7))
light = bpy.context.object
light.name = 'Large soft area light'
light.data.energy = 750
light.data.shape = 'DISK'
light.data.size = 7
light.rotation_euler = (Vector((0, 0, 0)) - light.location).to_track_quat('-Z', 'Y').to_euler()

bpy.ops.object.camera_add(location=(0, 0, 12))
camera = bpy.context.object
camera.name = 'Orthographic camera'
camera.data.type = 'ORTHO'
camera.data.ortho_scale = 16
camera.rotation_euler = (0, 0, 0)
scene.camera = camera
scene.frame_start = 1
scene.frame_end = 3
scene.render.filepath = str(probe_dir / 'probe.png')
bpy.ops.wm.save_as_mainfile(filepath=str(probe_dir / 'probe.blend'))
print('PROBE_SCENE_READY', json.dumps({'engine': scene.render.engine, 'setup_seconds': time.monotonic() - start}), flush=True)

results = []
for frame in (1, 2, 3):
    scene.frame_set(frame)
    rig.rotation_euler.z = math.radians(-1 + (frame - 1) * 0.5)
    scene.render.filepath = str(probe_dir / ('probe.png' if frame == 1 else f'probe-{frame:02d}.png'))
    frame_start = time.monotonic()
    bpy.ops.render.render(write_still=True)
    result = {'frame': frame, 'render_write_seconds': round(time.monotonic() - frame_start, 3)}
    results.append(result)
    print('PROBE_FRAME_RESULT', json.dumps(result), flush=True)

report = {
    'blender_version': bpy.app.version_string,
    'engine': scene.render.engine,
    'resolution': [1920, 1080],
    'render_samples': scene.eevee.taa_render_samples,
    'camera': 'ORTHO',
    'ambient_occlusion': scene.eevee.use_gtao,
    'soft_shadows': scene.eevee.use_soft_shadows,
    'transparent_ui_texture': str(texture_path),
    'frames': results,
    'total_script_seconds': round(time.monotonic() - start, 3),
    'scope': 'Minimal local engine probe only; not final video quality or duration acceptance',
}
(probe_dir / 'report.json').write_text(json.dumps(report, indent=2) + '\n')
print('PROBE_FINISHED', json.dumps(report), flush=True)
