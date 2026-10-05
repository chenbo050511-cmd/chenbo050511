# WordMaster 下一步：逻辑修复 + 功能增量（决策文档）

> 本文件合并三轮独立结果：
> **A. 我的实测审计**（代码走查 + 对运行中实例的只读探测 + 只读 SQL 核对真实数据）
> **B. GitHub 同类项目调研**（抓到 README / 官方文档 / Anki 源码原文，非搜索摘要）
> **C. 独立深度审计**（逐行走查 + 隔离副本上的写操作试验，全程真实库零写入）
>
> 全程未修改任何业务代码，未对 `data/wordmaster.db` 写过任何东西。

---

## ⚠️ 首先修正我自己两处结论

审计 C 纠正了我两个判断，都记在这里，避免你按错的信息做决定：

### 修正 1：我说「同组题可能抽到重复词」是**误报**

审计用数据结构证明了不可能：`book_words` 的主键是 `(book_id, word_id)`，
出题 SQL 又限定在单本词库内 —— 所以**一组题里不可能出现同一个词两次**。
实测 `GROUP BY book_id, word_id HAVING COUNT(*)>1` = 0 条。

我原来把它列为 P2，**作废**。（`quiz.js` 里那条「同一组里可能出现重复的词」的注释也是多虑的。）

### 修正 2：翻卡「错词隔 3~5 张再考」**根本没生效**，比我以为的严重得多

我只发现了「连对 3 次是死代码」，但审计读出了更深的控制流问题
（`public/js/views/study.js:272-303` 的 `grade()` + `:350-362` 的 `paint()`）：

- 答「不认识」时 `state.cards.splice(state.idx + gap, 0, w)` 插回队列，
  但因为 `w._done` 为假，**`state.idx` 不前进 → 同一张卡立刻在原地再考一遍**
- 而插在后面那份**指向同一个对象**，等轮到它时它已经 `_done=true`，
  `paint()` **却从不跳过已过关的卡** → 再显示一次
- 实测呈现顺序变成：`A → A → B → C → D → A[已过关] → E`，`cards.length` 变 6（实际 5 个词）

**这不是边缘情况，是答错时的标准流程。** 后果：一个词被要求作答 3 次、
`unknown_count` 被多计（而它正是**顽固词阈值**和**复习队列排序**的输入）、
每多点一次就多一条流水。

顺带证实：`_repeats`（`study.js:154`）**从来没有 `+1` 过**，
所以 `:359-360` 和 `:396-397` 那两处「重复第 N 次 / 再考一次 / 连对 x/3」**永远不会渲染**。

---

## 第一部分：逻辑错误（合并三轮，按严重度重排）

严重度：**P0** 会永久/静默写坏数据 · **P1** 用户可见错误 · **P2** 轻微
· **✓** 查过没问题

### 🔴 P0-1 【新发现·最紧急】「恢复出厂设置」删掉了 `srs_v2` 迁移标记 → 下次重启把重置后的进度**再迁移一遍**

**这是审计 C 的发现，我认为它应该排在第一位。**

- `src/routes/settings.js:59-65`：`scope='all'` 执行 `DELETE FROM settings`，
  然后只重插 `DEFAULT_SETTINGS` —— 而 `DEFAULT_SETTINGS` **不含** `srs_v2`
- `src/db.js:347-352`：`migrateOnce('srs_v2')` 用 **settings 表里的一行**当「已跑过」标记
- `src/db.js:359-369`：srs_v2 的 UPDATE 把**旧 10 档阶段号**映射到新 6 档

于是「恢复出厂设置」顺手让系统**忘了这个库已经迁移过**。下次启动服务时
`migrateOnce('srs_v2')` 会把**新的 6 档阶段号当成旧 10 档**再平移一次：

```
迁移前:  stage 0,1,2,3,4,5   （间隔 1/3/7/15/30/60 天）
迁移后:  stage 0,0,0,0,1,1   ← stage5(60天) 变成 stage1(3天)
        而 due_at 不动
```

**触发条件几乎必然**：点「恢复出厂设置」→ 继续背单词 → **关掉窗口**（=停止服务）
→ 下次双击 `start.bat`（=重启）就中招。**而且没有任何提示。**

**实测现状（我核对过）**：
```
settings.srs_v2 = "1"          ← 标记还在，所以这个雷还没炸
stage 分布: 0→10, 1→75, 2→145, 3→99   ← 分布正常，没被二次迁移压过
```
**你目前是安全的，只要你没点过「恢复出厂设置」。**

**修复方向（几行）**：迁移标记不要放在用户可清的 `settings` 表里 —— 挪到 `meta` 表
（那张表本来就是放元信息的，而且现在的 `settings` 还会把 `srs_v2` 一起下发给前端，见 P2-4）。
或者在 `scope='all'` 里显式保留 `srs_v2`。

### 🔴 P0-2 给「还没学过的词」写笔记 / 收藏 / 标错题 / 暂缓 / **做一组测试** → 这个词**永久**从「学新词」队列消失

（这部分我已开始动手：`src/util.js` 已加好 `isUntouched()` / `isStarted()` 两个常量。
**但审计补充了两个我漏掉的入口，修法必须覆盖。**）

四个 `words.js` 接口用「先建后改」给未学的词建 progress 行
（`:281-286` note、`:309-314` mark、`:331-336` favorite、`:364-369` suspend），
而「学新词」判定是 `p.word_id IS NULL`（`study.js:125-130` 的 `newAvail`、
`study.js:243` 的取队列）。**多了一行 → 不再是新词 → 从学新词里消失。**

**审计实测（隔离副本，词 321 `reveal`，原本是 cet4 学新词队列第一个）**：
```
newAvail 3518 → POST /api/words/321/note → 3517，队列变成 322,323,324,325,326（321 消失）
浏览页 status=new 仍显示 3518   ← 浏览页还把它当"未学"
books.started 328→329、today.started 329→330   ← 累计学过又把它当"已学"
清空笔记 → newAvail 仍是 3517                  ← 坑留下了，清笔记不还原
```

