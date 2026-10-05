# WordMaster 逻辑审计（只报告，未改动任何代码）

> 审计方式：代码走查 + 对**运行中的实例**做只读探测 + 只读 SQL 核对真实数据。
> 全程没有对 `data/wordmaster.db` 执行任何写操作。
>
> 严重度：**P0** 会写坏数据 / 崩溃 · **P1** 用户可见的错误 · **P2** 轻微 / 边界
> · **P3** 可疑，需进一步确认 · **✓** 查过了，没问题（列出来省得再怀疑）

---

## P0-1 给「还没学过的词」写笔记 / 收藏 / 暂缓，会让它永远进不了「学新词」队列

**这是本次审计最严重的一条，而且是我上一轮给你加的笔记功能直接踩出来的。**

### 机制

四个接口都用同一套「先建后改」写法（`src/routes/words.js`）：

```js
// :id/note  (line ~330)
db.execute(
  `INSERT INTO progress(word_id, status, stage, note)
   VALUES(?, 'new', 0, ?)
   ON CONFLICT(word_id) DO UPDATE SET note = excluded.note`, [id, note]);
// :id/favorite / :id/mark / :id/suspend 是同样的形状
```

而「学新词」的筛选条件是 `src/routes/study.js`:

```sql
WHERE bw.book_id = ? AND p.word_id IS NULL
```

`p.word_id IS NULL` 的意思是「**progress 表里没有这个词的行**」。
所以：只要给一个没学过的词写了一句笔记，它就多了一行 `status='new'` 的 progress ——
于是它**不再是 new，也不再被当作「未学」**，从此在「学新词」里彻底消失。

`/api/study/plan` 的 `newAvail`（可学新词数）用同一条 SQL，所以数字也会跟着变小。

### 实测证据（只读）

`tools/diagnose-ghost-progress.js` 在你的真实数据里查到 **1 个**这种词：

```
【幽灵行】有 progress 行但从未学过: 1
  样例: #4958 staggering   （属于 kaoyan 词库，无收藏/无笔记/无暂缓、无任何 logs 流水）
状态分布之和 328  vs  overview.started 329   ← 差额正是这一行
```

也就是说：**已经有一个考研词被永久堵住了**，只是它恰好没带任何标记
（推测是「加入错题本又移除」留下的空行）。

### 为什么现在还没大面积爆发

我检查了当前数据：带 `favorite/marked/note/suspended` 任一标记的幽灵行是 **0 个**。
因为你刚拿到这个功能，还没在新词上写过笔记。
但 `PASS` 一下就会中招 —— 用户在「翻卡」时随手在卡片背面写个助记，
**如果他还没点过那三个反馈按钮**，这个词就再也不出现了。

### 附带影响：`started` 与状态分布对不上

`overview.started` 是 `COUNT(*) FROM progress`（把幽灵行也算「学过」），
而统计页的状态分布只统计 `learning / reviewing / mastered`（幽灵行是 `new`，不计）。
两者天然差着幽灵行的数量 → 现在差 1，以后会越差越多。

### 修复方向（三选一，我倾向 B）

- **A. 前端兜底**：不解决根因，新词写笔记仍会被吞。不推荐。
- **B. 让「未学」的判定不再依赖「有没有 progress 行」**（推荐）
  把「学新词」的条件从 `p.word_id IS NULL` 改成
  `p.word_id IS NULL OR (p.status='new' AND p.reps=0 AND p.first_seen_at IS NULL)`，
  并抽出成一个常量（像 `util.js` 里 `isMistake()` 那样）在 plan/today/words 三处共用，
  避免以后再次走偏。同时把 `started` 的统计口径也跟着对齐。
- **C. 不给未学的词建 progress 行**：把 note/favorite/marked/suspended 挪到独立小表。
  最干净，但要迁移数据、改动面大。

> 顺带一提：这个坑**在我加笔记功能之前就存在**（`/favorite` 和 `/mark` 早就是这个写法），
> 只是笔记功能把它从「点收藏才会中招」变成了「写笔记就会中招」，概率大幅上升。

---

## P1-2 「恢复出厂设置」不清真题记录，两套数据对不上

