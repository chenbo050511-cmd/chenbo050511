'use strict';

/**
 * 从真题源库（tools/_raw/exam/source_v2.db）构建本应用的真题题库。
 *
 * 源数据来自开源项目 ShepiTT/CET_practice_questions（四六级真题 + OCR 答案）。
 * 只取两种题型：
 *   reading  —— 短文阅读（Section C，一篇 passage + 5 道四选一）
 *   matching —— 段落匹配（Section B，一篇多段文章 + 10 条陈述找段落）
 *
 * 源数据的坑（都已处理）：
 *   1. 段落标记有四种写法：行首 `A)`、行内 ` A)`、紧凑 `A)How`、方括号 `[A]`
 *      → 不靠「行首」也不靠「标签后必须有空格」，改成「收集候选 + 按字母顺序贪心接受」
 *   2. 阅读正文完全没有段落信号（107/108 组连换行都没有）→ 按整段渲染
 *   3. 少数卷的正文被 OCR 截断，答案指向的段落根本不在正文里
 *      → 丢弃这些「无解」的题目；整组可用题不足 5 道就整组丢弃
 *
 * 用法：node tools/build-exam.js [--force]
 */

const fs = require('node:fs');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');

const db = require('../src/db');

const SRC = path.join(__dirname, '_raw', 'exam', 'source_v2.db');
const FORCE = process.argv.includes('--force');
const LETTERS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ'.split('');
const MIN_PARA = 40;        // 段落短于这个长度视为误匹配
const MIN_PASSAGE = 400;    // 正文太短的组直接不要
const MIN_QUESTIONS = 5;    // 一组里可用题少于这个数就整组丢弃

/* ------------------------------------------------------------------ */
/* 清洗                                                                */
/* ------------------------------------------------------------------ */

/* OCR 的标点缺空格很好修，而且没有歧义：
   句号/逗号后面紧跟字母时补一个空格。
   注意句号规则要求后面是「大写字母」—— 这样 "2.5"、"e.g."、"U.S." 都不会被误伤。 */
function tidyPunctuation(text) {
  return String(text || '')
    .replace(/([a-z0-9])\.(?=[A-Z])/g, '$1. ')
    .replace(/([a-zA-Z]),(?=[a-zA-Z])/g, '$1, ')
    .replace(/([a-z]);(?=[A-Za-z])/g, '$1; ')
    .replace(/([a-z])\?(?=[A-Z])/g, '$1? ')
    .replace(/([a-z])!(?=[A-Z])/g, '$1! ')
    .replace(/ {2,}/g, ' ')
    .trim();
}

/**
 * OCR 还会把「短功能词 + 下一个词」粘在一起，例如 ofabandonment、isjust、atthe。
 *
 * 这里只做**保守**修复：只有当 token 不在 ECDICT 词表里、
 * 且「切出来的前半段正好是常见功能词、后半段也是合法单词」时才切开。
 *
 * 为什么不做得更激进：像 caregiving / emailing / texters 这些本来就是完整单词
 * （只是 ECDICT 没收录），任何「二分后两半都是词就切」的规则都会把它们改坏。
 * 只认功能词就绕开了这个坑 —— caregiving 的 "care" 不在功能词表里，于是不动它。
 */
const FUNCTION_WORDS = new Set([
  'of', 'to', 'in', 'on', 'at', 'is', 'it', 'we', 'he', 'be', 'as', 'or', 'an', 'my',
  'no', 'so', 'up', 'us', 'do', 'if', 'me', 'am', 'by', 'go', 'ok',
  'the', 'and', 'for', 'are', 'was', 'were', 'has', 'had', 'have', 'not', 'but', 'out',
  'you', 'his', 'her', 'its', 'our', 'they', 'them', 'this', 'that', 'with', 'from',
  'will', 'can', 'may', 'must', 'one', 'two', 'all', 'any', 'who', 'how', 'why', 'what',
  'when', 'more', 'most', 'some', 'such', 'than', 'then', 'there', 'their', 'also',
]);

