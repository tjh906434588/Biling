import json
import sqlite3

db = sqlite3.connect(r"d:\Project\personal\Biling\backend\biling.db")
db.row_factory = sqlite3.Row

rows = db.execute(
    "SELECT id, title, background_type, genres, era_research FROM novels"
).fetchall()
for r in rows:
    print("=" * 60)
    print("novel:", r["id"], "|", r["title"])
    print("background_type:", repr(r["background_type"]))
    print("genres:", repr(r["genres"]))
    er = r["era_research"]
    print("era_research (raw):", (er or "")[:2000])
    if er:
        try:
            d = json.loads(er)
            print("era_research keys:", list(d.keys()))
            print("scope_issues:", json.dumps(d.get("scope_issues"), ensure_ascii=False, indent=1))
        except Exception as e:
            print("era_research parse error:", e)
