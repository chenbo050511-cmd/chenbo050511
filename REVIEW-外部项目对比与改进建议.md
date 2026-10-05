# WordMaster 外部对比评审 · 可改进项

> 评审方式：通读项目说明与全部源码（`server.js` / `src/**` / `public/js/**`），
> 检索 GitHub 上同类项目（FSRS 系、Anki 系、国内背单词桌面应用）作为参照，
> 并对关键结论**在本机做了实测验证**（使用数据库临时副本，真实数据未改动）。
>
> 结论分四档：**P0 缺陷**（会写坏数据 / 安全）· **P1 正确性**（用户可见的矛盾）·
> **P2 工程**（可维护性）· **P3 功能**（对标同类项目缺失的能力）。

---

## 一、先说结论：这个项目已经很强的地方

对照同类项目，WordMaster 有几处做得比大多数开源背单词项目好，**不要为了「像别人」而改掉**：

| 维度 | WordMaster | 同类项目常见情况 |
|---|---|---|
| 部署 | `tools/pack.js` 打出 14MB「零下载」包，连 `node_modules` 都带上 | 克隆 → `pip install` → 下载语料 → 建库，新手常在第一步失败 |
| 依赖 | 后端只有 express，SQLite 用 Node 22.5+ 内置 `node:sqlite` | 常需原生编译（better-sqlite3 / PyQt6 / 各种 wheel） |
| 前端 | 零依赖、手写 SVG 图表、离线可用 | 大量 CDN / React / ECharts，断网即白屏 |
| 数据质量 | OCR 粘连修复、从真题 PDF 还原分段、官方答案交叉校验、**每条规则都有踩坑记录** | 直接把 OCR 原文入库，正文里混着 `pastpapers.cn` 和页码 |
| 真题库 | 58 套 / 1077 题 + 逐题解析（69% 覆盖）+ 五色划线 | 多数项目只有词表，没有真题 |
| 文档 | README 记录了**每个坑的现象、原因、修法** | 通常只写「怎么跑」 |

也就是说，**最值得补的不是功能数量，而是「自检」与「学习算法」两块**——
恰好也是这个项目目前最薄的地方（没有测试，排期算法是手写固定表）。

---

## 二、P0 缺陷（建议优先修）

### P0-1 测试判分完全由前端决定 —— 已实测确认可以任意刷数据

**这是本次评审发现的最严重问题。**

`README.md:509` 写的是 `/api/quiz/submit` → `{bookCode, answers[]}`「**判分落库**」，
但服务端从来没有拿到过正确答案。

- 出题接口 `src/routes/quiz.js:117-134` 返回给前端时，**把答案一起发下去了**
  （`options` 里带 `correct: true`），同时**没有在服务端留下任何答案记录**
  （库里没有 quiz session 表，见 `src/db.js` 的 SCHEMA）。
- `src/routes/quiz.js:155` 直接采信前端传来的布尔值：

  ```js
  const correct = a.correct ? 1 : 0;        // ← 前端说对就是对
  const next = srs.schedule(prev, correct ? 'known' : 'unknown');
  ```

- 前端确实也是这么传的：`public/js/views/quiz.js:291`
  ```js
  answered.map((a) => ({ wordId: a.wordId, correct: a.correct }))
  ```

**实测**（数据库临时副本，非真实数据）：

```
提交 {wordId:1, correct:true}（并未提供任何作答内容）
→ 响应 right:1, accuracy:100%
→ progress: stage 3 → 5，status → mastered，
   due_at → 2026-12-04，quiz_right 1 → 2
```

一个不存在的「答案」被记为答对，并且**直接改写了艾宾浩斯排期**。

**为什么这比看起来更严重**：

1. **把 SRS 污染了**。排期是基于作答质量算的，前端可任意声明质量，
   等于整条学习曲线的输入不可信。答错的词会被标记成 `mastered` 推到 60 天后再也不出现。
2. **不是"只有自己用所以无所谓"**。服务端 `server.js:110` 监听 `0.0.0.0`，
   同一局域网内任何设备都能 POST 这个接口（见 P0-2）。
3. **注意这与 exam 是两套做法**。真题模块做对了，可以照抄：
   `src/routes/exam.js:231-232` 是**服务端比对答案**：
   ```js
   const chosen = chosenOf.get(q.id) || '';
   const ok = chosen && chosen === q.answer ? 1 : 0;
   ```
   exam 甚至额外处理了「未作答按错计分」（`:194-196`）。quiz 缺的正是这一步。