**⚠️ 我漏掉的两个入口（审计补充）**：
1. **`POST /api/quiz/submit` 也会中招**。默认出题范围是「整个词库随机」（`scope='all'`），
   所以**做一组题就会给抽到的、从没学过的词建 progress 行** ——
   一次最多吞掉 `quiz_count`（默认 **10**）个新词。
2. 还有 P1-3 那条漏洞：quiz 提交能给 session 之外的**任意词**建行。

**这三处口径互相矛盾（审计实测）**：`未学筛选 3518` / `累计学过 +1` / `新词队列 -1`
—— 三处各说各话。真实库里**已经有 1 个**这种幽灵行（word `4958 staggering`，属 kaoyan）。

**可用的补救**：`POST /api/words/:id/reset` 会删掉那行、词就回到队列 ——
但要先知道是哪个词，用户侧没有批量入口。所以建议顺手提供一个小工具。

**修复方向**：
- 判定抽成共用常量（**我已加好 `util.js` 的 `isUntouched()`**），
  在 `study.js`(×2) + `words.js` 的 `status=new` + `started` + `stats` 的 `status.new` 共**五处**统一
- `started` / `percent` 用互补的 `isStarted()`
- 顺手把现有的幽灵词放回队列

### 🟠 P1-1 `/api/quiz/submit` 取不到 session 时退回「信前端」，而前端根本不发 `correct` → **全部判错并照常写库**

`src/routes/quiz.js:254-262` 的过渡分支 `correct = a.correct ? 1 : 0`，
但前端提交体只有 `{index, wordId, chosen}`（`quiz.js:293`）→ `a.correct` 是 `undefined` → **判错**。

而 session 是**内存态**（TTL 2 小时、上限 40 组、**服务重启就全丢**），正常使用就会丢。

**审计实测**：
```
POST {sessionId:"no-such-session", answers:[3题全错]} → 200, graded=legacy, right=0/3
POST {不带 sessionId, chosen:"bogus", correct:true}   → 200, correct=true, stage=1  ← 伪造仍被采信，且绕过限流
同一份伪造请求带上真 sessionId                          → correct=false  ← 只有这条退路是开的
```

**这直接让我上一轮「服务端判分」的结论打了折**：`README:90-93` 声称
「提交上来的对/错会被忽略」，但**这条路径上不成立**。

**修复**：session 取不到就**拒绝**（400/409 让前端重新出题），
彻底删掉 `a.correct` 这条退路。

### 🟠 P1-2 `/api/quiz/submit` 用请求里的 `wordId` 写库（只用 session 校验对错）→ 可给**任意词**写「答错 + stage0 + 明天到期」

`quiz.js:241-275`：判分用了 `expectedWordId`，但写库用的是请求里的 `wordId`，
不匹配时**只是 `correct=0`，照写不误**。

**审计实测**：一次请求就把一个从没学过的考研词（1168）
从 `progress=null` 变成 `{status:'learning', stage:0, due_at:明天, quiz_wrong:1, reps:1}` ——
既写坏了排期，又把它推进了 P0-2 的坑。

**修复**：`expectedWordId !== wordId` 时 `continue`（跳过，不写库）。

### 🟠 P1-3 前端永远只发 `phase:'legacy'` → 「今日已复习」**恒为 0**

`public/js/views/study.js:285` 固定传 `'legacy'`，全项目没有任何地方发 `first/repeat/pass`。
所以后端 `study.js:298-319` 的两个分支是死代码（我原本列为 P2-10，**审计证明它后果严重得多**）：

1. **`reviewed` 只统计 `mode='card_done'`**（`study.js:68-75`），
   而 legacy 分支写的是 `mode='card'`（`:349`）→ **`reviewed` 永远是 0**
2. 实测：一整批复习走完后 `counters.reviewed` 仍是 0；显式发一次 `phase:'pass'` 才变 1
3. 界面后果：今日页「复习 0 / 120」**永远不动**（`today.js:33-34,95,24`），
   完成度被拖住，「今日已达标」永不出现
4. **「重复作答不计入正确率」也失效**：legacy 每次作答都 `countStats:true`，
   实测重复作答让 `right/total` 从 3/3 变 4/4 —— 与 `README:246` 矛盾

### 🟠 P1-4 「模糊」的提示与落库**完全相反**

`study.js:273-275`：`isKnown || isVague → w._done = true`，`:289` 传 `true`
→ `:726` 显示绿色 **「✓ 已掌握」**；
但后端 `routes/study.js:334` 是 `firstRating === 'known' ? 'known' : 'unknown'`
→ 模糊走 **unknown**，`stage=0`、明天再来、`vague_count++`（**参与顽固词判定**）。

**同一次点击里，用户看到「已掌握」，落库的是「明天重来 + 记为错词」。**
（后端行为是符合 README 的，**前端提示错了**。）

### 🟠 P1-5 翻卡 keydown 监听从不移除 → **离开学习页后按 1/2/3 会真的提交一次作答**

`study.js:131-143` 每次 render 都挂一个新的 keydown，而 `:70` 的 `_cleanup`
**只上报时长、从不 `removeEventListener`**；`app.js:44-47` 切换视图时只调 `_cleanup`。
`state.flipped` 是模块级、离开时不重置 —— 所以「翻面后直接点返回」，
之后在**任何**页面按数字键，旧 handler 仍然活着 → **真的 POST `/api/study/answer`**
（改排期、写流水），还会在页面正中弹一个浮层。

**这是跨页面的意外数据写入**，修法两行。

### 🟠 P1-6 词库详情抽屉不随视图切换关闭（新页面被全屏遮罩压住）

