"""Blender 4.0: DuduHire 44-second 2.5D product film.

Run with --factory-startup --background --python create_scene.py -- [options].
All artwork, geometry and timing remain editable in the saved .blend.
"""
import argparse
import json
import math
import sys
from pathlib import Path
import bpy
from mathutils import Vector

ROOT=Path(__file__).resolve().parent
sys.path.insert(0,str(ROOT))
ASSETS=ROOT/'assets'
GRAPHICS=ROOT/'.generated'/'graphics'
BUILD=ROOT/'.generated'/'v1'
FPS=30
W,H=1920,1080
CAM_Z=26.666666667
GRAPH={}
ACTORS=[]
IMAGE_CACHE={}


def frame(t):return max(1,round(t*FPS)+1)
def xy(x,y,z=0):return ((x-W/2)/100,(H/2-y)/100,z)
def radians(v):return tuple(math.radians(x) for x in v)


def smooth_keys(idblock):
    if idblock.animation_data and idblock.animation_data.action:
        for curve in idblock.animation_data.action.fcurves:
            for k in curve.keyframe_points:
                k.interpolation='BEZIER'
                k.handle_left_type='AUTO_CLAMPED'
                k.handle_right_type='AUTO_CLAMPED'


def value_key(obj,prop,t,value):
    obj[prop]=float(value);obj.keyframe_insert(data_path='["'+prop+'"]',frame=frame(t))
    smooth_keys(obj)


def pose(obj,t,x=None,y=None,z=None,scale=None,rot=None,local=False):
    if x is not None and y is not None:
        obj.location= (x,y,z or 0) if local else xy(x,y,z or 0)
        obj.keyframe_insert(data_path='location',frame=frame(t))
    if scale is not None:
        obj.scale=(scale,scale,scale)
        obj.keyframe_insert(data_path='scale',frame=frame(t))
    if rot is not None:
        obj.rotation_euler=radians(rot)
        obj.keyframe_insert(data_path='rotation_euler',frame=frame(t))
    smooth_keys(obj)


def visibility(obj,start,end):
    obj.hide_render=True;obj.keyframe_insert(data_path='hide_render',frame=1)
    obj.hide_render=False;obj.keyframe_insert(data_path='hide_render',frame=frame(start))
    obj.hide_render=True;obj.keyframe_insert(data_path='hide_render',frame=min(1322,frame(end)))
    for curve in obj.animation_data.action.fcurves:
        if curve.data_path=='hide_render':
            for k in curve.keyframe_points:k.interpolation='CONSTANT'


def driver(socket,obj,key):
    f=socket.driver_add('default_value')
    f.driver.type='SCRIPTED'
    var=f.driver.variables.new();var.name='v';var.type='SINGLE_PROP'
    var.targets[0].id=obj;var.targets[0].data_path='["'+key+'"]'
    f.driver.expression='v'


def load_image(path):
    p=str(Path(path).resolve())
    if p not in IMAGE_CACHE:
        im=bpy.data.images.load(p,check_existing=True);im.alpha_mode='STRAIGHT'
        IMAGE_CACHE[p]=im
    return IMAGE_CACHE[p]


def image_material(name,path,owner,wipe=False):
    mat=bpy.data.materials.new(name);mat.use_nodes=True
    mat.blend_method='BLEND';mat.use_screen_refraction=False
    mat.show_transparent_back=True;mat.use_backface_culling=False
    mat.use_nodes=True;mat.shadow_method='NONE'
    nodes=mat.node_tree.nodes;nodes.clear();links=mat.node_tree.links
    tex=nodes.new('ShaderNodeTexImage');tex.image=load_image(path);tex.interpolation='Linear';tex.extension='CLIP'
    emission=nodes.new('ShaderNodeEmission');links.new(tex.outputs['Color'],emission.inputs['Color'])
    transparent=nodes.new('ShaderNodeBsdfTransparent')
    opacity=nodes.new('ShaderNodeMath');opacity.operation='MULTIPLY'
    links.new(tex.outputs['Alpha'],opacity.inputs[0]);driver(opacity.inputs[1],owner,'opacity')
    alpha=opacity.outputs[0]
    if wipe:
        uv=nodes.new('ShaderNodeTexCoord');sep=nodes.new('ShaderNodeSeparateXYZ')
        links.new(uv.outputs['UV'],sep.inputs[0])
        compare=nodes.new('ShaderNodeMath');compare.operation='LESS_THAN'
        links.new(sep.outputs['X'],compare.inputs[0]);driver(compare.inputs[1],owner,'reveal')
        mul=nodes.new('ShaderNodeMath');mul.operation='MULTIPLY'
        links.new(alpha,mul.inputs[0]);links.new(compare.outputs[0],mul.inputs[1]);alpha=mul.outputs[0]
    mix=nodes.new('ShaderNodeMixShader');links.new(alpha,mix.inputs[0])
    links.new(transparent.outputs[0],mix.inputs[1]);links.new(emission.outputs[0],mix.inputs[2])
    output=nodes.new('ShaderNodeOutputMaterial');links.new(mix.outputs[0],output.inputs[0])
    return mat


