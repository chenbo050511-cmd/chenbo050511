"""
用真题 PDF 的「首行缩进」还原阅读短文的分段。

为什么能行：试卷 PDF 有完整文字层，段落首行比正文左边距缩进约 35pt
（实测 92.3 vs 56.8），这是排版系统留下的确定信号，比猜行间距可靠得多。

关键设计：**PDF 只用来算分段位置，正文文字仍用数据库里已有的。**
原因是有一种试卷 PDF 提取出来整行没有空格
（`Onlineclassesbegantobepopularized...`），文字没法直接展示，
但它的行坐标依然准确。所以：
  1. 从 PDF 拿到「哪几行是段落首行」
  2. 把每段规范化后，在库里的正文里按顺序定位，换算成字符区间
  3. 用这些区间去切库里的正文 —— 分段来自 PDF，文字来自 OCR，各取所长

用法：
  python tools/extract-paragraphs.py             # 只统计
  python tools/extract-paragraphs.py --write     # 写回数据库
  python tools/extract-paragraphs.py --report    # 打印失败样例
"""

import collections
import os
import re
import sqlite3
import sys

import pdfplumber

PDF_DIR = 'D:/WordMaster/tools/_raw/exam/pdf'
DB = 'D:/WordMaster/data/wordmaster.db'
WRITE = '--write' in sys.argv
REPORT = '--report' in sys.argv

SENT_END = '.!?"\u201d\u2019)'
MIN_PARA_CHARS = 40
MAX_PARAS = 16

ANCHOR_RE = re.compile(
    r'Questions?\s*(\d+)\s*to\s*(\d+)\s*are\s*based\s*on\s*the\s*following\s*passage', re.I)
# 兜底：有的卷子这行被截断成只有 "Questions46to50"，后面半句没了
ANCHOR_LOOSE = re.compile(r'^Questions?\s*(\d+)\s*to\s*(\d+)\b', re.I)
# 说明文字的特征，用来在宽松兜底时跳过残留的 Directions
DIRECTIONISH = re.compile(r'(based\s*on|Answer\s*Sheet|following\s*passage|Directions)', re.I)
# 水印 / 页脚噪声：这些 PDF 在正文中间插了站点水印和页码，
# 不滤掉会被当成正文段落拼进去，把段落探针污染掉（实测 16 组「对不上」全是这个原因）
NOISE_RE = re.compile(r'(pastpapers|www\.|https?://|英语[四六]级真题|真题\s*第|第\s*\d+\s*套|页\s*码)', re.I)
PAGENUM_RE = re.compile(r'^\s*\d{1,3}\s*$')
# 水印常常和正文黏在同一行（"...onion.202467pastpapers.cn"），
# 所以要先「抠掉水印」再判断这一行是不是纯噪声，不能整行丢弃 —— 否则会连正文一起删
WATERMARK_SUB = re.compile(r'\d{0,6}\s*pastpapers\s*\.?\s*cn', re.I)
TITLE_SUB = re.compile(r'\d{4}\s*年\s*\d{1,2}\s*月\s*英语[四六]级真题.{0,12}?(套|页\s*码)?', re.I)


def strip_noise(text):
    t = WATERMARK_SUB.sub(' ', text)
    t = TITLE_SUB.sub(' ', t)
    return re.sub(r'\s+', ' ', t).strip()
# 题号行：允许 "46." "46)" "46 ." 以及句点后没有空格（部分 PDF 全文无空格）
QSTART_RE = re.compile(r'^(\d{1,3})\s*[.)](?!\d)')


def norm_index(s):
    """返回 (只含小写字母数字的串, 每个字符在原文中的下标)"""
    chars, pos = [], []
    for i, ch in enumerate(s or ''):
        c = ch.lower()
        if c.isalnum():
            chars.append(c)
            pos.append(i)
    return ''.join(chars), pos


def page_lines(pdf):
    out = []
    for pno, page in enumerate(pdf.pages):
        words = page.extract_words(use_text_flow=False, keep_blank_chars=False)
        if not words:
            continue
        buckets = {}
        for w in words:
            buckets.setdefault(round(w['top'], 1), []).append(w)
        for top in sorted(buckets.keys()):
            ws = sorted(buckets[top], key=lambda x: x['x0'])
            out.append({'page': pno, 'x0': round(ws[0]['x0'], 1),
                        'text': ' '.join(w['text'] for w in ws).strip()})
    return out


