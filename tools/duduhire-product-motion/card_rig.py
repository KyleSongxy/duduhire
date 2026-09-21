"""Local Blender geometry for the DuduHire capability card's lanyard.

The helper creates hardware and fabric only. All returned objects are direct
children of the supplied parent, in its XY plane, facing a camera on +Z.
"""

import math
import bpy


def _linear(hex_color):
    rgb = [int(hex_color[index:index + 2], 16) / 255 for index in (1, 3, 5)]
    return tuple(value / 12.92 if value <= 0.04045 else ((value + 0.055) / 1.055) ** 2.4 for value in rgb) + (1,)


def _material(name, color, roughness=0.75, metalness=0.0, fabric=False):
    material = bpy.data.materials.new(name)
    material.diffuse_color = _linear(color)
    material.use_nodes = True
    nodes = material.node_tree.nodes
    shader = nodes.get('Principled BSDF')
    shader.inputs['Base Color'].default_value = _linear(color)
    shader.inputs['Roughness'].default_value = roughness
    shader.inputs['Metallic'].default_value = metalness
    shader.inputs['Specular IOR Level'].default_value = 0.28 if metalness else 0.18
    if fabric:
        noise = nodes.new('ShaderNodeTexNoise')
        noise.inputs['Scale'].default_value = 180
        noise.inputs['Detail'].default_value = 1.0
        bump = nodes.new('ShaderNodeBump')
        bump.inputs['Strength'].default_value = 0.11
        bump.inputs['Distance'].default_value = 0.008
        material.node_tree.links.new(noise.outputs['Fac'], bump.inputs['Height'])
        material.node_tree.links.new(bump.outputs['Normal'], shader.inputs['Normal'])
    return material


def _mesh(parent, name, vertices, faces, materials, output):
    mesh = bpy.data.meshes.new(name + ' mesh')
    mesh.from_pydata(vertices, [], faces)
    mesh.update()
    obj = bpy.data.objects.new(name, mesh)
    bpy.context.collection.objects.link(obj)
    obj.parent = parent
    for material in materials:
        mesh.materials.append(material)
    output.append(obj)
    return obj


def _rounded_outline(width, height, radius, steps=10):
    radius = min(radius, width / 2, height / 2)
    points = []
    corners = ((width / 2 - radius, height / 2 - radius, 0),
               (-width / 2 + radius, height / 2 - radius, 90),
               (-width / 2 + radius, -height / 2 + radius, 180),
               (width / 2 - radius, -height / 2 + radius, 270))
    for x, y, angle in corners:
        for index in range(steps + 1):
            theta = math.radians(angle + 90 * index / steps)
            points.append((x + radius * math.cos(theta), y + radius * math.sin(theta)))
    return points


def _box(parent, name, center, size, radius, material, output):
    x, y, z = center
    width, height, depth = size
    outline = _rounded_outline(width, height, radius)
    count = len(outline)
    vertices = [(x + px, y + py, z + depth / 2) for px, py in outline]
    vertices += [(x + px, y + py, z - depth / 2) for px, py in outline]
    faces = [tuple(range(count)), tuple(reversed(range(count, 2 * count)))]
    faces += [(index, index + count, (index + 1) % count + count, (index + 1) % count) for index in range(count)]
    obj = _mesh(parent, name, vertices, faces, [material], output)
    modifier = obj.modifiers.new('Small rounded metal edge', 'BEVEL')
    modifier.width = min(depth * 0.18, 0.012)
    modifier.segments = 3
    obj.data.use_auto_smooth = True
    obj.modifiers.new('Face normals', 'WEIGHTED_NORMAL')
    return obj


