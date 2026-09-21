import bpy
import importlib.util
import json
import math
import sys
from pathlib import Path
from mathutils import Vector

output_dir=Path(__file__).resolve().parent
sys.dont_write_bytecode=True
module_path=output_dir.parent/'card_rig.py'
spec=importlib.util.spec_from_file_location('card_rig',module_path)
module=importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)
bpy.ops.wm.read_factory_settings(use_empty=True)
scene=bpy.context.scene
scene.render.engine='BLENDER_EEVEE'
scene.eevee.taa_render_samples=16
scene.eevee.use_gtao=False
scene.eevee.use_soft_shadows=False
scene.render.resolution_x=1920
scene.render.resolution_y=1080
scene.render.resolution_percentage=100
scene.render.image_settings.file_format='PNG'
scene.render.image_settings.color_mode='RGBA'
scene.view_settings.view_transform='Standard'
scene.view_settings.look='None'
scene.world=bpy.data.worlds.new('Neutral studio')
scene.world.color=(0.8,0.8,0.8)

bpy.ops.object.empty_add()
parent=bpy.context.object
parent.name='Card suspension pivot'
parent.rotation_euler=(math.radians(3),math.radians(-6),math.radians(-2))
objects=module.add_lanyard(parent)

# A plain proxy card only; the production card belongs to the parent renderer.
card_material=bpy.data.materials.new('Unlabelled forest placeholder')
card_material.use_nodes=True
nodes=card_material.node_tree.nodes
nodes.clear()
emission=nodes.new('ShaderNodeEmission')
emission.inputs['Color'].default_value=module._linear('#102A1D')
out=nodes.new('ShaderNodeOutputMaterial')
card_material.node_tree.links.new(emission.outputs[0],out.inputs[0])
proxy=[]
module._box(parent,'Proxy card body',(0,-4.6,-0.037),(5.0,6.36,0.055),0.19,card_material,proxy)

background=bpy.data.materials.new('Flat warm white background')
background.use_nodes=True
background.node_tree.nodes.clear()
emission=background.node_tree.nodes.new('ShaderNodeEmission')
emission.inputs['Color'].default_value=module._linear('#F7F7F4')
out=background.node_tree.nodes.new('ShaderNodeOutputMaterial')
background.node_tree.links.new(emission.outputs[0],out.inputs[0])
bpy.ops.mesh.primitive_plane_add(size=100,location=(0,0,-3))
bpy.context.object.data.materials.append(background)

for location,energy,size in (((-4,3,10),1250,7),((6,-2,7),650,5)):
    bpy.ops.object.light_add(type='AREA',location=location)
    light=bpy.context.object
    light.data.energy=energy
    light.data.size=size
    light.data.use_shadow=False
    light.rotation_euler=(Vector((0,-1,0))-light.location).to_track_quat('-Z','Y').to_euler()

bpy.ops.object.camera_add(location=(0,-2.8,20))
camera=bpy.context.object
camera.data.type='ORTHO'
camera.data.ortho_scale=18.5
scene.camera=camera
scene.render.filepath=str(output_dir/'card-proxy.png')
bpy.ops.wm.save_as_mainfile(filepath=str(output_dir/'card-proxy.blend'))
bpy.ops.render.render(write_still=True)
assert all(obj.parent == parent for obj in objects)
report={
    'function':'add_lanyard(parent, card_width=5.0, card_height=6.36, card_center_y=-4.6)',
    'objects_created':len(objects),
    'all_objects_direct_children':True,
    'card_top_y':-1.42,
    'strap_width':0.31,
    'strap_thickness':0.035,
    'clasp_width':1.09,
    'clasp_height':0.355,
    'slot_center_y':-1.65,
    'slot_width':0.99,
    'materials':'sRGB hex decoded into linear Principled base colors; matte fabric and satin metal',
    'camera':'orthographic on +Z; preview parent tilted 3/-6/-2 degrees',
    'shadow_casting':False,
    'scope':'Unlabelled proxy tests proportion and connection geometry only; no production card UI',
}
(output_dir/'card-proxy-report.json').write_text(json.dumps(report,indent=2)+'\n')
print(json.dumps(report),flush=True)