def plane(name,path,width,owner,z=0,offset=(0,0),wipe=False):
    im=load_image(path);height=width*im.size[1]/im.size[0]
    mesh=bpy.data.meshes.new(name+' mesh')
    mesh.from_pydata([(-width/2,-height/2,0),(width/2,-height/2,0),(width/2,height/2,0),(-width/2,height/2,0)],[],[(0,1,2,3)])
    mesh.uv_layers.new(name='UVMap')
    for loop,uv in zip(mesh.uv_layers[0].data,[(0,0),(1,0),(1,1),(0,1)]):loop.uv=uv
    obj=bpy.data.objects.new(name,mesh);bpy.context.collection.objects.link(obj)
    obj.parent=owner;obj.location=(offset[0],offset[1],z)
    obj.data.materials.append(image_material(name+' material',path,owner,wipe))
    obj['source_artwork']=str(path)
    return obj


def actor(name,filename,center,width,start,end,z=0,rot=(0,0,0),shadow=True,parent=None,wipe=False):
    path=Path(filename) if Path(filename).is_absolute() else ASSETS/filename
    root=bpy.data.objects.new(name,None);bpy.context.collection.objects.link(root)
    root.empty_display_type='PLAIN_AXES';root['opacity']=1.0;root['reveal']=1.1
    if parent:
        root.parent=parent;root.location=center
    else:root.location=xy(*center,z)
    root.rotation_euler=radians(rot)
    root['display_width_px']=width
    root['start_seconds']=start;root['end_seconds']=end
    main=plane(name+' / artwork',path,width/100,root,wipe=wipe)
    visibility(main,start,end)
    if shadow:
        entry=GRAPH['shadows'].get(path.name) or GRAPH['shadows'].get(path.name.replace('-base.png','.png'))
        if entry:
            im=load_image(path)
            sh=plane(name+' / soft shadow',entry['path'],width/100*entry['width']/im.size[0],root,z=-.10,offset=(.045,-.045))
            visibility(sh,start,end)
    ACTORS.append(root)
    return root


def fade(obj,start,arrival,end,departure=None):
    value_key(obj,'opacity',start,0)
    value_key(obj,'opacity',arrival,1)
    if departure is not None:
        value_key(obj,'opacity',departure,1)
        value_key(obj,'opacity',end,0)


def overlay(name,path,x,y,width,start,end,enter=.38,exit=.3):
    # Camera-local plane guarantees stable, pixel-aligned Chinese reading.
    root=bpy.data.objects.new(name,None);bpy.context.collection.objects.link(root)
    root.parent=CAMERA;root['opacity']=1.;root['reveal']=1.1
    depth=2.0;unit=depth*.72/W
    im=load_image(path);height=width*im.size[1]/im.size[0]
    root.location=((x+width/2-W/2)*unit,(H/2-y-height/2)*unit,-depth)
    p=plane(name+' / overlay',path,width*unit,root)
    visibility(p,start,end)
    if enter:
        fade(root,start,start+enter,end,end-exit if exit else None)
    elif exit:
        value_key(root,'opacity',start,1);value_key(root,'opacity',end-exit,1);value_key(root,'opacity',end,0)
    return root


def title(key,start,end,x=112,y=139,size_width=None):
    item=GRAPH[key]
    return overlay(key,item['path'],x,y,size_width or item['width'],start,end)


