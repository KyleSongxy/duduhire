#!/usr/bin/env python3
"""Deterministic film graphics. Existing product assets are read-only inputs."""
from pathlib import Path
import argparse
import json
from PIL import Image, ImageDraw, ImageFont, ImageFilter

ROOT = Path(__file__).resolve().parent
ASSETS = ROOT / 'assets'
OUT = ROOT / '.generated' / 'graphics'
SCALE = 1
FONT = '/System/Library/Fonts/STHeiti Medium.ttc'
LIGHT = '/System/Library/Fonts/STHeiti Light.ttc'
INK = '#181818'
FOREST = '#102a1d'
GREEN = '#0f8300'
LIME = '#9fe870'


def font(size, light=False):
    return ImageFont.truetype(LIGHT if light else FONT, size, index=1)


def text_image(name, lines, size=80, color=INK, leading=1.32, width=None, light=False):
    f = font(size, light)
    bbox = [f.getbbox(s) for s in lines]
    w = width or max(b[2]-b[0] for b in bbox)+12
    h = round(size * leading * len(lines))+12
    im = Image.new('RGBA', (w*SCALE, h*SCALE))
    d = ImageDraw.Draw(im)
    f = font(size*SCALE, light)
    for i, s in enumerate(lines):
        d.text((4*SCALE, (i*size*leading+4)*SCALE), s, font=f, fill=color, stroke_width=0)
    im.save(OUT / (name+'.png'))
    return {'path':str(OUT / (name+'.png')), 'width':w, 'height':h,
            'pixel_width':im.width, 'pixel_height':im.height, 'output_scale':SCALE}


def main():
    global ASSETS, OUT, SCALE
    parser = argparse.ArgumentParser()
    parser.add_argument('--assets', type=Path, default=ASSETS)
    parser.add_argument('--output', type=Path, default=OUT)
    parser.add_argument('--scale', type=int, choices=(1,2,3), default=1)
    args = parser.parse_args()
    ASSETS, OUT, SCALE = args.assets.resolve(), args.output.resolve(), args.scale
    OUT.mkdir(parents=True, exist_ok=True)
    manifest = {}
    for name, lines, size, color in [
        ('intro', ['让需求说得清', '让能力看得见'], 94, INK),
        ('intro-sub', ['从一个问题，或一段经历开始。'], 33, '#5e5e5e'),
        ('demand-title', ['从一个问题开始'], 80, INK),
        ('structure-title', ['把需求整理清楚'], 80, INK),
        ('talent-title', ['从一段经历开始'], 80, INK),
        ('card-title', ['让能力有据可循'], 76, INK),
        ('confirm-title', ['内容，由你确认'], 80, INK),
        ('compare-title', ['看清工作与能力'], 80, INK),
        ('ending-title', ['让需求说得清，让能力看得见。'], 68, INK),
        ('ending-sub', ['梳理用人需求   /   完善能力档案'], 34, '#5e5e5e'),
        ('footnote', ['产品交互演示 · 示例内容'], 24, '#6d736d'),
        ('compare-note', ['已确认示例资料 · 供对照理解'], 28, '#5e5e5e'),
        ('card-note', ['个人职责 · 具体行动 · 提炼依据'], 31, '#5e5e5e'),
        ('confirm-note', ['本人确认 · 未经平台验证'], 29, '#5e5e5e'),
        ('private-note', ['确认保存后，展示内容仍由你决定'], 30, '#5e5e5e'),
        ('opening-roles', ['业务需求      专业能力'], 28, GREEN),
    ]:
        manifest[name] = text_image(name, lines, size, color)

    # A quiet studio background, using product surface colors rather than stock art.
    bg = Image.new('RGB', (1920*SCALE,1080*SCALE), '#f7f7f7')
    glow = Image.new('RGBA', bg.size)
    d = ImageDraw.Draw(glow)
    d.ellipse(tuple(v*SCALE for v in (1120,-520,2440,1080)), fill=(220,240,211,74))
    d.ellipse(tuple(v*SCALE for v in (-600,460,850,1530)), fill=(222,225,215,76))
    glow = glow.filter(ImageFilter.GaussianBlur(140*SCALE))
    bg = Image.alpha_composite(bg.convert('RGBA'),glow)
    bg.save(OUT/'background.png')

    # Cursor and ring are separate objects, timed to specific demonstrated actions.
    im=Image.new('RGBA',(100*SCALE,132*SCALE))
    d=ImageDraw.Draw(im)
    points=[(12,9),(12,90),(35,71),(54,113),(70,105),(49,64),(80,61)]
    d.polygon([(x*SCALE,y*SCALE) for x,y in points],fill='#ffffff',outline='#17271b',width=4*SCALE)
    im.save(OUT/'cursor.png')
    im=Image.new('RGBA',(160*SCALE,160*SCALE));d=ImageDraw.Draw(im)
    d.ellipse(tuple(v*SCALE for v in (8,8,152,152)),outline=(159,232,112,235),width=7*SCALE)
    im.save(OUT/'click-ring.png')

    # Each source mask yields a bounded, noise-free soft shadow in the same rig.
    shadows={}
    for p in sorted(ASSETS.glob('*.png')):
        if p.name.endswith(('-text.png','-base.png')) or p.name=='brand-logo.png':
            continue
        src=Image.open(p).convert('RGBA')
        pad=90*SCALE
        mask=Image.new('L',(src.width+2*pad,src.height+2*pad))
        mask.paste(src.getchannel('A'),(pad,pad+14*SCALE))
        blur=mask.filter(ImageFilter.GaussianBlur(25*SCALE)).point(lambda v:round(v*.13))
        shadow=Image.new('RGBA',mask.size,FOREST);shadow.putalpha(blur)
        out=OUT/(p.stem+'-shadow.png');shadow.save(out)
        shadows[p.name]={'path':str(out),'pad':pad,'width':shadow.width,'height':shadow.height}
    manifest['shadows']=shadows
    (OUT/'manifest.json').write_text(json.dumps(manifest,ensure_ascii=False,indent=2)+'\n')
    print(f'Graphics ready: {OUT}')


if __name__=='__main__':
    main()
