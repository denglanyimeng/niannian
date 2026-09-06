// 应用入口：Express 服务 + 静态资源 + API 路由
const express = require('express');
const path = require('path');
const fs = require('fs');

require('./db'); // 初始化数据库

const app = express();
app.use(express.json({ limit: '25mb' }));
app.use(express.urlencoded({ extended: true, limit: '25mb' }));

app.use('/api/config', require('./routes/config'));
app.use('/api/notes', require('./routes/notes'));
app.use('/api/knowledge', require('./routes/knowledge'));
app.use('/api/freetime', require('./routes/freetime'));
app.use('/api/review', require('./routes/review'));
app.use('/api/questions', require('./routes/questions'));
app.use('/api/errorbook', require('./routes/errorbook'));
app.use('/api/export', require('./routes/export'));
app.use('/api/stats', require('./routes/stats'));

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