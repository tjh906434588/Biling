"""按 era_research.scope_issues 的 genres 建议，补写 novel.genres（模拟修复后的 apply_fix 逻辑）。
仅用于修复历史数据：novel.genres 因裸 JSON 列原地 append 不被 SQLAlchemy 追踪而未落库。

用法：python scripts/fix_genres.py
固定修复脚本内 NOVEL_ID 指定的一本小说，直接 UPDATE 落库。
"""
import json
import re
import sqlite3

db = sqlite3.connect(r"d:\Project\personal\Biling\backend\biling.db")
db.row_factory = sqlite3.Row

NOVEL_ID = "1483a7fd47b447fcacf6cced3ff15bfb"

row = db.execute(
    "SELECT id, title, background_type, genres, era_research FROM novels WHERE id=?",
    (NOVEL_ID,),
).fetchone()
if row is None:
    print("novel not found")
    raise SystemExit(1)

print("title:", row["title"])
print("background_type:", repr(row["background_type"]))
print("genres BEFORE:", repr(row["genres"]))

current = json.loads(row["genres"]) if row["genres"] else []
er = json.loads(row["era_research"]) if row["era_research"] else {}
suggested = ""
for issue in er.get("scope_issues") or []:
    if issue.get("dim") == "genres":
        suggested = str(issue.get("suggested") or "").strip()
print("genres suggested:", suggested)

new_genres = list(current)
if suggested:
    for g in re.split(r"[、,，;；]", suggested):
        g = g.strip()
        if g and g not in new_genres:
            new_genres.append(g)

print("genres AFTER:", new_genres)
db.execute(
    "UPDATE novels SET genres=? WHERE id=?",
    (json.dumps(new_genres, ensure_ascii=False), NOVEL_ID),
)
db.commit()
print("updated OK")
