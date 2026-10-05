'use strict';

/**
 * 给每个单词生成「常见搭配 + 真题例句」，写进 word_phrases 表。
 *
 * 两个数据源各司其职：
 *   · **搭配**来自 Tatoeba 英文语料（约 200 万句 / 2000 万词）——
 *     先用真题语料（10 万词）试过，**统计基础太小**：任意两个词偶尔相邻都会被算成搭配，
 *     抽样只有一半能用（"split within"、"what appears"、"share of young" 这类）。
 *     换大语料后 PMI 才有意义，才能把「真搭配」和「碰巧挨着」分开。
 *   · **例句**来自真题语料 —— 给的是这个人真正要考的卷子里的原句，语境最贴。
 *
 * 用法：
 *   node tools/build-phrases.js
 *   node tools/build-phrases.js --limit 4 --min-hits 3 --min-pmi 3
 *   node tools/build-phrases.js --max-words 3000000   # 语料采样上限（控内存）
 */

const fs = require('node:fs');
const path = require('node:path');

const db = require(path.join(__dirname, '..', 'src', 'db.js'));

const argOf = (name, def) => {
  const i = process.argv.indexOf(name);
  return i > 0 && process.argv[i + 1] ? Number(process.argv[i + 1]) : def;
};
const PER_WORD = argOf('--limit', 4);
const MIN_HITS = argOf('--min-hits', 3);
const MIN_PMI = argOf('--min-pmi', 3);
const MAX_WORDS = argOf('--max-words', 3000000);

const TATOEBA = 'D:/WordMaster/tools/_raw/tatoeba/eng.txt';

/* ------------------------------------------------------------------ */
/* 词形                                                                */
/* ------------------------------------------------------------------ */

/* ECDICT 的 exchange 里只有这几个键是真正的词形变化。
 * 必须白名单：里面混着「原形: cong」「原形变化: t」这类脏数据，
 * 照单全收的话 `t` 会变成 foremost / worst / congest 的「变形」，
 * 于是这些词下面会挂上 "don t"、"isn t" 这种荒唐搭配（踩过）。 */
const FORM_KEYS = new Set(['复数', '过去式', '过去分词', '现在分词', '第三人称单数', '比较级', '最高级']);