function loadWordList() {
  const csvPath = path.join(__dirname, '_raw', 'ecdict.csv');
  if (!fs.existsSync(csvPath)) return null;
  const known = new Set();
  const lines = fs.readFileSync(csvPath, 'utf8').split('\n');
  for (let i = 1; i < lines.length; i++) {
    const w = lines[i].slice(0, lines[i].indexOf(','));
    if (w && /^[a-zA-Z'’-]+$/.test(w)) known.add(w.toLowerCase());
  }
  return known;
}

function fixGluedWords(text, known) {
  if (!known) return text;
  return String(text || '')
    .split(' ')
    .map((tok) => {
      const core = tok.replace(/^[^a-zA-Z]+|[^a-zA-Z]+$/g, '');
      if (core.length < 5 || core.length > 26) return tok;
      if (!/^[A-Za-z]+$/.test(core)) return tok;
      if (known.has(core.toLowerCase())) return tok;

      for (const fw of FUNCTION_WORDS) {
        const lower = core.toLowerCase();
        // 功能词必须在开头且大小写无非：「Ofabandonment」也要能修
        if (!lower.startsWith(fw)) continue;
        const rest = core.slice(fw.length);
        if (rest.length < 3) continue;
        if (!known.has(rest.toLowerCase())) continue;
        // 只切一处分，且保持原大小写
        return core.slice(0, fw.length) + ' ' + core.slice(fw.length);
      }
      return tok;
    })
    .join(' ');
}

function tidy(text, known) {
  return fixGluedWords(tidyPunctuation(text), known);
}

/** 剥掉 OCR 带进来的 Directions 说明文字 */
function stripDirections(text) {
  return String(text || '')
    .replace(/^\s*Directions\s*[:：][\s\S]*?Answer\s*Sheet\s*2\s*\.?\s*/i, '')
    .trim();
}

/**
 * 段落匹配：把整块正文切成带字母标号的段落。
 * 关键：先把所有「X)」和「[X]」都当候选收集起来，再按 A、B、C… 顺序贪心接受。
 * 这样无论标签在行首、行内、还是紧贴正文（`A)How will we`）都能切对，
 * 而正文里偶尔出现的 `A)` 会因为「不是下一个期望字母」被跳过。
 */
function splitParagraphs(rawText) {
  const text = stripDirections(rawText);
  const cands = [];
  for (const m of text.matchAll(/(?<![A-Za-z])([A-Z])\)/g)) {
    cands.push({ letter: m[1], start: m.index, contentStart: m.index + m[0].length });
  }
  for (const m of text.matchAll(/\[([A-Z])\]/g)) {
    cands.push({ letter: m[1], start: m.index, contentStart: m.index + m[0].length });
  }
  cands.sort((a, b) => a.start - b.start || (a.letter < b.letter ? -1 : 1));

  const hits = [];
  let expect = 0;
  for (const c of cands) {
    if (c.letter === LETTERS[expect]) { hits.push(c); expect++; }
  }
  if (!hits.length) return { title: '', paragraphs: [] };

  const title = text.slice(0, hits[0].start).trim();
  const paragraphs = hits
    .map((h, i) => ({
      label: h.letter,
      text: text.slice(h.contentStart, i + 1 < hits.length ? hits[i + 1].start : text.length).trim(),
    }))
    .filter((p) => p.text.length >= MIN_PARA);

  return { title, paragraphs };
}

/** 阅读正文：源数据没有段落信号，压掉多余空白即可 */
function cleanPassage(text) {
  return String(text || '')
    .replace(/\s*\n\s*/g, ' ')
    .replace(/ {2,}/g, ' ')
    .replace(/\s+([,.;:!?])/g, '$1')
    .trim();
}

function parseSourceFile(name) {
  const m = String(name).match(/^(\d{4})-(\d{2})-(CET[46])-(\d+)/);
  if (!m) return null;
  const [, y, mo, lv, setNo] = m;
  const level = lv === 'CET6' ? 'cet6' : 'cet4';
  return {
    code: `${y}-${mo}-${lv}-${setNo}`,
    level,
    year: Number(y),
    month: Number(mo),
    set_no: Number(setNo),
    title: `${y} 年 ${Number(mo)} 月${level === 'cet6' ? '六级' : '四级'}真题（第 ${setNo} 套）`,
  };
}

const INSTRUCTIONS = {
  reading: '阅读下面的短文，然后从每题给出的四个选项中选出最佳答案。',
  matching: '阅读下面的文章，判断下列陈述分别出自哪一个段落，选出对应的段落字母。每个段落可以使用多次。',
};

/* ------------------------------------------------------------------ */
/* 主流程                                                              */
/* ------------------------------------------------------------------ */

function main() {
  if (!fs.existsSync(SRC)) {
    console.error(`\n找不到真题源库：${SRC}`);
    console.error('下载方式：');
    console.error('  mkdir -p tools/_raw/exam && curl -L -o tools/_raw/exam/source_v2.db \\');
    console.error('    https://raw.githubusercontent.com/ShepiTT/CET_practice_questions/main/instance/cet4_v2.db\n');
    process.exit(1);
  }

  const existing = db.queryOne('SELECT COUNT(*) AS c FROM exam_sets');
  if (existing.c > 0 && !FORCE) {
    console.log(`\n真题库已存在（${existing.c} 组），跳过构建。重建请加 --force。\n`);
    return;
  }

  const t0 = Date.now();
  const src = new DatabaseSync(SRC, { readOnly: true });
  const sAll = (sql, ...a) => src.prepare(sql).all(...a);
  const sOne = (sql, ...a) => src.prepare(sql).get(...a);

  // 粘连词修复需要一份英文词表，直接用 ECDICT
  const known = loadWordList();
  if (known) console.log(`\n已加载英文词表 ${known.size} 条（用于修复 OCR 粘连词）`);
  else console.log('\n未找到 ecdict.csv，跳过粘连词修复（标点修复仍会执行）');

  const stat = { papers: 0, reading: 0, readingQ: 0, matching: 0, matchQ: 0, dropped: [], skippedQ: 0 };

  db.transaction(() => {
    db.execute('DELETE FROM exam_answers');
    db.execute('DELETE FROM exam_attempts');
    db.execute('DELETE FROM exam_options');
    db.execute('DELETE FROM exam_questions');
    db.execute('DELETE FROM exam_paragraphs');
    db.execute('DELETE FROM exam_sets');
    db.execute('DELETE FROM exam_papers');
    db.execute("DELETE FROM sqlite_sequence WHERE name LIKE 'exam_%'");

    const insPaper = db.db.prepare(
      `INSERT INTO exam_papers(code, level, year, month, set_no, title) VALUES(?,?,?,?,?,?)`
    );
    const insSet = db.db.prepare(
      `INSERT INTO exam_sets(paper_id, kind, seq, title, instructions, passage, word_count, question_count)
       VALUES(?,?,?,?,?,?,?,?)`
    );
    const insPara = db.db.prepare(
      `INSERT INTO exam_paragraphs(set_id, label, text, seq) VALUES(?,?,?,?)`
    );
    const insQ = db.db.prepare(
      `INSERT INTO exam_questions(set_id, seq, q_number, stem, answer) VALUES(?,?,?,?,?)`
    );
    const insOpt = db.db.prepare(
      `INSERT INTO exam_options(question_id, label, text, seq) VALUES(?,?,?,?)`
    );

    // 按 source_file 分组，逐个文件处理
    const files = sAll(`SELECT DISTINCT source_file FROM question_group ORDER BY source_file`);
    const paperIds = new Map();

    for (const f of files) {
      const info = parseSourceFile(f.source_file);
      if (!info) { stat.dropped.push(`${f.source_file} 文件名无法解析`); continue; }

      if (!paperIds.has(info.code)) {
        const res = insPaper.run(info.code, info.level, info.year, info.month, info.set_no, info.title);
        paperIds.set(info.code, Number(res.lastInsertRowid));
        stat.papers++;
      }
      const paperId = paperIds.get(info.code);

      // 该套卷里我们关心的两种题型，reading 按题号排序（Passage One/Two）
      const groups = sAll(
        `SELECT * FROM question_group
          WHERE source_file = ? AND group_type IN ('reading','matching')
          ORDER BY group_type DESC, id`,
        f.source_file
      );

      let readSeq = 0;
      let matchSeq = 0;

      for (const g of groups) {
        const qs = sAll(
          `SELECT * FROM question WHERE group_id = ? ORDER BY q_number`,
          g.id
        ).map((q) => ({
          ...q,
          answer: String(q.correct_answer || '').trim(),
          options: sAll(`SELECT label, text FROM option WHERE question_id = ? ORDER BY label`, q.id),
        }));

        if (g.group_type === 'reading') {
          const passage = tidy(cleanPassage(g.passage), known);
          if (passage.length < MIN_PASSAGE) { stat.dropped.push(`${f.source_file} 阅读正文过短`); continue; }
          const good = qs.filter((q) => /^[A-D]$/.test(q.answer) && q.options.length === 4);
          if (good.length < 3) { stat.dropped.push(`${f.source_file} 阅读可用题不足`); continue; }

          readSeq++;
          const lo = good[0].q_number;
          const hi = good[good.length - 1].q_number;
          const title = `Passage ${readSeq} · Q${lo}-${hi}`;

          const setId = Number(insSet.run(
            paperId, 'reading', readSeq, title, INSTRUCTIONS.reading,
            passage, passage.split(/\s+/).length, good.length
          ).lastInsertRowid);

          good.forEach((q, i) => {
            const qid = Number(insQ.run(
              setId, i + 1, q.q_number, tidy(String(q.content || ''), known), q.answer
            ).lastInsertRowid);
            q.options.forEach((o, oi) => insOpt.run(qid, o.label, tidy(String(o.text || ''), known), oi + 1));
          });

          stat.reading++;
          stat.readingQ += good.length;
        } else {
          const parsed = splitParagraphs(g.passage);
          const artTitle = tidy(parsed.title, known);
          const paragraphs = parsed.paragraphs.map((p) => ({ label: p.label, text: tidy(p.text, known) }));
          if (paragraphs.length < 3) { stat.dropped.push(`${f.source_file} 段落匹配切不出段落`); continue; }

          const labels = paragraphs.map((p) => p.label);
          // 答案指向的段落必须真的存在，否则这题无法作答
          const good = qs.filter((q) => labels.includes(q.answer));
          stat.skippedQ += qs.length - good.length;
          if (good.length < MIN_QUESTIONS) { stat.dropped.push(`${f.source_file} 段落匹配可用题仅 ${good.length} 道`); continue; }

          matchSeq++;
          const full = paragraphs.map((p) => `${p.label}) ${p.text}`).join(' ');
          const setId = Number(insSet.run(
            paperId, 'matching', matchSeq, artTitle || `Passage · ${good.length} 条陈述`,
            INSTRUCTIONS.matching, full, full.split(/\s+/).length, good.length
          ).lastInsertRowid);

          paragraphs.forEach((p, i) => insPara.run(setId, p.label, p.text, i + 1));
          good.forEach((q, i) => {
            insQ.run(setId, i + 1, q.q_number, tidy(String(q.content || ''), known), q.answer);
          });

          stat.matching++;
          stat.matchQ += good.length;
        }
      }
    }

    db.execute('INSERT OR REPLACE INTO meta(key, value) VALUES(?,?)', ['exam_source', 'ShepiTT/CET_practice_questions (CET 4/6 真题 + OCR 答案)']);
    db.execute('INSERT OR REPLACE INTO meta(key, value) VALUES(?,?)', ['exam_built_at', new Date().toISOString()]);
    db.execute('INSERT OR REPLACE INTO meta(key, value) VALUES(?,?)', ['exam_total', String(stat.reading + stat.matching)]);
  });

  src.close();

  console.log('');
  console.log('真题库构建完成：');
  console.log(`  试卷  ${stat.papers} 套`);
  console.log(`  短文阅读  ${stat.reading} 组 / ${stat.readingQ} 道题`);
  console.log(`  段落匹配  ${stat.matching} 组 / ${stat.matchQ} 条陈述`);
  if (stat.skippedQ) console.log(`  因源数据正文截断而丢弃的无解题目：${stat.skippedQ} 条`);
  if (stat.dropped.length) {
    console.log(`  整组丢弃 ${stat.dropped.length} 处：`);
    for (const d of stat.dropped.slice(0, 10)) console.log(`    ${d}`);
  }

  const verify = db.query(`
    SELECT p.level, COUNT(DISTINCT p.id) papers,
           SUM(CASE WHEN s.kind='reading' THEN 1 ELSE 0 END) reading,
           SUM(CASE WHEN s.kind='matching' THEN 1 ELSE 0 END) matching
      FROM exam_sets s JOIN exam_papers p ON p.id = s.paper_id
     GROUP BY p.level ORDER BY p.level
  `);
  console.log('');
  console.log('  按级别：');
  for (const v of verify) console.log(`    ${v.level}  试卷 ${v.papers} 套  阅读 ${v.reading} 组  匹配 ${v.matching} 组`);

  const years = db.query(
    `SELECT year, COUNT(*) c FROM exam_papers GROUP BY year ORDER BY year`
  );
  console.log('  按年份：', years.map((y) => `${y.year}(${y.c}套)`).join(' '));
  console.log(`\n耗时 ${((Date.now() - t0) / 1000).toFixed(1)} 秒。\n`);
}

main();