`library.js:456-459` 导出了 `cleanup`，但 `app.js:44-47` **只调用 `_cleanup`**，
全项目没有任何地方调用 `Views[x].cleanup`；而 `library.js` **从不设置** `App._cleanup`。
抽屉与遮罩是 append 到 `document.body` 的（`z-index:100/101`），切路由不会被覆盖。

### 🟠 P1-7 统计页「各词库完成度」的待复习数**没排除已暂缓**

`src/routes/stats.js:240` 少了 `COALESCE(p.suspended,0)=0`
（`util.js:176-178`、`study.js:117-123`、`words.js:24` 都有）。
**审计实测**：`today.dueTotal=108` / `books.due=108` / **`stats/books.due=109`**。
这正好违反你 README:113-114 刚写下的承诺。真实库 suspended=0，所以还没显形。

### 🟠 P1-8 今日页与统计页的「累计正确率」是两套口径 → **同一份数据显示两个数**

- `routes/study.js:437-445`：`COUNT(*) FROM logs`（**含 `card_done`、`card_repeat`**）
- `routes/stats.js:35-41`：`WHERE mode IN ('card','quiz')`

**审计实测（真实库，两个接口同时在跑）**：
```
/api/study/today    global.accuracy = 96%   (1861/1933)
/api/stats/overview accuracy        = 94%   (1151/1220)
```
于是「今日」页磁贴显示 **96%**，统计页和错题本卡片显示 **94%**。
`totalReviews` 也一样（1933 vs 1220），两处都写成「共练习 N 次」。

### 🟡 P2（数量不少，多为「同一概念在多处各自实现」）

| # | 问题 | 位置 |
|---|---|---|
| P2-1 | `srs_v2` 只搬了 `stage` 没搬 `status` → 实测 **14 行** `status` 与 `statusOf()` 不符（如 `government` status=reviewing 但 stage=1） | `src/db.js:359-369` |
| P2-2 | `/api/stats/stages` 的 `status.new` = 词数 − progress 行数 → 四桶合计 **6157**，而 `word_total` 是 6158 | `stats.js:220` |
| P2-3 | `due_at` = 现在 + N×24 小时（不是「第 N 天」）→ 深夜学的词第二天白天不出现 | `src/srs.js:43-45` |
| P2-4 | `getSettings()` 把迁移标记 `srs_v2` 一起下发给前端 | `src/db.js:405-410` |
| P2-5 | 错题本/顽固词的 `total` 是「返回条数」而非真实总数（`?limit=1` 返回 `total:1`，徽标却是 8） | `quiz.js:357,392` |
| P2-6 | 按词重置进度只删 progress+logs、不动 `checkins` → 实测 `SUM(checkins.learned)=1243` vs logs 有效 1220，**差 23 条**永久不同步 | `words.js:382-385` |
| P2-7 | 两个**死设置**：`show_phonetic`、`auto_next` 全项目无读取点，开关按了没反应 | `settings.js:73-76` |
| P2-8 | `/quiz/mistakes/clear` 缺 `wordId` 时**清空全部错题**（`int(undefined,0,0)` → 0 走 else 全表 UPDATE），且无二次确认 | `quiz.js:397-415` |
| P2-9 | 每日练习量（logs）与热力图（checkins）两个数据源，同页面两个总量 | `stats.js:65-75` vs `:133` |
| P2-10 | 测试页文案仍是「**5 分钟后**重新出现」，实际最小间隔是 1 天 | `views/quiz.js:107,331` |
| P2-11 | 词库列表把已暂缓的词标成「待复习」（`due` 判定没看 `suspended`）→ 与「待复习」筛选矛盾 | `library.js:238` |
| P2-12 | 错题本「详情」按钮不打开该词详情（`data-id` 传了但不读，只 `go('#/library')`） | `mistakes.js:140-144` |
| P2-13 | 错题本卡片把 `wrong_words` 说成「选择题答错的词数」，实际含翻卡不认识+手动加入 | `mistakes.js:43-45` |
| P2-14 | 设置里「每日复习上限」说明与实现不符（队列其实完全不截断） | `settings.js:45-46` |
| P2-15 | 复习队列仍有 `safetyCap = 1000`，超过又会回到「说复习完了但徽标还有」 | `study.js:160,183` |
| P2-16 | 真题两处除零无守卫（**实测 `total=0` 记录为 0 条，纯理论**） | `exam.js:1085,1130` |
| P2-17 | quiz 每题挂一个 keydown、只移除最后一个（泄漏，但被 `state.locked` 挡住不会重复判分） | `views/quiz.js:230-235` |

### 🟡 P3

- **P3-1** `streak()` 的 `LIMIT 400`：`best` 只算最近 400 条打卡（跨月/跨年/闰日逻辑本身**核对过是对的**）
- **P3-2 时区**：只要**不改系统时区**，`dayStartIso` 与 `first_seen_at` 的比较无歧义、跨午夜也对。
  但改过时区后，已写入的 `logs.day` / `checkins` 会与读取时按当前时区重新归日的 `first_seen_at` 错位
- **P3-3** `/api/words` 搜索没转义 LIKE 通配符（搜 `_` 命中任意单字符、`%` 命中全部）
- **P3-4** README 自身数据矛盾（纯文档）：`:183` 写「70 组分好的段落」，`:382` 写「87 组 / 598 段」——
  **DB 实测 87 组 / 598 段，`:382` 对**；`:151` 写阅读 527 题，DB 实测 **528**（`:167` 的 `741/1077` 用的就是 528+549）

### ✓ 查过没问题的（三轮合计，省得再怀疑）

