'use strict';

/**
 * 从真题语料里抽「常见搭配」—— 先做原型，看质量再决定要不要入库。
 *
 * 思路：
 *   1. 一次扫过语料，统计所有 2~4 元组（n-gram）的词频
 *   2. 对每个目标词，取包含它（或其变形）的 n-gram
 *   3. 按「出现次数 → 长度」排序，去掉被更长搭配包住的短搭配
 *
 * 为什么用真题语料而不是外部词典：本地没有搭配数据，
 * 而真题正文正好是这个人要背的词的真实用武之地（已学词 97% 都在里面）。
 *
 * 用法：node tools/proto-phrases.js condition adapt account upon quality
 */

const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');

const db = new DatabaseSync(path.join(__dirname, '..', 'data', 'wordmaster.db'), { readOnly: true });

/* ---------------- 语料 ---------------- */

function buildCorpus() {
  const parts = [];
  for (const r of db.prepare("SELECT passage t FROM exam_sets WHERE kind='reading'").all()) parts.push(r.t);
  for (const r of db.prepare('SELECT text t FROM exam_paragraphs').all()) parts.push(r.t);
  for (const r of db.prepare('SELECT stem t FROM exam_questions').all()) parts.push(r.t);
  for (const r of db.prepare('SELECT text t FROM exam_options').all()) parts.push(r.t);
  return parts;
}

/** 切成小写词形，丢掉纯符号；句末标点当作边界（不跨句取搭配） */
function tokenize(text) {
  const out = [];
  // 按句子切，句内再切词 —— 避免抽到「…end. In addition…」这种跨句组合
  for (const sent of String(text || '').split(/[.!?;:，。；：\n]/)) {
    const toks = sent.match(/[A-Za-z][A-Za-z'-]*/g) || [];
    if (toks.length) {
      out.push(toks.map((t) => t.toLowerCase()));
      out.push(null); // 句子边界标记
    }
  }
  return out;
}

/** 一个词的所有可能表面形式（含 ECDICT 给的词形变化） */
function formsOf(word, exchange) {
  const base = word.toLowerCase();
  const set = new Set([base]);
  String(exchange || '').split('·').forEach((seg) => {
    const m = seg.split(':');
    if (m.length === 2) {
      m[1].trim().split(/[,;]/).forEach((f) => {
        const v = f.trim().toLowerCase();
        if (v && /^[a-z][a-z'-]*$/.test(v)) set.add(v);
      });
    }
  });
  // 兜底规则
  set.add(base + 's');
  set.add(base + 'es');
  set.add(base + 'ed');
  set.add(base + 'ing');
  if (base.endsWith('e')) { set.add(base + 'd'); set.add(base.slice(0, -1) + 'ing'); }
  if (base.endsWith('y')) set.add(base.slice(0, -1) + 'ies');
  return set;
}

/* ---------------- 抽搭配 ---------------- */

const STOP = new Set(['the', 'a', 'an', 'of', 'to', 'and', 'or', 'in', 'on', 'at', 'for', 'is', 'are', 'was', 'were', 'be', 'been', 'it', 'its', 'this', 'that', 'these', 'those', 'as', 'by', 'with', 'from', 'they', 'their', 'we', 'our', 'you', 'your', 'he', 'she', 'his', 'her', 'them', 'i', 'not', 'no', 'but', 'so', 'if', 'than', 'then', 'there', 'more', 'most', 'such', 'also', 'can', 'could', 'will', 'would', 'may', 'might', 'must', 'should', 'do', 'does', 'did', 'has', 'have', 'had']);

function extractAll() {
  const counts = new Map();   // 短语 → 次数
  const sentences = [];
  for (const part of buildCorpus()) {
    const sents = tokenize(part);
    let cur = [];
    for (const s of sents) {
      if (s === null) { if (cur.length) sentences.push(cur); cur = []; continue; }
      cur = s;
    }
    if (cur.length) sentences.push(cur);
  }
  for (const toks of sentences) {
    for (let i = 0; i < toks.length; i++) {
      for (let n = 2; n <= 4; n++) {
        if (i + n > toks.length) break;
        const gram = toks.slice(i, i + n);
        // 首尾不能都是虚词（否则「of the」这种也会进来）
        if (STOP.has(gram[0]) && STOP.has(gram[gram.length - 1])) continue;
        const key = gram.join(' ');
        counts.set(key, (counts.get(key) || 0) + 1);
      }
    }
  }
  return { counts, sentences };
}

function phrasesFor(word, exchange, corpus, limit = 6) {
  const forms = formsOf(word, exchange);
  const hits = [];
  for (const [phrase, n] of corpus.counts) {
    const toks = phrase.split(' ');
    const has = toks.some((t) => forms.has(t));
    if (!has) continue;
    // 目标词不该在中间被虚词淹没：要求短语里除目标词外至少有一个实词
    const content = toks.filter((t) => !STOP.has(t) && !forms.has(t));
    if (!content.length) continue;
    hits.push({ phrase, n, len: toks.length, content: content.length });
  }
  // 频次优先、其次更长、再次实词更多
  hits.sort((a, b) => b.n - a.n || b.len - a.len || b.content - a.content);

  // 去掉被保留项「包含」的短搭配：in good condition 保留了，就不要 good condition
  const kept = [];
  for (const h of hits) {
    if (kept.some((k) => k.phrase.includes(h.phrase))) continue;
    kept.push(h);
    if (kept.length >= limit) break;
  }
  return kept;
}

const targets = process.argv.slice(2);
const { counts, sentences } = extractAll();
console.log(`语料 n-gram：${counts.size.toLocaleString()} 个不同短语\n`);

for (const w of targets) {
  const row = db.prepare('SELECT spelling, exchange, meaning FROM words WHERE lower = ?').get(String(w).toLowerCase());
  if (!row) { console.log(`[${w}] 词库里没有`); continue; }
  console.log(`[${row.spelling}]  ${String(row.meaning || '').slice(0, 44)}`);
  const list = phrasesFor(row.spelling, row.exchange, { counts });
  if (!list.length) console.log('    （真题语料里没出现）');
  for (const h of list) console.log(`    ${String(h.n).padStart(3)}×  ${h.phrase}`);
  // 顺带看看能不能给一句真题例句
  const forms = formsOf(row.spelling, row.exchange);
  const sent = sentences.find((s) => s.some((t) => forms.has(t)));
  if (sent) console.log(`    例: ${sent.join(' ').replace(/^./, (c) => c.toUpperCase())}`);
  console.log('');
}
