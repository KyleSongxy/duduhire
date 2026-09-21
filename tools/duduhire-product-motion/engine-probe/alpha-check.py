import bpy
from pathlib import Path

probe_dir=Path(__file__).resolve().parent
bpy.ops.wm.open_mainfile(filepath=str(probe_dir/'probe.blend'))
scene=bpy.context.scene
scene.eevee.taa_render_samples=8
bpy.data.objects['Rounded white card'].hide_render=True
mat=bpy.data.materials.new('Neutral gray alpha inspection background')
mat.use_nodes=True
mat.node_tree.nodes.clear()
out=mat.node_tree.nodes.new('ShaderNodeOutputMaterial')
emission=mat.node_tree.nodes.new('ShaderNodeEmission')
emission.inputs['Color'].default_value=(0.22,0.22,0.22,1)
mat.node_tree.links.new(emission.outputs[0],out.inputs[0])
bpy.data.objects['Matte background'].data.materials.clear()
bpy.data.objects['Matte background'].data.materials.append(mat)
scene.render.filepath=str(probe_dir/'alpha-on-gray-08.png')
bpy.ops.render.render(write_still=True)
