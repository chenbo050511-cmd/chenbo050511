"""
建「查词用的扩展词表」dict_extra。

背景：背单词的词库只有 6158 个（四级/六级/考研），而做真题阅读时点词查义，
正文里 **81% 的词查不到** —— 连 study / people / because 这种基础词都没有
（实测正文 3.97 万词次里只有 19% 能查到）。

所以单独建一张**只用于查词**的表，从完整 ECDICT 里取「常见词」：
  · 有考试标签（zk/gk/cet4/cet6/ky/toefl/ielts/gre）的
  · 或 BNC 语料库词频排名前 25000 的
约 2.7 万条，只存查词要用的字段。

**不并进 words 表** —— 那是背单词的词库，混进 /the/ /because/ 会污染学习列表。

用法：python tools/build-extra-dict.py
"""

import csv
import os
import sqlite3
import time

ECDICT = 'D:/WordMaster/tools/_raw/ecdict.csv'
DB = 'D:/WordMaster/data/wordmaster.db'
BNC_MAX = 25000


def main():
    if not os.path.exists(ECDICT):
        print(f'找不到 {ECDICT}')
        print('获取方式：node tools/fetch-assets.js（会下 ECDICT）')
        return

    con = sqlite3.connect(DB)
    con.executescript("""
      CREATE TABLE IF NOT EXISTS dict_extra (
        id        INTEGER PRIMARY KEY AUTOINCREMENT,
        word      TEXT NOT NULL,
        lower     TEXT NOT NULL,
        phonetic  TEXT DEFAULT '',
        pos       TEXT DEFAULT '',
        meaning   TEXT DEFAULT '',
        exchange  TEXT DEFAULT ''
      );
      CREATE INDEX IF NOT EXISTS idx_dict_extra_lower ON dict_extra(lower);
    """)

    print(f'读取 {os.path.basename(ECDICT)} …')
    t0 = time.time()
    rows = []
    seen = set()
    with open(ECDICT, encoding='utf-8', errors='ignore') as f:
        for row in csv.DictReader(f):
            w = (row.get('word') or '').strip()
            # 只要纯英文单词（排除短语、带空格的、带标点的）
            if not w or not w.isalpha() or len(w) < 2:
                continue
            low = w.lower()
            if low in seen:
                continue
            tag = (row.get('tag') or '').strip()
            try:
                bnc = int(row.get('bnc') or 0)
            except ValueError:
                bnc = 0
            if not tag and not (0 < bnc <= BNC_MAX):
                continue
            meaning = (row.get('translation') or '').replace('\n', '；').strip()
            if not meaning:
                continue
            seen.add(low)
            rows.append((w, low, (row.get('phonetic') or '').strip(),
                         (row.get('pos') or '').strip(), meaning[:400],
                         (row.get('exchange') or '').strip()))

    print(f'  命中常见词 {len(rows):,} 条，用时 {time.time() - t0:.0f}s')
    con.execute('DELETE FROM dict_extra')
    con.executemany(
        'INSERT INTO dict_extra(word, lower, phonetic, pos, meaning, exchange) VALUES(?,?,?,?,?,?)',
        rows
    )
    con.commit()

    n = con.execute('SELECT COUNT(*) FROM dict_extra').fetchone()[0]
    print(f'  写入 dict_extra：{n:,} 条')
    for w in ('study', 'people', 'because', 'the', 'research', 'obesity'):
        r = con.execute('SELECT word, phonetic, substr(meaning,1,40) FROM dict_extra WHERE lower=?', (w,)).fetchone()
        print(f'    抽查 {w:10} → {r if r else "（没有）"}')
    con.close()


main()