def find_anchor(lines, q_from):
    """
    找出所有 "Questions N to M are based on the following passage." 引导句，
    挑题号区间包含 q_from 的那个。

    不能拿库里的题号范围精确匹配 —— 清洗时可能丢过题，
    库里是 Q46-49 而试卷印的是 "Questions 46 to 50"。
    """
    cands = []
    for i, ln in enumerate(lines):
        m = ANCHOR_RE.search(ln['text'])
        if m:
            cands.append((i, int(m.group(1)), int(m.group(2))))
    if not cands:
        for i in range(len(lines) - 1):
            m = ANCHOR_RE.search(lines[i]['text'] + ' ' + lines[i + 1]['text'])
            if m:
                cands.append((i + 1, int(m.group(1)), int(m.group(2))))
    for idx, lo, hi in cands:
        if lo <= q_from <= hi:
            return idx + 1

    # 兜底：只认题号区间，不看后半句
    loose = []
    for i, ln in enumerate(lines):
        m = ANCHOR_LOOSE.match(ln['text'])
        if m:
            loose.append((i, int(m.group(1)), int(m.group(2))))
    for idx, lo, hi in loose:
        if lo <= q_from <= hi:
            return idx + 1
    return None


def skip_directions(lines, start):
    """宽松兜底时，跳过紧跟锚点的残留说明行（最多 2 行）"""
    i = start
    skipped = 0
    while i < len(lines) and skipped < 2 and DIRECTIONISH.search(lines[i]['text']):
        i += 1
        skipped += 1
    return i


def collect_block(lines, start, q_from, q_to):
    """从正文起点收到第一道题之前，并滤掉水印/页码这类噪声行"""
    end = None
    for i in range(start, len(lines)):
        m = QSTART_RE.match(lines[i]['text'])
        if m:
            n = int(m.group(1))
            if q_from - 2 <= n <= q_to + 2:
                end = i
                break
    if end is None:
        end = min(start + 200, len(lines))

    block = []
    for l in lines[start:end]:
        t = strip_noise(l['text'])
        if not t or PAGENUM_RE.match(t):
            continue
        # 抠掉水印后还是纯噪声（很短且命中噪声特征）的整行丢弃
        if len(t) < 20 and NOISE_RE.search(t):
            continue
        block.append({'x0': l['x0'], 'text': t})
    return block


def split_by_indent(block):
    """按缩进初步切分，再用「段落必须以句末标点结尾」修正边界"""
    if len(block) < 4:
        return None
    xs = [round(l['x0']) for l in block]
    counts = collections.Counter(xs)
    margin = counts.most_common(1)[0][0]
    indents = [x for x in counts if x >= margin + 8]
    if not indents:
        return None
    indent = min(indents)

    paras, cur = [], []
    for l in block:
        if round(l['x0']) >= indent - 3 and cur:
            paras.append(' '.join(cur))
            cur = []
        cur.append(l['text'])
    if cur:
        paras.append(' '.join(cur))
    paras = [re.sub(r'\s+', ' ', p).strip() for p in paras if p.strip()]
    if len(paras) < 2:
        return None

    fixed = []
    for p in paras:
        if fixed and (not fixed[-1].rstrip().endswith(tuple(SENT_END)) or len(fixed[-1]) < MIN_PARA_CHARS):
            fixed[-1] = fixed[-1] + ' ' + p
        else:
            fixed.append(p)
    if len(fixed) > 1 and len(fixed[-1]) < MIN_PARA_CHARS:
        fixed[-2] = fixed[-2] + ' ' + fixed[-1]
        fixed.pop()
    if len(fixed) < 2 or len(fixed) > MAX_PARAS:
        return None
    return fixed


def map_by_head(paras, src_norm):
    """
    按「段首」映射：找到每段的起点，段的终点由下一段的起点决定。
    这是默认方式，对绝大多数卷子都对。
    """
    cursor = 0
    starts = []
    for p in paras:
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
            return None
        starts.append(hit)
        cursor = hit + 1
    return starts


