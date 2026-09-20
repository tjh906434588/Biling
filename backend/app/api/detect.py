"""AI 生成检测 API（§13.5）：体检性质、不设硬阈值、不阻断写作。

- POST /api/novels/{novel_id}/detect         通用文本检测
- POST /api/novels/{novel_id}/chapters/{chapter_id}/detect  对已存章节的 active 版本检测
"""
import uuid

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field
from sqlalchemy.orm import Session

from app.db.models import Chapter, ChapterVersion, Novel
from app.db.session import get_db
from app.services.detector import detect

router = APIRouter(prefix="/api/novels", tags=["detect"])


class DetectIn(BaseModel):
    text: str = Field(..., min_length=1)


@router.post("/{novel_id}/detect")
def detect_text(novel_id: uuid.UUID, payload: DetectIn, db: Session = Depends(get_db)):
    if db.get(Novel, novel_id) is None:
        raise HTTPException(404, "项目不存在")
    return detect(payload.text)


@router.post("/{novel_id}/chapters/{chapter_id}/detect")
def detect_chapter(novel_id: uuid.UUID, chapter_id: uuid.UUID, db: Session = Depends(get_db)):
    """检测章节 active 版本正文；无 active 版本回退 content。"""
    chapter = db.get(Chapter, chapter_id)
    if chapter is None or chapter.novel_id != novel_id:
        raise HTTPException(404, "章节不存在")
    active = db.query(ChapterVersion).filter(
        ChapterVersion.chapter_id == chapter.id, ChapterVersion.is_active.is_(True)
    ).first()
    text = (active.content if active else chapter.content) or ""
    if not text.strip():
        raise HTTPException(422, "该章节暂无正文可检测")
    result = detect(text)
    result.density = result.density or {}
    return {
        **result.__dict__,
        "chapter_no": chapter.chapter_no,
        "source": "active_version" if active else "chapter_content",
    }
