'use strict';

/**
 * WordMaster 服务入口
 * 启动：node server.js   （或双击 start.bat）
 * 浏览器访问：http://127.0.0.1:3000
 */

const path = require('node:path');
const express = require('express');
const { spawn, exec } = require('node:child_process');

const db = require('./src/db');

const app = express();
const PREFERRED_PORT = Number(process.env.PORT) || 3000;
const OPEN_BROWSER = !process.argv.includes('--no-open');
/*
 * 默认只监听回环地址。
 *
 * 以前是 '0.0.0.0'（所有网卡），意味着同一个 WiFi 下的任何设备都能打开
 * 你的学习记录，并且这些接口**没有任何认证** ——
 * 其中 POST /api/settings/reset 可以直接清空全部进度。
 * 而界面和 README 都承诺「本地运行 · 数据不出本机」，两者是矛盾的。
 *
 * 确实需要手机 / 平板访问时，显式打开：
 *   HOST=0.0.0.0 node server.js
 * 这时会在控制台打印醒目警告。
 */
const HOST = process.env.HOST || '127.0.0.1';
const EXPOSED = HOST !== '127.0.0.1' && HOST !== 'localhost' && HOST !== '::1';

app.use(express.json({ limit: '2mb' }));
app.disable('x-powered-by');

// 本地应用：接口一律不缓存，避免改完代码看到旧数据
app.use('/api', (req, res, next) => {
  res.set('Cache-Control', 'no-store');
  next();
});

app.use('/api/books', require('./src/routes/books'));
app.use('/api/words', require('./src/routes/words'));
app.use('/api/study', require('./src/routes/study'));
app.use('/api/exam', require('./src/routes/exam'));
app.use('/api/quiz', require('./src/routes/quiz'));
app.use('/api/stats', require('./src/routes/stats'));
app.use('/api/settings', require('./src/routes/settings'));

/** 健康检查 / 首页引导信息 */
app.get('/api/health', (req, res) => {
  const stat = db.queryOne(`
    SELECT (SELECT COUNT(*) FROM words) AS words,
           (SELECT COUNT(*) FROM books) AS books,
           (SELECT COUNT(*) FROM units) AS units,
           (SELECT COUNT(*) FROM progress) AS progress,
           (SELECT COUNT(*) FROM exam_sets) AS exam_sets,
           (SELECT COUNT(*) FROM exam_questions) AS exam_questions
  `);
  res.json({
    ok: true,
    app: 'WordMaster',
    version: '1.0.0',
    node: process.version,
    database: db.DB_FILE,
    stat,
  });
});

// 静态资源每次都回源校验。
// 本地应用没有 CDN，缓存带来的唯一后果就是「改完代码刷新还是旧界面」，所以关掉强缓存。
app.use(
  express.static(path.join(__dirname, 'public'), {
    extensions: ['html'],
    setHeaders: (res) => res.set('Cache-Control', 'no-cache'),
  })
);

// 兜底：任何未匹配的非 API 路径都回首页（前端用 hash 路由）
app.use((req, res, next) => {
  if (req.path.startsWith('/api/')) return next();
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.use((req, res) => {
  res.status(404).json({ error: '接口不存在', path: req.path });
});

// eslint-disable-next-line no-unused-vars
app.use((err, req, res, next) => {
  console.error('[API 错误]', req.method, req.originalUrl, '-', err.message);
  res.status(500).json({ error: err.message || '服务器内部错误' });
});

/* ------------------------------------------------------------------ */
/* 启动                                                                */
/* ------------------------------------------------------------------ */

/**
 * 打开默认浏览器。
 *
 * 先试 explorer.exe：它是桌面外壳进程，不经过 cmd，
 * 某些安全软件会拦截 `cmd /c start`，用 explorer 成功率更高。
 * explorer 起不来（被禁用/裁剪的系统）再退回 cmd。
 * 打不开也不影响服务本身 —— 窗口里会打印地址让人手动访问。
 */
function openBrowser(url) {
  try {
    const child = spawn('explorer.exe', [url], { detached: true, stdio: 'ignore' });
    child.on('error', () => openBrowserViaCmd(url));
    child.unref();
  } catch {
    openBrowserViaCmd(url);
  }
}

function openBrowserViaCmd(url) {
  try {
    exec(`start "" "${url}"`, { shell: 'cmd.exe' }, () => { /* 静默 */ });
  } catch { /* 静默：用户手动访问即可 */ }
}

function listen(port, attempt = 0) {
  const server = app.listen(port, HOST);

  server.on('listening', () => {
    const url = `http://127.0.0.1:${port}`;
    const stat = db.queryOne(`
      SELECT (SELECT COUNT(*) FROM words) AS words,
             (SELECT COUNT(*) FROM exam_sets) AS examSets,
             (SELECT COUNT(*) FROM exam_questions) AS examQuestions
    `);
    console.log('');
    console.log('  WordMaster 已启动');
    console.log(`  地址：${url}`);
    console.log(`  词库：${stat.words} 个单词    真题库：${stat.examSets} 组 / ${stat.examQuestions} 道题`);
    console.log(`  数据库：${db.DB_FILE}`);
    if (EXPOSED) {
      console.log('');
      console.log(`  ⚠ 正在监听 ${HOST} —— 局域网内其他设备可以访问，且接口没有认证！`);
      console.log('    其中「重置数据」能清空你的全部学习记录。');
      console.log('    只想自己用就停掉，然后用默认方式启动（不带 HOST）。');
      console.log('');
    }
    console.log('  按 Ctrl+C 停止服务');
    console.log('');
    if (OPEN_BROWSER) {
      // 打不开浏览器就算了 —— 这是锦上添花的事，绝不能把服务带崩。
      // （之前这里抛异常会直接让进程退出：exec 忘了 import，默认模式一启动就崩）
      if (attempt > 0) {
        // 端口被占过，地址和用户书签里的不一样了，得说清楚，否则会以为「服务没起来」
        console.log(`  ⚠ 端口 ${PREFERRED_PORT} 被占用，已改用 ${url}`);
        console.log('    请访问上面这个地址（旧地址 http://127.0.0.1:' + PREFERRED_PORT + ' 连不上是正常的）');
        console.log('');
      }
      openBrowser(url);
      console.log(`  如果浏览器没有自动打开，手动访问：${url}`);
      console.log('');
    }
  });

  server.on('error', (err) => {
    if (err.code === 'EADDRINUSE' && attempt < 10) {
      console.log(`  端口 ${port} 被占用，换 ${port + 1} 试试 ...`);
      listen(port + 1, attempt + 1);
    } else {
      console.error('启动失败：', err.message);
      process.exit(1);
    }
  });
}

listen(PREFERRED_PORT);
