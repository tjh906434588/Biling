"""作者确认流程冒烟：DB 层流转 + 对运行中服务的 HTTP 接口。

用法：python scripts/smoke_author_confirm.py [novel_id]
缺省取库中第一本小说。HTTP 段需要服务在 127.0.0.1:8000 运行。
"""
import asyncio
import sys
import uuid
from pathlib import Path

import httpx

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
from app.db.base import Base  # noqa: E402
from app.db.session import SessionLocal, engine  # noqa: E402
from app.db.models import AuthorConfirm  # noqa: E402
from app.services.pipeline import (  # noqa: E402
    answer_author_confirm,
    dismiss_author_confirm,
    get_pending_confirms,
)
from sqlalchemy import delete  # noqa: E402


def main():
    novel_id = sys.argv[1] if len(sys.argv) > 1 else None
    Base.metadata.create_all(bind=engine)
    if novel_id is None:
        import sqlite3
        conn = sqlite3.connect("biling.db")
        row = conn.execute("select id from novels limit 1").fetchone()
        conn.close()
        if row is None:
            print("库中没有项目，请先创建一本小说再跑冒烟。")
            return
        novel_id = str(row[0])

    db = SessionLocal()
    try:
        # 0. 清理历史冒烟残留（避免与本次断言混淆）
        db.execute(delete(AuthorConfirm).where(AuthorConfirm.confirm_key.like("smoke_%")))
        db.commit()

        # 1. 插三条 pending 确认
        rows = []
        for i, agent in enumerate(("outliner", "era_researcher", "outliner")):
            row = AuthorConfirm(
                novel_id=uuid.UUID(novel_id),
                agent=agent,
                task_id=None,
                confirm_key=f"smoke_{i}_{uuid.uuid4().hex[:6]}",
                status="pending",
                question=f"冒烟测试确认 {i}",
                options=[{"id": "a", "label": "方向A", "desc": "描述"}, {"id": "b", "label": "方向B", "desc": "描述"}],
                allow_custom=True,
            )
            db.add(row)
            rows.append(row)
        db.commit()
        ids = [str(r.id) for r in rows]

        # 2. 查询待确认
        pending = get_pending_confirms(db, uuid.UUID(novel_id))
        assert {p["id"] for p in pending} >= set(ids), "新确认未出现在待确认列表"
        print(f"[OK] 待确认列表含 3 条：{ids}")

        # 3. 按 agent 过滤
        outliner = get_pending_confirms(db, uuid.UUID(novel_id), agent="outliner")
        assert {p["id"] for p in outliner} == {ids[0], ids[2]}, "agent 过滤不准"
        print("[OK] agent 过滤正确")

        # 4. 答复（选选项 + note）
        answered = answer_author_confirm(db, uuid.UUID(ids[0]), "a", "补充说明")
        assert answered["status"] == "answered" and answered["answer_meta"]["label"] == "方向A"
        print("[OK] 答复选项 -> answered, meta.label=方向A")

        # 5. 答复（自定义输入）
        answered2 = answer_author_confirm(db, uuid.UUID(ids[1]), "我自己想的方向")
        assert answered2["status"] == "answered" and answered2["answer"] == "我自己想的方向"
        print("[OK] 自定义输入 -> answered, answer=我自己想的方向")

        # 6. 重复答复应报错
        try:
            answer_author_confirm(db, uuid.UUID(ids[0]), "b")
            raise SystemExit("FAIL 重复答复未报错")
        except ValueError as e:
            print(f"[OK] 重复答复拒绝：{e}")

        # 7. 跳过
        dismissed = dismiss_author_confirm(db, uuid.UUID(ids[2]))
        assert dismissed["status"] == "dismissed"
        print("[OK] 跳过 -> dismissed")

        # 8. 待确认列表只剩未处理的
        pending = get_pending_confirms(db, uuid.UUID(novel_id))
        assert all(p["id"] not in ids for p in pending), "已答复/跳过的仍留在待确认列表"
        print("[OK] 处理后待确认列表已清空")

        # 9. request_author_confirmation 幂等复用 + 已答复直接返回
        # 复用 ids[0] 的 (novel, agent, confirm_key)：因已 answered，应立即返回结果，不再重复创建/弹窗
        from app.services.pipeline import request_author_confirmation

        async def wait_reuse():
            old = db.get(AuthorConfirm, uuid.UUID(ids[0]))
            return await request_author_confirmation(
                db,
                novel_id=uuid.UUID(novel_id),
                task_id=None,
                agent=old.agent,
                confirm_key=old.confirm_key,
                question="幂等复用测试",
                options=old.options,
            )

        res = asyncio.run(wait_reuse())
        assert res["status"] == "answered" and res["answer"] == "a", f"幂等复用返回异常: {res}"
        print(f"[OK] request_author_confirmation 幂等复用已答复确认 -> {res['status']}/{res['answer']}")

        # 清理
        for row in rows:
            db.delete(db.get(AuthorConfirm, row.id))
        db.commit()
        print("\nDB 层流转全部通过")
    finally:
        db.close()

    # ---- HTTP 段：验证运行中服务的新接口已生效 ----
    client = httpx.Client(timeout=15)
    try:
        def ok(name: str, resp: httpx.Response) -> dict:
            status = "OK" if resp.status_code < 300 else f"FAIL({resp.status_code})"
            print(f"[{status}] {name} -> {resp.text[:200]}")
            if resp.status_code >= 300:
                raise SystemExit(f"HTTP 冒烟失败：{name} {resp.text[:300]}")
            return resp.json()

        base = "http://127.0.0.1:8000/api/stream/agents"
        items = ok("GET /confirm (novel_id)", client.get(f"{base}/confirm?novel_id={novel_id}"))["items"]
        assert isinstance(items, list)
        print("[OK] GET /confirm?novel_id= 路由已生效")

        # 跨小说：不带 novel_id 应返回所有小说的 pending，且附带 novel_title
        all_items = ok("GET /confirm (all)", client.get(f"{base}/confirm"))["items"]
        assert isinstance(all_items, list)
        print(f"[OK] GET /confirm（跨小说）已生效，当前全局待确认 {len(all_items)} 条")

        # 建一条 pending 再走 HTTP 答复/跳过
        db = SessionLocal()
        try:
            row = AuthorConfirm(
                novel_id=uuid.UUID(novel_id),
                agent="outliner",
                task_id=None,
                confirm_key=f"smoke_http_{uuid.uuid4().hex[:6]}",
                status="pending",
                question="HTTP 冒烟测试",
                options=[{"id": "a", "label": "A", "desc": "d"}],
                allow_custom=True,
            )
            db.add(row)
            db.commit()
            cid = str(row.id)
            # 跨小说列表应包含刚建的这条，且 novel_title 已带上
            all_items = client.get(f"{base}/confirm").json()["items"]
            found = next((i for i in all_items if i["id"] == cid), None)
            assert found is not None, "跨小说列表未包含刚创建的确认"
            assert found.get("novel_title"), f"跨小说列表未附带小说标题: {found}"
            print(f"[OK] 跨小说列表附带小说标题：{found['novel_title']}")
            answered = ok(
                "POST /confirm",
                client.post(f"{base}/confirm", json={"confirm_id": cid, "answer": "a", "note": "n"}),
            )
            assert answered["status"] == "answered" and answered["answer_meta"]["label"] == "A"

            row2 = AuthorConfirm(
                novel_id=uuid.UUID(novel_id),
                agent="era_researcher",
                task_id=None,
                confirm_key=f"smoke_http_dismiss_{uuid.uuid4().hex[:6]}",
                status="pending",
                question="HTTP 冒烟跳过",
                options=[{"id": "x", "label": "X"}],
                allow_custom=False,
            )
            db.add(row2)
            db.commit()
            cid2 = str(row2.id)
            dismissed = ok(f"POST /confirm/{cid2}/dismiss", client.post(f"{base}/confirm/{cid2}/dismiss"))
            assert dismissed["status"] == "dismissed"

            # 清理
            for r in (row, row2):
                db.delete(db.get(AuthorConfirm, r.id))
            db.commit()
        finally:
            db.close()
        print("\nHTTP 接口冒烟全部通过")
    finally:
        client.close()


if __name__ == "__main__":
    main()