def _ring(parent, center, width, height, border, depth, material, output):
    x, y, z = center
    outer = _rounded_outline(width, height, min(width / 2, 0.13))
    inner = _rounded_outline(width - 2 * border, height - 2 * border, max(0.01, min(width / 2, 0.13) - border))
    count = len(outer)
    vertices = []
    for plane_z, outline in ((z + depth / 2, outer), (z + depth / 2, inner), (z - depth / 2, outer), (z - depth / 2, inner)):
        vertices += [(x + px, y + py, plane_z) for px, py in outline]
    faces = []
    for index in range(count):
        next_index = (index + 1) % count
        faces.extend(((index, next_index, count + next_index, count + index),
                      (2 * count + index, 3 * count + index, 3 * count + next_index, 2 * count + next_index),
                      (index, 2 * count + index, 2 * count + next_index, next_index),
                      (count + index, count + next_index, 3 * count + next_index, 3 * count + index)))
    obj = _mesh(parent, 'DH lanyard connector ring', vertices, faces, [material], output)
    obj.data.use_auto_smooth = True
    bevel = obj.modifiers.new('Rounded ring edges', 'BEVEL')
    bevel.width = depth * 0.17
    bevel.segments = 3
    obj.modifiers.new('Ring normals', 'WEIGHTED_NORMAL')
    return obj


def _cubic(points, t):
    u = 1 - t
    return tuple(u ** 3 * points[0][axis] + 3 * u * u * t * points[1][axis]
                 + 3 * u * t * t * points[2][axis] + t ** 3 * points[3][axis]
                 for axis in range(2))


def _ribbon(parent, name, points, width, thickness, scale, fabric, edge, stitch, output):
    def position(t, offset=0, z_offset=0):
        x, y = _cubic(points, t)
        before = _cubic(points, max(0, t - 0.0005))
        after = _cubic(points, min(1, t + 0.0005))
        dx, dy = after[0] - before[0], after[1] - before[1]
        length = max(math.hypot(dx, dy), 1e-9)
        x += -dy / length * offset
        y += dx / length * offset
        z = scale * (0.07 + 0.025 * math.sin(t * math.pi)) + z_offset
        return x, y, z

    segments = 70
    vertices = []
    for index in range(segments + 1):
        t = index / segments
        vertices += [position(t, -width / 2, thickness / 2), position(t, width / 2, thickness / 2),
                     position(t, -width / 2, -thickness / 2), position(t, width / 2, -thickness / 2)]
    faces = []
    for index in range(segments):
        current, following = index * 4, (index + 1) * 4
        faces.extend(((current, following, following + 1, current + 1),
                      (current + 2, current + 3, following + 3, following + 2),
                      (current, current + 2, following + 2, following),
                      (current + 1, following + 1, following + 3, current + 3)))
    faces += [(0, 1, 3, 2), (4 * segments, 4 * segments + 2, 4 * segments + 3, 4 * segments + 1)]
    ribbon = _mesh(parent, name, vertices, faces, [fabric, edge], output)
    for index, polygon in enumerate(ribbon.data.polygons):
        polygon.material_index = 0 if index % 4 == 0 else 1
        polygon.use_smooth = True

    vertices, faces = [], []
    dash_count = 42
    for side in (-1, 1):
        offset = side * width * 0.37
        for index in range(dash_count):
            start = (index + 0.12) / dash_count
            end = (index + 0.55) / dash_count
            base = len(vertices)
            half_line_width = 0.005 * scale
            vertices += [position(start, offset - half_line_width, thickness / 2 + 0.001 * scale),
                         position(end, offset - half_line_width, thickness / 2 + 0.001 * scale),
                         position(end, offset + half_line_width, thickness / 2 + 0.001 * scale),
                         position(start, offset + half_line_width, thickness / 2 + 0.001 * scale)]
            faces.append((base, base + 1, base + 2, base + 3))
    _mesh(parent, name + ' restrained edge stitching', vertices, faces, [stitch], output)

    # Very fine crosswise weave: geometry, not an external bitmap dependency.
    vertices, faces = [], []
    for index in range(100):
        start = (index + 0.1) / 100
        end = (index + 0.28) / 100
        base = len(vertices)
        vertices += [position(start, -width * 0.34, thickness / 2 + 0.0007 * scale),
                     position(end, -width * 0.34, thickness / 2 + 0.0007 * scale),
                     position(end, width * 0.34, thickness / 2 + 0.0007 * scale),
                     position(start, width * 0.34, thickness / 2 + 0.0007 * scale)]
        faces.append((base, base + 1, base + 2, base + 3))
    _mesh(parent, name + ' fabric cross weave', vertices, faces, [edge], output)


