"""导入文件文本提取：支持 Word(.docx) / PDF / Markdown / 纯文本。

提取结果作为「导入大纲」的原材料，由蓝图师识别规范化为 Blueprint JSON 后落库。
"""
import io
import logging
from pathlib import Path

logger = logging.getLogger(__name__)

SUPPORTED_EXTS = {".md", ".markdown", ".txt", ".docx", ".pdf"}
MAX_IMPORT_BYTES = 10 * 1024 * 1024  # 10MB


def extract_text(filename: str, data: bytes) -> str:
    """按扩展名提取纯文本。不支持的格式/提取失败抛 ValueError。"""
    ext = (Path(filename).suffix or "").lower()
    if ext not in SUPPORTED_EXTS:
        raise ValueError(
            f"不支持的文件格式：{ext or '（无扩展名）'}（支持 .docx / .pdf / .md / .txt）"
        )
    if ext in (".md", ".markdown", ".txt"):
        return _decode_text(data)
    if ext == ".docx":
        return _extract_docx(data)
    return _extract_pdf(data)


def _decode_text(data: bytes) -> str:
    for enc in ("utf-8-sig", "utf-8", "gb18030"):
        try:
            return data.decode(enc)
        except UnicodeDecodeError:
            continue
    return data.decode("utf-8", errors="replace")


def _extract_docx(data: bytes) -> str:
    from docx import Document

    doc = Document(io.BytesIO(data))
    parts = [p.text for p in doc.paragraphs if p.text.strip()]
    # 表格中的文字也提取（大纲常用表格呈现分卷/伏笔计划）
    for table in doc.tables:
        for row in table.rows:
            cells = [c.text.strip() for c in row.cells]
            if any(cells):
                parts.append(" | ".join(cells))
    return "\n".join(parts)


def _extract_pdf(data: bytes) -> str:
    from pypdf import PdfReader

    reader = PdfReader(io.BytesIO(data))
    parts = []
    for page in reader.pages:
        parts.append(page.extract_text() or "")
    return "\n".join(parts)
