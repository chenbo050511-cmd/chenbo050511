"""
清洗真题文本里的两类脏数据。

① 单词粘连：源数据是 OCR 出来的，本该有空格的地方丢了空格
     challenginglandscapes   → challenging landscapes
     prescriptionmedications → prescription medications
     servicesinsideschools   → services inside schools
   解法：基于词典的最小代价分词。**关键前提是绝不拆真词** ——
   `disproportionately` / `counterintuitively` 本身就是合法长词，必须先查词典再决定拆不拆。

② 正文里混进试卷名称/页脚：这些是 PDF 页眉页脚被 OCR 进正文的
     ...recent studies have 四级2020年12月6 shown that...   → ...recent studies have shown that...
     ...benefit us all. 2022 年 6 月英语四级真题 第一套 页码 9  → ...benefit us all.

默认**只预演**，把每一处改动都打印出来；确认无误后加 --write 才写库。
用法：
  python tools/clean-exam-text.py            # 预演
  python tools/clean-exam-text.py --write    # 写库
  python tools/clean-exam-text.py --only-glue / --only-noise   # 只做其中一类
"""

import csv
import math
import os
import re
import sqlite3
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

DB = 'D:/WordMaster/data/wordmaster.db'
FULL_CSV = 'D:/WordMaster/tools/_raw/ecdict.csv'
SLIM_CSV = 'D:/WordMaster/tools/_raw/ecdict-slim.csv'

WRITE = '--write' in sys.argv
ONLY_GLUE = '--only-glue' in sys.argv
ONLY_NOISE = '--only-noise' in sys.argv

PER_WORD = 2.2      # 每多切一个词加一份代价，抑制过度切分
MAX_WORD_LEN = 22

# 这几个常用小词在 ECDICT 里词频是 0，会被下面「无词频且短于 5 字母不成词」的规则误伤，
# 结果 conversationalistis 切不出 conversationalist is（因为 is 不算词）。
# 所以给它们开白名单，无条件算词。
ALWAYS_WORDS = set("""
a an the and or but if of to in on at by for with from as is are was were be been being am
do does did have has had will would can could may might must shall should not no nor so up us
it its we our you your he him his she her they them their this that these those there then than
when where why how who whom whose which what all any some more most much many other another
such same own only just even very too also now here one two both each either neither
ever never always often sometimes about after before over under between through during while
because although however therefore into onto out off down upon within without
""".split())


# ------------------------------------------------------------------ #
# 词典
# ------------------------------------------------------------------ #

def load_dict():
    """
    返回 (word_set, cost)。
    word_set 用来判断「这是不是一个真词」—— 必须用全量词典，
    否则 disproportionately 这类词会被误当成粘连词拆开。
    全量词典下载不完整时（正在下/断了）拒绝使用，改用精简词典 ——
    否则会拿着半个词典把真词拆坏。
    """
    full_ok = os.path.exists(FULL_CSV) and os.path.getsize(FULL_CSV) > 50 * 1024 * 1024
    if os.path.exists(FULL_CSV) and not full_ok:
        print(f'  ! 全量词典不完整（{os.path.getsize(FULL_CSV) / 1048576:.1f} MB），改用精简词典')
    src = FULL_CSV if full_ok else SLIM_CSV
    words = {}
    with open(src, encoding='utf-8', errors='ignore', newline='') as f:
        rd = csv.reader(f)
        header = next(rd)
        iw, ifr = header.index('word'), header.index('frq')
        for parts in rd:
            if len(parts) <= max(iw, ifr):
                continue
            w = parts[iw]
            if not w or not w.isalpha():
                continue
            try:
                fr = int(parts[ifr])
            except ValueError:
                fr = 0
            wl = w.lower()
            prev = words.get(wl)
            if prev is None or (0 < fr < prev) or (prev == 0 and fr > 0):
                words[wl] = fr
    return words, ('全量' if full_ok else '精简（仅够兜底）')


def build_cost(words):
    cost = {}
    for w, fr in words.items():
        if fr > 0:
            cost[w] = math.log(fr + 10) + PER_WORD
        elif len(w) >= 5:
            cost[w] = math.log(90000) + PER_WORD
        # 没有词频且短于 5 字母的碎片不允许成词（eti / rio / sto / th / obes 这类）。
        # 阈值从 6 降到 5 是为了放进 seems 这种没有词频的常见变形 ——
        # 挡在 6 会让 DP 退而求其次切成 see ms
    # 常用小词无条件放行（is / an / at 这些在 ECDICT 里词频为 0，会被上面挡掉）
    for w in ALWAYS_WORDS:
        if w not in cost:
            cost[w] = math.log(50) + PER_WORD
    return cost


