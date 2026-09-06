// 错题本：收纳作答失误的习题
const express = require('express');
const { db } = require('../db');

const router = express.Router();

router.get('/', (req, res) => {
  const rows = db.prepare(`SELECT eb.id AS eb_id, eb.create_time, eb.reason,
      q.id AS q_id, q.question_text, q.answer, q.question_type, q.choices, k.name AS kp_name, k.id AS kp_id
    FROM error_book eb
    JOIN question q ON q.id = eb.q_id
    JOIN knowledge_point k ON k.id = eb.kp_id
    ORDER BY eb.id DESC`).all();
  res.json(rows.map((r) => Object.assign({}, r, {
    choices: r.choices ? (() => { try { return JSON.parse(r.choices); } catch (e) { return null; } })() : null,
    question_type_label: ['选择题', '填空题', '简答题'][r.question_type] || '简答题'
  })));
});

// 从错题本移除
router.delete('/:id', (req, res) => {
  const id = Number(req.params.id);
  const row = db.prepare('SELECT q_id FROM error_book WHERE id = ?').get(id);
  if (row) db.prepare('UPDATE question SET is_error = 0 WHERE id = ?').run(row.q_id);
  const info = db.prepare('DELETE FROM error_book WHERE id = ?').run(id);
  res.json({ ok: info.changes > 0 });
});

module.exports = router;