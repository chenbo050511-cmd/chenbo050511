"""
把 PDF 里丢空格黏在一起的英文还原成正常句子。

有些试卷 PDF 的字符是逐个定位的，pdfplumber 抽出来会变成
`dowhenprescribingmedicine`、`Theygivelittlethoughttothetime` 这样。

解法是标准的**最小代价分词**（动态规划）：拿 ECDICT 当词典，
用词频算代价，找总代价最小的切分。比「两半都是词就切」这种贪心可靠得多，
因为它是在全局最优的前提下切，而不是逐段猜。
"""

import csv
import re
import sys
import math

CSV = 'D:/WordMaster/tools/_raw/ecdict.csv'


def load_dict(limit=120000):
    """返回 {小写单词: 代价}，代价 = log(词频排名)，越常见越小"""
    cost = {}
    with open(CSV, encoding='utf-8', errors='ignore') as f:
        f.readline()
        for line in f:
            i = line.find(',')
            if i <= 0:
                continue
            w = line[:i]
            if not w or not w.isalpha():
                continue
            # 只取前若干列里的 frq 需要解析 CSV，这里简化：用行序当大致频率参考不可靠，
            # 所以额外读一次 frq（第 10 列）
            cost[w.lower()] = None
    return cost


def load_dict_with_freq():
    """
    正经解析 CSV 拿 frq（频率排名）。

    注意必须用 csv 模块：ECDICT 的 translation 列里含逗号和引号，
    用 line.split(',') 会让所有列错位 —— 词频就全错了，
    分词结果会变成 `toth eti me` 这种鬼东西（踩过这个坑）。
    """
    words = {}
    with open(CSV, encoding='utf-8', errors='ignore', newline='') as f:
        rd = csv.reader(f)
        header = next(rd)
        try:
            iw = header.index('word')
            ifr = header.index('frq')
        except ValueError:
            return {}
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
    return words


PER_WORD = 2.2          # 每多切一个词就加这么多代价，抑制过度切分


def build_cost(words):
    """
    词 → 代价。

    两条经验规则：
    - 有词频的按 log(词频排名) 计价，越常见越便宜
    - **没有词频且不到 6 个字母的词直接不允许成词**。
      这条很关键：ECDICT 里混着一堆碎片（eti / rio / sto / th），
      它们没词频但能被当成"词"，不加限制就会切出 `toth eti me` 这种鬼东西。
      长词（≥6）即使没词频也放行，因为真正的长碎片很罕见。
    """
    cost = {}
    for w, fr in words.items():
        if fr > 0:
            cost[w] = math.log(fr + 10) + PER_WORD
        elif len(w) >= 6:
            cost[w] = math.log(90000) + PER_WORD
    return cost


def segment(run, cost, max_len=22):
    """把一串没有空格的字母切成单词，返回切好的字符串"""
    n = len(run)
    best = [float('inf')] * (n + 1)
    back = [0] * (n + 1)
    best[0] = 0.0
    for i in range(1, n + 1):
        for L in range(1, min(max_len, i) + 1):
            w = run[i - L:i].lower()
            c = cost.get(w)
            if c is None:
                continue
            if best[i - L] + c < best[i]:
                best[i] = best[i - L] + c
                back[i] = i - L
    if best[n] == float('inf'):
        return None                       # 切不动，交给调用方兜底
    out = []
    i = n
    while i > 0:
        j = back[i]
        out.append(run[j:i])
        i = j
    return ' '.join(reversed(out))


TOKEN = re.compile(r"[A-Za-z][A-Za-z']*")


def restore_spaces(text, cost):
    """对「不在词典里的较长 token」做分词；顺带把数字和字母分开"""
    def fix(m):
        t = m.group(0)
        if len(t) <= 5 or t.lower() in cost:
            return t
        seg = segment(t, cost)
        return seg if seg else t

    out = TOKEN.sub(fix, text)
    # 24hours → 24 hours；a4 → a 4 之类
    out = re.sub(r'(?<=[A-Za-z])(?=\d)', ' ', out)
    out = re.sub(r'(?<=\d)(?=[A-Za-z])', ' ', out)
    return re.sub(r'\s{2,}', ' ', out)


if __name__ == '__main__':
    print('加载词典 ...', flush=True)
    words = load_dict_with_freq()
    print(f'  词条 {len(words)}', flush=True)
    cost = build_cost(words)

    tests = [
        'What do doctors dowhenprescribingmedicine forpeople?',
        'Theygivelittlethoughttothetime oftaking it formaximum effect.',
        'Theyrarely considerwhichmedicineworksbetter forwhichpatient.',
        'Theytellpatientsitspossible sideeffects during aperiodof24hours.',
        'Theytellpatientsto complywiththe directions ofdrugmanufacturers.',
        'Whydodoctorsadvisepatientstotakemost drugsinthemorningorinthe evening?',
        'A)Considering drug-takingtimingwhenprescribing drugs forpatients.',
    ]
    for t in tests:
        print('\n  原: ' + t)
        print('  修: ' + restore_spaces(t, cost))
