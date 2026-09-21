#!/usr/bin/env python3
"""Build deterministic, transparent UI planes for the DuduHire motion film.

These are product interaction demonstrations from current source copy. They are
not screenshots of a live AI call, customer records, or platform verification.
No timeline, external shadows, camera, cursor, or lanyard is rendered here.

The default writes the existing 1x assets. For native 3x UI planes:
    python3 build_assets.py --output assets-hd --scale 3
Output paths are relative to this script unless absolute. Layout coordinates
stay in logical pixels; HD manifests also provide physical pixel coordinates.
"""
from pathlib import Path
import argparse
import json
import math
import sys

HERE = Path(__file__).resolve().parent
ROOT = HERE.parents[1]
OUT = HERE / "assets"
sys.path.insert(0, str(OUT / ".deps"))
from PIL import Image, ImageDraw, ImageFont
from fontTools.ttLib import TTFont
from fontTools.varLib.instancer import instantiateVariableFont

S = 2
OUTPUT_SCALE = 1
BG = "#fdfdfd"
INK = "#181818"
MUTED = "#5e5e5e"
GREEN = "#0f8300"
LIME = "#9fe870"
PALE = "#d8f7c7"
DEEP = "#102a1d"
DEEP2 = "#173728"
LINE = "#ddddda"
LIGHT = "#f7f7f7"
FONT_SC = "/System/Library/Fonts/STHeiti Medium.ttc"
FONT_SC_LIGHT = "/System/Library/Fonts/STHeiti Light.ttc"
FONT_INDEX = 1
FONT_SRC = ROOT / "apps/web/public/fonts/duduhire-sans.woff2"
LOGO_SRC = ROOT / "apps/web/public/images/duduhire-logo.png"
HOME_SRC = HERE / "reference/home-demand.png"
FONT_TTF = OUT / "duduhire-sans-600.ttf"
META = {}
TEXT_AUDIT = []


def prepare_fonts():
    OUT.mkdir(parents=True, exist_ok=True)
    if not FONT_TTF.exists():
        font = TTFont(FONT_SRC)
        font.flavor = None
        font = instantiateVariableFont(font, {"wght": 600}, inplace=True)
        font.save(FONT_TTF)


FONT_CACHE = {}
def font(size, medium=False, latin=False):
    key = (size, medium, latin)
    if key not in FONT_CACHE:
        p = str(FONT_TTF) if latin else FONT_SC if medium else FONT_SC_LIGHT
        FONT_CACHE[key] = ImageFont.truetype(p, round(size*S), index=0 if latin else FONT_INDEX)
    return FONT_CACHE[key]


