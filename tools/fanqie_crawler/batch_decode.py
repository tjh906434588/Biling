"""批量把 corpus/<书名>/raw_ch{n}.txt 解码为 dec_ch{n}.txt。

用法：python tools/fanqie_crawler/batch_decode.py [书名...]
不带参数则处理 corpus 下所有含 raw_ch 的书籍目录。
"""
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from decode_text import load_mapping, decode_text

CORPUS = Path(__file__).resolve().parent / "corpus"


def decode_book(book_dir: Path, mapping: dict) -> list:
    done = []
    for raw in sorted(book_dir.glob("raw_ch*.txt")):
        num = raw.name[len("raw_ch"): -len(".txt")]
        dec_path = book_dir / f"dec_ch{num}.txt"
        if dec_path.exists():
            done.append(f"{raw.name} -> skip(exist)")
            continue
        plain = raw.read_text(encoding="utf-8")
        decoded = decode_text(plain, mapping)
        dec_path.write_text(decoded, encoding="utf-8")
        done.append(f"{raw.name} -> {dec_path.name} ({len(decoded)}字)")
    return done


def main():
    mapping = load_mapping()
    names = sys.argv[1:]
    targets = [CORPUS / n for n in names] if names else sorted(
        d for d in CORPUS.iterdir() if d.is_dir()
    )
    for t in targets:
        if not t.exists():
            print(f"[missing] {t}")
            continue
        print(f"[book] {t.name}")
        for line in decode_book(t, mapping):
            print("  " + line)


if __name__ == "__main__":
    main()
