"""
诊断：哪些阅读短文没分到段，各自卡在哪一步。

复用 extract-paragraphs.py 里的函数，逐个报告：
  PDF 有没有文字层 → 能不能定位锚点 → 切出几段 → 映射回正文时哪一段的探针没找到
"""

import os
import re
import sqlite3

import pdfplumber

EX = 'D:/WordMaster/tools/extract-paragraphs.py'
PDF_DIR = 'D:/WordMaster/tools/_raw/exam/pdf'
DB = 'D:/WordMaster/data/wordmaster.db'

ns = {'__name__': 'ex', '__file__': EX}
exec(compile(open(EX, encoding='utf-8').read().replace('\nmain()\n', '\n'), EX, 'exec'), ns)

db = sqlite3.connect(DB)
db.row_factory = sqlite3.Row
sets = db.execute("""
    SELECT s.id, s.passage, p.code,
           MIN(q.q_number) AS q_from, MAX(q.q_number) AS q_to
      FROM exam_sets s
      JOIN exam_papers p ON p.id = s.paper_id
      JOIN exam_questions q ON q.set_id = s.id
     WHERE s.kind = 'reading'
       AND s.id NOT IN (SELECT DISTINCT set_id FROM exam_reading_paragraphs)
     GROUP BY s.id ORDER BY p.code, s.seq
""").fetchall()

print(f'没分到段的阅读短文共 {len(sets)} 组\n')

cache = {}
buckets = {}
for row in sets:
    code = row['code']
    path = os.path.join(PDF_DIR, code + '.pdf')
    if not os.path.exists(path):
        buckets.setdefault('① PDF 没下载（扫描件）', []).append(f'{code}#{row["id"]}')
        continue
    if code not in cache:
        try:
            with pdfplumber.open(path) as pdf:
                cache[code] = ns['page_lines'](pdf)
        except Exception as e:
            cache[code] = []
    lines = cache[code]
    chars = sum(len(l['text']) for l in lines)
    if chars < 500:
        buckets.setdefault('② PDF 无文字层（扫描件）', []).append(f'{code}#{row["id"]} 仅{chars}字符')
        continue

    start = ns['find_anchor'](lines, row['q_from'])
    if start is None:
        buckets.setdefault('③ 定位不到引导句', []).append(f'{code}#{row["id"]}')
        continue
    start = ns['skip_directions'](lines, start)
    block = ns['collect_block'](lines, start, row['q_from'], row['q_to'])
    paras = ns['split_by_indent'](block)
    if not paras:
        buckets.setdefault('④ 缩进切不出段落', []).append(f'{code}#{row["id"]} 行数{len(block)}')
        continue

    # 逐段映射，找出第一段对不上的
    src_norm, _ = ns['norm_index'](row['passage'])
    cursor = 0
    bad = None
    for i, p in enumerate(paras, 1):
        pn = re.sub(r'[^a-z0-9]', '', p.lower())
        hit = -1
        for L in (80, 60, 45, 30, 20, 14):
            if len(pn) < L:
                continue
            idx = src_norm.find(pn[:L], cursor)
            if idx >= 0:
                hit = idx
                break
        if hit < 0:
            bad = (i, len(paras), pn[:60])
            break
        cursor = hit + 1
    if bad:
        buckets.setdefault('⑤ 某段探针在正文里找不到', []).append(
            f'{code}#{row["id"]} 第{bad[0]}/{bad[1]}段: 探针「{bad[2]}」正文长度{len(src_norm)}'
        )
    else:
        buckets.setdefault('⑥ 其他（开头位置/递增/长度校验）', []).append(f'{code}#{row["id"]}')

for k in sorted(buckets):
    items = buckets[k]
    print(f'{k}：{len(items)} 组')
    for it in items:
        print(f'    {it}')
    print('')