- **「到期」口径**：徽标 / 今日页 / 复习计划 / 队列长度 / 负载图 **全是 110**（除了 P1-7 那个统计页副本）
- 「已掌握」阈值三处一致（`srs.js:50`、`stats.js:199-203`、README:131），实测都是 0
- 阶段分布总数 = `progress` 行数（都是 329）；`streak()` 跨月/跨年/闰日成立
- **排期 UPSERT 不会冲掉笔记/收藏/标错题/暂缓**（`util.js:50-67` 的 `ON CONFLICT` 没列这些列）
- `db.transaction()` 没有嵌套；`logStudy(countStats:false)` 确实不进 checkins/正确率
- **真题判分**：分母是整组题数、未作答按错（实测空答=5 题全错）；`records/reset` 先删 answers 再删 attempts；题库侧答案全部合法、0 条「无解」题
- **划词标记**：key 按套卷 + 位置前缀，不会撞车；答题时选项不参与划线、交卷后才参与（与 README 一致）
- **同一组题不可能出现重复词**（`book_words` 主键 `(book_id, word_id)` + 单库查询）
- 派生值除零基本都有守卫

---

## 第二部分：功能增量（外部调研结论）

### ⭐ 一条重要的设计辩护（建议写进 README）

Anki 官方文档在 FSRS 章节的原话：