def map_by_tail(paras, src_norm):
    """
    按「段尾」映射：找到每段的终点，段的起点由上一段的终点决定。

    为什么需要这个：有些试卷 PDF 的文字层是**乱的** ——
    段首那几个词被重排过（比如 pdf 里是
    `hairdresser about katharine abraham an economics professor was chatting…`，
    而正文是 `Katharine Abraham, an economics professor, was chatting with her hairdresser…`）。
    这种卷子按段首永远对不上，但**段尾是好的**，所以换一头当探针就能救回来。
    """
    cursor = 0
    ends = []
    for p in paras:
        pn = re.sub(r'[^a-z0-9]', '', p.lower())
        hit = -1
        for L in (80, 60, 45, 30, 20, 14):
            if len(pn) < L:
                continue
            probe = pn[-L:]
            idx = src_norm.find(probe, cursor)
            if idx >= 0:
                hit = idx + len(probe)
                break
        if hit < 0:
            return None
        ends.append(hit)
        cursor = hit
    return ends


# 段尾要补回来的标点。注意**不能包含左引号**（\u201c / \u2018）——
# 它们通常是**下一段**的开头，吃进来就变成「上一段以 . “ 结尾」了（踩过）。
# ASCII 双引号同理有歧义，也不收。
TAIL_PUNCT = '.\u201d\u2019)!?'

# 段首可能带的前导引号/括号。这些属于**本段**，
# 所以上面一段的终点必须让到它们前面 —— 否则同一个引号会同时出现在两段里
# （症状：上一段以 `. “` 结尾，下一段又以 `“` 开头）
LEAD_QUOTES = '"\u201c\u2018('


def snap_char(source, ch, window=200):
    """
    把切分位置吸附到**后面最近的**句子开头。

    段尾映射出来的边界可能落在半句话中间（症状：下一段以 and / developing 这类小写词开头）。
    判据是往回跳过空白后应当是句末标点 —— 那样候选位置就正好是新句子的第一个字符。

    **只朝后找**：段尾映射给出的位置本来就更可能偏前一点；
    往前找会跳到更早的句末，反而把上一句的尾巴切给了下一段。
    找不到就原样返回（宁可不动，也别乱移）。
    """
    for d in range(0, window):
        p = ch + d
        if p <= 0 or p > len(source):
            continue
        q = p - 1
        while q > 0 and source[q] in ' \t\r\n':
            q -= 1
        if source[q] in '.!?\u201d\u2019)':
            while p < len(source) and source[p] in ' \t\r\n"\u201c\u2018':
                p += 1
            return p
    return ch


def map_to_source(paras, source):
    """
    把 PDF 切出来的段落对应回库里的正文，返回分段后的段落列表。

    先按段首映射（绝大多数卷子走这条路）；对不上时改按段尾映射
    （救那些「段首被重排」的 PDF）。两条路都不行才放弃 —— 宁可保持整段，
    也不给出错位的分段。

    **不能整段精确比对**：库里的正文来自 OCR，和 PDF 文字总有漏字、标点差异、
    专有名词拼错；而且部分 PDF 的阅读顺序本身就是乱的。
    所以只拿每段一头的一小段当探针，长度从 80 字逐步退让到 14 字。
    """
    src_norm, src_pos = norm_index(source)
    total = len(src_norm)
    if total < 200:
        return None

    cuts = None

    # ① 按段首
    starts = map_by_head(paras, src_norm)
    if (starts is not None
            and all(starts[i] < starts[i + 1] for i in range(len(starts) - 1))
            and starts[0] <= total * 0.05):
        # 把每个段首都换算成「含前导引号」的位置，这样前一段的终点正好落在引号前，不会重叠
        cuts = [0]
        for s in starts[1:]:
            ch = src_pos[s]
            while ch > 0 and source[ch - 1] in LEAD_QUOTES:
                ch -= 1
            cuts.append(ch)
        cuts.append(len(source))

    # ② 按段尾（段首被重排的那些 PDF）
    if cuts is None:
        ends = map_by_tail(paras, src_norm)
        if ends is None or any(ends[i] >= ends[i + 1] for i in range(len(ends) - 1)):
            return None
        cuts = [0]
        for e in ends[:-1]:
            ch = src_pos[e - 1] + 1
            while ch < len(source) and source[ch] in TAIL_PUNCT:
                ch += 1
            cuts.append(snap_char(source, ch))
        cuts.append(len(source))
        if any(cuts[i] >= cuts[i + 1] for i in range(len(cuts) - 1)):
            return None

    out = []
    for i in range(len(cuts) - 1):
        s, e = cuts[i], cuts[i + 1]
        # 段首往前吃掉紧邻的左引号/左括号
        while s > 0 and source[s - 1] in '"\u201c\u2018(':
            s -= 1
        # 段尾往后吃掉句末标点与收尾引号
        while e < len(source) and source[e] in TAIL_PUNCT:
            e += 1
        t = source[s:e].strip()
        if t:
            out.append(t)

    if len(out) < 2:
        return None
    if any(len(t) < MIN_PARA_CHARS for t in out):
        return None
    return out


