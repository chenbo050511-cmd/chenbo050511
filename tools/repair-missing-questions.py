"""
从真题 PDF 里找回题库缺失的题目。

背景：源题库有少数题缺失（OCR/整理时漏了）。以 2025-12-CET4-1 为例，
整组 Q46-Q50 里就是没有 Q48 —— 不是导入时丢的，是源数据本身没有。
但试卷 PDF 里有这道题，官方答案页里也有它的答案，所以可以补回来。

只处理**阅读题**的缺口；段落匹配的缺口是正文被 OCR 截断导致的
（答案指向的段落根本不在正文里），那类题目补出来也做不了，属于主动丢弃。

用法：
  python tools/repair-missing-questions.py            # 只预演，打印将要补的内容
  python tools/repair-missing-questions.py --write    # 真的写入
"""

import json
import os
import re
import sqlite3
import sys
import urllib.request

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from importlib import import_module

fixsp = import_module('fix-spacing')

PDF_DIR = 'D:/WordMaster/tools/_raw/exam/pdf'
KEY_DIR = 'D:/WordMaster/tools/_raw/exam/answerkey'
DB = 'D:/WordMaster/data/wordmaster.db'
WRITE = '--write' in sys.argv

import pdfplumber

Q_START = re.compile(r'^\s*(\d{1,3})\s*[.)]\s*(?=\S)')
OPT_MARK = re.compile(r'(?:(?<=^)|(?<=\s))([A-D])\s*[.)]\s*(?=\S)')


def page_lines(pdf):
    out = []
    for page in pdf.pages:
        words = page.extract_words(use_text_flow=False, keep_blank_chars=False)
        if not words:
            continue
        buckets = {}
        for w in words:
            buckets.setdefault(round(w['top'], 1), []).append(w)
        for top in sorted(buckets.keys()):
            ws = sorted(buckets[top], key=lambda x: x['x0'])
            out.append(' '.join(w['text'] for w in ws).strip())
    return out


def extract_question(lines, qnum, cost):
    """从行列表里取出第 qnum 题的题干和四个选项"""
    si = None
    for i, t in enumerate(lines):
        m = Q_START.match(t)
        if m and int(m.group(1)) == qnum:
            si = i
            break
    if si is None:
        return None

    # 题干：本题起始行去掉题号，再加上后续不以选项标记开头的行
    stem_parts = [Q_START.sub('', lines[si], count=1).strip()]
    i = si + 1
    while i < len(lines):
        t = lines[i]
        if Q_START.match(t):
            return None                       # 直接撞上下一题，说明没选项
        if OPT_MARK.search(t):
            break
        stem_parts.append(t)
        i += 1

    # 选项：从 i 开始，直到下一题
    opt_text = []
    while i < len(lines) and not Q_START.match(lines[i]):
        opt_text.append(lines[i])
        i += 1

    joined = ' '.join(opt_text)
    joined = fixsp.restore_spaces(joined, cost)

    # 按 A) B) C) D) 切开（有的卷把两个选项排在一行）
    parts = re.split(r'(?:(?<=^)|(?<=\s))(?=[A-D]\s*[.)]\s*\S)', joined)
    opts = {}
    for p in parts:
        m = re.match(r'^\s*([A-D])\s*[.)]\s*(.+)$', p.strip())
        if m:
            opts[m.group(1)] = re.sub(r'\s+', ' ', m.group(2)).strip()
    if sorted(opts.keys()) != ['A', 'B', 'C', 'D']:
        return None

    stem = fixsp.restore_spaces(' '.join(stem_parts), cost)
    stem = re.sub(r'\s+', ' ', stem).strip()
    return stem, opts