**修法（三选一，按改动量排序）**：

- **A. 最省事**：提交时改传**选项 id 而不是布尔**，服务端重新校验
  （`quiz` 出题时把每个选项的 `wordId` 也带上，服务端判断 `chosen === q.wordId`）。
  仍需服务端能重建题目 → 见 B/C。
- **B. 推荐**：出题时把答案写进 `quiz_sessions` 表（id / word_id / 正确答案 / 过期时间），
  提交时按 session 比对。顺带能解决「刷新页面重做同一题」和「重复提交刷分」。
- **C. 轻量**：出题时签发 HMAC token（`wordId + answer + 时间戳`），提交时验签。
  不落库，但需要密钥（可存 `settings`）。

> 无论选哪种，`/quiz/submit` 都应加**幂等/限速**，避免脚本循环提交把打卡和流水刷满。

---

### P0-2 监听 `0.0.0.0` 且无任何认证，与「数据不出本机」的承诺不一致

- `server.js:110`：`app.listen(port, '0.0.0.0')` —— 绑定**所有网卡**，
  同一 WiFi 下的手机、同宿舍的电脑都能访问 `http://<你的内网IP>:3000`。
- 界面却写着「本地运行 · 数据不出本机」（`public/index.html:84`），
  README 开头也强调「不联网、不上传」。
- 所有接口**没有任何认证**，且 `POST /api/settings/reset`（`src/routes/settings.js:50`）
  可以**清空全部学习数据**——`{scope:'all'}` 连设置一起恢复出厂。

咖啡厅 / 校园 WiFi 下这就等于把「清空我的学习记录」按钮挂到局域网上。

**修法**：

- 默认改成 `app.listen(port, '127.0.0.1')`；确实需要手机访问时，
  用 `HOST=0.0.0.0` 显式打开，并在控制台打印醒目警告。
- 若要保留局域网访问，加一个启动时随机生成的 token：
  首次访问带 `?k=<token>`，服务端校验后种 cookie。工作量不大，能挡住绝大多数场景。
- 顺带给**破坏性接口**加二次校验（现仅靠前端 confirm，`curl` 可直接绕）。

---

## 三、P1 正确性（用户可见的自相矛盾）

### P1-1 统计页的阶段标签**还停留在迁移前的 10 档表**

排期模型已经从「10 档含 5 分钟/30 分钟/12 小时」改成「6 档日粒度」，
`src/srs.js:18-25` 和 README:195 都改过来了，**但统计页没跟着改**：

```js
// public/js/views/stats.js:7
const STAGE_LABEL = ['5 分钟','30 分钟','12 小时','1 天','2 天','4 天','7 天','15 天','30 天','60 天'];
```

现在的真实映射是 `0→1天, 1→3天, 2→7天, 3→15天, 4→30天, 5→60天`。造成：

- 一个**刚学完、明天复习**（stage 0）的词，统计页显示成 **「5 分钟」**；
- stage 1 显示「30 分钟」，实际是 **3 天**；
- **和翻卡页直接冲突**：翻卡页用 `srs.humanInterval()` 显示正确文案
  （`src/routes/study.js:341`），同一个词在两个页面显示两个数字。

同时 `src/routes/stats.js:188` 硬编码输出 `stage 0..9`，而 6 档模型只用 `0..5`，
于是多出 4 行**永远是 0 的空柱子**（标签还是「7 天/15 天/30 天/60 天」）。

`STAGE_COLOR`（`stats.js:9-14`）也没跟上：`s <= 5 → accent`，`return 'var(--ok)'` 那条**永远不会命中**
（stage 最大 5），所以「已掌握」反而拿不到绿色。

**修法**：让统计页的标签**从服务端来**，别再手抄一份。
`src/srs.js` 已经导出 `INTERVALS` / `MAX_STAGE` / `humanInterval`，
在 `/api/stats/stages` 里一并返回 `labels`，前端直接用；
`for (let i = 0; i <= 9; i++)` 改成 `MAX_STAGE`。这类「同一份事实抄两处」的问题是复发性的，
建议顺手全局搜一遍还有没有别的硬编码副本。

### P1-2 README 自相矛盾：同一份文档里有两套间隔表