class Plane:
    def __init__(self, w, h):
        self.w, self.h = w, h
        self.im = Image.new("RGBA", (w*S, h*S), (0, 0, 0, 0))
        self.d = ImageDraw.Draw(self.im)

    def rr(self, box, r=20, fill=BG, outline=None, width=1):
        self.d.rounded_rectangle(tuple(round(v*S) for v in box), round(r*S), fill,
                                 outline, width=round(width*S))

    def line(self, xy, fill=LINE, width=1):
        self.d.line(tuple(round(v*S) for v in xy), fill, round(width*S))

    def dot(self, x, y, radius=4, fill=GREEN):
        self.d.ellipse(((x-radius)*S, (y-radius)*S, (x+radius)*S, (y+radius)*S), fill=fill)

    def text(self, xy, value, size=32, fill=INK, medium=False, latin=False, anchor="lt"):
        x, y = xy
        f = font(size, medium, latin)
        self.d.text((round(x*S), round(y*S)), value, font=f, fill=fill, anchor=anchor)
        box = self.d.textbbox((round(x*S), round(y*S)), value, font=f, anchor=anchor)
        TEXT_AUDIT.append({"text": value, "size": size, "bbox": [v/S for v in box],
                           "plane": [self.w, self.h]})
        if box[0] < -1 or box[1] < -1 or box[2] > self.w*S+1 or box[3] > self.h*S+1:
            raise ValueError(f"Text outside plane: {value}: {box}, {self.w}x{self.h}")
        return (box[2]-box[0])/S

    def pill(self, xy, text, fill=LIGHT, ink=MUTED, size=23, pad=17, height=45, medium=False, outline=None):
        x, y = xy
        width = self.d.textlength(text, font=font(size, medium))/S+pad*2
        self.rr((x, y, x+width, y+height), r=height/2, fill=fill, outline=outline)
        self.text((x+width/2, y+height/2), text, size, ink, medium, anchor="mm")
        return width

    def paste(self, img, box):
        x, y, w, h = box
        resized = img.resize((round(w*S), round(h*S)), Image.Resampling.LANCZOS)
        self.im.alpha_composite(resized, (round(x*S), round(y*S)))

    def save(self, name, purpose, copy, sources=None, **extra):
        output_size = (self.w*OUTPUT_SCALE, self.h*OUTPUT_SCALE)
        # At 2x/3x, save the native draw buffer without a 1x detour or upscaling.
        output_image = self.im if self.im.size == output_size else self.im.resize(output_size, Image.Resampling.LANCZOS)
        output_image.save(OUT/name)
        META[name] = {"width": output_size[0], "height": output_size[1], "purpose": purpose,
                      "copy": copy, "sources": sources or ["docs/PRODUCT.md", "apps/web/src/discoveryFlow.ts"],
                      "transparent_background": True, "external_shadow": False,
                      "classification": "product_interaction_demonstration", **extra}
        if OUTPUT_SCALE != 1:
            coordinate_keys = {"text_bbox", "text_layout_area", "button_bbox", "button_center",
                               "attachment_point", "highlight_bbox", "field_bbox", "edit_button_center",
                               "confirmation_button_center", "role_evidence_bbox", "common_work_bbox"}
            META[name].update({"logical_width": self.w, "logical_height": self.h,
                               "output_scale": OUTPUT_SCALE,
                               "coordinate_space": "logical_layout_pixels",
                               "pixel_coordinates": {key: [value*OUTPUT_SCALE for value in extra[key]]
                                                     for key in coordinate_keys if key in extra},
                               "alpha_bbox_pixels": list(output_image.getbbox()) if output_image.getbbox() else None})
            if "crop_bbox" in extra:
                META[name]["crop_bbox_coordinate_space"] = "source_image_pixels"


def arrow(p, cx, cy, ink=BG, size=13, width=3):
    p.line((cx-size, cy, cx+size, cy), ink, width)
    p.line((cx+size-9, cy-9, cx+size, cy, cx+size-9, cy+9), ink, width)


def check(p, cx, cy, ink=GREEN, size=10, width=3):
    p.line((cx-size, cy, cx-2, cy+size*.75, cx+size, cy-size*.7), ink, width)


def pencil(p, cx, cy, ink=GREEN):
    p.line((cx-10, cy+8, cx+7, cy-9), ink, 3)
    p.line((cx-6, cy+12, cx+11, cy-5), ink, 3)
    p.line((cx-10, cy+8, cx-12, cy+14, cx-6, cy+12), ink, 2)
    p.line((cx+7, cy-9, cx+11, cy-5), ink, 3)


def brand(p, xy, width=230, light=False):
    logo = Image.open(LOGO_SRC).convert("RGBA")
    logo = logo.crop(logo.getbbox())
    if light:
        pixels = logo.load()
        for y in range(logo.height):
            for x in range(logo.width):
                r,g,b,a = pixels[x,y]
                if a and max(r,g,b) < 100:
                    pixels[x,y] = (253,253,253,a)
    p.paste(logo, (xy[0], xy[1], width, width*logo.height/logo.width))


def build_logo():
    logo = Image.open(LOGO_SRC).convert("RGBA")
    crop = logo.getbbox()
    logo = logo.crop(crop)
    logo.save(OUT/"brand-logo.png")
    META["brand-logo.png"] = {"width": logo.width, "height": logo.height,
        "purpose": "Original transparent DuduHire logo, no wordmark reconstruction",
        "copy": "DuduHire", "sources": [str(LOGO_SRC.relative_to(ROOT))],
        "crop_bbox": crop, "transparent_background": True, "external_shadow": False,
        "classification": "existing_brand_asset"}
    if OUTPUT_SCALE != 1:
        META["brand-logo.png"].update({"logical_width": logo.width, "logical_height": logo.height,
            "output_scale": 1, "coordinate_space": "source_image_pixels",
            "crop_bbox_coordinate_space": "source_image_pixels",
            "native_source_preserved": True, "note": "The original logo pixels are retained; no interpolation or reconstruction."})


