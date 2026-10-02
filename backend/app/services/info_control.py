"""信息控制（谁知道了什么）生效合并。

规则（对应「按章设立的链条 + 版本快照」模型）：
- 每章可有一份信息控制（chapters.info_control），生成/重写本章时填写；不可事后单独编辑，只能重写覆盖。
- 第 N 章生成时的「生效信息」= 按章号升序合并「全局默认 + 已定稿章节的信息控制」+ 本章自己填的，
  同名字段后者覆盖（冲突以新章为准）、不同名合并保留（不冲突都生效）。
- 仅「已定稿」章节（存在激活版本）的信息控制才纳入合并（草稿章只是界面展示、不参与注入）。
"""
import uuid

from sqlalchemy import select
from sqlalchemy.orm import Session

from app.db.models import Chapter, ChapterVersion, Novel

INFO_FIELDS = ("reader_knows", "protagonist_knows", "must_hide", "hint_only")


def effective_info_control(
    db: Session,
    novel_id: uuid.UUID,
    chapter_no: int,
    own: dict | None = None,
) -> dict | None:
    """计算第 chapter_no 章生成时的生效信息控制。

    合并顺序（同名后者覆盖、不同名合并）：
    1. 全局默认（novel.info_control，可空，作为全书兜底）；
    2. 第 1..chapter_no-1 章中「已定稿」的 info_control（按章号升序）；
    3. 本章自己填的 own（正在生成的这章，即使未定稿也算——本次生成就用它）。
    """
    merged: dict[str, str] = dict(getattr(db.get(Novel, novel_id), "info_control", None) or {})
    rows = db.execute(
        select(Chapter.info_control)
        .join(ChapterVersion, ChapterVersion.chapter_id == Chapter.id)
        .where(
            Chapter.novel_id == novel_id,
            Chapter.chapter_no < chapter_no,
            ChapterVersion.is_active.is_(True),
            Chapter.info_control.is_not(None),
        )
        .order_by(Chapter.chapter_no.asc())
    ).scalars().all()
    for ic in rows:
        for k, v in (ic or {}).items():
            if k in INFO_FIELDS and v:
                merged[k] = v
    for k, v in (own or {}).items():
        if k in INFO_FIELDS and v:
            merged[k] = v
    return merged or None
