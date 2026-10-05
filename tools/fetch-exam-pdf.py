"""
下载真题 PDF（只下含文字层的）。

实测规律：含文字层的试卷 PDF 约 130 KB，扫描件约 2 MB 且 extract_text() 返回空。
所以先用 GitHub API 拿文件大小，只下小于阈值的那些，省时间也省流量。

沙箱注意：curl -o 在这里会静默失败，所以统一用 urllib。
"""

import json
import os
import sqlite3
import sys
import urllib.request

BASE = 'https://raw.githubusercontent.com/ShepiTT/CET_practice_questions/main/data'
OUT = 'D:/WordMaster/tools/_raw/exam/pdf'
SIZE_LIMIT = 1100 * 1024          # 实测 900KB 左右仍有文字层，1.4MB 以上才是扫描件
os.makedirs(OUT, exist_ok=True)

# 1. 拿文件清单与大小
req = urllib.request.Request(
    'https://api.github.com/repos/ShepiTT/CET_practice_questions/git/trees/HEAD?recursive=1',
    headers={'User-Agent': 'Mozilla/5.0'},
)
tree = json.load(urllib.request.urlopen(req, timeout=60))
sizes = {t['path'].split('/')[-1][:-4]: t.get('size', 0)
         for t in tree['tree'] if t['path'].endswith('.pdf')}

db = sqlite3.connect('D:/WordMaster/data/wordmaster.db')
papers = [r[0] for r in db.execute('SELECT code FROM exam_papers ORDER BY code')]
db.close()

small = [p for p in papers if 0 < sizes.get(p, 0) < SIZE_LIMIT]
large = [p for p in papers if sizes.get(p, 0) >= SIZE_LIMIT]
print(f'题库共 {len(papers)} 套；小文件（含文字层）{len(small)} 套，扫描件 {len(large)} 套', flush=True)
print(f'预计下载 {sum(sizes[p] for p in small) / 1024 / 1024:.1f} MB\n', flush=True)

# 2. 逐个下载
done = 0
for i, code in enumerate(small, 1):
    dest = os.path.join(OUT, code + '.pdf')
    if os.path.exists(dest) and os.path.getsize(dest) > 10000:
        done += 1
        continue
    try:
        r = urllib.request.Request(f'{BASE}/{code}.pdf', headers={'User-Agent': 'Mozilla/5.0'})
        with urllib.request.urlopen(r, timeout=30) as resp:
            data = resp.read()
        with open(dest, 'wb') as f:
            f.write(data)
        done += 1
        print(f'  [{i}/{len(small)}] {code}  {len(data) // 1024} KB', flush=True)
    except Exception as e:
        print(f'  [{i}/{len(small)}] {code}  失败: {type(e).__name__} {e}', flush=True)

print(f'\n完成：已有 {done}/{len(small)} 个含文字层的 PDF', flush=True)
print('\n扫描件（无文字层，这些套卷的短文将保持整段显示）：', flush=True)
for c in large:
    print(f'  {c}  {sizes[c] // 1024} KB', flush=True)
