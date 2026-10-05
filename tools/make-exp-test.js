'use strict';

/**
 * 生成「一半答对一半答错」的测试页，用来验证解析的展开/收起行为。
 * 用法：node tools/make-exp-test.js <setId>
 */

const fs = require('node:fs');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');

const setId = Number(process.argv[2]);
const ROOT = path.resolve(__dirname, '..');
const db = new DatabaseSync(path.join(ROOT, 'data', 'wordmaster.db'), { readOnly: true });
const rows = db.prepare('SELECT id, answer FROM exam_questions WHERE set_id = ? ORDER BY seq').all(setId);
const key = Object.fromEntries(rows.map((r) => [r.id, r.answer]));

const probe = `/* 临时：验证「答错自动展开解析、答对可点开」 */
(function () {
  window.__KEY__ = ${JSON.stringify(key)};
  window.confirm = function () { return true; };
  var log = [];
  function note(t, o) { log.push(Object.assign({ tag: t }, o || {})); }
  function wait(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }

  setTimeout(async function () {
    var qs = [].slice.call(document.querySelectorAll('.qq'));
    note('题目数', { n: qs.length });

    // 前一半按标准答案（答对），后一半故意选错
    var half = Math.ceil(qs.length / 2);
    for (var i = 0; i < qs.length; i++) {
      var all = qs[i].querySelectorAll('[data-q]');
      if (!all.length) continue;
      var qid = Number(all[0].dataset.q);
      var want = window.__KEY__[qid];
      var btn = null;
      for (var j = 0; j < all.length; j++) {
        var hitCorrect = all[j].dataset.label === want;
        if (i < half && hitCorrect) { btn = all[j]; break; }
        if (i >= half && !hitCorrect) { btn = all[j]; break; }
      }
      if (btn) btn.click();
      await wait(25);
    }
    await wait(200);
    document.getElementById('ex-submit').click();
    await wait(2500);

    var cards = [].slice.call(document.querySelectorAll('.exam-split .qbox .qq'));
    var report = cards.map(function (c, i) {
      var isRight = c.classList.contains('right');
      var exp = c.querySelector('.qq-exp');
      var toggle = c.querySelector('.exp-toggle');
      return {
        序号: i + 1,
        判对: isRight,
        有解析: !!exp,
        解析默认可见: exp ? !exp.hasAttribute('hidden') : null,
        有按钮: !!toggle,
        按钮文字: toggle ? toggle.textContent.trim() : null
      };
    });
    note('结果页每张卡片', { list: report });
    note('规则自检', {
      答错的都自动展开: report.filter(function (r) { return !r.判对; }).every(function (r) { return r.有解析 && r.解析默认可见; }),
      答对的默认收起: report.filter(function (r) { return r.判对 && r.有解析; }).every(function (r) { return !r.解析默认可见 && r.有按钮; })
    });

    // 点一个「查看解析」看能不能展开
    var t = document.querySelector('.exp-toggle');
    if (t) {
      var id = t.dataset.exp;
      t.click();
      await wait(200);
      var p = document.getElementById('exp-' + id);
      note('点开之后', {
        解析已可见: p ? !p.hasAttribute('hidden') : null,
        按钮文字: t.textContent.trim(),
        按钮带open类: t.classList.contains('open')
      });
      t.click();
      await wait(200);
      note('再点一次收起', { 解析已隐藏: p ? p.hasAttribute('hidden') : null, 按钮文字: t.textContent.trim() });
    } else {
      note('没有可测试的按钮', {});
    }

    var pre = document.createElement('pre');
    pre.id = 'D';
    pre.textContent = JSON.stringify(log, null, 1);
    document.body.appendChild(pre);

    // 滚到第一道错题，方便截图看解析块
    var wrong = document.querySelector('.qq.wrong');
  }, 3500);
})();
`;

fs.writeFileSync(path.join(ROOT, 'public', 'js', '_exp.js'), probe);
const html = fs.readFileSync(path.join(ROOT, 'public', 'index.html'), 'utf8')
  .replace('<script src="/js/app.js"></script>',
    '<script src="/js/app.js"></script>\n<script src="/js/_exp.js"></script>');
fs.writeFileSync(path.join(ROOT, 'public', '_exp.html'), html);
console.log(`已生成，set#${setId} 共 ${rows.length} 题`);