def build_hero():
    p = Plane(1560, 850)
    p.rr((1,1,1559,849), 28, BG, LINE, 1)
    # Quiet browser chrome, without the generic traffic-light motif.
    p.rr((414,15,1146,57), 13, LIGHT, "#e9e9e5")
    p.text((780,36), "DuduHire", 23, MUTED, True, latin=True, anchor="mm")
    p.line((34,36,45,25), MUTED, 2)
    p.line((34,36,45,47), MUTED, 2)
    p.line((68,25,79,36,68,47), "#b2b2ae", 2)
    p.rr((1484,26,1506,46), 3, None, MUTED, 2)
    p.line((1519,28,1531,28), MUTED, 2)
    p.line((1519,35,1531,35), MUTED, 2)
    p.line((1519,42,1531,42), MUTED, 2)
    p.line((2,73,1558,73), "#e8e8e4")
    # The bottom methods strip has promises outside this short film's scope.
    cropbox = (0,0,1280,639)
    screenshot = Image.open(HOME_SRC).convert("RGBA").crop(cropbox)
    shot = screenshot.resize((1556*S, 775*S), Image.Resampling.LANCZOS)
    mask = Image.new("L", p.im.size, 0)
    md = ImageDraw.Draw(mask)
    md.rounded_rectangle((2*S,74*S,1558*S,849*S), radius=24*S, fill=255)
    md.rectangle((2*S,74*S,1558*S,104*S), fill=255)
    layer = Image.new("RGBA", p.im.size, (0,0,0,0)); layer.alpha_composite(shot,(2*S,74*S))
    p.im = Image.composite(layer,p.im,mask)
    p.save("hero-window.png", "Existing homepage in minimal browser frame; positioning shot only",
           ["让真实痛点", "与真实能力更好地相遇", "我想解决业务问题", "我想发现自己的价值"],
           sources=[str(HOME_SRC.relative_to(ROOT))], crop_bbox=cropbox,
           classification="existing_screenshot_with_browser_frame")


def build_input(kind):
    is_demand = kind == "demand"
    base, text = Plane(1380,440), Plane(1380,440)
    base.rr((1,1,1379,439), 32, BG, LINE)
    base.rr((32,27,90,85), 17, PALE)
    if is_demand:
        base.rr((48,43,74,65), 5, None, GREEN, 2)
        base.line((49,63,49,72,60,65), GREEN, 2)
    else:
        base.rr((45,47,77,68), 5, None, GREEN, 2)
        base.rr((54,40,68,48), 3, None, GREEN, 2)
        base.line((46,57,76,57), GREEN, 2)
    title = "梳理用人需求" if is_demand else "完善能力档案"
    base.text((108,44), title, 30, INK, True)
    base.pill((1190,33), "需求示例" if is_demand else "经历示例", PALE, GREEN, 23, 17, 44)
    base.line((42,107,1338,107), "#eeeeea")
    base.text((48,356), "可继续补充，也可随时修改", 24, MUTED)
    button = (1052,325,1336,401)
    base.rr(button, 38, INK)
    base.text((1177,363), "开始梳理" if is_demand else "发送消息", 30, BG, True, anchor="mm")
    arrow(base,1298,363)
    if is_demand:
        lines = ["客服资料太分散，", "想做能引用出处的知识库。"]
        text.text((49,144), lines[0], 43, INK, True)
        text.text((49,204), lines[1], 43, INK, True)
        chips = ["6 周试点", "远程合作", "预算未定"]
        chip_y = 268
    else:
        lines = ["做过内部知识库。", "我负责文档整理、检索与评测；", "同事负责权限和上线。可提供脱敏报告。"]
        for y,line in zip([136,184,232],lines):
            text.text((49,y), line, 37, INK, True)
        chips = ["个人职责", "团队分工", "依据线索"]
        chip_y = 286
    x = 49
    for chip in chips:
        x += text.pill((x,chip_y),chip,LIGHT,MUTED,23,18,42,outline="#e9e9e5") + 12
    content = lines+chips
    actual_text_bbox = text.im.resize((1380,440), Image.Resampling.LANCZOS).getbbox()
    common = dict(text_bbox=list(actual_text_bbox), text_layout_area=[49,142,1300,311] if is_demand else [49,136,1300,330], button_bbox=list(button), button_center=[1194,363],
                  entry_label=title, example=True, content_alignment="same-pixel-coordinate across base, text, and composite")
    base.save(f"{kind}-input-base.png", "Input frame, role, example label and action button", [title,"需求示例" if is_demand else "经历示例"], **common)
    text.save(f"{kind}-input-text.png", "Transparent input content for phrase reveal", content, **common)
    composite = Plane(1380,440); composite.im=Image.alpha_composite(base.im,text.im)
    composite.save(f"{kind}-input.png", "Composite reference for QA of input layers", content, **common)