def segment(run, cost, raw=None):
    n = len(run)
    best = [float('inf')] * (n + 1)
    back = [0] * (n + 1)
    best[0] = 0.0
    for i in range(1, n + 1):
        for L in range(1, min(MAX_WORD_LEN, i) + 1):
            piece = run[i - L:i]
            c = cost.get(piece.lower())
            # 专有名词常常没有词频（Jose / Harvard / Keynes），
            # 只要首字母大写且出现在原始词表里就放行
            if c is None and raw is not None and piece[:1].isupper() and piece.lower() in raw:
                c = math.log(90000) + PER_WORD
            if c is None:
                continue
            if best[i - L] + c < best[i]:
                best[i] = best[i - L] + c
                back[i] = i - L
    if best[n] == float('inf'):
        return None
    out, i = [], n
    while i > 0:
        j = back[i]
        out.append(run[j:i])
        i = j
    return ' '.join(reversed(out))


# ------------------------------------------------------------------ #
# ① 粘连词
# ------------------------------------------------------------------ #
#
# 教训：**「词典里没有」不等于「就是粘连」**。
# 第一版直接拿 DP 分词去切所有「不在词典里的词」，结果把
#   caregiving → care giving、crowdfunding → crowd funding、
#   Kickstarter → Kick starter、Petridish → Petri dish、kleptoplasty → klepto plasty
# 全切坏了 —— 这些是合成词、品牌名、术语，ECDICT 里当然没有。
#
# 所以改成两层保守规则：
#   甲、只在这类「几乎不会作为合成词后半个成分」的高频虚词边界切开，
#       并要求另一截本身就是词典里的词
#   乙、只有长度 ≥20 且不在词典里的 token 才交给 DP 分词
#       （disproportionately / counterintuitively / misinterpretations 都是 18 字母，
#         落在阈值之下，天然被保护）
# 真词一律不碰。

# 甲层用的边界词：代词 / 限定词 / 冠词 / 高频副词。
# 不放名词、动词、形容词 —— 那些容易是合成词的后半截（care+giving）。
MARKER_WORDS = [
    # 代词 / 限定词
    'themselves', 'themself', 'their', 'theirs', 'these', 'those', 'this', 'that', 'them', 'they',
    'your', 'yours', 'you', 'ours', 'our', 'his', 'him', 'her', 'hers', 'its', 'it', 'we', 'us',
    'whom', 'whose', 'which', 'what', 'when', 'where', 'why', 'how', 'who',
    # 冠词 / 连词 / 介词
    'the', 'and', 'but', 'for', 'nor', 'yet', 'or',
    # 助动词 / be 动词 —— 补上这些才能修 nationallyhad → nationally had
    'had', 'has', 'have', 'was', 'were', 'are', 'will', 'would', 'could', 'should',
    'might', 'must', 'been', 'being', 'does', 'did',
    # 高频副词
    'there', 'here', 'then', 'than', 'now', 'not', 'also', 'very', 'just', 'even', 'only',
    'both', 'each', 'either', 'neither', 'some', 'any', 'all', 'most', 'more', 'much', 'many',
    'other', 'another', 'such', 'same', 'own', 'too', 'ever', 'never', 'always', 'often', 'sometimes',
]
# 长词在前，避免 "the" 先命中把 "their" 的尾巴切走
MARKERS = sorted(set(MARKER_WORDS), key=len, reverse=True)

MIN_TOKEN = 7          # 短于这个长度不碰（避免拆坏缩写）
DP_MIN_LEN = 15        # 只有这么长的非词典词才交给 DP