`src/routes/settings.js:50-75` 的三个分支都只动 `progress / logs / checkins / settings`，
**没有** `exam_attempts` / `exam_answers`。

实测你的库里已经有：`exam_attempts` 5 条、`exam_answers` 29 条。

后果：点了「恢复出厂设置」之后，单词进度全空，但真题页的
「做过几次 / 最好成绩 / 用时 / 题目错题本」**原样还在** ——
用户会以为没清干净。

**修复方向**：`scope='all'` 里补上两张表（`exam_answers` 有 `ON DELETE CASCADE`，
删 `exam_attempts` 会自动带走，但显式删更清楚）；
另外考虑给前端加一个独立的「只清真题记录」选项。

---

## P1-3 `due_at` 是「N×24 小时后」，不是「第 N 天」——复习时间会逐次往后漂

`src/srs.js` 的 `addMinutes()` 是 `Date.now() + minutes*60*1000`，
而 `INTERVALS` 里的「1 天」= 1440 分钟 = 固定 24 小时。实测：

```
现在 2026-10-05 23:47 学了一个新词，一遍过（跳 2 档 → 3 天）
  → 下次到期 = 2026-10-08 23:47     ← 72 小时之后
  而不是「2026-10-08 00:00」
```

两个后果：

1. **当天看不到该复习的词**：你晚上 23:47 学的词，第 3 天**整个白天**都不在队列里，
   只有当晚 23:47 之后才出现。如果你习惯白天复习，会感觉「明明到期了却没出现」。
2. **复习时刻单调后移**：每次到期时刻 = 上次学习的时刻，所以复习时间会一直往后漂，
   不会稳定在某个时段。

**这不是崩溃级错误**，README 里「刻意不用同日内短间隔」的取舍也正是为了避免
「当天反复到期」的观感 —— 但现在的实现把「日粒度」偷偷变成了「24 小时粒度」。

**修复方向**：
- **A（推荐，改动小）**：`schedule()` 算完 `due_at` 后**向下取整到当天 00:00**
  （或次日 00:00），确保任何时刻学完，「第 N 天」都是从那天的开始算。
- **B**：引入「学习日边界」设置（比如凌晨 4 点算前一天），解决熬夜学习归日的问题。
- 注意：改这个会让所有存量 `due_at` 提前最多 24 小时，
  到期量会在某天突然变大 —— 建议配合一次性迁移，或先只在**新建/新复习**的词上生效。

---

## P1-4 「连对 3 次」是死代码，界面上那行提示永远不会出现

`public/js/views/study.js`：

- `:9` 注释：错词「插回队列隔 3~5 张再考，**连对 3 次**才算过关」
- `:23` `const PASS_STREAK = 3;`
- `:360` / `:397` 界面会渲染 `连对 ${w._streak}/${PASS_STREAK}`

但实际逻辑（`:272-281`）：

```js
// 认识 / 模糊直接过关；不认识要连对 3 次
if (isKnown || isVague) { w._done = true; w._streak = 0; }   // ← 直接完成
else { w._streak = 0; ...插回队列 }                           // ← 只剩「不认识」，且清零
```

「模糊」和「认识」一样**立即过关**，所以 `else` 分支只有「不认识」，
而「不认识」又立刻把 `_streak` 清零 —— **`_streak` 恒为 0，
`PASS_STREAK` 与那两处 UI 提示都是永远不会触发的死代码**。

真实规则其实更简单：**不认识就重来，认识或模糊就过。**

**修复方向**：二选一，别维持现状（两套说法并存会被当成 bug）：
- 删掉 `PASS_STREAK` / `_streak` 和对应 UI，README 与注释改成真实规则；
- 或者真按注释实现（让「模糊」也入队、靠连对推进）。

---

## P1-5 `/quiz/submit` 同组内抽到重复词时会少算错误

`src/routes/quiz.js` 的提交循环对 `answers` 里每一项**各写一次** `progress`：

```js
for (...) { ... const prev = getProgress(wordId); const next = srs.schedule(prev, rating); saveProgress(...); }
```

出题是 `ORDER BY RANDOM() LIMIT ?`，**没有去重**，所以同一组里理论上可能出现同一个词两次。
这时第一次「答错」会被第二次的结果**覆盖**，`quiz_wrong` 只加了后一次的结果 —— 错误被少算。