- README **195 行**：「间隔表是**日粒度 6 档** —— `1天→3天→7天→15天→30天→60天`」
- README **94-98 行**：仍然写着「`src/srs.js` 里是一张 **10 级**间隔表……
  `5min → 30min → 12h → 1d → 2d → 4d → 7d → 15d → 30d → 60d`」

后者是迁移前的旧描述。**而 P1-1 的 bug 正是这段陈旧描述的真实后果**——
文档没跟着代码改，前端也没跟着改。

### P1-3 移动端朗读走一个未公开的 Google 接口，与「离线、不联网」冲突

`public/js/ui.js:102-124`：在移动端（`max-width:860px` 或移动 UA）**默认绕过
`speechSynthesis`**，改用：

```
https://translate.google.com/translate_tts?...&client=tw-ob
```

三个问题：

1. **隐私**：每个要朗读的单词都会发到 Google。这直接违反首页那句
   「本地运行 · 数据不出本机」和 README 的「不联网、不上传」。
2. **可靠性**：这是**未公开、无文档的接口**，Google 历来会封禁和限流，
   社区一直有相关报告（[SO: Google Translate TTS API blocked](https://stackoverflow.com/questions/32053442/google-translate-tts-api-blocked/49787284)）。
   一旦被限流，移动端就「点了没声音」，而这是默认可用的主路径。
   更糟的是**失败时没有回退**：`onerror` 只调 `opts.onBlocked`，
   **不会退回 `speechSynthesis`**（`:114-119`）。
3. **CORS/协议风险**：用 `<audio>` 直连第三方域，不受 CSP 保护，
   也依赖 `client=tw-ob` 这个随时可能失效的参数。

**修法**：把 `speechSynthesis` 作为**首选**，仅在它确实不出声时才**可选**回退到网络 TTS，
并且回退要在设置里显式开关（默认关），标注「会联网，单词会发送到第三方」。
至少要在 `audio.onerror` 里真的退回去。

### P1-4 「连对 3 次」只决定是否出队，对排期完全无影响

`public/js/views/study.js:9, 23`：错词要**连对 3 次**才算过关。

但 `src/routes/study.js:304` 排期只看**第一次**作答：

```js
const effective = firstRating === 'known' ? 'known' : 'unknown';
const next = srs.schedule(prev, effective);
```

于是「第一次不认识、之后连对」和「第一次不认识、再没答对过」
拿到的**下次复习时间完全一样**（都是明天）。

前端每次作答都调 `API.answer(..., 'legacy', w._first || g)`（`study.js:285`），
即走服务端的 `legacy` 分支（`src/routes/study.js:291` 之后），
**每次都重新排期**，而排期依据始终是 `firstRating = w._first`（第一次的判断），
所以重复作答只改 `reps`，**不改变最终结果**。

这是**刻意设计**（注释解释了「重复到会了不该白费」），但它意味着：
同一次会话里的重复作答**不产生任何记忆强度收益**，纯粹是「出队条件」。
认知科学上，成功的**提取练习（retrieval practice）**本身有促记效果，
把重复作答完全丢弃是很可惜的信息浪费。

**建议**（不推翻现有设计）：允许重复作答**在第一次是 known 时提供轻微加成**，
例如第一次 known + 当轮还有 known → 间隔额外 +1 档（带上限）。
或者退一步，至少把「首次 unknown 但后续答对」与「首次 unknown 且始终没答对」区分开，
前者下次间隔 ≠ 后者。改动集中在 `srs.schedule()`，不影响数据结构。

### P1-5 过关规则里「模糊」的分支实际是死代码

`public/js/views/study.js:272-281`：

```js
// 认识 / 模糊直接过关；不认识要连对 3 次
if (isKnown || isVague) {
  w._done = true;
  w._streak = 0;
} else {            // 只剩「不认识」
  w._streak = 0;    // 不认识清零
  ...插回队列
}
```

因为**模糊与认识一样直接过关**，`else` 分支只剩「不认识」，
而「不认识」又立刻把 `_streak` 清零并重新入队。
所以 `PASS_STREAK = 3`（`:23`）实际上**永远不会累积到 3**——
`_streak` 只可能是 0，界面上「连对 1/3」「连对 2/3」这类提示（`:360`）也就不会出现。

README:194「连对 3 次才算过关」与代码行为不一致：
实际规则是「**不认识就重来，认识或模糊就过**」，没有「连对」这回事。
（`P1-4` 里提到「重复作答不影响排期」也是在同一个地方——
`:285` 传的是 `'legacy'` + 客户端 `firstRating`，所以重复作答确实只记流水。）

**修法**：要么把 `_streak` 逻辑真正接上（让模糊也入队、靠连对推进），
要么删掉 `PASS_STREAK` / `_streak` 和对应 UI，并修正 README。
**现状是"两套说法并存"，读者会以为是 bug。**

### P1-6 `reps` 字段语义与注释不符

`src/db.js:170` 注释是「总复习次数」，但 `src/routes/study.js` 里
`next.reps = prev.reps + 1` 只在**过关时**执行一次，
所以 `reps` 实际是「**过关次数**」。`stats` 和前台都按「复习次数」展示。
要么改注释，要么把「作答次数」单独记一个字段——现在想统计「这个词我一共看了几遍」是做不到的
（`logs` 里有，但需要 join）。

---

## 四、P2 工程问题

### P2-1 完全没有版本控制

`D:\WordMaster` 下**没有 `.git`**（已确认）。仓库里还放了 `.gitignore`
（`node_modules/`、`data/*.db`、`tools/_raw/`），说明本来就打算用 Git，只是没初始化。

对一个有 37 个工具的脚本库 + 大量 OCR 清洗规则的项目来说，这是最大的工程风险：
**任何一次误操作都不可回滚**。而项目自己其实已经意识到这点——
`data/` 里堆了 4 个手工备份：

```
wordmaster.db.before-extra / .before-rollback / .before-srs2 / .before-test-cleanup
```

共约 **45MB**。也就是说「没有版本控制」的代价已经在用**手工复制整库**来偿还了。

**建议**：`git init` + 首次提交。`.gitignore` 已就绪，
数据库和 `_raw/` 不进仓库，正好。这一步成本极低、收益最大。

### P2-2 没有任何测试，也没有 CI

`package.json` 里 `"check": "node tools/check-frontend.js"`，
但那是个**静态引用检查**（检查前端调用的函数是否存在），不是测试。
没有 `*.test.js`、没有 `.github/workflows`。

这个项目的**真正难点全在数据清洗**（`clean-exam-text.py` 的 74 个 `NEVER_SPLIT` 人工白名单、
`extract-paragraphs.py` 的 7 步还原、`fix-spacing.py` 的最小代价分词）。
这些恰恰是最需要回归测试的地方——**规则改一行，可能悄悄改坏 58 套卷子里的几十处文本**，
而 README 自己也说「会静默产生错数据，只能靠校验发现」。

**建议**：不需要引入测试框架（保持零依赖），
用 Node 内置 `node:test` + `node:assert` 写在 `tools/test-*.js` 里即可。
优先补三个：

1. **`srs.schedule()` 的表驱动测试**（各阶段 × 各 rating → 期望 stage/due_at）。
   这是纯函数，最容易测，价值最高——P1-1 这类 bug 会被立刻抓住。
2. **清洗规则的不变量测试**：拿现有库跑一遍 `check-paragraphs.py` 的不变量
   （按顺序可定位、段尾是句末标点、拼接覆盖全文），断言「问题数 ≤ 已知基线」。
3. **API 冒烟测试**：`/api/quiz/submit` 改完之后，
   加一条「提交错误答案 → 必须记为 wrong」的断言（正好把 P0-1 钉死）。

### P2-3 每条 SQL 都重新 prepare，批次操作是 N+1

`src/db.js:43-54`：

```js
function query(sql, params = []) { return db.prepare(sql).all(...); }
function execute(sql, params = []) { return db.prepare(sql).run(...); }
```

每次调用都 `prepare()`。`node:sqlite` 没有 Anki/better-sqlite3 那种自动缓存，
所以这是**每次查询都重新编译 SQL**。

在热路径上更明显的是 **N+1**：

- `src/util.js:75` `saveProgress()` 每个词先 `SELECT first_seen_at` 再 UPSERT；
- `src/routes/quiz.js:150-177` 在事务循环里，**每题**做
  `SELECT words` + `SELECT progress` + `saveProgress`（内含 SELECT）→ 每词 ~4 条 SQL；
  一次 50 题的测试就是 ~200 条。

本地单用户、6000 词的量级下**目前不会卡**，所以这是「规模化的隐患」而非当前的 bug。
**建议**：在 `db.js` 里加一个 `Map<sql, stmt>` 语句缓存（约 10 行），
并把 `saveProgress` 的「查 first_seen_at」改成 UPSERT 里用
`first_seen_at = COALESCE(progress.first_seen_at, excluded.first_seen_at)`，直接省掉一次查询。

### P2-4 CSV 导出：日志导出没做转义，且没有防公式注入

`src/routes/settings.js:105-108` 的进度导出有正确的 `esc()`（引号包裹 + 双写引号），
但 **`:133-144` 的日志导出没有**，直接 `join(',')`：

```js
lines.push([r.day, r.created_at, r.spelling, r.mode, r.rating, r.correct ? '是':'否', r.book_code].join(','));
```

单词释义/拼写里一旦含逗号或引号就会**串列**。当前词表里单词拼写不会有逗号，
但这些字段来自 OCR 清洗过的数据，风险不为零。

另外两个导出都**没有防 CSV 公式注入**：以 `=` `+` `-` `@` 开头的单元格
在 Excel 里会被当公式执行。数据源是外部 OCR 文本，属于不可信输入。
**建议**：两个导出共用一个 helper，并对危险前缀加 `'` 或前置空格。

### P2-5 备份没有轮转，`data/` 会越堆越大

现在 4 个 `.before-*` 快照共 ~45MB，且**没有清理机制**。
`src/db.js` 也没有任何数据库备份 API——备份全靠各脚本自己 `copyFileSync`。
**建议**：写一个 `tools/backup.js`，保留最近 N 份、按时间戳命名、自动删旧，
并让 `clean-exam-text.py` 之类的脚本统一调用它。顺带能省下几十 MB。

### P2-6 迁移机制过于简陋，散落的「一次性脚本」在改生产库

`src/db.js:341` 的 `migrateOnce(key, fn)` 只记「跑过没有」，
**没有版本号、没有顺序保证、不能回滚**。数据量小的时候没问题，
但加上 P2-1（无 Git），一旦某次迁移写错就是不可逆的。

同时根目录躺着 `_fix_text.js`：一个**硬编码了具体行 id 的一次性修数脚本**
（`exam_paragraphs.id = 178/185/207` 的字符串替换），直接连 `data/wordmaster.db`。
这类脚本一旦重跑或换库就会静默失效/误改。

**建议**：把一次性修数逻辑统一收进 `tools/`，命名带日期或迁移 key，
并且**先备份、再预演、加 `--write` 才落库**——这正是项目自己在
`clean-exam-text.py` 里已经确立的规范（README:456-458），
`_fix_text.js` 应该遵守同一套。

---

## 五、P3 对标同类项目，缺失的能力

参照项目：

- [wenki2005/word-memorizer](https://github.com/wenki2005/word-memorizer) —— Python + PyQt6 + SQLite，
  **FSRS 算法**、按预测遗忘概率排序、**词根词缀拆解**、AI 辅助记忆、
  四档标记（含「已掌握」**永久豁免**）、**断点续背**、多主题
- [BaiYingNing/Engram](https://github.com/BaiYingNing/Engram) —— 间隔重复记忆系统
- [1103ph/cet-vocab](https://github.com/1103ph/cet-vocab) —— 四六级词库
- [open-spaced-repetition/fsrs-browser](https://www.npmjs.com/package/fsrs-browser) —— FSRS 的浏览器实现
- [Anki 手册 · Leeches](https://docs.ankiweb.net/leeches.html) —— 顽固词的官方处理方式

### P3-1 没有「顽固词 / leech」机制（建议优先）

Anki 的做法（[官方文档](https://docs.ankiweb.net/leeches.html)）：
一张卡**失败 8 次**就打上 leech 标签并**暂停**，之后每 4 次再警告一次。
理由说得很直白：这类卡「占用你远多于其他卡的时间」。

WordMaster 现在**恰好相反**：`src/routes/study.js:166-180` 把老是错的词
**排到队列最前面**（`error_score` 加权），所以最该被处理的顽固词会**每次都来**。
`unknown_count` / `quiz_wrong` 数据**已经齐了**，只差判定和动作。

**建议**（成本很低，收益很直接）：

- 增加 `leech` 判定：`unknown_count >= 6`（或可配）→ 打标；
- 在「错题本」里单开一块「顽固词」，给三个动作：
  **暂缓（suspend）** / **改记忆法（加笔记）** / **放弃（不再排入）**；
- 暂停的词不再进复习队列，但保留在列表里可随时恢复。

现在这些词只会无限循环占用你的时间，而项目已经采到了判断所需的全部信号。

### P3-2 复习模式没有「目标记忆保持率」

FSRS 系项目的核心卖点是可以设定期望保持率（如 90%），
算法再据此解出每个词的间隔。WordMaster 是**所有人共用一张固定表**
（`src/srs.js:18-25`），无法随个人记忆水平自适应。

**但这里要提醒**：真正接入 FSRS 需要 `fsrs.js` / `fsrs-browser` 这类 npm 依赖，
**与项目「后端只有 express、前端零依赖」的明确取舍冲突**。
所以我的建议是**不引入 FSRS**，改为：

- 保留固定表，但把它**变成可配置的曲线**（给设置页加一个「复习强度」三档，
  宽松/标准/严格，各自一套 `INTERVALS`）——零依赖、可解释、够用；
- 如果你愿意接受**一个纯 JS 文件**（FSRS 的公式本身不大，可以 vendored 进 `src/`，
  不走 npm），那才是真正的自适应。这是**取舍题，不是必须项**。

### P3-3 缺练习型态：拼写 / 听写

现在只有「翻卡」和「四选一」。同类项目普遍有**拼写输入**和**听写**。
四选一是**再认（recognition）**，拼写是**回忆（recall）**，
后者的记忆强度收益明显更高，而且项目**已经内置了 TTS**，做听写几乎没有额外成本。

**建议**：加第三种模式「拼写」——播放发音 + 中文释义 → 输入英文 → 校验。
后端只需一个「按 wordId 校验拼写」的接口（顺便注意：这个接口要**服务端比对**，
别重犯 P0-1）。

### P3-4 不是 PWA，手机上没有「加到主屏」

`public/index.html` 已经有 `apple-mobile-web-app-capable`、
`viewport-fit=cover`、内联 data-URI 图标、`mobile.css`、`mobile.js`，
明显已经为移动端做了不少工作，**但缺 `manifest.json` 和 service worker**，
所以不能「添加到主屏幕」独立运行，断网也打不开。

**建议**：加 `manifest.webmanifest` + 一个极简 service worker
（静态资源 cache-first、`/api` 一律 network-only）。
这能让手机体验接近原生 App，而且**完全符合本地优先的定位**。
注意 SW 与 `Cache-Control: no-cache`（`server.js:61`）的策略要协调好，
否则开发时会看到旧界面——建议 SW 只在生产路径启用。

### P3-5 词形还原只对「点词查义」有效，规则也很简陋

`src/routes/words.js:126-132` 的 `FORM_FALLBACK` 是正则回退：

```js
[/ies$/, 'y'], [/ied$/, 'y'], [/ying$/, 'ie'], [/es$/, ''], [/s$/, ''],
[/ing$/, ''], [/ing$/, 'e'], [/ed$/, ''], [/ed$/, 'e'], [/d$/, ''],
[/er$/, ''], [/est$/, ''],
```

没有不规则动词（`went` / `bought` / `children`）、没有规则顺序的冲突处理
（`studies` 会先命中 `ies→y`，还好；但 `used` 会先命中 `ed→''` 得到 `us`，
查不到再继续——顺序靠列表位置，脆弱）。

更值得注意的是：**`words` 表里本来就有 `exchange` 字段**
（词形变化，`src/db.js:106`，由 `build-dict.js` 从 ECDICT 的 `d:`/`p:` 解析来的）。
**建议**：用 `exchange` 建一张 (变形 → 原形) 的反查表，
比 12 条正则可靠得多，也是数据驱动而非手写规则。

### P3-6 词根词缀 / 助记笔记（同类项目的差异化功能）

word-memorizer 有**词根词缀拆解**和 AI 辅助记忆。WordMaster 卡片背面已有
音标 / 释义 / 搭配 / 真题例句 / 词形变化 / 英文释义，信息量其实更足，
但**没有词根词缀**，也**没有让用户自己写助记笔记的地方**。

**建议**：前者依赖外部词根数据源（要评估体积，且 ECDICT 不含词根），
优先级不高；**后者成本极低**——给 `progress` 加一列 `note TEXT`，
卡片背面加一个文本框。用户自己写的联想是最有效的记忆手段之一，
而且完全离线、零依赖。

---

## 六、明确「不建议做」的事（避免破坏现有取舍）

评审外部项目时，有几条**看着很香但会伤害这个项目**，特别标出来：

| 建议 | 为什么不该做 |
|---|---|
| 引入 FSRS 的 npm 包 | 项目核心卖点就是「无原生依赖、拷贝即跑」。要 FSRS 就 vendored 一个纯 JS 文件，别加依赖 |
| 加 React / Vue 重写前端 | 现在零依赖、离线可用、手写 SVG。重写会毁掉「断网能用」和 14MB 部署包 |
| 加云同步 / 账号系统 | 与「不联网、不上传」的根本定位冲突。要做就做**局域网同步或导出文件** |
| 引入 MySQL / Postgres | `node:sqlite` 是「换机器拷文件夹就能跑」的前提 |
| 为了测试引入 Jest/Vitest | 用内置 `node:test` 就够，别新增依赖树 |
| 加 Docker | 目标用户是「双击 start.bat」的个人用户；Docker 反而提高门槛 |

---

## 七、建议的动手顺序

按「收益 ÷ 成本」排序：

1. **`git init` 并首次提交** —— 5 分钟，从此一切可回滚（P2-1）
2. **修 `/api/quiz/submit` 判分**（P0-1）—— 先加 session 表 + 服务端比对，
   顺手加一条回归断言。这是唯一会**写坏学习数据**的缺陷
3. **改 `app.listen` 为 `127.0.0.1`**（P0-2）—— 一行，消除局域网暴露
4. **修统计页阶段标签**（P1-1）—— 标签改为服务端下发，消除与翻卡页的矛盾；
   同时清理 README 的两套间隔表（P1-2）
5. **给移动端 TTS 加回退 + 开关**（P1-3）—— 保住「不联网」承诺
6. **加 `tools/test-srs.js`**（P2-2）—— 用 `node:test` 覆盖排期表，
   以后改算法有安全网
7. **顽固词（leech）机制**（P3-1）—— 数据已齐，只差判定和暂停动作
8. 其余 P2/P3 按兴趣挑

---

## 附：本次评审的证据来源

**本机实测**（数据库临时副本，`WM_DB` 指向副本，端口 3999，真实数据未改动）：

- `POST /api/quiz/submit {"wordId":1,"correct":true}` →
  `stage 3→5`、`status→mastered`、`due_at→2026-12-04`、`accuracy 100%`（P0-1）

**代码定位**（均已阅读原文）：

- `server.js:110` 监听 `0.0.0.0`；`public/index.html:84` 「数据不出本机」
- `src/routes/quiz.js:155` 采信前端 `correct`；`src/routes/exam.js:231-232` 正确做法
- `public/js/views/stats.js:7` 旧 10 档标签；`src/srs.js:18-25` 新 6 档表；`src/routes/stats.js:188` 硬编码 0..9
- `public/js/ui.js:102-124` 移动端走 `translate.google.com/translate_tts`
- `src/routes/study.js:304` 排期只看首次作答；`public/js/views/study.js:23` `PASS_STREAK=3`
- `src/db.js:43-54` 每次 `prepare()`；`src/util.js:75` N+1；`src/routes/settings.js:133-144` 日志导出未转义
- `src/db.js:341` `migrateOnce`；根目录 `_fix_text.js` 硬编码行 id

**外部参考**：

- [Anki 手册 · Leeches](https://docs.ankiweb.net/leeches.html) —— 失败 8 次打标并暂停，之后每 4 次再警告（P3-1）
- [wenki2005/word-memorizer](https://github.com/wenki2005/word-memorizer) —— FSRS、词根词缀、断点续背、永久豁免（P3-1/P3-3/P3-6）
- [BaiYingNing/Engram](https://github.com/BaiYingNing/Engram)、[1103ph/cet-vocab](https://github.com/1103ph/cet-vocab) —— 同类间隔重复 / 四六级词库
- [open-spaced-repetition/fsrs-browser](https://www.npmjs.com/package/fsrs-browser) —— FSRS 浏览器实现（P3-2 的取舍依据）
- [SO: Google Translate TTS API blocked](https://stackoverflow.com/questions/32053442/google-translate-tts-api-blocked/49787284) —— 该接口历来被封禁/限流（P1-3）

> 说明：本次网络环境下 `github.com` 直连不可达，
> 同类项目的功能描述来自搜索索引摘要，未能逐个克隆仓库逐一核对源码。
> 上表「同类项目常见情况」一列属于**概括性对比**，请按需自行复核细节。
> 而 **P0/P1 的每一条都是在本机源码和实测中确认的**，不依赖外部资料。
