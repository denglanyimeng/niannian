// 题目管理：列表、手动重新出题、删除
const express = require('express');
const { db, now } = require('../db');
const { generateQuestions, questionCountFor } = require('../ai');
const { questionTypeForReview } = require('../ebbinghaus');

const router = express.Router();

router.get('/', (req, res) => {
  const rows = db.prepare(`SELECT q.*, k.name AS kp_name FROM question q JOIN knowledge_point k ON k.id = q.kp_id ORDER BY q.id DESC LIMIT 300`).all();
  res.json(rows.map((r) => Object.assign({}, r, {
    choices: r.choices ? (() => { try { return JSON.parse(r.choices); } catch (e) { return null; } })() : null,
    question_type_label: ['选择题', '填空题', '简答题'][r.question_type] || '简答题'
  })));
});

// 为某知识点手动重新出题（清除该知识点旧题）
router.post('/generate', async (req, res) => {
  const id = Number(req.body && req.body.kp_id);
  const kp = db.prepare('SELECT * FROM knowledge_point WHERE id = ?').get(id);
  if (!kp) return res.status(404).json({ ok: false, error: '知识点不存在' });
  const reviewCount = (kp.review_count || 0) + 1;
  const qType = questionTypeForReview(kp, reviewCount);
  const qCount = questionCountFor(kp, 1);
  const generated = await generateQuestions(kp, reviewCount, qType, qCount);
  db.prepare('DELETE FROM question WHERE kp_id = ?').run(id);
  db.prepare('DELETE FROM error_book WHERE kp_id = ?').run(id);
  const ts = now();
  const created = [];
  for (const g of generated.slice(0, qCount)) {
    const info = db.prepare(`INSERT INTO question (kp_id, question_text, answer, question_type, choices, hint, is_error, created_at)
      VALUES (?, ?, ?, ?, ?, ?, 0, ?)`)
      .run(id, g.question_text, g.answer, g.question_type || qType, g.choices ? JSON.stringify(g.choices) : null, g.hint || '', ts);
    created.push(Number(info.lastInsertRowid));
  }
  res.json({ ok: true, created });
});

router.delete('/:id', (req, res) => {
  const id = Number(req.params.id);
  db.prepare('DELETE FROM error_book WHERE q_id = ?').run(id);
  const info = db.prepare('DELETE FROM question WHERE id = ?').run(id);
  res.json({ ok: info.changes > 0 });
});

module.exports = router;