概率低（题量 50、词库 3500+），但不是不可能。**建议**：出题 SQL 加 `GROUP BY w.id`
或提交时按 `wordId` 去重（保留第一次作答）。

---

## P2-6 真题模块完全独立，不进单词排期 / 错题本 / 正确率

`src/routes/exam.js` 里**没有任何** `saveProgress` / `srs.` / `logStudy` / `progress` 引用。
所以做完 1077 道真题、答错一堆，**对单词的复习排期毫无影响**，
判断题也不进「错题本」，`overview.accuracy` 也不含它们。

这可能是有意的（真题是「整卷模考」，不该打乱单词节奏），但值得你确认这是不是你要的。
如果要打通，注意别让一次模考把几十个词的 stage 打乱 —— 更合适的做法是
**只把答错的题对应的词加进错题本 / 提醒队列**，而不是直接改排期。

---

## P2-7 `reps` 的语义与注释、界面文案都不符

`src/db.js` 注释写的是「总复习次数」，界面写「已复习 N 次」，
但实测 `reps` 与 `card_done` 流水条数完全对不上：

```
effort     reps=8   card_done流水=2   全部流水=14
furniture  reps=8   card_done流水=1   全部流水=9
team       reps=7   card_done流水=1   全部流水=8
```

`reps` 实际是「答题流水累计」的量级（每次提交都 +1），既不是「复习次数」
也不是「过关次数」，所以「已复习 7 次」这句是**误导性文案**。
**建议**：要么改注释/文案让它名副其实，要么改成真正的「过关次数」。

---

## P2-8 两处正确率计算没有除零保护

全项目其他地方都写了 `total ? Math.round(...) : 0`，只有 `public/js/views/exam.js` 两处漏了：

- `:1085` `const acc = Math.round((a.right_count / a.total) * 100);`
- `:1130` `${Math.round(data.attempt.right_count * 100 / data.attempt.total)}`

`total = 0` 时会显示 **`NaN%`**。

**实测澄清**：我查了真实数据，`exam_attempts` 里 `total=0` 的条数是 **0**，
而且服务端 `exam.js` 有 `if (!allQuestions.length) return 400` 的守卫，
所以**当前只是理论隐患**。但加个守卫能和全项目保持一致，成本几乎为零。

---

## ✓ 查过没问题的（省得你再怀疑）

- **「到期」的 5 个口径完全一致**：侧边栏徽标 `books.due` = 今日页 `pools.dueTotal`
  = 复习计划 `dueNow` = `queue.length` = 负载图 `overdue` = **110**。
  上一轮修暂缓时把这条链路理顺了。
- **「已掌握」阈值一致**：`srs.statusOf()` 是 `stage >= 4`，
  统计接口 `mastered` 标记也是 `i >= 4`，两者计数吻合（当前都是 0）。
- **阶段分布总数 = `overview.started`**（都是 329）—— 这一条是好的。
- **`streak()` 的边界**：用本地日期字符串排序 + 逐日回退，跨月/跨年/闰日都成立
  （中国无夏令时，不存在 23/25 小时的天）。`LIMIT 400` 对个人使用足够。
- **枚举参数都有白名单**：`quiz` 的 `type`/`scope`、`words` 的 `status`/`sort`
  都用白名单校验，非法值会回退默认，不会拼进 SQL。
- **真词库/题库数量与 README 一致**：6158 词、164 组、1077 题、283 单元。

---

## 建议修复顺序

1. **P0-1** 幽灵进度行吞掉新词 —— 唯一会**永久损坏学习流程**的问题，
   而且我的笔记功能放大了它。改之前先跑 `tools/diagnose-ghost-progress.js` 看现状。
2. **P1-2** 恢复出厂不清真题 —— 用户点一次就会看到矛盾，改动只有两行。
3. **P1-4** 死代码/文案不符 —— 改动小，但会持续被当成 bug 怀疑。
4. **P1-3** `due_at` 对齐自然日 —— 体验问题，但**会影响存量数据**，
   建议单独一次做、并想好迁移策略。
5. **P1-5 / P2-6 / P2-7 / P2-8** —— 按兴趣挑。
