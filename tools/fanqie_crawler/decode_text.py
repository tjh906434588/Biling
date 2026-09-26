"""正文解码工具：把番茄私有码位文本还原为明文（纯 Python，无浏览器依赖）。

用法
----
    from decode_text import load_mapping, decode_chapter
    mapping = load_mapping()                       # 默认 font/mapping_ocr.json
    plain = decode_chapter(html_content, mapping)  # 去 HTML 标签 + 解码

说明
----
- mapping 的键是码位十进制字符串（如 "58345"），值是真实汉字。
- 未映射字符（标点/数字/英文/普通汉字）原样保留。
- 若某本书正文解码后大量乱码，说明字体与 mapping_ocr.json 不同，
  需重新提取该书的 woff2 并用 build_mapping.py 重建映射。
"""
import json
import re
from pathlib import Path

DEFAULT_MAPPING = Path(__file__).resolve().parent / "font" / "mapping_ocr.json"

_TAG_RE = re.compile(r"<[^>]*>")


def load_mapping(path=None) -> dict:
    """读取映射文件，返回 {码位十进制字符串: 汉字} 字典。"""
    path = Path(path) if path else DEFAULT_MAPPING
    with open(path, encoding="utf-8") as fp:
        return json.load(fp)


def strip_html(content: str) -> str:
    """去掉正文 HTML 里的标签（<p>/<img> 等），保留纯文本。"""
    return _TAG_RE.sub("", content or "")


def decode_text(text: str, mapping: dict) -> str:
    """把文本中的私有码位按映射还原；未映射字符原样保留。"""
    out = []
    for ch in text:
        cp = str(ord(ch))
        out.append(mapping.get(cp, ch))
    return "".join(out)


def decode_chapter(content: str, mapping: dict) -> str:
    """一步到位：去 HTML 标签 + 解码，返回明文。"""
    return decode_text(strip_html(content), mapping)