def cubic_line(name,points,start,end,draw_end,color=(.15,.35,.09,1),radius=.014):
    curve=bpy.data.curves.new(name,'CURVE');curve.dimensions='3D';curve.resolution_u=24
    curve.bevel_depth=radius;curve.bevel_resolution=3;curve.resolution_u=24
    sp=curve.splines.new('BEZIER');sp.bezier_points.add(len(points)-1)
    for b,point in zip(sp.bezier_points,points):
        b.co=xy(point[0],point[1],-.22);b.handle_left_type='AUTO';b.handle_right_type='AUTO'
    ob=bpy.data.objects.new(name,curve);bpy.context.collection.objects.link(ob)
    mat=bpy.data.materials.new(name+' ink');mat.use_nodes=True
    n=mat.node_tree.nodes;n.clear();e=n.new('ShaderNodeEmission');e.inputs[0].default_value=color
    out=n.new('ShaderNodeOutputMaterial');mat.node_tree.links.new(e.outputs[0],out.inputs[0]);ob.data.materials.append(mat)
    curve.bevel_factor_end=0;curve.keyframe_insert(data_path='bevel_factor_end',frame=frame(start))
    curve.bevel_factor_end=1;curve.keyframe_insert(data_path='bevel_factor_end',frame=frame(draw_end))
    visibility(ob,start,end)
    return ob


def cursor(name,parent,center,width,start,click,end):
    # center is in pixels of the actor's design plane, with its center at (0,0).
    x,y=center
    cur=actor(name,GRAPHICS/'cursor.png',(x/100,-y/100,.30),width,start,end,parent=parent,shadow=False)
    # The authored hotspot is (12,9) in a 100x132 cursor, not its center.
    for child in cur.children:
        child.location.x+=width*.38/100
        child.location.y-=width*.57/100
    pose(cur,start,x/100+1.3,-y/100-.8,.30,scale=.8,local=True)
    pose(cur,click-.15,x/100,-y/100,.30,scale=1,local=True)
    pose(cur,click,x/100,-y/100,.30,scale=.86,local=True)
    pose(cur,click+.18,x/100,-y/100,.30,scale=1,local=True)
    fade(cur,start,start+.2,end,end-.25)
    ring=actor(name+' click',GRAPHICS/'click-ring.png',(x/100,-y/100,.28),110,click,click+.55,parent=parent,shadow=False)
    pose(ring,click,scale=.15);pose(ring,click+.5,scale=1.08)
    value_key(ring,'opacity',click,.9);value_key(ring,'opacity',click+.5,0)


def setup_scene(samples):
    global CAMERA
    bpy.ops.object.select_all(action='SELECT');bpy.ops.object.delete(use_global=False)
    scene=bpy.context.scene;scene.render.engine='BLENDER_EEVEE'
    scene.eevee.taa_render_samples=samples;scene.eevee.use_gtao=False
    scene.eevee.use_soft_shadows=False;scene.eevee.use_bloom=False
    scene.render.resolution_x=W;scene.render.resolution_y=H;scene.render.resolution_percentage=100
    scene.render.fps=FPS;scene.frame_start=1;scene.frame_end=1320
    scene.render.film_transparent=False
    scene.render.image_settings.file_format='PNG';scene.render.image_settings.color_mode='RGB'
    scene.render.image_settings.compression=15
    scene.view_settings.view_transform='Standard';scene.view_settings.look='None'
    scene.view_settings.exposure=0;scene.view_settings.gamma=1
    scene.world.color=(.8,.8,.8)
    data=bpy.data.cameras.new('Film camera');CAMERA=bpy.data.objects.new('Film camera',data)
    bpy.context.collection.objects.link(CAMERA);CAMERA.location=(0,0,CAM_Z)
    CAMERA.data.type='PERSP';CAMERA.data.lens=50;CAMERA.data.sensor_width=36
    CAMERA.data.clip_start=.1;CAMERA.data.clip_end=200
    scene.camera=CAMERA
    # Background is fixed to camera; no visible light rigs or technology motifs.
    bg=actor('Warm white studio',GRAPHICS/'background.png',(960,540),2400,0,44.1,z=-6,shadow=False)
    light_data=bpy.data.lights.new('Soft front light','AREA');light_data.energy=650;light_data.size=9
    lamp=bpy.data.objects.new('Soft front light',light_data);bpy.context.collection.objects.link(lamp)
    lamp.location=(-5,6,12);lamp.rotation_euler=(Vector((0,0,0))-lamp.location).to_track_quat('-Z','Y').to_euler()
    light_data.use_shadow=False
    fill_data=bpy.data.lights.new('Metal edge fill','AREA');fill_data.energy=330;fill_data.size=7;fill_data.use_shadow=False
    fill=bpy.data.objects.new('Metal edge fill',fill_data);bpy.context.collection.objects.link(fill);fill.location=(6,3,9)
    fill.rotation_euler=(Vector((0,0,0))-fill.location).to_track_quat('-Z','Y').to_euler()
    return scene


