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