def main():
    db = sqlite3.connect(DB)
    db.row_factory = sqlite3.Row
    sets = db.execute("""
        SELECT s.id, s.passage, p.code,
               MIN(q.q_number) AS q_from, MAX(q.q_number) AS q_to
          FROM exam_sets s
          JOIN exam_papers p ON p.id = s.paper_id
          JOIN exam_questions q ON q.set_id = s.id
         WHERE s.kind = 'reading'
         GROUP BY s.id ORDER BY p.code, s.seq
    """).fetchall()

    stat = collections.Counter()
    samples = collections.defaultdict(list)
    results = []
    cache = {}

    for row in sets:
        path = os.path.join(PDF_DIR, row['code'] + '.pdf')
        if not os.path.exists(path):
            stat['无 PDF（扫描件或未下载）'] += 1
            continue
        if path not in cache:
            try:
                with pdfplumber.open(path) as pdf:
                    cache[path] = page_lines(pdf)
            except Exception:
                cache[path] = []
        lines = cache[path]
        if not lines:
            stat['PDF 无文字层（扫描件）'] += 1
            continue

        start = find_anchor(lines, row['q_from'])
        if start is None:
            stat['定位不到正文锚点'] += 1
            samples['定位不到正文锚点'].append(row['code'])
            continue
        start = skip_directions(lines, start)

        block = collect_block(lines, start, row['q_from'], row['q_to'])
        paras = split_by_indent(block)
        if not paras:
            stat['缩进切分失败'] += 1
            xs = collections.Counter(round(l['x0']) for l in block)
            samples['缩进切分失败'].append(f'{row["code"]}#{row["id"]} 行数={len(block)} x0={dict(sorted(xs.items()))}')
            continue

        mapped = map_to_source(paras, row['passage'])
        if not mapped:
            stat['分段与正文对不上'] += 1
            samples['分段与正文对不上'].append(f'{row["code"]}#{row["id"]}')
            continue

        stat['成功'] += 1
        results.append((row['id'], row['code'], mapped))

    print(f'阅读短文总数 {len(sets)}')
    for k, v in stat.most_common():
        print(f'  {v:>4}  {k}')
    dist = collections.Counter(len(p) for _, _, p in results)
    print(f'  段落数分布 {dict(sorted(dist.items()))}')

    if REPORT:
        print('\n失败样例：')
        for k, items in samples.items():
            print(f'  [{k}]')
            for it in items[:8]:
                print(f'    {it}')

    if results:
        sid, code, paras = results[0]
        print(f'\n样例 {code} set#{sid}，{len(paras)} 段：')
        for i, p in enumerate(paras, 1):
            print(f'  [{i}] {p[:110]}{"..." if len(p) > 110 else ""}')

    if not WRITE:
        print('\n（只统计模式，未写库。加 --write 才会写入）')
        return

    db.execute('DELETE FROM exam_reading_paragraphs')
    for sid, code, paras in results:
        for i, p in enumerate(paras, 1):
            db.execute('INSERT INTO exam_reading_paragraphs(set_id, seq, text) VALUES(?,?,?)', (sid, i, p))
    db.commit()
    print(f'\n已写入 {len(results)} 组短文的分段')


main()
