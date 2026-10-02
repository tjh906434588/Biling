"""章节路由：列表 / 详情 / 版本选定回滚。"""
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
    UpdateVersionRequest,
)
from app.schemas.novel import ChapterInfoControl, InfoControl

router = APIRouter(prefix="/api/novels", tags=["chapters"])


def _get_novel(db: Session, novel_id: uuid.UUID) -> Novel:
    """按 id 取小说，不存在抛 404（各路由的前置校验）。"""
    novel = db.get(Novel, novel_id)
    if novel is None:
        raise HTTPException(404, "项目不存在")
    return novel


def _get_chapter(db: Session, novel_id: uuid.UUID, chapter_no: int) -> Chapter:
    """按章号取章节，不存在抛 404。"""
    chapter = db.execute(
        select(Chapter).where(Chapter.novel_id == novel_id, Chapter.chapter_no == chapter_no)
    ).scalar_one_or_none()
    if chapter is None:
        raise HTTPException(404, "章节不存在")
    return chapter


@router.get("/{novel_id}/chapters/{chapter_no}/info-control", response_model=ChapterInfoControl)
def get_chapter_info_control(novel_id: uuid.UUID, chapter_no: int, db: Session = Depends(get_db)):
    """某章信息控制：chapter=该章自己填的（可编辑），effective=当前生效合并（只读展示）。
    章节尚不存在（如新增下一章）时 chapter 返回空，effective 仍按已定稿章节链计算。"""
    from app.services.info_control import effective_info_control

    _get_novel(db, novel_id)
    chapter = db.execute(
        select(Chapter).where(Chapter.novel_id == novel_id, Chapter.chapter_no == chapter_no)
    ).scalar_one_or_none()
    own = (chapter.info_control or {}) if chapter else {}
    return {"chapter": own, "effective": effective_info_control(db, novel_id, chapter_no, own) or {}}


@router.put("/{novel_id}/chapters/{chapter_no}/info-control", response_model=ChapterInfoControl)
def update_chapter_info_control(
    payload: InfoControl,
    novel_id: uuid.UUID,
    chapter_no: int,
    db: Session = Depends(get_db),
):
    """保存某章信息控制（生成/重写本章时填写；仅保留非空字段，全空 = 清空该章）。
    注意：信息控制只能随本章生成/重写填写，不能事后单独编辑已生成版本。"""
    from app.services.info_control import effective_info_control

    _get_novel(db, novel_id)
    chapter = _get_chapter(db, novel_id, chapter_no)
    cleaned = {k: v.strip() for k, v in payload.model_dump().items() if v and v.strip()}
    chapter.info_control = cleaned or None
    db.commit()
    return {"chapter": cleaned, "effective": effective_info_control(db, novel_id, chapter_no, cleaned) or {}}


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
        # 章级标题兜底：未定稿章节的标题只存在版本里（定稿时才同步回章级），
        # 列表直接返回章级 title 会是空 → 目录/大纲里「第X章」后没标题。
        # 章级 title 为空时回退到该章最新版本的标题，保证列表项始终有标题可显示。
        title = c.title
        if not title:
            title = db.execute(
                select(ChapterVersion.title)
                .where(
                    ChapterVersion.chapter_id == c.id,
                    ChapterVersion.title.isnot(None),
                )
                .order_by(ChapterVersion.version_no.desc())
                .limit(1)
            ).scalar_one_or_none()
        items.append(ChapterListItem(
            id=c.id,
            chapter_no=c.chapter_no,
            title=title,
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


@router.patch("/{novel_id}/chapters/{chapter_no}/versions/{version_id}", response_model=ChapterVersionRead)
def update_version(
    novel_id: uuid.UUID,
    chapter_no: int,
    version_id: uuid.UUID,
    payload: UpdateVersionRequest,
    db: Session = Depends(get_db),
):
    """作者手动编辑正文的就地自动保存：就地更新当前选中版本（不新建版本）。

    编辑不改变 source / 版本号，评价仍绑定该版本 id；作者改完正文后由前端提示重新评价，
    使评价与最新内容对齐。若编辑的是已定稿（激活）版本，章级正文/字数同步刷新，
    保持「章 = 激活版本」的一致性口径。
    """
    _get_novel(db, novel_id)
    chapter = db.execute(
        select(Chapter).where(
            Chapter.novel_id == novel_id, Chapter.chapter_no == chapter_no
        )
    ).scalar_one_or_none()
    if chapter is None:
        raise HTTPException(404, "章节不存在")

    target = db.get(ChapterVersion, version_id)
    if target is None or target.chapter_id != chapter.id:
        raise HTTPException(404, "版本不存在")

    if payload.content is not None:
        target.content = payload.content
    if payload.title is not None:
        target.title = payload.title or None
    # 已定稿版本被就地编辑：章级正文/字数保持与激活版本一致（定稿按钮已隐藏，仍是本章正文）
    if target.is_active:
        chapter.content = target.content
        chapter.word_count = len(target.content)
    db.commit()
    db.refresh(target)
    return ChapterVersionRead.model_validate(target)


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

    选择版本时保留 source 标记；用户后续手动编辑/合并走 user_edit / merged 来源。
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

    # 签约未过签拦截：最新评价存在 severity=high 的红线 issue（内容红线/抄袭）→ 默认拒绝定稿；
    # force=true 为作者权威逃生口，强制通过。
    if target.signing_blocked and not payload.force:
        # 取该版本最新一条评价中的红线 issue，拼成提示
        last_review = db.execute(
            select(QualityReview)
            .where(QualityReview.chapter_version_id == target.id)
            .order_by(QualityReview.created_at.desc())
        ).scalars().first()
        red_lines: list[str] = []
        for i in (last_review.issues if last_review else []) or []:
            if (i.get("severity") or "").lower() == "high":
                red_lines.append(f"[{i.get('type')}] {i.get('desc')}")
        hint = "；".join(red_lines) if red_lines else "存在签约红线问题（内容红线/抄袭）"
        raise HTTPException(
            409,
            f"该版本未过签（{hint}）。请先按评价师建议修改重生成，或确认风险后强制定稿（force=true）。",
        )

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
