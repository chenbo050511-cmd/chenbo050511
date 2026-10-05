'use strict';

/**
 * 生成一个带「标准答案」的测试页，用来验证界面链路：
 * 点正确答案 → 交卷 → 是否被判对。
 *
 * 用法：node tools/make-qa-page.js <setId>
 * 产物：public/_qa.html + public/js/_qa.js（用完即删）
 */

const fs = require('node:fs');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');

const setId = Number(process.argv[2]);
if (!setId) {
  console.error('用法: node tools/make-qa-page.js <setId>');
  process.exit(1);
}

const ROOT = path.resolve(__dirname, '..');
const db = new DatabaseSync(path.join(ROOT, 'data', 'wordmaster.db'), { readOnly: true });
const rows = db.prepare('SELECT id, answer FROM exam_questions WHERE set_id = ? ORDER BY seq').all(setId);
const key = Object.fromEntries(rows.map((r) => [r.id, r.answer]));

const probe = `/* 临时测试页：按标准答案自动作答，验证批改是否正确 */
(function () {
  window.__KEY__ = ${JSON.stringify(key)};
  window.confirm = function () { return true; };
  var log = [];
  function note(tag, obj) { log.push(Object.assign({ tag: tag }, obj)); }
  function wait(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }

  setTimeout(async function () {
    var qs = document.querySelectorAll('.qq');
    note('题目数', qs.length);
    var isMatch = !!document.querySelector('.pick-btn');
    note('题型', isMatch ? '段落匹配' : '四选一');

    // 按标准答案逐题作答
    var clicked = 0;
    var notFound = [];
    for (var i = 0; i < qs.length; i++) {
      var qid = null;
      var btn = null;
      var all = qs[i].querySelectorAll('[data-q]');
      if (!all.length) continue;
      qid = Number(all[0].dataset.q);
      var want = window.__KEY__[qid];
      for (var j = 0; j < all.length; j++) {
        if (all[j].dataset.label === want) { btn = all[j]; break; }
      }
      if (!btn) { notFound.push(qid + '→' + want); continue; }
      btn.click();
      clicked++;
      await wait(30);
    }
    note('已按标准答案作答', { 点击: clicked, 没找到对应按钮: notFound });
    await wait(300);
    note('作答进度', document.getElementById('ex-count').textContent);

    document.getElementById('ex-submit').click();
    await wait(2500);

    var fb = [].slice.call(document.querySelectorAll('.qq-feedback')).map(function (n) {
      return n.textContent.replace(/\\s+/g, ' ').trim().slice(0, 40);
    });
    note('结果页', {
      得分: document.querySelector('.score-big').textContent.replace(/\\s+/g, ' ').trim(),
      说明: document.querySelector('.quiz-result p').textContent.replace(/\\s+/g, ' ').trim(),
      逐题反馈前6条: fb.slice(0, 6),
      判对数量: document.querySelectorAll('.qq.right').length,
      判错数量: document.querySelectorAll('.qq.wrong').length
    });
    note('结论', {
      全对: document.querySelectorAll('.qq.wrong').length === 0,
      漏点: notFound.length
    });

    var pre = document.createElement('pre');
    pre.id = 'D';
    pre.textContent = JSON.stringify(log, null, 1);
    document.body.appendChild(pre);
  }, 3500);
})();
`;

fs.writeFileSync(path.join(ROOT, 'public', 'js', '_qa.js'), probe);

const html = fs.readFileSync(path.join(ROOT, 'public', 'index.html'), 'utf8')
  .replace('<script src="/js/app.js"></script>',
    '<script src="/js/app.js"></script>\n<script src="/js/_qa.js"></script>');
fs.writeFileSync(path.join(ROOT, 'public', '_qa.html'), html);

console.log(`已生成测试页，set#${setId} 共 ${rows.length} 题`);
console.log('  答案: ' + Object.entries(key).map(([k, v]) => `${k}:${v}`).join(' '));