def build():
    # Stable identity and an explicit demonstration label.
    overlay('Corner brand',ASSETS/'brand-logo.png',88,49,190,0,40.3,enter=.25)
    item=GRAPH['footnote'];overlay('Demonstration label',item['path'],94,1010,item['width'],3.8,40.2)

    # 0–4: brand promise becomes the actual homepage and its dual entry.
    intro=title('intro',0,2.45,x=115,y=310)
    title('intro-sub',.45,2.5,x=119,y=600)
    title('opening-roles',.7,2.6,x=120,y=692)
    hero=actor('01 / DuduHire homepage','hero-window.png',(1440,560),930,0,4.55,z=.2)
    fade(hero,0,.85,4.55,4.02)
    pose(hero,0,1585,660,-.7,scale=.90,rot=(4,-14,-3))
    pose(hero,1.4,1420,585,.1,scale=1,rot=(3,-8,-2))
    pose(hero,2.9,1000,590,.1,scale=1.56,rot=(1,-2,0))
    pose(hero,3.75,980,585,.15,scale=1.58,rot=(.5,0,0))
    pose(hero,4.5,800,190,-.5,scale=1.45,rot=(8,3,1))

    # 4–10: readable natural-language input, followed by a deliberate click.
    title('demand-title',4.45,9.75)
    inp=actor('02 / Demand input shell','demand-input-base.png',(995,605),1540,3.65,10.4)
    fade(inp,3.65,4.4,10.4,9.8)
    pose(inp,3.65,1130,880,-1.2,scale=.92,rot=(10,-6,1))
    pose(inp,4.6,995,605,0,scale=1,rot=(2,-2,0))
    pose(inp,9.25,975,600,.15,scale=1.015,rot=(0,1,0))
    pose(inp,10.4,400,585,-1.1,scale=.90,rot=(2,13,-2))
    txt=actor('02 / Demand words','demand-input-text.png',(0,0,.035),1540,4.65,10.4,parent=inp,shadow=False,wipe=True)
    value_key(txt,'reveal',4.65,0);value_key(txt,'reveal',5.85,1.1)
    value_key(txt,'opacity',9.8,1);value_key(txt,'opacity',10.4,0)
    cursor('02 / Begin clarification',inp,(562.44,159.58),62,7.7,8.65,9.25)

    # 10–16: three independent cards form out of the source, with traceable links.
    title('structure-title',10.4,15.62)
    source=actor('03 / Original demand','demand-source.png',(460,620),590,9.85,16.5,rot=(0,3,0))
    fade(source,9.85,10.55,16.5,15.95)
    pose(source,9.85,280,675,-1,scale=.9,rot=(3,8,-2))
    pose(source,10.65,460,620,0,scale=1,rot=(0,2,0))
    pose(source,15.65,454,615,.12,scale=1,rot=(0,0,0))
    pose(source,16.5,350,60,-1,scale=.96,rot=(7,3,-2))
    for i,y in enumerate((413,647,881)):
        st=10.55+i*.19
        obj=actor(f'03 / Demand field {i+1}',f'demand-field-{i+1}.png',(1260,y),805,st,16.5,z=.12+i*.10)
        fade(obj,st,st+.65,16.5,15.95)
        pose(obj,st,1080,y+105,-.7,scale=.90,rot=(5,-5,1))
        pose(obj,st+.80,1260,y,.12+i*.10,scale=1,rot=(0,-1,0))
        pose(obj,15.65,1268,y-3,.2+i*.10,scale=1,rot=(0,0,0))
        pose(obj,16.5,1360,y-530,-.6,scale=.96,rot=(6,-4,1))
        cubic_line(f'03 / Source relation {i+1}',[(758,y),(796,y),(838,y),(853,y)],st+.45,15.95,st+1.15)

    # 16–21: mirrored talent input makes the two sides understandable.
    title('talent-title',16.4,20.62)
    talent=actor('04 / Experience input','talent-input-base.png',(995,605),1540,15.7,21.4)
    fade(talent,15.7,16.45,21.4,20.87)
    pose(talent,15.7,1100,875,-1,scale=.93,rot=(8,-5,1))
    pose(talent,16.55,995,605,0,scale=1,rot=(2,-2,0))
    pose(talent,20.6,975,600,.15,scale=1.015,rot=(0,1,0))
    pose(talent,21.4,1600,645,-1,scale=.88,rot=(3,-12,2))
    words=actor('04 / Experience words','talent-input-text.png',(0,0,.035),1540,16.6,21.4,parent=talent,shadow=False,wipe=True)
    value_key(words,'reveal',16.6,0);value_key(words,'reveal',17.7,1.1)
    value_key(words,'opacity',20.87,1);value_key(words,'opacity',21.4,0)
    cursor('04 / Clarify experience',talent,(562.44,159.58),62,18.75,19.6,20.25)

    # 21–28: a physical identity card and its evidence, linked but distinct.
    title('card-title',21.35,27.58,x=925,y=171,size_width=760)
    title('card-note',21.7,27.58,x=933,y=291)
    rig=bpy.data.objects.new('05 / Hanging identity rig',None);bpy.context.collection.objects.link(rig)
    rig.location=xy(525,155,0)
    pose(rig,20.65,485,-280,-.4,rot=(0,-6,-5))
    pose(rig,21.7,525,155,.2,rot=(0,-2,2.7))
    pose(rig,22.5,525,155,.2,rot=(0,-1,-1.4))
    pose(rig,23.4,525,155,.2,rot=(0,0,.5))
    pose(rig,24.2,525,155,.2,rot=(0,0,0))
    pose(rig,27.55,525,155,.2,rot=(0,0,0))
    pose(rig,28.5,375,-730,-.5,rot=(0,5,-3))
    card=actor('05 / Capability identity','capability-card.png',(0,-4.6,0),500,20.65,28.5,parent=rig)
    fade(card,20.65,21.45,28.5,27.7)
    try:
        from card_rig import add_lanyard
        for obj in add_lanyard(rig,card_width=5.0,card_height=500/590*750/100,card_center_y=-4.6):
            visibility(obj,20.65,28.5)
    except ImportError:
        raise RuntimeError('card_rig.py must exist before final rendering')
    evidence=actor('05 / Evidence and responsibility','evidence-panel.png',(1290,650),845,21.7,28.5,rot=(0,-3,0))
    fade(evidence,21.7,22.55,28.5,27.75)
    pose(evidence,21.7,1510,725,-.5,scale=.91,rot=(3,-7,1))
    pose(evidence,22.65,1290,650,.05,scale=1,rot=(0,-2,0))
    pose(evidence,27.6,1280,645,.16,scale=1.014,rot=(0,0,0))
    pose(evidence,28.5,1530,220,-.6,scale=.94,rot=(5,-4,1))

    # 28–34: a visible edit, then the confirmed state, without public verification claims.
    title('confirm-title',28.45,33.55)
    conf=actor('06 / Review source before confirming','confirm-before.png',(1010,604),1290,27.8,29.95)
    fade(conf,27.8,28.65,29.95,29.55)
    pose(conf,27.8,880,865,-.8,scale=.92,rot=(8,5,-1))
    pose(conf,28.7,1010,604,.05,scale=1,rot=(1,0,0))
    pose(conf,29.55,1010,604,.05,scale=1,rot=(0,0,0))
    edited=actor('06 / Corrected words await confirmation','confirm-edited.png',(1010,604),1290,29.55,31.35,z=.055)
    fade(edited,29.55,29.95,31.35,30.95)
    after=actor('06 / Confirmed own contribution','confirm-after.png',(1010,604),1290,30.95,34.5,z=.06)
    fade(after,30.95,31.35,34.5,33.92)
    pose(after,31.3,1010,604,.06,scale=1,rot=(0,0,0))
    pose(after,33.65,1010,601,.10,scale=1.006,rot=(0,0,0))
    pose(after,34.5,790,255,-.7,scale=.88,rot=(8,8,-2))
    cursor('06 / Edit contribution',conf,(517.17,-62.15),60,28.9,29.42,29.8)
    cursor('06 / Confirm corrected contribution',edited,(430.39,250.96),60,30.1,30.9,31.2)
    title('private-note',31.45,33.65,x=665,y=978)

    # 34–40: approved fallback is an explicit comparison of confirmed example material.
    title('compare-title',34.45,39.85)
    left=actor('07 / Confirmed example demand','compare-demand.png',(534,604),715,33.7,40.98,z=.15)
    right=actor('07 / Confirmed example capability','compare-capability.png',(1396,604),715,33.8,40.98,z=.15)
    for obj,x,sign in [(left,534,-1),(right,1396,1)]:
        fade(obj,33.7,34.7,40.95,40.0)
        pose(obj,33.7,x+sign*240,770,-.8,scale=.91,rot=(4,sign*-7,sign*2))
        pose(obj,34.9,x,604,.15,scale=1,rot=(0,sign*-2,0))
        pose(obj,39.65,x,601,.2,scale=1,rot=(0,0,0))
        pose(obj,40.8,960+sign*470,660,-3.5,scale=.45,rot=(5,sign*10,sign*-3))
    cubic_line('07 / Shared work relation',[(900,595),(940,595),(990,595),(1030,595)],35.3,39.94,36.05,color=(.21,.47,.12,1),radius=.018)
    item=GRAPH['compare-note'];overlay('07 / Clear example status',item['path'],735,948,item['width'],34.9,40.2)

    # 40–44: everything yields to the brand; the final three seconds are still.
    overlay('08 / Main brand',ASSETS/'brand-logo.png',665,345,590,40.05,44.1,enter=.65,exit=0)
    title('ending-title',40.30,44.1,x=480,y=579,size_width=960)
    # Override fade-out on the closing message: hold right through the end.
    closing=bpy.data.objects.get('ending-title')
    if closing:
        closing.animation_data_clear();closing['opacity']=0
        value_key(closing,'opacity',40.3,0);value_key(closing,'opacity',40.9,1)
    ending=title('ending-sub',40.5,44.1,x=643,y=715,size_width=634)
    ending.animation_data_clear();ending['opacity']=0
    value_key(ending,'opacity',40.5,0);value_key(ending,'opacity',40.95,1)
    # Structured timeline markers are true content boundaries, not decorative numbering.
    for t,label in [(0,'品牌与双入口'),(4,'需求输入'),(10,'需求结构'),(16,'经历输入'),(21,'能力与依据'),(28,'本人确认'),(34,'示例资料对照'),(40,'品牌收尾')]:
        bpy.context.scene.timeline_markers.new(label,frame=frame(t))


