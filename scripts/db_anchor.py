"""调试 backend/biling.db 的 blueprints 表：检查开篇锚点与金手指相关伏笔。

用法：python scripts/db_anchor.py
逐条打印 blueprint 的 opening_anchor、foreshadowing_plan 中含
"金手指/系统/觉醒/天赋"的条目，以及 notes 摘要。
"""
import json
import sqlite3

db = sqlite3.connect(r"d:\Project\personal\Biling\backend\biling.db")
db.row_factory = sqlite3.Row

rows = db.execute(
    "SELECT id, novel_id, version, status, content FROM blueprints"
).fetchall()
for r in rows:
    print("=" * 70)
    print("blueprint:", r["id"], "| novel:", r["novel_id"], "| v", r["version"], "|", r["status"])
    d = json.loads(r["content"])
    print("opening_anchor:")
    print(json.dumps(d.get("opening_anchor"), ensure_ascii=False, indent=2))
    print()
    print("foreshadowing_plan (金手指相关):")
    fp = d.get("foreshadowing_plan") or []
    if isinstance(fp, dict):
        fp = fp.get("items") or []
    for it in (fp if isinstance(fp, list) else []):
        s = json.dumps(it, ensure_ascii=False)
        if "金手指" in s or "系统" in s or "觉醒" in s or "天赋" in s:
            print(" -", s[:300])
    print()
    print("notes:", json.dumps(d.get("notes"), ensure_ascii=False)[:500])
