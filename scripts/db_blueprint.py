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
    try:
        d = json.loads(r["content"])
    except Exception as e:
        print("content parse error:", e)
        continue
    print("keys:", list(d.keys()))
    # 打印可能包含背景/题材的顶层字段
    for k in d:
        v = d[k]
        if k in ("genres", "background_type", "genre", "theme", "题材", "背景类型"):
            print(f"  {k}:", json.dumps(v, ensure_ascii=False)[:500])
    # 看前几个字段的样例
    for k in list(d.keys())[:6]:
        v = d[k]
        s = json.dumps(v, ensure_ascii=False)
        print(f"  [{k}] {s[:200]}")
