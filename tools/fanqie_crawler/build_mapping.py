"""番茄小说字库反爬映射构建：用 ddddocr 识别自定义字体字形，建立 私有码位->真实汉字 映射。

原理
----
番茄正文把常用汉字映射到私有 Unicode 码位（U+E000-F8FF，十进制 58368-58879），
靠 @font-face 自定义字体渲染。把每个私有码位用该字体渲染成图片，交给 ddddocr
识别出真实汉字，即可建立「私有码位 -> 真实汉字」字典。映射一次建好，同字体全书
/全站复用；换字体时需重建。

用法
----
    python build_mapping.py [字体文件.woff2] [输出映射.json]

默认：tools/fanqie_crawler/font/fanqie.woff2 -> tools/fanqie_crawler/font/mapping_ocr.json

依赖：fontTools / Pillow / ddddocr（pip install fonttools pillow ddddocr）
"""
import io
import json
import sys
from pathlib import Path

from fontTools.ttLib import TTFont
from PIL import Image, ImageDraw, ImageFont
import ddddocr

IMG_SIZE = 120        # 渲染画布尺寸
FONT_RATIO = 0.75     # 字号相对画布的比例

BASE = Path(__file__).resolve().parent


def build_mapping(woff2: Path, ttf: Path) -> dict:
    """读取 woff2 字体，返回 {十进制码位int: 真实汉字} 映射。"""
    f = TTFont(str(woff2))
    f.save(str(ttf))
    cmap = None
    for t in f["cmap"].tables:
        if t.isUnicode():
            cmap = t.cmap
            break
    privates = sorted(cp for cp in cmap if 0xE000 <= cp <= 0xF8FF)
    print("private codepoints:", len(privates))

    ocr = ddddocr.DdddOcr(show_ad=False)
    font = ImageFont.truetype(str(ttf), int(IMG_SIZE * FONT_RATIO))
    mapping = {}
    bad = []
    for i, cp in enumerate(privates):
        img = Image.new("RGB", (IMG_SIZE, IMG_SIZE), (255, 255, 255))
        draw = ImageDraw.Draw(img)
        # 用该码位渲染字形（自定义字体把私有码位画成真实汉字）
        draw.text((IMG_SIZE // 2, IMG_SIZE // 2), chr(cp), font=font,
                  fill=(0, 0, 0), anchor="mm")
        buf = io.BytesIO()
        img.save(buf, format="JPEG", quality=95)
        word = ocr.classification(buf.getvalue())
        if len(word) == 1:
            mapping[cp] = word
        else:
            bad.append((cp, word))
        if (i + 1) % 100 == 0:
            print(f"  {i + 1}/{len(privates)} done")
    print("multi/none results:", len(bad), bad[:10])
    return mapping


def main():
    woff2 = Path(sys.argv[1]) if len(sys.argv) > 1 else BASE / "font" / "fanqie.woff2"
    out_json = Path(sys.argv[2]) if len(sys.argv) > 2 else BASE / "font" / "mapping_ocr.json"
    ttf = woff2.with_suffix(".ttf")
    mapping = build_mapping(woff2, ttf)
    with open(out_json, "w", encoding="utf-8") as fp:
        json.dump({str(k): v for k, v in mapping.items()}, fp,
                  ensure_ascii=False, indent=1)
    print("mapping saved:", len(mapping), "->", out_json)


if __name__ == "__main__":
    main()
