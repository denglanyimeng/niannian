// 应用入口：Express 服务 + 静态资源 + API 路由
const express = require('express');
const path = require('path');
const fs = require('fs');

require('./db'); // 初始化数据库

// ---------- 稳定性兜底 ----------
// Express 4 不会接管 async 路由处理函数里抛出的异常：它会变成「未处理的 Promise 拒绝」，
// 而 Node 默认会直接终止整个进程 —— 曾导致念念整体挂掉，浏览器只看到 "Failed to fetch"。
// 两层保护：
//   1) hardenRouter：给每个路由处理函数包一层，异常转交 Express 错误处理中间件，
//      客户端会收到 500 和错误信息，而不是请求一直卡住；
//   2) 兜底的 unhandledRejection 监听：任何漏网的拒绝只记录日志，不再终止进程。
process.on('unhandledRejection', (reason) => {
  console.error('[未处理的异步错误]', (reason && reason.stack) || reason);
});

function hardenRouter(router) {
  const stack = router && Array.isArray(router.stack) ? router.stack : [];
  for (const layer of stack) {
    if (!layer || !layer.route || !Array.isArray(layer.route.stack)) continue;
    for (const l of layer.route.stack) {
      const fn = l && l.handle;
      if (typeof fn !== 'function' || fn.length === 4) continue; // 跳过错误处理中间件
      l.handle = function (req, res, next) {
        try {
          const out = fn.call(this, req, res, next);
          if (out && typeof out.then === 'function') out.catch(next);
          return out;
        } catch (e) {
          next(e);
          return undefined;
        }
      };
    }
  }
  return router;
}

const app = express();
app.use(express.json({ limit: '25mb' }));
app.use(express.urlencoded({ extended: true, limit: '25mb' }));

// 统一挂载 API 路由，并逐条加固
function mountApi(prefix, router) {
  return app.use(prefix, hardenRouter(router));
}
mountApi('/api/config', require('./routes/config'));
mountApi('/api/notes', require('./routes/notes'));
mountApi('/api/knowledge', require('./routes/knowledge'));
mountApi('/api/freetime', require('./routes/freetime'));
mountApi('/api/review', require('./routes/review'));
mountApi('/api/questions', require('./routes/questions'));
mountApi('/api/errorbook', require('./routes/errorbook'));
mountApi('/api/export', require('./routes/export'));
mountApi('/api/stats', require('./routes/stats'));

const PUBLIC = path.join(__dirname, '..', 'public');
app.use(express.static(PUBLIC));

// 静态页面路由
const pages = ['index', 'settings', 'notes', 'knowledge', 'schedule', 'review', 'errorbook'];
for (const p of pages) {
  app.get('/' + (p === 'index' ? '' : p), (req, res) => {
    res.sendFile(path.join(PUBLIC, p + '.html'));
  });
}

app.use('/api', (req, res) => res.status(404).json({ ok: false, error: '接口不存在' }));

// 全局错误处理
app.use((err, req, res, next) => {
  console.error('[error]', err.message);
  res.status(500).json({ ok: false, error: err.message || '服务器内部错误' });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log('念念已启动：http://localhost:' + PORT);
  console.log('   数据目录：' + path.join(__dirname, '..', 'data'));
});