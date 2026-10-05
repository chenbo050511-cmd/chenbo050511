"""
用官方答案页（答案速查表）交叉校验题库里的答案。

源仓库除了试卷，还存了一份官方答案页的 OCR（`data/ocr/answers/<卷号>.json`），
是一份独立的来源 —— 正好用来验证题库里的答案对不对。

用法：python tools/verify-answer-key.py
"""

import json
import os
import re
import sqlite3
import urllib.request

BASE = 'https://raw.githubusercontent.com/ShepiTT/CET_practice_questions/main/data/ocr/answers'
CACHE = 'D:/WordMaster/tools/_raw/exam/answerkey'
DB = 'D:/WordMaster/data/wordmaster.db'
os.makedirs(CACHE, exist_ok=True)

# OCR 会把字母认错：I→1、O→0、A→4 之类
FIX = {'1': 'I', '0': 'O', '4': 'A', '8': 'B', '5': 'S', '6': 'G'}


def fetch(code):
    path = os.path.join(CACHE, code + '.json')
    if os.path.exists(path) and os.path.getsize(path) > 5000:
        return path
    try:
        r = urllib.request.Request(f'{BASE}/{code}.json', headers={'User-Agent': 'Mozilla/5.0'})
        with urllib.request.urlopen(r, timeout=45) as resp:
            data = resp.read()
        with open(path, 'wb') as f:
            f.write(data)
        return path
    except Exception:
        return None


def parse_official(path):
    """从答案页 OCR 里抽出 {题号: 字母}"""
    try:
        doc = json.load(open(path, encoding='utf-8'))
    except Exception:
        return {}
    out = {}
    for page in doc:
        for item in page.get('lines', []):
            t = (item[1] or '').strip()
            m = re.fullmatch(r'(\d{1,2})\s*[.、,]\s*([A-Za-z0-9])', t)
            if not m:
                continue
            n = int(m.group(1))
            c = m.group(2).upper()
            c = FIX.get(c, c)
            out.setdefault(n, c)
    return out


def main():
    db = sqlite3.connect(DB)
    db.row_factory = sqlite3.Row
    papers = [r[0] for r in db.execute('SELECT code FROM exam_papers ORDER BY code')]

    total_q = 0
    total_checked = 0
    total_diff = 0
    no_key = []
    diff_by_paper = []

    for code in papers:
        path = fetch(code)
        if not path:
            no_key.append(code)
            continue
        official = parse_official(path)
        if len(official) < 20:
            no_key.append(code + '(解析不出)')
            continue

        rows = db.execute("""
            SELECT q.q_number, q.answer, s.kind, q.stem
              FROM exam_questions q
              JOIN exam_sets s ON s.id = q.set_id
              JOIN exam_papers p ON p.id = s.paper_id
             WHERE p.code = ?
        """, (code,)).fetchall()

        diffs = []
        for r in rows:
            total_q += 1
            n = r['q_number']
            if n not in official:
                continue
            total_checked += 1
            if official[n] != r['answer']:
                diffs.append((n, r['kind'], official[n], r['answer'], (r['stem'] or '')[:52]))

        if diffs:
            total_diff += len(diffs)
            diff_by_paper.append((code, diffs))

    print(f'题库总题数 {total_q}，其中能和官方答案对上的 {total_checked} 题')
    print(f'不一致 {total_diff} 题\n')
    if no_key:
        print(f'没有官方答案页的卷子（{len(no_key)} 套）：')
        for c in no_key[:20]:
            print(f'  {c}')
        print()

    if not diff_by_paper:
        print('✅ 所有能对上的题，答案都与官方一致')
        return

    print('=== 不一致明细 ===')
    for code, diffs in diff_by_paper:
        print(f'\n{code}  共 {len(diffs)} 处')
        for n, kind, off, mine, stem in diffs:
            print(f'  Q{n:<4} {kind:<9} 官方={off}  题库={mine}   {stem}')


main()