def build_demand():
    p=Plane(640,670)
    p.rr((1,1,639,669),24,BG,LINE)
    p.pill((36,31),"需求示例",PALE,GREEN,23,17,44)
    p.text((38,113),"原始描述",34,INK,True)
    p.text((38,177),"客服资料太分散，",37,INK,True)
    p.text((38,233),"想做能引用出处",37,INK,True)
    p.text((38,289),"的知识库。",37,INK,True)
    p.line((39,370,601,370),LINE)
    p.text((39,414),"6 周试点 · 远程合作",31,INK)
    p.pill((38,469),"预算未定",LIGHT,MUTED,27,20,49)
    p.dot(48,592,5,GREEN)
    p.text((67,580),"保留已知，也保留未知",26,MUTED)
    p.save("demand-source.png","Original description to remain beside extracted fields",
           ["原始描述","客服资料太分散，想做能引用出处的知识库。","6 周试点 · 远程合作","预算未定"],example=True)
    fields=[("主要工作","资料整理 · 知识库 · 检索测试"),
            ("预期结果","回答附出处，便于核对"),
            ("时间与合作条件","6 周试点 · 远程 · 预算未定")]
    for n,(label,value) in enumerate(fields,1):
        p=Plane(700,180)
        p.rr((1,1,699,179),21,BG,LINE)
        p.rr((1,26,6,154),2,PALE)
        p.text((32,32),label,26,MUTED)
        source_status="AI 建议 · 待确认" if n==1 else "来自你的描述"
        p.pill((473,24),source_status,PALE,GREEN,21,15,39)
        p.text((33,93),value,31,INK,True)
        p.save(f"demand-field-{n}.png","Independent structured field plane",[label,value,source_status],example=True,
               source_status="inferred" if n==1 else "provided")


def build_capability():
    p=Plane(590,750)
    p.rr((1,1,589,749),30,DEEP,"#284938")
    # Subtle material-like internal sheen, no external shadow.
    p.rr((19,19,571,731),23,None,"#264533")
    brand(p,(37,42),240,light=True)
    p.text((38,139),"能力身份卡",26,"#b8d0be")
    p.text((37,201),"示例能力档案",43,BG,True)
    p.line((38,278,552,278),"#355341")
    p.text((38,317),"适合承担的工作",25,"#b8d0be")
    p.text((38,371),"知识库资料整理",37,BG,True)
    p.text((38,425),"检索与评测",37,BG,True)
    p.pill((37,495),"文档整理",DEEP2,"#d8f7c7",24,18,44,outline="#375743")
    p.pill((194,495),"检索评测",DEEP2,"#d8f7c7",24,18,44,outline="#375743")
    p.pill((37,596),"AI 草稿",LIME,DEEP,27,23,49,True)
    p.text((38,671),"经历示例 · 待本人核对",24,"#c2d4c6")
    p.save("capability-card.png","Deep green physical identity card face, no lanyard",
           ["示例能力档案","知识库资料整理","检索与评测","文档整理","检索评测","AI 草稿","经历示例 · 待本人核对"],
           sources=["apps/web/src/CapabilityIdentityCard.tsx","apps/web/src/discoveryFlow.ts","docs/PRODUCT.md"],
           example=True, attachment_point=[295,18])


def build_evidence():
    p=Plane(900,630)
    p.rr((1,1,899,629),24,BG,LINE)
    p.text((37,38),"查看提炼依据",35,INK,True)
    p.pill((704,30),"经历示例",PALE,GREEN,23,17,44)
    p.rr((34,107,866,288),17,LIGHT,"#e6e6e1")
    p.text((58,129),"来源原句",23,MUTED)
    personal_quote="我负责文档整理、检索与评测；"
    highlight_bbox=[52,171,62+p.d.textlength(personal_quote,font=font(34,True))/S,216]
    p.rr(highlight_bbox,7,PALE)
    p.text((57,178),personal_quote,34,INK,True)
    p.text((58,229),"同事负责权限和上线。",34,INK,True)
    p.text((40,326),"个人职责",25,GREEN,True)
    p.text((40,373),"文档、检索与评测",31,INK,True)
    p.line((447,325,447,429),"#e4e4df")
    p.text((480,326),"团队分工",25,MUTED,True)
    p.text((480,373),"权限与上线",31,INK,True)
    p.line((37,461,863,461),LINE)
    p.text((39,496),"依据线索",25,MUTED)
    p.text((196,491),"可提供脱敏报告",31,INK,True)
    p.text((39,567),"材料线索不等于已上传，也不等于平台核验",24,MUTED)
    p.save("evidence-panel.png","Evidence excerpt with personal and teammate attribution",
           ["我负责文档整理、检索与评测；同事负责权限和上线。","个人职责","团队分工","可提供脱敏报告"],
           example=True, highlight_bbox=highlight_bbox, highlight_meaning="Personal responsibilities, paired with the green personal-responsibility label below")


