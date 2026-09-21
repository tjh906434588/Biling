"""章节路由：列表 / 详情 / 版本选定合并（M1：双版本生成后对比选择）。"""
import uuid
from typing import Optional

from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.db.models import Chapter, ChapterVersion, Novel, QualityReview, StoryState
from app.db.session import get_db
from app.schemas.chapter import (
    ChapterDetail,
    ChapterListItem,
    ChapterVersionRead,
    ReviewRead,
    SelectVersionRequest,
)

router = APIRouter(prefix="/api/novels", tags=["chapters"])


def _get_novel(db: Session, novel_id: uuid.UUID) -> Novel:
    novel = db.get(Novel, novel_id)
    if novel is None:
        raise HTTPException(404, "项目不存在")
    return novel


@router.get("/{novel_id}/chapters", response_model=list[ChapterListItem])
def list_chapters(novel_id: uuid.UUID, db: Session = Depends(get_db)):
    """章节列表：每章附激活版本来源与正文（续写/阅读用）。"""
    _get_novel(db, novel_id)
    chapters = db.execute(
        select(Chapter)
        .where(Chapter.novel_id == novel_id)
        .order_by(Chapter.chapter_no)
    ).scalars().all()

    items: list[ChapterListItem] = []
    for c in chapters:
        active = db.execute(
            select(ChapterVersion).where(
                ChapterVersion.chapter_id == c.id, ChapterVersion.is_active.is_(True)
            )
        ).scalar_one_or_none()
        # 该章提取入记忆层时对应的正文版本（幂等覆盖，每章最多一条）
        extracted_version_id = db.execute(
            select(StoryState.chapter_version_id).where(
                StoryState.novel_id == novel_id,
                StoryState.chapter_no == c.chapter_no,
            )
        ).scalar_one_or_none()
        items.append(ChapterListItem(
            id=c.id,
            chapter_no=c.chapter_no,
            title=c.title,
            status=c.status,
            word_count=c.word_count,
            updated_at=c.updated_at,
            active_source=active.source if active else None,
            active_content=active.content if active else None,
            extracted_version_id=extracted_version_id,
        ))
    return items


@router.get("/{novel_id}/chapters/{chapter_no}", response_model=ChapterDetail)
def get_chapter(novel_id: uuid.UUID, chapter_no: int, db: Session = Depends(get_db)):
    """单章详情：全部版本（含 is_active 标记），供对比选择。"""
    _get_novel(db, novel_id)
    chapter = db.execute(
        select(Chapter).where(
            Chapter.novel_id == novel_id, Chapter.chapter_no == chapter_no
        )
    ).scalar_one_or_none()
    if chapter is None:
        raise HTTPException(404, "章节不存在")
    versions = db.execute(
        select(ChapterVersion)
        .where(ChapterVersion.chapter_id == chapter.id)
        .order_by(ChapterVersion.version_no)
    ).scalars().all()
    return ChapterDetail(
        chapter_no=chapter.chapter_no,
        title=chapter.title,
        status=chapter.status,
        versions=[ChapterVersionRead.model_validate(v) for v in versions],
    )


@router.get("/{novel_id}/reviews", response_model=list[ReviewRead])
def list_reviews(
    novel_id: uuid.UUID,
    chapter_no: Optional[int] = None,
    db: Session = Depends(get_db),
):
    """质量账本：某小说的全部评价（可按章过滤），最新在前。

    只返回挂在具体正文版本上的评价（schema 校验告警类无版本，不在此列）。
    同时带出版本号与 is_current，供前端判断评价是否已随版本更替而过期。
    """
    _get_novel(db, novel_id)
    stmt = (
        select(QualityReview, Chapter, ChapterVersion)
        .join(ChapterVersion, ChapterVersion.id == QualityReview.chapter_version_id)
        .join(Chapter, Chapter.id == ChapterVersion.chapter_id)
        .where(QualityReview.novel_id == novel_id)
        .order_by(QualityReview.created_at.desc())
    )
    if chapter_no is not None:
        stmt = stmt.where(Chapter.chapter_no == chapter_no)
    rows = db.execute(stmt).all()
    return [
        ReviewRead(
            id=r.id,
            chapter_no=c.chapter_no,
            chapter_title=c.title,
            chapter_version_id=r.chapter_version_id,
            version_no=v.version_no,
            version_source=v.source,
            is_current=bool(v.is_active),
            overall_score=r.overall_score,
            rubric=r.rubric,
            issues=r.issues,
            strengths=r.strengths,
            revision_hints=r.revision_hints,
            created_at=r.created_at,
        )
        for r, c, v in rows
    ]


@router.post("/{novel_id}/chapters/{chapter_no}/select", response_model=ChapterDetail)
def select_version(
    novel_id: uuid.UUID,
    chapter_no: int,
    payload: SelectVersionRequest,
    db: Session = Depends(get_db),
):
    """选定合并：激活指定版本 → 该版本 is_active=true，其余 false；chapters 正文/字数/状态同步。

    选择来源为 novelist_A/B 时保留 source 标记；用户后续手动编辑合并走 M2 的 merged 来源。
    """
    _get_novel(db, novel_id)
    chapter = db.execute(
        select(Chapter).where(
            Chapter.novel_id == novel_id, Chapter.chapter_no == chapter_no
        )
    ).scalar_one_or_none()
    if chapter is None:
        raise HTTPException(404, "章节不存在")

    target = db.get(ChapterVersion, payload.version_id)
    if target is None or target.chapter_id != chapter.id:
        raise HTTPException(404, "版本不存在")

    # 取消其它激活，激活目标版本
    db.query(ChapterVersion).filter(
        ChapterVersion.chapter_id == chapter.id
    ).update({"is_active": False})
    target.is_active = True
    chapter.content = target.content
    chapter.word_count = len(target.content)
    chapter.status = "complete"
    # 版本级元数据同步回章：标题/所用大纲版本以被定稿版本为准
    # （草稿各自独立存于版本行，定稿那一刻才落到章，避免多草稿并存时错位）
    if target.title is not None:
        chapter.title = target.title
    if target.outline_id is not None:
        chapter.outline_id = target.outline_id
    db.commit()
    # 账本不在版本激活时登记：伏笔动作由「大纲批准」时进入账本（draft 不生效，与设定同语义）

    versions = db.execute(
        select(ChapterVersion)
        .where(ChapterVersion.chapter_id == chapter.id)
        .order_by(ChapterVersion.version_no)
    ).scalars().all()
    return ChapterDetail(
        chapter_no=chapter.chapter_no,
        title=chapter.title,
        status=chapter.status,
        versions=[ChapterVersionRead.model_validate(v) for v in versions],
    )
