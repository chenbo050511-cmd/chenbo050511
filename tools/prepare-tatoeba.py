"""
把 Tatoeba 的英文语料解压成「一行一句」的纯文本，给 build-phrases.js 用。

源文件是 TSV（id \t lang \t 句子），只留句子那一列。
bz2 解压用 Python 标准库（Node 不带 bz2）。

用法：python tools/prepare-tatoeba.py
"""

import bz2
import os
import time

SRC = 'D:/WordMaster/tools/_raw/tatoeba/eng.tsv.bz2'
DST = 'D:/WordMaster/tools/_raw/tatoeba/eng.txt'


def main():
    if not os.path.exists(SRC):
        print(f'找不到 {SRC}，先下载：')
        print('  https://downloads.tatoeba.org/exports/per_language/eng/eng_sentences.tsv.bz2')
        return
    if os.path.exists(DST) and os.path.getsize(DST) > 1_000_000:
        print(f'已存在 {DST}（{os.path.getsize(DST) / 1048576:.0f} MB），跳过')
        return

    print(f'解压 {os.path.basename(SRC)} …')
    t0 = time.time()
    n = 0
    with bz2.open(SRC, 'rt', encoding='utf-8', errors='ignore') as f, \
            open(DST, 'w', encoding='utf-8') as out:
        for line in f:
            parts = line.rstrip('\n').split('\t')
            if len(parts) < 3:
                continue
            text = parts[2].strip()
            if text:
                out.write(text + '\n')
                n += 1
    print(f'  写出 {n:,} 句 → {DST}')
    print(f'  大小 {os.path.getsize(DST) / 1048576:.0f} MB，用时 {time.time() - t0:.0f}s')


main()