# 绝不拆分的词。
# 这些是本语料里出现的长词，但 ECDICT 里没有（英式拼写、派生词等），
# 阈值降到 15 之后它们会被 DP 误切 —— 比如 Personalisation → Personal is ation。
# 名单是扫描全库 ≥15 字符的 token 后逐个人工分出来的：79 个里 74 个是合法长词。
NEVER_SPLIT = set("""
antidepressants interchangeably acclimatization recommendations accomplishments appropriateness
entrepreneurial standardization experimentation generalisations internalization neuroscientists
individualistic interdependence internationally competitiveness environmentally straightforward
representations characteristics disappointments unsophisticated professionalism congratulations
traditionalists americanization technologically standardisation diversification chronologically
procrastination superintendents representatives marginalisation pessimistically personalisation
synchronization dissatisfaction underprivileged industriousness nonconventional unconditionally
interpretations revolutionizing compassionately responsibilities multidimensional undernourishment
environmentalist environmentalism communitarianism disproportionate rationalizations
entrepreneurship enthusiastically indistinguishable socioeconomically materialistically
intergovernmental industrialisation environmentalists intergenerational counterproductive
conversationalist misunderstandings environmentalists interdisciplinary multidisciplinary
misinterpretations disproportionately counterintuitively
""".split())
                       # 16 是安全的：misunderstanding / responsibilities / fatnessrepresent 都是 16，
                       # 前两个在词典里会被跳过，只有真正粘连的才会走到 DP


def is_word(part, known, raw):
    """
    判断一段是不是「真词」。
    普通词用过滤后的词表（挡掉 obes 这类碎片）；
    但专有名词（Jose / Harvard）往往没有词频，所以要允许
    「首字母大写 + 出现在原始词表里」。
    """
    if part.lower() in known:
        return True
    return part[:1].isupper() and part.lower() in raw


def split_by_marker(tok, words, depth=0, raw=None):
    raw = raw if raw is not None else words
    """在虚词边界切开，要求非虚词那截本身是词典里的词"""
    low = tok.lower()
    if low in words or len(low) < MIN_TOKEN:
        return None
    # 带连字符的复合词（obesity-inducing）原样保留：
    # 连字符说明原文本在这里本来就不缺空格，硬切只会切出 obes ity-inducing 这种
    if '-' in tok or '\u2019' in tok or "'" in tok:
        return None
    for fw in MARKERS:
        if len(low) <= len(fw) + 3:
            continue
        if low.endswith(fw):
            head = tok[:-len(fw)]
            if head.lower() in words:
                return head + ' ' + tok[-len(fw):]
    for fw in MARKERS:
        if len(low) <= len(fw) + 3:
            continue
        if low.startswith(fw):
            tail = tok[len(fw):]
            if tail.lower() in words:
                return tok[:len(fw)] + ' ' + tail
    if depth < 2:
        for fw in MARKERS:
            pos = low.find(fw)
            while pos > 2:
                left, right = tok[:pos], tok[pos:]
                # 中间切分必须**两边都成立**才接受。
                # 否则 nationallyhad 会被切成 nation allyhad（后半截递归失败还硬切）
                if left.lower() in words:
                    sub = split_by_marker(right, words, depth + 1)
                    if sub is not None:
                        return left + ' ' + sub
                    if right.lower() in words:
                        return left + ' ' + right
                pos = low.find(fw, pos + 1)
    return None


def strip_possessive(tok):
    """剥掉结尾的所有格，返回 (词干, 后缀)。's 不该让整个词被跳过。"""
    for suf in ("'s", '\u2019s', "'", '\u2019'):
        if tok.endswith(suf) and len(tok) > len(suf):
            return tok[:-len(suf)], suf
    return tok, ''


# 跨句点的粘连：theU.S.economy → the U.S. economy
# 要求「小写词 + 大写缩写点号」紧贴、后面紧跟小写字母才动手，
# 所以正常写法的 "the U.S. economy"（本来就有空格）不会被碰
PERIOD_GLUE = re.compile(r'([a-z]{2,})([A-Z]\.(?:[A-Z]\.)+)(?=[a-z])')


def fix_period_glue(text):
    return PERIOD_GLUE.sub(lambda m: f'{m.group(1)} {m.group(2)} ', text)


