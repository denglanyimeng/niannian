// 资料导出：笔记导出 / 题目导出
const express = require('express');
const { db } = require('../db');

const router = express.Router();

// 笔记导出（Markdown，含复习块摘要与要点）
router.get('/notes', (req, res) => {
  const rows = db.prepare('SELECT * FROM knowledge_point ORDER BY created_at DESC').all();
  const lines = ['# 我的复习笔记', '', `共 ${rows.length} 个知识点/复习块`, ''];
  for (const k of rows) {
    let tags = '';
    try { tags = JSON.parse(k.tag_tree || '[]').map((t) => '#' + t).join(' '); } catch (e) {}
    lines.push(`## ${k.name}`, '');
    if (tags) lines.push(`标签：${tags}`, '');
    if (k.summary) lines.push(`**AI 总结**：${k.summary}`, '');
    let points = [];
    try { points = JSON.parse(k.points || '[]'); } catch (e) {}
    if (Array.isArray(points) && points.length) {
      lines.push('**复习要点**：', '');
      points.forEach((p, i) => {
        lines.push(`${i + 1}. ${p.name || ('要点' + (i + 1))}`, '');
        if (p.content) lines.push(p.content, '');
      });
    }
    lines.push(k.content || '(无内容)', '', `复习次数：${k.review_count || 0}　掌握度：${k.master_rate || 0}%　下次复习：${k.next_review_time || '未安排'}`, '', '---', '');
  }
  const content = lines.join('\n');
  res.setHeader('Content-Type', 'text/markdown; charset=utf-8');
  res.setHeader('Content-Disposition', 'attachment; filename="notes-export.md"');
  res.send(Buffer.from(content, 'utf8'));
});

// 题目导出（文本）
router.get('/questions', (req, res) => {
  const rows = db.prepare(`SELECT q.*, k.name AS kp_name FROM question q JOIN knowledge_point k ON k.id = q.kp_id ORDER BY k.name, q.id`).all();
  const typeLabel = { 0: '选择题', 1: '填空题', 2: '简答题' };
  const lines = ['# 题目导出', '', `共 ${rows.length} 题`, ''];
  let current = '';
  for (const q of rows) {
    if (q.kp_name !== current) {
      current = q.kp_name;
      lines.push(`## ${q.kp_name}`, '');
    }
    let choices = '';
    if (q.choices) {
      try {
        choices = '\n' + JSON.parse(q.choices).map((c, i) => `${String.fromCharCode(65 + i)}. ${c}`).join('\n');
      } catch (e) {}
    }
    lines.push(`【${typeLabel[q.question_type] || '简答题'}】${q.question_text}${choices}`, '', `答案：${q.answer}`, '', '---', '');
  }
  const content = lines.join('\n');
  res.setHeader('Content-Type', 'text/plain; charset=utf-8');
  res.setHeader('Content-Disposition', 'attachment; filename="questions-export.txt"');
  res.send(Buffer.from(content, 'utf8'));
});

module.exports = router;