def main():
    global ASSETS, GRAPHICS, BUILD, GRAPH
    parser=argparse.ArgumentParser();parser.add_argument('--samples',type=int,default=8)
    parser.add_argument('--frames',default='');parser.add_argument('--render',action='store_true')
    parser.add_argument('--start',type=int,default=1);parser.add_argument('--end',type=int,default=1320)
    parser.add_argument('--assets-dir',type=Path,default=ASSETS)
    parser.add_argument('--graphics-dir',type=Path,default=GRAPHICS)
    parser.add_argument('--build-dir',type=Path,default=BUILD)
    parser.add_argument('--resolution-scale',type=int,choices=(1,2),default=1)
    argv=sys.argv[sys.argv.index('--')+1:] if '--' in sys.argv else []
    args=parser.parse_args(argv)
    ASSETS=args.assets_dir.resolve();GRAPHICS=args.graphics_dir.resolve();BUILD=args.build_dir.resolve()
    GRAPH=json.loads((GRAPHICS/'manifest.json').read_text())
    BUILD.mkdir(parents=True,exist_ok=True);(BUILD/'frames').mkdir(exist_ok=True);(BUILD/'stills').mkdir(exist_ok=True)
    scene=setup_scene(args.samples);build()
    scene.render.resolution_percentage=100*args.resolution_scale
    scene.render.filepath=str(BUILD/'frames'/'frame_')
    scene['film_title']='DuduHire — 让需求说得清，让能力看得见'
    scene['status']='Approved concept; independent product interaction demonstration'
    scene['source_reference']='81be96f13424478eb48b17b7c9decb38.mp4; original content is not used'
    scene['matching_scene']='Confirmed example materials shown for comparison; no fabricated match output'
    scene.frame_set(1)
    bpy.ops.wm.save_as_mainfile(filepath=str(BUILD/'duduhire-product-motion.blend'))
    if args.frames:
        for token in args.frames.split(','):
            f=int(token);scene.frame_set(f);scene.render.filepath=str(BUILD/'stills'/f'frame-{f:04d}.png')
            bpy.ops.render.render(write_still=True)
            print('STILL_READY',f,flush=True)
    if args.render:
        scene.frame_start=args.start;scene.frame_end=args.end
        scene.render.filepath=str(BUILD/'frames'/'frame_')
        bpy.ops.render.render(animation=True)
    print('SCENE_READY',str(BUILD/'duduhire-product-motion.blend'),flush=True)


if __name__=='__main__':main()