def build_confirmation(after, edited=False):
    name="after" if after else "edited" if edited else "before"
    p=Plane(1100,620)
    p.rr((1,1,1099,619),26,BG,LINE)
    p.text((39,41),"能力档案 · 经历示例",28,INK,True)
    status="用户已确认" if after else "已修改 · 待确认" if edited else "修改前 · 待核对"
    p.pill((812 if after else 765,31),status,PALE if after else LIGHT,GREEN if after else MUTED,25,21,48)
    p.line((37,111,1063,111),"#e7e7e2")
    p.text((42,143),"实际结果",26,MUTED)
    p.rr((37,190,1063,326),19,"#f5fbf1" if after else LIGHT,"#b7d9aa" if after else "#e0e0db")
    p.text((65,230),"完成检索与评测" if after or edited else "知识库上线",49,INK if after or edited else MUTED,True)
    if after:
        p.dot(1005,258,23,GREEN);check(p,1005,257,BG,11,3)
    else:
        p.rr((952,221,1030,294),17,BG,"#e1e1dc");pencil(p,991,257)
    p.text((41,378),"角色核对",25,MUTED)
    p.text((194,348),"“我负责文档整理、检索与评测；",29,INK,True)
    p.text((194,393),"同事负责权限和上线。”",29,INK,True)
    p.line((39,448,1061,448),"#e5e5df")
    if after:
        p.text((42,502),"本人确认 · 未经平台验证",27,MUTED)
        p.rr((774,484,1060,564),40,GREEN)
        check(p,817,524,BG,9,3)
        p.text((936,524),"已确认保存",29,BG,True,anchor="mm")
    else:
        p.text((42,502),"核对修改内容，再确认保存" if edited else "修正表述，保留原始依据",27,MUTED)
        p.rr((774,484,1060,564),40,INK)
        p.text((917,524),"确认并保存" if edited else "保存修改",30,BG,True,anchor="mm")
    p.save(f"confirm-{name}.png","Before/after attribution correction and explicit user confirmation",
           ["实际结果","完成检索与评测" if after or edited else "知识库上线","角色核对","我负责文档整理、检索与评测；同事负责权限和上线。",status],
           example=True, correction_demo=True, field_bbox=[37,190,1063,326],
           edit_button_center=[991,257], confirmation_button_center=[917,524],
           role_evidence_bbox=[194,348,1022,423],
           role_evidence_lines=["我负责文档整理、检索与评测；","同事负责权限和上线。"],
           verification_note="Edited state has revised copy and awaits explicit confirmation; user confirmation is not platform verification; before state is an illustrative editable statement.")


def build_compare(kind):
    talent=kind=="capability"
    p=Plane(700,590)
    surface=DEEP if talent else BG
    main=BG if talent else INK
    muted="#bdd0c2" if talent else MUTED
    border="#36523f" if talent else LINE
    p.rr((1,1,699,589),25,surface,border)
    p.pill((32,29),"能力示例" if talent else "需求示例",DEEP2 if talent else LIGHT,muted,23,17,44,outline=border)
    p.pill((470,29),"用户已确认",LIME if talent else PALE,DEEP if talent else GREEN,22,17,44,True)
    p.text((34,112),"能力档案" if talent else "用人需求",40,main,True)
    p.text((35,178),"知识库 · 检索评测" if talent else "内部知识库试点",32,main,True)
    p.line((35,243,665,243),border)
    rows=([("适合承担","资料整理、检索与评测"),("个人职责","文档整理、检索与评测"),("依据线索","可提供脱敏报告")]
          if talent else [("主要工作","资料整理、检索与评测"),("预期目标","回答附出处，便于核对"),("合作条件","6 周试点 · 远程 · 预算未定")])
    for y,(label,value) in zip([278,359,440],rows):
        p.text((36,y),label,23,muted)
        p.text((171,y-2),value,29,main,True)
    p.text((35,542),"本人确认 · 未经平台验证",22,muted)
    p.save(f"compare-{kind}.png","Confirmed example summary for side-by-side comparison, not platform matching result",
           ["能力档案" if talent else "用人需求"]+[v for pair in rows for v in pair]+["用户已确认","本人确认 · 未经平台验证"],
           example=True, is_matching_result=False, common_work_bbox=[163,270,662,313])