def get_official_answer(code, qnum):
    """官方答案页有两种版式：答案速查表 / 解析版，两种都试"""
    path = os.path.join(KEY_DIR, code + '.json')
    if not os.path.exists(path):
        try:
            r = urllib.request.Request(
                'https://raw.githubusercontent.com/ShepiTT/CET_practice_questions/main/data/ocr/answers/%s.json' % code,
                headers={'User-Agent': 'Mozilla/5.0'})
            data = urllib.request.urlopen(r, timeout=45).read()
            os.makedirs(KEY_DIR, exist_ok=True)
            with open(path, 'wb') as f:
                f.write(data)
        except Exception:
            return None

    try:
        doc = json.load(open(path, encoding='utf-8'))
    except Exception:
        return None

    rows = []
    for pi, page in enumerate(doc):
        for item in page.get('lines', []):
            bb = item[0]
            rows.append((pi, bb[0][1], bb[0][0], item[1] or ''))
    rows.sort(key=lambda r: (r[0], r[1], r[2]))

    # 版式一：速查表，整行就是 "48. A"
    for _, _, _, t in rows:
        m = re.fullmatch(r'(\d{1,2})\s*[.、,]\s*([A-Za-z0-9])', t.strip())
        if m and int(m.group(1)) == qnum:
            c = m.group(2).upper()
            return {'1': 'I', '0': 'O', '4': 'A'}.get(c, c)

    # 版式二：解析版，题目行之后若干行里出现「故选项X正确」
    ANS = re.compile(r'(?:故)?(?:选项|答案为|答案选|应选)\s*([A-D])\s*(?:项|正确|为正确)')
    for i, (_, _, _, t) in enumerate(rows):
        if re.match(r'^\s*%d\s*[.、]' % qnum, t):
            for (_, _, _, tt) in rows[i:i + 16]:
                m = ANS.search(tt)
                if m:
                    return m.group(1)
    return None


def main():
    print('加载词典 ...', flush=True)
    cost = fixsp.build_cost(fixsp.load_dict_with_freq())
    print(f'  可成词的条目 {len(cost)}\n', flush=True)

    db = sqlite3.connect(DB)
    db.row_factory = sqlite3.Row

    # 找阅读题里的题号缺口
    gaps = []
    sets = db.execute("""
        SELECT s.id, s.kind, p.code, GROUP_CONCAT(q.q_number) nums
          FROM exam_sets s JOIN exam_papers p ON p.id = s.paper_id
          JOIN exam_questions q ON q.set_id = s.id
         WHERE s.kind = 'reading'
         GROUP BY s.id ORDER BY p.code, s.id
    """).fetchall()
    for s in sets:
        ns = sorted(int(x) for x in s['nums'].split(','))
        for n in range(ns[0], ns[-1] + 1):
            if n not in ns:
                gaps.append((s['id'], s['code'], n))

    if not gaps:
        print('阅读题没有题号缺口。')
        return

    print(f'发现 {len(gaps)} 处阅读题缺口：')
    for sid, code, n in gaps:
        print(f'  {code}  set#{sid}  缺 Q{n}')

    recovered = []
    for sid, code, n in gaps:
        pdf_path = os.path.join(PDF_DIR, code + '.pdf')
        if not os.path.exists(pdf_path):
            print(f'\n[{code} Q{n}] 没有 PDF，跳过')
            continue
        with pdfplumber.open(pdf_path) as pdf:
            lines = page_lines(pdf)
        got = extract_question(lines, n, cost)
        if not got:
            print(f'\n[{code} Q{n}] PDF 里定位不到这道题，跳过')
            continue
        stem, opts = got
        ans = get_official_answer(code, n)

        print(f'\n[{code} Q{n}] 从 PDF 恢复：')
        print(f'  题干: {stem}')
        for L in 'ABCD':
            print(f'    {L}) {opts[L]}')
        print(f'  官方答案: {ans if ans else "（没能解析出来，跳过）"}')
        if not ans or ans not in 'ABCD':
            continue
        recovered.append((sid, n, stem, opts, ans))

    if not WRITE:
        print(f'\n（预演模式，未写库。可恢复 {len(recovered)} 题，加 --write 才会写入）')
        return

    for sid, n, stem, opts, ans in recovered:
        order = db.execute('SELECT COALESCE(MAX(seq),0) m FROM exam_questions WHERE set_id=?', (sid,)).fetchone()['m']
        # 按题号插到正确位置：重排 seq
        db.execute("""
            UPDATE exam_questions SET seq = seq + 1
             WHERE set_id = ? AND q_number > ?
        """, (sid, n))
        pos = db.execute('SELECT COUNT(*) c FROM exam_questions WHERE set_id=? AND q_number<?', (sid, n)).fetchone()['c'] + 1
        cur = db.execute(
            'INSERT INTO exam_questions(set_id, seq, q_number, stem, answer) VALUES(?,?,?,?,?)',
            (sid, pos, n, stem, ans))
        qid = cur.lastrowid
        for i, L in enumerate('ABCD', 1):
            db.execute('INSERT INTO exam_options(question_id, label, text, seq) VALUES(?,?,?,?)',
                       (qid, L, opts[L], i))
        db.execute('UPDATE exam_sets SET question_count = question_count + 1 WHERE id = ?', (sid,))
        print(f'  ✓ 已补入 {sid} Q{n}（答案 {ans}）')
    db.commit()
    print(f'\n共补回 {len(recovered)} 题')


main()