function formsOf(word, exchange) {
  const base = String(word || '').toLowerCase();
  const set = new Set([base]);
  String(exchange || '').split('·').forEach((seg) => {
    const parts = seg.split(':');
    if (parts.length !== 2) return;
    if (!FORM_KEYS.has(parts[0].trim())) return;
    parts[1].split(/[,;]/).forEach((f) => {
      const v = f.trim().toLowerCase();
      if (v && v.length >= 2 && /^[a-z][a-z'-]*$/.test(v)) set.add(v);
    });
  });
  return set;
}

/* ------------------------------------------------------------------ */
/* 语料                                                                */
/* ------------------------------------------------------------------ */

const STOP = new Set(('the a an of to and or in on at for is are was were be been being am it its ' +
  'this that these those as by with from they their them we our you your he she his her i not no nor ' +
  'but so if than then there here more most such also can could will would may might must should shall ' +
  'do does did done has have had having').split(' '));

const TOKEN_RE = /[A-Za-z][A-Za-z'\u2019-]*/g;   // 语料里是排版撇号，带上它 don’t 才不会被切开

/*
 * Tatoeba 是众包翻译语料，里面有大量重复出现的**示例人名**
 * （"Tom thought…"、"I saw Tom"），不排掉的话「搭配」榜会被它们占满
 * —— 实测 "thought tom" 1349 次、"saw tom" 483 次，全都不是搭配。
 */
const NOISE = new Set(('tom mary john sami layla bob alice jane jack mike lisa sarah david emma lucy ' +
  'peter jimmy bobby hank tatoeba').split(' '));

/** 大语料：一行一句的纯文本 */
function* bigCorpus() {
  if (!fs.existsSync(TATOEBA)) return;
  const raw = fs.readFileSync(TATOEBA, 'utf8');
  for (const line of raw.split('\n')) {
    const t = line.trim();
    if (!t) continue;
    const toks = t.match(TOKEN_RE);
    if (toks && toks.length >= 2) yield toks.map((x) => x.toLowerCase());
  }
}

/** 真题语料（只要正文，不要题干 —— 否则会被 "What does the author say" 淹掉） */
function examSentences() {
  const parts = [];
  for (const r of db.query("SELECT passage t FROM exam_sets WHERE kind='reading'")) parts.push(r.t);
  for (const r of db.query('SELECT text t FROM exam_paragraphs')) parts.push(r.t);
  const out = [];
  for (const part of parts) {
    for (const sent of String(part || '').split(/[.!?;:。；：\n]/)) {
      const toks = sent.match(TOKEN_RE);
      if (toks && toks.length >= 2) out.push({ raw: sent.trim(), low: toks.map((t) => t.toLowerCase()) });
    }
  }
  return out;
}

/* ------------------------------------------------------------------ */
/* 主流程                                                              */
/* ------------------------------------------------------------------ */

function main() {
  const useBig = fs.existsSync(TATOEBA);
  if (!useBig) {
    console.log('!! 没找到 Tatoeba 语料，回退用真题语料（搭配质量会明显下降）');
    console.log('   获取方式：下载 eng_sentences.tsv.bz2 后跑 python tools/prepare-tatoeba.py\n');
  }

  console.log('① 统计 n-gram …');
  const counts = new Map();       // 短语 → { n, tokens }
  const uni = new Map();          // 单词频次
  const index = new Map();        // 表面词形 → Set(短语)
  let N = 0;

  const feed = (toks) => {
    N += toks.length;
    for (const t of toks) uni.set(t, (uni.get(t) || 0) + 1);
    for (let i = 0; i < toks.length; i++) {
      for (let n = 2; n <= 4; n++) {
        if (i + n > toks.length) break;
        let gram = toks.slice(i, i + n);
        while (gram.length >= 2 && STOP.has(gram[0])) gram = gram.slice(1);
        while (gram.length >= 2 && STOP.has(gram[gram.length - 1])) gram = gram.slice(0, -1);
        if (gram.length < 2 || gram.every((t) => STOP.has(t))) continue;
        if (gram.some((t) => NOISE.has(t))) continue;      // 示例人名之类的语料噪声
        const key = gram.join(' ');
        const cur = counts.get(key);
        if (cur) cur.n += 1;
        else counts.set(key, { n: 1, tokens: gram });
        for (const t of new Set(gram)) {
          if (!index.has(t)) index.set(t, new Set());
          index.get(t).add(key);
        }
      }
    }
  };

  if (useBig) {
    let done = 0;
    for (const toks of bigCorpus()) {
      feed(toks);
      done += toks.length;
      if (done >= MAX_WORDS) break;
    }
    console.log(`   Tatoeba 采样 ${N.toLocaleString()} 词`);
  } else {
    for (const s of examSentences()) feed(s.low);
    console.log(`   真题语料 ${N.toLocaleString()} 词`);
  }
  console.log(`   ${counts.size.toLocaleString()} 个候选短语`);

  /** PMI：log2( 实际共现 ÷ 独立假设下的期望 )。越大越像真搭配 */
  function pmiOf(tokens, n) {
    let expected = N;
    for (const t of tokens) expected = (expected * (uni.get(t) || 1)) / N;
    if (expected <= 0) return Infinity;
    return Math.log2(n / expected);
  }

  console.log('② 找真题例句 …');
  const exam = examSentences();
  const exampleOf = new Map();     // 词形 → 真题句子
  for (const s of exam) {
    for (const t of s.low) if (!exampleOf.has(t)) exampleOf.set(t, s.raw);
  }
  console.log(`   ${exampleOf.size.toLocaleString()} 个词形有真题例句`);

  console.log('③ 给每个词选搭配 …');
  const words = db.query('SELECT id, lower, spelling, exchange FROM words');
  let filled = 0;
  let withExample = 0;

  db.transaction(() => {
    db.execute('DELETE FROM word_phrases');
    for (const w of words) {
      const cands = new Set();
      let example = '';
      for (const form of formsOf(w.spelling, w.exchange)) {
        const s = index.get(form);
        if (s) for (const p of s) cands.add(p);
        if (!example && exampleOf.has(form)) example = exampleOf.get(form);
      }

      const list = [];
      for (const phrase of cands) {
        const c = counts.get(phrase);
        if (!c || c.n < MIN_HITS) continue;
        const pmi = pmiOf(c.tokens, c.n);
        if (pmi < MIN_PMI) continue;             // 只是碰巧相邻，丢掉
        list.push({ phrase, n: c.n, len: c.tokens.length, pmi });
      }
      // 频次优先（更常用先给），平手时 PMI 高（结合更紧）的优先
      list.sort((a, b) => b.n - a.n || b.pmi - a.pmi);

      // 去掉被包含的短搭配，并让更完整的版本胜出
      const kept = [];
      for (const h of list) {
        const sup = kept.findIndex((k) => h.phrase.includes(k.phrase));
        if (sup >= 0) {
          if (h.n * 3 >= kept[sup].n) kept[sup] = h;
          continue;
        }
        if (kept.some((k) => k.phrase.includes(h.phrase))) continue;
        kept.push(h);
        if (kept.length >= PER_WORD) break;
      }
      kept.sort((a, b) => b.n - a.n || b.pmi - a.pmi);
      if (!kept.length && !example) continue;

      kept.forEach((h, i) => {
        db.execute(
          'INSERT INTO word_phrases(word_id, phrase, hits, pmi, example, seq) VALUES(?,?,?,?,?,?)',
          [w.id, h.phrase, h.n, Math.round(h.pmi * 100) / 100, i === 0 ? String(example).slice(0, 240) : '', i]
        );
      });
      if (kept.length) filled += 1;
      if (example) withExample += 1;
    }
  });

  const stat = db.queryOne('SELECT COUNT(DISTINCT word_id) AS w, COUNT(*) AS p FROM word_phrases');
  console.log(`\n完成：${stat.w.toLocaleString()} 个词拿到搭配，共 ${stat.p.toLocaleString()} 条`);
  console.log(`覆盖率 ${Math.round((stat.w / words.length) * 100)}%（词库 ${words.length.toLocaleString()} 词）`);
  console.log(`有真题例句的词：${withExample.toLocaleString()}`);

  const sample = db.query(`
    SELECT w.spelling, p.phrase, p.hits, p.pmi FROM word_phrases p JOIN words w ON w.id = p.word_id
     WHERE p.seq = 0 ORDER BY p.hits DESC LIMIT 10`);
  console.log('\n出现最多的搭配：');
  for (const s of sample) console.log(`  ${s.hits}×  ${s.phrase}   (${s.spelling}, pmi ${s.pmi})`);
}

main();