def fix_glue(text, words, cost, raw=None):
    stats = {'marker': 0, 'dp': 0}

    def fix(m):
        tok = m.group(0)
        core, suf = strip_possessive(tok)
        low = core.lower()
        if not core or low in words or low in NEVER_SPLIT:
            return tok                                    # 真词 / 白名单，绝不拆
        if len(core) < MIN_TOKEN:
            return tok
        if '-' in core or "'" in core or '\u2019' in core:
            return tok                                    # 连字符/内嵌撇号的复合词不碰
        got = split_by_marker(core, words, 0, raw)
        if got:
            stats['marker'] += 1
            return got + suf
        if len(core) >= DP_MIN_LEN:
            seg = segment(core, cost, raw)
            if seg and ' ' in seg:
                stats['dp'] += 1
                return seg + suf
        return tok

    text = fix_period_glue(text)
    out = re.sub(r"[A-Za-z][A-Za-z'\u2019-]{5,}", fix, text)
    fix_glue.stats = stats
    return out


# ------------------------------------------------------------------ #
# ② 试卷名 / 页脚
# ------------------------------------------------------------------ #

# "2022 年 6 月英语四级真题 第一套 页码 7" / "2024年12月四级真题(第三套)" /
# "2022年9月英语四级真题1套第7页共10页" / "2022 年 0 6 月大学英语四级真题第二套 页码 4"
PAPER_CORE = r'\d{4}\s*年\s*[\d\s]{0,6}月\s*(?:大学)?(?:英语)?[四六]级(?:考试)?真题'
PAPER_TAIL = (r'(?:\s*[（(]?\s*第?\s*[一二三四五六\d]{1,2}\s*套\s*[)）]?)?'
              r'(?:\s*页\s*码?\s*\d{0,3})?(?:\s*第\s*\d+\s*页)?(?:\s*共\s*\d+\s*页)?'
              r'(?:\s*[·•]\s*\d{0,3})?\s*\d{0,3}')

NOISE_PATTERNS = [
    (re.compile(r'[·•]?\s*' + PAPER_CORE + PAPER_TAIL + r'[·•]?'), '试卷名'),
    # "四级2020年12月6" —— 插在句子中间，后面常跟一个页码数字
    (re.compile(r'[四六]级\s*\d{4}\s*年\s*[\d\s]{0,6}月\s*\d{0,3}'), '页脚'),
    # 站点水印
    (re.compile(r'pastpapers\s*\.?\s*cn', re.I), '站点水印'),
    (re.compile(r'https?://\S+', re.I), '网址'),
]

NOISE_LOG = []


def strip_noise(text):
    out = text
    for pat, kind in NOISE_PATTERNS:
        def _sub(m):
            NOISE_LOG.append((kind, m.group(0)))
            return ' '
        out = pat.sub(_sub, out)
    # 去掉残留的空格问题
    out = re.sub(r'\s{2,}', ' ', out)
    out = re.sub(r'\s+([,.;:!?])', r'\1', out)
    return out.strip()


# ------------------------------------------------------------------ #
# 主流程
# ------------------------------------------------------------------ #

TARGETS = [
    ('阅读短文', 'exam_sets', 'passage', "kind='reading'"),
    ('短文分段', 'exam_reading_paragraphs', 'text', '1=1'),
    ('匹配段落', 'exam_paragraphs', 'text', '1=1'),
    ('题干', 'exam_questions', 'stem', '1=1'),
    ('选项', 'exam_options', 'text', '1=1'),
]


def diff_context(before, after, span=80):
    """只显示真正变了的那一小段（前后各留 span 个字符），否则改动藏在长文里看不出来"""
    i = 0
    while i < min(len(before), len(after)) and before[i] == after[i]:
        i += 1
    j = 0
    while (j < len(before) - i and j < len(after) - i
           and before[len(before) - 1 - j] == after[len(after) - 1 - j]):
        j += 1
    b0, b1 = max(0, i - span), min(len(before), len(before) - j + span)
    a0, a1 = max(0, i - 0), min(len(after), len(after) - j + 0)
    a0 = max(0, a0 - span)
    a1 = min(len(after), a1 + span)
    return before[b0:b1], after[a0:a1]


def word_diff(before, after, ctx=4):
    """
    词级 diff：只列出变化的那几处，每处带 ctx 个词的上下文。
    整段打印没法核对 —— 改动藏在两千字的短文里根本看不出来。
    """
    import difflib
    a = before.split(' ')
    b = after.split(' ')
    sm = difflib.SequenceMatcher(None, a, b, autojunk=False)
    out = []
    for tag, i1, i2, j1, j2 in sm.get_opcodes():
        if tag == 'equal':
            continue
        pre = ' '.join(a[max(0, i1 - ctx):i1])
        post = ' '.join(a[i2:i2 + ctx])
        was = ' '.join(a[i1:i2]) or '（空）'
        now = ' '.join(b[j1:j2]) or '（删）'
        out.append((pre, was, now, post))
    return out


