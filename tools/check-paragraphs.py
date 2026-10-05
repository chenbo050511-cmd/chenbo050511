"""
分段质量检查：对每一组的每一段做几项硬检查，找出可疑的边界。

检查项：
  1. 段落文本必须能在正文里按顺序找到（不该凭空出现）
  2. 段首应当是大写字母或引号/括号开头（英文段落不会以小写词开头）
  3. 段尾应当是句末标点结尾（. ! ? " )）
  4. 段落数应当合理（2–16）
  5. 相邻段落起点必须递增
  6. 把这组的分段拼起来，应当几乎覆盖整篇正文

用法：python tools/check-leaf-paragraphs.py [只查某几组，逗号分隔的 set id]
"""

import os
import re
import sqlite3
import sys

DB = 'D:/WordMaster/data/wordmaster.db'
SENT_END = ('.', '!', '?', '"', '\u201d', '\u2019', ')', ':')
OUT = 'D:/WordMaster/tools/_raw/exam'


def norm(s):
    return re.sub(r'[^a-z0-9]', '', (s or '').lower())


def main():
    only = None
    if len(sys.argv) > 1:
        only = {int(x) for x in sys.argv[1].split(',')}

    db = sqlite3.connect(DB)
    db.row_factory = sqlite3.Row
    rows = db.execute("""
        SELECT p.set_id, p.seq, p.text, s.passage, pa.code
          FROM exam_reading_paragraphs p
          JOIN exam_sets s ON s.id = p.set_id
          JOIN exam_papers pa ON pa.id = s.paper_id
         ORDER BY p.set_id, p.seq
    """).fetchall()

    groups = {}
    for r in rows:
        groups.setdefault(r['set_id'], {'code': r['code'], 'passage': r['passage'], 'paras': []})
        groups[r['set_id']]['paras'].append(r['text'])

    issues = []
    for sid, g in sorted(groups.items()):
        if only and sid not in only:
            continue
        ps = g['paras']
        code = g['code']
        src = norm(g['passage'])

        if not (2 <= len(ps) <= 16):
            issues.append((sid, code, f'段落数异常 {len(ps)}'))
        if src:
            joined = norm(' '.join(ps))
            cover = len(joined) / len(src)
            if cover < 0.95 or cover > 1.03:
                issues.append((sid, code, f'与正文覆盖比例 {cover:.3f}'))
        for i, p in enumerate(ps, 1):
            t = p.strip()
            if not t:
                issues.append((sid, code, f'第{i}段为空'))
                continue
            first = t[0]
            if not (first.isupper() or first in '"\u201c\u2018([\u2014-'):
                issues.append((sid, code, f'第{i}段以小写开头: 「{t[:46]}」'))
            if not t.endswith(SENT_END):
                issues.append((sid, code, f'第{i}段结尾标点异常: 「{t[-46:]}」'))
            if len(t) < 60:
                issues.append((sid, code, f'第{i}段过短 {len(t)} 字: 「{t[:46]}」'))

        # 段落顺序必须与正文一致
        cursor = 0
        for i, p in enumerate(ps, 1):
            pn = norm(p)
            head = pn[:40] if len(pn) >= 40 else pn
            idx = src.find(head, cursor)
            if idx < 0:
                issues.append((sid, code, f'第{i}段在正文里找不到（顺序错乱）: 「{p[:46]}」'))
                break
            cursor = idx + 1

    print(f'检查了 {len(groups)} 组、{sum(len(g["paras"]) for g in groups.values())} 个段落')
    print(f'可疑点 {len(issues)} 处\n')
    for sid, code, msg in issues[:40]:
        print(f'  #{sid} {code:16} {msg}')
    if len(issues) > 40:
        print(f'  … 还有 {len(issues) - 40} 处')

    os.makedirs(OUT, exist_ok=True)
    with open(os.path.join(OUT, 'para-issues.txt'), 'w', encoding='utf-8') as f:
        for sid, code, msg in issues:
            f.write(f'#{sid} {code} {msg}\n')
    print(f'\n（完整清单写到 {OUT}/para-issues.txt）')


main()