> **(Re)learning steps of 1 day or greater are not recommended when using FSRS……
> 我们建议把 learning steps 的数量保持在最低。有证据表明，在同一天内多次重复一张卡
> 对长期记忆没有显著贡献。**
> —— [Deck Options · Learning and Relearning Steps](https://docs.ankiweb.net/deck-options.html#learning-and-relearning-steps)

**所以「刻意不用同日内短间隔」不是落后，而是与 Anki 最新官方建议一致。**
建议主动引用这条来防御「你怎么不做 5 分钟/30 分钟」的质疑，
并说明「错词插回队列隔 3~5 张」是**轮内练习**、不是排期学习步骤，两者不冲突。

> 注意：P1-6 修完后，「轮内练习」才是真的成立（现在它其实没生效）。

### 候选功能（按「对背单词的价值」排序）

| # | 功能 | 外部证据 | 量 |
|---|---|---|---|
| **T1** | **拼写 / 听写题型** | 现有「翻卡 + 四选一」**两种都是再认**，拼写是**回忆**，提取练习的长期保持更高（[Test-enhanced Learning, APS](https://www.psychologicalscience.org/observer/test-enhanced-learning)）。**TTS 已内置，边际成本极低**。同类：qwerty-learner 整个项目建立在拼写输入上、TypeWords 有 Follow-along/**Dictation**/Self-test/**Spelling from memory**、cet-vocab 把拼写写进规划 | S/M |
| **T2** | **目标保持率 / 间隔三档可配** | Anki 称之为 FSRS 中**最重要的设置**；并给出数字：**保持率 85%→90% 要多花约 35% 复习量**（[Desired Retention](https://docs.ankiweb.net/deck-options.html#desired-retention) / [Interval Modifier](https://docs.ankiweb.net/deck-options.html#interval-modifier)） | S |
| **T3** | **间隔 fuzz（防扎堆）** | Anki 精确参数可抄（[fuzz.rs](https://github.com/ankitects/anki/blob/main/rslib/src/scheduler/states/fuzz.rs)）：<2.5 天不 fuzz；三段 factor **0.15/0.1/0.05**；7→[5,9]、17→[14,20]；**且有一条「不许让间隔倒退」的保护，必须一起抄**。「一批 5 个新词 + 词频连续 + 评分趋同」恰是高危场景 | S |
| **T4** | **「已掌握」一键豁免** | 与「暂缓」**语义相反**：豁免是**主动毕业**（word-memorizer：「永久不再复习」），暂缓是**顽固词止损**（[Anki leech](https://docs.ankiweb.net/leeches.html)） | S |
| **T5** | **新词上限 / 积压熔断 + 学习日边界** | Anki 给了后果与建议：「持续每天 20 张新卡 → 每天约 **200 张复习**」；「有积压时**建议停止引入新卡**」（[Daily Limits](https://docs.ankiweb.net/deck-options.html#daily-limits)）。学习日边界：Engram 支持「0 点或 5 点刷新学习日」 | S/M |
| **T6** | **导入能力（现在只有导出）** | 数据可迁移 = 抗锁定。word-memorizer 支持 txt/csv/json；cet-vocab 有 JSON 备份导入导出 | S/M |
| **T7** | **可提取性显式建模与排序** | word-memorizer 卖点：「按**预测遗忘概率**排序」。现在的 `error_score` 把「最容易忘」和「错了最多次」混为一谈 | M/L |
| **T8** | 队列级「今天别给我看，明天再说」（Anki Burying） | 生病/出差时很需要 | S |
| **T9** | 记录单卡作答时长 | Anki 有（含 60 秒上限防走开污染）（[Timers](https://docs.ankiweb.net/deck-options.html#timers)） | S |

### 算法层面：两处**零依赖**可改的实质提升

调研的核心判断：**WordMaster 现在不是「落后的 SM-2」，而是更简单的物种——
莱特纳式离散盒子 + 手工查表**（SM-2 至少有连续可变 ease factor，这里连这个都没有）。
但两条提升不需要任何依赖：

1. **fuzz（T3）** —— 约 15 行，消除扎堆。
2. **post-lapse 恢复更快** —— 现在「不认识 → 回 `stage 0`」是**硬归零**，
   问题不是惩罚太重，而是**丢弃了「这个词已经跟了我 30 天」这个信息**。
   Anki 文档引 SuperMemo 的警告说明**不该保留旧间隔**，但正确做法是
   **让 post-lapse 恢复更快**：已复习 5 次的词忘一次，重爬回 30 天应比新词快。
   只需在 `srs.schedule()` 里读 `reps`/`stage`，**仍是零依赖纯函数**。

> **关于「20–30% fewer reviews」**：来自 [ABC of FSRS](https://github.com/open-spaced-repetition/awesome-fsrs/wiki/ABC-of-FSRS)，
> **但官方自己标注「基于模拟结果」**；[官方 benchmark](https://github.com/open-spaced-repetition/srs-benchmark)
> **表里没有 SM-2 行**，所以**无法独立验证**。另有墨墨 KDD 2022 的 **12.6%**，但那是**另一个口径**，
> 两者不可互相印证。引用时**请保留这个限定**。

---

## 第三部分：明确**不建议**做的

| 看起来该加 | 为什么不该做 |
|---|---|
| 引入 `ts-fsrs` / `py-fsrs` / `fsrs-browser` 依赖 | **最容易被推荐、也最危险**。真正的优化器是 **Rust/WASM 原生绑定**；`fsrs-browser` 自己说 dev 构建训练 24,394 条日志要**好几天**。要用 FSRS 就**只 vendored 纯 JS 调度器，绝不引入优化器** |
| 云同步 / 账号 | 意味着你要跑常驻服务、负责账号与隐私 —— 是真正的工程投入，不是「顺手加」 |
| React / Vue / ECharts 重写前端 | qwerty-learner / TypeWords 是 React/Nuxt **网页优先**路线 —— **不同产品形态，不是更高级的形态**。会毁掉「14MB 零下载包 + 拷文件夹就能跑」 |
| Docker / MySQL / Postgres | 目标用户是「双击 `start.bat`」的个人用户；换掉 `node:sqlite` 就毁掉「拷文件夹就能跑」 |
| 为测试引入 Jest / Vitest | 用内置 `node:test` 即可 |
| 词根词缀 | 那是 word-memorizer 的**手工数据集**，**ECDICT 不含词根字段**；且是锦上添花，优先级低于 T1–T4 |
| 为「像 Anki」加回同日内 5/30 分钟 steps | Anki 官方**明确建议不要**，加回去是退步 |
| 把「已掌握」与「暂缓」合并 | 语义相反（毕业 vs 止损），合并会让两类词进同一个桶 |

> **战略提示（约束取消后已解锁）**：cet-vocab 如实写了「**完整 PWA 需要部署到 HTTPS**」。
> 现在你不再受「不联网」约束，**可以真正部署到 HTTPS**（GitHub Pages / Cloudflare Pages 等），
> 从而让 Service Worker 可用 —— 这条路之前是堵死的。

---

## 第四部分：建议的动手顺序（已按审计重排）

**先修会**静默写坏数据**的，再修用户可见的，最后加功能。**

| 顺序 | 项目 | 为什么排这里 | 量 |
|---|---|---|---|
| 1 | **P0-1 二次迁移压 stage** | **唯一会「自动、静默」写坏排期**的：点一次恢复出厂设置，之后每次重启都在继续破坏。改动几行（标记挪到 `meta` 表） | S |
| 2 | **P0-2 幽灵行吞新词**（**已动手**） | 我上一轮的功能放大了它；审计补充了 quiz 提交这个入口，**修法必须覆盖五处口径** | M |
| 3 | **P1-1 + P1-2 quiz 的两条写库漏洞** | 同一函数里几行。修完「服务端判分」这个故事才真正完整，`verify-quiz-grading.js` 也才测得到 | S |
| 4 | **P1-3 `phase:'legacy'` → `reviewed` 恒为 0** | 决定走哪条路：恢复三阶段协议，或删死分支+改 `reviewed` 口径。不修则今日页目标永远不动 | M |
| 5 | **P1-7 + P1-8**（暂缓多算一个 / 两个正确率） | 各几行，立刻消除两处用户可见矛盾 | S |
| 6 | **P1-4 + P1-6 一起**（「模糊」提示相反 + 重复插队 + 连对死代码） | 同一处控制流，一起改才自洽；顺带让「轮内练习」真正生效 | M |
| 7 | **P1-5 + P1-9**（keydown 跨页写入 / 抽屉不关） | 前者能防止意外写数据 | S |
| 8 | **P2-7 死设置 + P2-10「5 分钟后」** | 最便宜的两处「按了没反应 / 说错了」 | S |
| 9 | **T3 fuzz + T2 三档 + 「模糊」升 1 档** | 排期正确性的实质提升，仍全部零依赖 | S |
| 10 | **T1 拼写 / 听写** | 价值最高但改动最大，放地基稳之后 | M |
| 11 | **P2-1/2/3 数据一致性**（status 派生、状态桶、`due_at` 对齐自然日） | 会动存量数据，单独一次做并想好迁移 | M |


---

## 第一部分：逻辑错误

严重度：**P0** 会永久损坏学习流程 · **P1** 用户可见错误 · **P2** 轻微/边界
· **✓** 查过没问题（列出来省得再怀疑）

### 🔴 P0-1 给「还没学过的词」写笔记 / 收藏 / 暂缓，会让它永远进不了「学新词」队列

四个接口都用「先建后改」写法给未学的词建 progress 行（`src/routes/words.js`）：

```js
// :id/note —— favorite / mark / suspend 是同样的形状
INSERT INTO progress(word_id, status, stage, note) VALUES(?, 'new', 0, ?)
```

而「学新词」的筛选是 `WHERE p.word_id IS NULL`（**progress 里没有这一行**）。
所以只要给新词写一句笔记，它就多了一行 `status='new'`，**从此在「学新词」里彻底消失**；
`newAvail`（可学新词数）也会跟着变小。

**实测**（`tools/diagnose-ghost-progress.js`，只读）：

```
【幽灵行】有 progress 行但从未学过: 1
  样例: #4958 staggering   （kaoyan 词库，无任何标记、无任何 logs 流水）
状态分布之和 328  vs  overview.started 329   ← 差额正是这一行
```

**已经有一个考研词被永久堵住。** 当前带标记的幽灵行是 0，所以是我新加的笔记功能**尚未被触发**；
但用户只要**翻卡时在背面写个助记、还没点那三个反馈按钮**，这个词就再也不出现。

**修复方向（推荐 B）**
- **A** 前端兜底 —— 不解决根因，不推荐
- **B** 让「未学」不再依赖「有没有 progress 行」：条件改为
  `p.word_id IS NULL OR (p.status='new' AND p.reps=0 AND p.first_seen_at IS NULL)`，
  抽成共用常量（像现有 `isMistake()`）在 plan / today / words 三处一起用，
  并让 `overview.started` 的口径对齐（现在它把幽灵行也算「学过」，与状态分布差着幽灵行数量）
- **C** 不给未学的词建 progress 行（note/favorite/marked/suspended 挪独立表）—— 最干净但改动最大

> 这个坑**在加笔记之前就存在**（`/favorite`、`/mark` 早就是这个写法），笔记功能把它从
> 「点收藏才中招」放大成「写笔记就中招」。

### 🟠 P1-2 「恢复出厂设置」不清真题记录

`src/routes/settings.js:50-75` 三个分支都只动 `progress / logs / checkins / settings`，
**没有** `exam_attempts` / `exam_answers`。实测库里已有 `exam_attempts` 5 条、`exam_answers` 29 条。

后果：重置后单词进度全空，真题页的「做过几次 / 最好成绩 / 用时 / 题目错题」**原样还在**。

**修复**：`scope='all'` 补上两张表（`exam_answers` 有 `ON DELETE CASCADE`，显式删更清楚）；
可考虑给前端加一个独立的「只清真题记录」。

### 🟠 P1-3 `due_at` 是「N×24 小时后」，不是「第 N 天」

`src/srs.js` 的 `addMinutes()` = `Date.now() + minutes*60*1000`，「1 天」= 固定 1440 分钟。实测：

```
现在 2026-10-05 23:47 学一个新词，一遍过（跳 2 档 → 3 天）
  → 到期 = 2026-10-08 23:47     ← 72 小时后，而不是「10-08 00:00」
```

两个后果：① 第 3 天**整个白天**它都不在队列里，只有当晚 23:47 后才出现；
② 到期时刻 = 上次学习时刻，**复习时间会逐次往后漂**。

**修复方向**：算完 `due_at` 后向下取整到当天 00:00（改动最小）；
或引入可配「学习日边界」（见 T5）。
**注意**：改这个会让存量 `due_at` 最多提前 24 小时，到期量会在某天突增 —— 建议单独一次做并想好迁移。

### 🟠 P1-4 「连对 3 次」是死代码 —— 两轮审计独立复现

`public/js/views/study.js:272-281`：

```js
if (isKnown || isVague) { w._done = true; w._streak = 0; }   // 直接完成
else { w._streak = 0; ...插回队列 }                           // 只剩「不认识」，且清零
```

「模糊」和「认识」一样**立即过关**，所以 `_streak` 恒为 0 ——
`PASS_STREAK = 3`（`:23`）和界面 `连对 ${w._streak}/${PASS_STREAK}`（`:360`/`:397`）
**永远不会触发**。真实规则只是「不认识就重来，认识或模糊就过」。

### 🟠 P1-5 「模糊」与「认识」待遇完全相同 —— 丢掉了三档反馈的意义

这是上一个问题的**同一处根因**，但值得单列，因为它正好对应一条几乎免费的算法改进。

调研发现：三档反馈是同类项目 `BaiYingNing/Engram` 的核心设计；
FSRS 里 **Hard（≈模糊）对应更小的 stability 增长**。
而 WordMaster 现在「模糊」与「认识」都是「过关 + 跳 2 档」，
`vague_count` 只被用来算 `error_score`，**对排期没有任何影响**。

**修复（S 级）**：`srs.schedule()` 里让 `vague` → **间隔只升 1 档**（而不是跳 2 档），
同时把前端 `isVague` 从「立即过关」改成「入队、靠连对推进」。
**这一步同时修掉 P1-4，并让「模糊」这个按钮真正有意义。**

### 🟡 P2-6 真题模块完全独立

`src/routes/exam.js` 里**没有任何** `saveProgress` / `srs.` / `logStudy` / `progress` 引用。
做 1077 道真题答错一堆，**对单词排期毫无影响**，判断题也不进错题本、不进 `accuracy`。

这**可能是有意的**（模考不该打乱单词节奏）。若要打通，建议只把**答错的题对应的词**
加进错题本 / 提醒队列，而不是直接改 stage。

### 🟡 P2-7 `reps` 语义与注释、界面文案都不符

`src/db.js` 注释写「总复习次数」，界面写「已复习 N 次」，实测两者都不是：

```
effort     reps=8   card_done流水=2   全部流水=14
furniture  reps=8   card_done流水=1   全部流水=9
team       reps=7   card_done流水=1   全部流水=8
```

### 🟡 P2-8 两处正确率无除零保护

`public/js/views/exam.js:1085`、`:1130` 缺 `total ? ... : 0`（全项目其他地方都有）。
`total=0` 会显示 **`NaN%`**。**实测澄清**：库里 `total=0` 的记录是 0 条，
服务端也有 `if (!allQuestions.length) return 400`，所以**目前只是理论隐患**。

### 🟡 P2-9 `/quiz/submit` 同组内重复词会少算错误

出题 `ORDER BY RANDOM() LIMIT ?` **没去重**，提交循环里每项各写一次 `progress`，
同一词第二次会覆盖第一次的结果。概率低但存在。
**修复**：出题加 `GROUP BY w.id`，或提交时按 `wordId` 去重。

### 🟡 P2-10 `/api/study/answer` 有三分支是死代码

前端固定传 `'legacy'`（`study.js:285`：`API.answer(w.id, g, state.bookCode, 'legacy', w._first || g)`），
所以服务端 `phase === 'first'` / `'repeat'` / `'pass'` 三个分支**永远不会被执行**。
属于上一轮「先建后改」类重构的残留。建议删掉或让前端真正走新协议。

### ✓ 查过没问题的

- **「到期」的 5 个口径完全一致**：徽标 / 今日页 / 复习计划 / 队列长度 / 负载图**全是 110**
- 「已掌握」阈值一致（`srs.statusOf()` 与统计接口都是 `stage >= 4`）
- 阶段分布总数 = `overview.started`（都是 329）
- `streak()` 跨月/跨年/闰日都成立；枚举参数都有白名单校验，不会拼进 SQL
- 词库/题库数量与 README 一致：6158 词、164 组、1077 题、283 单元

---

## 第二部分：功能增量（外部调研结论）

### ⭐ 一条重要的设计辩护（建议写进 README）

调研抓到 Anki 官方文档在 FSRS 章节的原话：

> **(Re)learning steps of 1 day or greater are not recommended when using FSRS…… 我们建议把
> learning steps 的数量保持在最低。有证据表明，在同一天内多次重复一张卡对长期记忆
> 没有显著贡献。**
> —— [Deck Options · Learning and Relearning Steps](https://docs.ankiweb.net/deck-options.html#learning-and-relearning-steps)

**也就是说 WordMaster「刻意不用同日内短间隔」不仅站得住，而且与 Anki 最新官方建议一致。**
建议在 README 里主动引用这条来防御「你怎么不做 5 分钟/30 分钟」的质疑，
并说明「错词插回队列隔 3~5 张」是**轮内练习**、不是排期学习步骤，两者不冲突。

### 候选功能（按「对背单词的价值」排序）

| # | 功能 | 为什么值得做（外部证据） | 改动量 |
|---|---|---|---|
| **T1** | **拼写 / 听写题型** | 现在「翻卡 + 四选一」**两种都是再认（recognition）**，拼写是**回忆（recall）**，提取练习的长期保持更高（[Test-enhanced Learning, APS](https://www.psychologicalscience.org/observer/test-enhanced-learning)）。**TTS 已内置，边际成本极低**。同类：qwerty-learner 整个项目建立在拼写输入上（并在输错时强制重输，「避免错误的肌肉记忆」）、TypeWords 有 Follow-along/**Dictation**/Self-test/**Spelling from memory** 四种模式、cet-vocab 把「拼写练习」写进规划 | S/M |
| **T2** | **目标保持率 / 间隔三档可配** | Anki 称之为 FSRS 中**最重要的设置**：「更高的保持率导致更短间隔和更多复习；高于 90% 工作量增长很快」——[Desired Retention](https://docs.ankiweb.net/deck-options.html#desired-retention)。Anki 还给了纯小学数学的等价做法与数字：**保持率 85%→90% 要多花约 35% 复习量**（[Interval Modifier](https://docs.ankiweb.net/deck-options.html#interval-modifier)） | S |
| **T3** | **间隔 fuzz（防扎堆）** | Anki 有精确实现可抄，[fuzz.rs 源码](https://github.com/ankitects/anki/blob/main/rslib/src/scheduler/states/fuzz.rs)：<2.5 天不 fuzz；三段 factor **0.15 / 0.1 / 0.05**；7→[5,9]、17→[14,20]、37→[33,41]；**且有一条「不许让间隔倒退」的保护**（必须一起抄）。WordMaster 的「一批 5 个新词 + 词频连续 + 评分趋同」恰好是高危场景 | S |
| **T4** | **「已掌握」一键豁免** | 与「暂缓」**语义相反**：暂缓是顽固词止损（Anki leech 失败 8 次打标并 suspend，[Leeches](https://docs.ankiweb.net/leeches.html)），豁免是**主动毕业**。word-memorizer 把它当卖点：「标记后**永久不再复习**」；cet-vocab 有「开始前逐个弹单词，认识的直接移出待背」。6158 词里哪怕 200 个早会，每次复习都是纯浪费 | S |
| **T5** | **新词上限 / 积压熔断 + 学习日边界** | Anki 给了明确后果与建议：「持续每天 20 张新卡 → 每天约 **200 张复习**……有人头几天学几百张然后被压垮」；「有积压时**建议停止引入新卡**直到追上」——[Daily Limits](https://docs.ankiweb.net/deck-options.html#daily-limits)。学习日边界：Engram 已支持「每日 0 点或 5 点刷新学习日」 | S/M |
| **T6** | **导入能力（现在只有导出）** | 数据可迁移 = 抗锁定，对本地优先应用尤其重要。word-memorizer 支持 txt/csv/json 导入导出；cet-vocab 有 JSON 备份导入导出 | S/M |
| **T7** | **可提取性显式建模与排序** | word-memorizer 卖点：「复习队列按**预测遗忘概率**排序（最易忘的优先）」。WordMaster 现在的 `error_score` 把「最容易忘」和「已经错了最多次」混为一谈 | M/L |
| **T8** | 队列级「今天别给我看，明天再说」（Anki Burying） | 生病/出差一天时很需要 | S |
| **T9** | 记录单卡作答时长 | Anki 有（且有 60 秒上限防走开污染数据）——[Timers](https://docs.ankiweb.net/deck-options.html#timers) | S |

### 算法层面：两处**零依赖**可改的实质提升

调研的关键结论是：**WordMaster 现在不是「落后的 SM-2」，而是更简单的物种——莱特纳式离散盒子 + 手工查表**。
Anki 的 SM-2 至少有连续可变的 ease factor，这里连这个都没有。但有两条不需要任何依赖就能拿到的提升：

1. **fuzz（T3）** —— 约 15 行，消除扎堆。
2. **post-lapse 恢复更快** —— 现在「不认识 → 回到 stage 0」是**硬归零**，
   它的问题不是惩罚太重，而是**丢弃了「这个词已经跟了我 30 天」这个信息**。
   Anki 文档引 SuperMemo 的警告说明**不该保留旧间隔**，但正确做法是
   **让 post-lapse 的恢复速度更快**：已复习 5 次的词忘一次，重新爬回 30 天应该比新词快得多。
   只需在 `srs.schedule()` 里读 `reps` / `stage`，**仍是零依赖纯函数改动**。

> ⚠️ **一处需要澄清的判断（我一开始想错了，核对后修正）**
> 我原本担心：`src/srs.js` 的 `schedule()` 用 `status === 'new'` 判断新词，
> 而 P0-1 制造的幽灵行 `status` 正是 `'new'`，会不会把「写了笔记的未学词」
> 当成老词、起算点算错（`stage = -1` 被当成 `stage = 0`）？
>
> **核对源码 `src/srs.js:66` 后确认：不会。**
> ```js
> const isNew = !prev.status || prev.status === 'new';
> const stage = isNew ? -1 : Number(prev.stage ?? 0);
> ```
> 幽灵行的 `status` 是 `'new'`，所以 `isNew` 为真、`stage` 取 `-1`，
> **恰好和真正的全新词走同一条路径**。也就是说幽灵行在排期上表现得和「没学过」一致。
>
> 所以 **P0-1 的危害范围应精确表述为「该词在 UI 上消失、不再被推荐学习、统计数字对不上」**，
> 而**不包含**「排期起算点被污染」。修 P0-1 时不必额外处理这一项。

### 版本号、star 数类事实

调研员**明确声明**：查不到可靠版本号/下载量的就一律没写；文中未引用任何 star 数。
「FSRS 比 SM-2 少 20–30% 复习量」这个数字来自官方 wiki 自述，**且 wiki 自己标注「基于模拟结果」**；
官方 benchmark 表里**没有 SM-2 行**，所以该数字**无法独立验证**，引用时需保留这个限定。

---

## 第三部分：明确**不建议**做的（会破坏核心取舍）

| 看起来该加 | 为什么不该做 |
|---|---|
| 引入 `ts-fsrs` / `py-fsrs` / `fsrs-browser` 作为依赖 | **最容易被推荐、也最危险**。真正的优化器在 `@open-spaced-repetition/binding`，是 **Rust/WASM 原生绑定**；`fsrs-browser` 自己说 dev 构建训练 24,394 条日志要**好几天**。这会摧毁「14MB 零下载包、拷文件夹就能跑」。**要用 FSRS 就只 vendored 纯 JS 调度器，绝不引入优化器** |
| 云同步 / 账号系统 | 与「不联网、不上传」根本冲突。**替代**：导出/导入 JSON + 「按 `last_review` 新者胜」的合并策略；多设备走**局域网同步** |
| React / Vue / ECharts 重写前端 | 现在零依赖、手写 SVG、断网可用。qwerty-learner / TypeWords 是 React/Nuxt **网页优先**路线——它们是**不同产品形态，不是更高级的形态** |
| Docker / MySQL / Postgres | 目标用户是「双击 `start.bat`」的个人用户；换掉 `node:sqlite` 就毁掉「拷文件夹就能跑」 |
| 为测试引入 Jest / Vitest | 用内置 `node:test` 即可 |
| AI 生成助记 / AI 词法分析 | word-memorizer 的 AI 是**可选在线增强**，需 API key，与「完全离线」冲突。**而你已经有了「用户自己写助记」——自写联想收益更高、零依赖、零成本** |
| 词根词缀拆解 | 那是 word-memorizer 自带的**手工数据集**；**ECDICT 不含词根字段**。要做就得评估新数据源与许可，且它是「锦上添花」而非「影响排期正确性」，优先级应低于 T1–T4 |
| 为「像 Anki」加回同日内 5/30 分钟 steps | 见上文——Anki 官方在 FSRS 章节**明确建议不要**这样做。加回去是退步 |
| 把「已掌握」与「暂缓」合并成一个功能 | 语义相反（毕业 vs 止损），合并会让两类词进同一个桶，统计和恢复策略都会乱 |

### 一个战略级提示：PWA 的 HTTPS 障碍

cet-vocab 是网页版 PWA，但它如实写了：**「完整 PWA 体验（离线缓存 / 安装为 App）需要把页面部署到 HTTPS 地址」**。
对 WordMaster 意味着：**在「拷文件夹就能跑 + 局域网 HTTP」的形态下，
Service Worker 不可用（只有 localhost 例外）**，所以「PWA 让手机离线可用」这条路当前形态下走不通。
这是个需要提前知道的取舍，而不是可以顺手加的功能。

---

## 第四部分：建议的动手顺序

**先修正确性，再加功能。** 理由：P0-1 会**永久吞掉词**，P1-5 的修正会改变排期行为 ——
在这两件事定下来之前加新功能，等于在一个会变的地基上盖房子。

1. **P0-1 幽灵进度行**（唯一会永久损坏学习流程的；我的笔记功能放大了它）
   —— 修完先跑 `tools/diagnose-ghost-progress.js` 确认归零
2. **P1-4 + P1-5 一起修**：让「模糊」真正区别于「认识」（间隔只升 1 档 + 入队靠连对），
   同时消掉死代码。**这是「修 bug + 加功能」一步到位，且直击排期正确性**
3. **P1-2 出厂重置补真题表**（两行）
4. **T3 间隔 fuzz**（约 15 行，含「不许倒退」保护）
5. **P2-10 删掉三个死分支**（顺手清理）
6. **T2 间隔强度三档**（让用户自己承担「更严要花更多时间」）
7. **T1 拼写 / 听写题型** —— 价值最高但改动最大，建议放在地基稳了之后
8. **P1-3 `due_at` 对齐自然日** —— 会影响存量数据，单独一次做
9. 其余 P2 与 T4–T9 按兴趣