def contact_sheet():
    names=[n for n in META if n.endswith('.png') and not n.endswith('-text.png') and not n.endswith('-base.png')]
    tw,th=520,385
    columns=3
    sheet=Image.new("RGB",(columns*tw,math.ceil(len(names)/columns)*th),"#eeeeea")
    d=ImageDraw.Draw(sheet)
    for i,name in enumerate(names):
        x=(i%columns)*tw; y=(i//columns)*th
        im=Image.open(OUT/name).convert("RGBA")
        im.thumbnail((tw-30,th-54),Image.Resampling.LANCZOS)
        sheet.paste(im,(x+(tw-im.width)//2,y+41+(th-54-im.height)//2),im)
        d.text((x+15,y+12),name,fill=INK,font=ImageFont.truetype(FONT_SC,19,index=1))
    sheet.save(OUT/"contact-sheet.jpg",quality=94)


def main(argv=None):
    global OUT, OUTPUT_SCALE, FONT_TTF, S
    parser=argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--output", default="assets", help="Output directory, relative to this script or absolute (default: assets)")
    parser.add_argument("--scale", type=int, choices=(1,2,3), default=1,
                        help="Output pixels per logical pixel; 2/3 draw and save natively (default: 1)")
    args=parser.parse_args(argv)
    output_path=Path(args.output).expanduser()
    OUT=output_path if output_path.is_absolute() else HERE/output_path
    OUTPUT_SCALE=args.scale
    S=max(2,OUTPUT_SCALE)
    FONT_TTF=OUT/"duduhire-sans-600.ttf"
    META.clear();TEXT_AUDIT.clear();FONT_CACHE.clear()
    prepare_fonts()
    build_logo();build_hero()
    build_input("demand");build_input("talent")
    build_demand();build_capability();build_evidence()
    build_confirmation(False);build_confirmation(False,edited=True);build_confirmation(True)
    build_compare("demand");build_compare("capability")
    manifest={"schema_version":1,"render_scale":S,"color_space":"sRGB","source_classification":"Product interaction demonstration with explicitly labeled sample content",
              "chinese_font":{"path":FONT_SC,"index":FONT_INDEX,"family":"Heiti SC Medium","regular_path":FONT_SC_LIGHT,"reason":"PingFang unavailable; website Noto Sans SC is a 597-glyph subset. Use consistent Chinese system fallback."},
              "latin_font":{"path":str(FONT_TTF),"family":"Website DuduHire Sans / Noto Sans SC","weight":600},
              "brand_colors":{"surface":BG,"ink":INK,"muted":MUTED,"green":GREEN,"lime":LIME,"pale":PALE,"deep":DEEP,"deep_secondary":DEEP2},
              "global_notes":["No real customer, candidate, or matching result is represented.","Sample input remains sample throughout confirmation.","No external shadow, cursor, lanyard, headline or timeline included."],"assets":META}
    if OUTPUT_SCALE != 1:
        manifest.update({"requested_output_scale": OUTPUT_SCALE,
            "coordinate_contract": "width/height and alpha_bbox_pixels are output pixels; named bbox/center/attachment coordinates remain logical layout pixels. pixel_coordinates supplies their output-pixel equivalents. Source crop coordinates remain source pixels.",
            "source_limits": {"brand-logo.png": "Original cropped pixels retained at 1245x314; not upscaled.",
                              "hero-window.png": f"Browser frame is rendered at {OUTPUT_SCALE}x, but the existing homepage screenshot is limited to its 1280x720 source and 1280x639 crop."}})
    (OUT/"manifest.json").write_text(json.dumps(manifest,ensure_ascii=False,indent=2)+"\n")
    (OUT/"text-layout-audit.json").write_text(json.dumps(TEXT_AUDIT,ensure_ascii=False,indent=2)+"\n")
    contact_sheet()
    print(f"Built {len(META)} image planes in {OUT}")


if __name__=="__main__":
    main()
