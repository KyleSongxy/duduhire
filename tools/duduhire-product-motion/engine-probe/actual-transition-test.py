import argparse
import bpy
import json
import sys
import time
from mathutils import Vector
from pathlib import Path

sys.dont_write_bytecode=True
outdir=Path(__file__).resolve().parent
parser=argparse.ArgumentParser()
parser.add_argument('--variant',default='original')
parser.add_argument('--frames',default='481')
args=parser.parse_args(sys.argv[sys.argv.index('--')+1:] if '--' in sys.argv else [])
snapshot=outdir/'actual-transition-source.blend'
bpy.ops.wm.open_mainfile(filepath=str(snapshot if snapshot.exists() else outdir.parent/'.generated/v1/duduhire-product-motion.blend'))
original_blend_dir=outdir.parent/'.generated/v1'
for image in bpy.data.images:
    if image.filepath.startswith('//'):
        image.filepath=str((original_blend_dir/image.filepath[2:]).resolve())
        image.reload()
scene=bpy.context.scene
variant=args.variant
if variant=='hashed':
    for material in bpy.data.materials:
        if material.blend_method=='BLEND':
            material.blend_method='HASHED'
elif variant in ('backfaces','backfaces-float'):
    for material in bpy.data.materials:
        if material.blend_method=='BLEND':
            material.show_transparent_back=True
elif variant=='opaque-bg':
    for material in bpy.data.materials:
        if 'Warm white studio' in material.name:
            material.blend_method='OPAQUE'
elif variant=='no-shadows':
    for obj in bpy.data.objects:
        if '/ soft shadow' in obj.name:
            obj.animation_data_clear()
            obj.hide_render=True
elif variant=='far-bg':
    bpy.data.objects['Warm white studio'].location.z=-30
    bpy.data.objects['Warm white studio'].scale=(3,3,3)
if variant=='backfaces-float':
    for obj in bpy.data.objects:
        if 'opacity' in obj:
            obj['opacity']=float(obj['opacity'])
            if obj.animation_data and obj.animation_data.action:
                action=obj.animation_data.action
                for curve in list(action.fcurves):
                    if curve.data_path=='["opacity"]':
                        values=[(p.co[:],p.handle_left[:],p.handle_right[:],p.interpolation,p.handle_left_type,p.handle_right_type) for p in curve.keyframe_points]
                        action.fcurves.remove(curve)
                        curve=action.fcurves.new(data_path='["opacity"]')
                        curve.keyframe_points.add(len(values))
                        for point,info in zip(curve.keyframe_points,values):
                            point.co=info[0]
                            point.handle_left=info[1]
                            point.handle_right=info[2]
                            point.interpolation=info[3]
                            point.handle_left_type=info[4]
                            point.handle_right_type=info[5]
                        curve.update()
                        curve.update_autoflags(obj)
report={'variant':variant,'frames':[]}
for number in map(int,args.frames.split(',')):
    scene.frame_set(number)
    scene.render.filepath=str(outdir/f'actual-transition-{variant}-{number:04d}.png')
    visible=[]
    for obj in scene.objects:
        if obj.type=='MESH' and not obj.hide_render:
            corners=[obj.matrix_world@Vector(corner) for corner in obj.bound_box]
            opacity=obj.parent.get('opacity') if obj.parent else None
            visible.append({'name':obj.name,'world_z_min':min(v.z for v in corners),'world_z_max':max(v.z for v in corners),
                            'opacity':opacity,'parent':obj.parent.name if obj.parent else None,
                            'blend_method':obj.active_material.blend_method if obj.active_material else None})
    started=time.monotonic()
    bpy.ops.render.render(write_still=True)
    result={'frame':number,'seconds':round(time.monotonic()-started,3),'visible_objects':visible}
    report['frames'].append(result)
    print('TRANSITION_RESULT',json.dumps(result),flush=True)
(outdir/f'actual-transition-{variant}.json').write_text(json.dumps(report,indent=2)+'\n')