def add_lanyard(parent, card_width=5.0, card_height=6.36, card_center_y=-4.6):
    """Create lanyard, clip, connector ring and the card's short top slot.

    Args:
        parent: Existing Blender Object, used directly as each object's parent.
        card_width/card_height: Card dimensions in the parent's local XY plane.
        card_center_y: Card PNG center, with its surface at local Z=0.

    Returns:
        List of newly created bpy.types.Object instances. The helper creates no
        card body, text, lights, camera, animation or external image dependency.
    """
    if parent is None or card_width <= 0 or card_height <= 0:
        raise ValueError('An existing parent and positive card dimensions are required')
    output = []
    scale = card_width / 5
    top = card_center_y + card_height / 2
    clip_y = top + 0.31 * scale
    start_y = 2.2 * scale
    if clip_y >= start_y:
        raise ValueError('Card top must sit below the lanyard upper ends')
    fabric = _material('DH lanyard forest fabric', '#263C30', fabric=True)
    edge = _material('DH lanyard woven dark edge', '#34483B', fabric=True)
    stitch = _material('DH lanyard quiet sage seam', '#768477', roughness=0.95)
    metal = _material('DH lanyard brushed pewter', '#9CA89F', roughness=0.33, metalness=0.72)
    metal_light = _material('DH lanyard satin edge', '#CBD1CA', roughness=0.28, metalness=0.58)
    metal_dark = _material('DH lanyard hardware recess', '#435149', roughness=0.52, metalness=0.45)
    slot_dark = _material('DH lanyard short card slot', '#070F0B', roughness=0.92)

    drop = start_y - clip_y
    for side, label in ((-1, 'left'), (1, 'right')):
        points = [(side * 1.24 * scale, start_y),
                  (side * 1.15 * scale, start_y - drop * 0.34),
                  (side * 0.76 * scale, clip_y + drop * 0.27),
                  (side * 0.28 * scale, clip_y + 0.035 * scale)]
        _ribbon(parent, 'DH lanyard ' + label + ' woven strap', points,
                0.31 * scale, 0.035 * scale, scale, fabric, edge, stitch, output)

    # Slot is a local overlay at the PNG surface, without replacing the card.
    slot_y = top - 0.23 * scale
    _box(parent, 'DH lanyard top slot rim', (0, slot_y, 0.010 * scale),
         (0.99 * scale, 0.145 * scale, 0.010 * scale), 0.055 * scale, metal_dark, output)
    _box(parent, 'DH lanyard top slot recess', (0, slot_y, 0.019 * scale),
         (0.89 * scale, 0.092 * scale, 0.010 * scale), 0.040 * scale, slot_dark, output)
    _ring(parent, (0, top + 0.025 * scale, 0.080 * scale),
          0.52 * scale, 0.54 * scale, 0.073 * scale, 0.068 * scale, metal, output)

    _box(parent, 'DH lanyard clasp back', (0, clip_y - 0.035 * scale, 0.111 * scale),
         (1.045 * scale, 0.38 * scale, 0.080 * scale), 0.075 * scale, metal_dark, output)
    _box(parent, 'DH lanyard rounded clasp face', (0, clip_y, 0.180 * scale),
         (1.09 * scale, 0.355 * scale, 0.105 * scale), 0.068 * scale, metal, output)
    _box(parent, 'DH lanyard clasp top glint', (0, clip_y + 0.111 * scale, 0.237 * scale),
         (0.88 * scale, 0.026 * scale, 0.011 * scale), 0.012 * scale, metal_light, output)
    _box(parent, 'DH lanyard clasp inset opening', (0, clip_y + 0.025 * scale, 0.239 * scale),
         (0.70 * scale, 0.076 * scale, 0.012 * scale), 0.021 * scale, metal_dark, output)
    _box(parent, 'DH lanyard clasp lower fold', (0, clip_y - 0.117 * scale, 0.239 * scale),
         (0.73 * scale, 0.035 * scale, 0.022 * scale), 0.010 * scale, metal_light, output)
    for x in (-0.444, 0.444):
        _box(parent, 'DH lanyard clasp rivet', (x * scale, clip_y + 0.020 * scale, 0.242 * scale),
             (0.045 * scale, 0.045 * scale, 0.013 * scale), 0.021 * scale, metal_light, output)
    for obj in output:
        obj['duduhire_component'] = 'lanyard_hardware'
    return output