def main():
    print('加载词典 ...', flush=True)
    words, src_kind = load_dict()
    cost = build_cost(words)
    # 「是不是真词」用过滤后的词表：ECDICT 原始词表里混着 obes 这类碎片，
    # 拿它当判据会把 obesity-inducing 切成 obes ity-inducing
    known = set(cost)
    raw_words = set(words)
    print(f'  {len(words)} 个词条，其中 {len(known)} 个可用于判词（来源：{src_kind}）')
    print('', flush=True)

    db = sqlite3.connect(DB)
    db.row_factory = sqlite3.Row

    changes = []          # (table, id, before, after, kind)
    for label, table, col, where in TARGETS:
        rows = db.execute(f'SELECT id, {col} AS t FROM {table} WHERE {where}').fetchall()
        n_glue = n_noise = 0
        for r in rows:
            before = r['t'] or ''
            if not before:
                continue
            after = before
            if not ONLY_GLUE:
                after = strip_noise(after)
            if not ONLY_NOISE:
                after = fix_glue(after, known, cost, raw_words)
            if after != before:
                changes.append((table, r['id'], before, after, label))
                if not ONLY_NOISE and fix_glue(before, known, cost, raw_words) != before:
                    n_glue += 1
                if not ONLY_GLUE and strip_noise(before) != before:
                    n_noise += 1
        print(f'  {label:<6} 共 {len(rows):>4} 条，需改动 {sum(1 for c in changes if c[4] == label)} 条')

    print('')
    print('=' * 74)
    print('改动明细（词级 diff）')
    print('=' * 74)
    n_all = 0
    for i, (table, rid, before, after, label) in enumerate(changes, 1):
        diffs = word_diff(before, after)
        print(f'\n[{i}] {label} ({table} #{rid})  {len(diffs)} 处')
        for pre, was, now, post in diffs:
            n_all += 1
            print(f'    …{pre} 【{was}】 {post}…')
            print(f'                 ↓')
            print(f'    …{pre} 【{now}】 {post}…')
    print(f'\n  共 {n_all} 处改动')

    if NOISE_LOG:
        print('')
        print('=' * 72)
        print('剥掉的试卷名/页脚片段')
        print('=' * 72)
        from collections import Counter
        for kind, frag in Counter(x[0] for x in NOISE_LOG).most_common():
            pass
        for kind, frag in NOISE_LOG:
            print(f'  [{kind}] 「{frag}」')
        print(f'  共 {len(NOISE_LOG)} 处')

    print('')
    if not WRITE:
        print(f'（预演模式，未写库。共 {len(changes)} 条待改，加 --write 才会写入）')
        return

    # 写库前备份。
    # 注意用的是 WAL 感知快照，不是裸 copyfile —— 数据库跑在 WAL 模式下，
    # 最近的写入可能还留在 -wal 文件里，只复制主库文件会拿到**旧数据**。
    # （实测踩过：修完 31 处文本后只复制主库文件，副本里那些修复"不存在"。）
    #
    # 本进程此刻持有数据库连接，wal_checkpoint 可能拿不到独占锁，
    # 那种情况下快照会退化为「db + -wal + -shm 三文件一起复制」，同样完整。
    import sys as _sys
    import os as _os
    _sys.path.insert(0, _os.path.dirname(_os.path.dirname(_os.path.abspath(__file__))))
    try:
        db.execute('PRAGMA wal_checkpoint(TRUNCATE)')
    except Exception:
        pass
    import shutil
    shutil.copyfile(DB, DB + '.before-clean')
    for _s in ('-wal', '-shm'):
        if _os.path.exists(DB + _s):
            shutil.copyfile(DB + _s, DB + '.before-clean' + _s)
    print(f'  已备份到 {DB}.before-clean（含 -wal/-shm）')

    db.execute('BEGIN')
    for table, rid, before, after, label in changes:
        col = dict((t, c) for _, t, c, _ in TARGETS)[table]
        db.execute(f'UPDATE {table} SET {col} = ? WHERE id = ?', (after, rid))
    db.execute('COMMIT')
    print(f'  已写入 {len(changes)} 条改动')


main()
