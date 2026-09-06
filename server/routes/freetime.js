// 空闲时间配置：时间段 + 循环周期（每日 / 每两天 / 每三天）
const express = require('express');
const { db, now } = require('../db');

const router = express.Router();
const CYCLE_LABEL = ['每日', '每两天', '每三天'];

function validHM(s) {
  return /^([01]\d|2[0-3]):[0-5]\d$/.test(String(s || ''));
}

router.get('/', (req, res) => {
  const rows = db.prepare('SELECT * FROM free_time ORDER BY start_time').all();
  res.json(rows.map((r) => Object.assign({}, r, { cycle_label: CYCLE_LABEL[r.cycle_type] || '每日' })));
});

router.post('/', (req, res) => {
  const b = req.body || {};
  if (!validHM(b.start_time) || !validHM(b.end_time)) {
    return res.status(400).json({ ok: false, error: '时间格式应为 HH:MM' });
  }
  if (b.start_time >= b.end_time) {
    return res.status(400).json({ ok: false, error: '结束时间必须晚于开始时间' });
  }
  const cycle = [0, 1, 2].includes(Number(b.cycle_type)) ? Number(b.cycle_type) : 0;
  const info = db.prepare('INSERT INTO free_time (start_time, end_time, cycle_type, enabled, created_at) VALUES (?, ?, ?, ?, ?)')
    .run(b.start_time, b.end_time, cycle, b.enabled === false ? 0 : 1, now());
  res.json({ ok: true, id: Number(info.lastInsertRowid) });
});

router.put('/:id', (req, res) => {
  const id = Number(req.params.id);
  const row = db.prepare('SELECT * FROM free_time WHERE id = ?').get(id);
  if (!row) return res.status(404).json({ ok: false, error: '时段不存在' });
  const b = req.body || {};
  const start = b.start_time !== undefined ? b.start_time : row.start_time;
  const end = b.end_time !== undefined ? b.end_time : row.end_time;
  if (!validHM(start) || !validHM(end)) return res.status(400).json({ ok: false, error: '时间格式应为 HH:MM' });
  if (start >= end) return res.status(400).json({ ok: false, error: '结束时间必须晚于开始时间' });
  const cycle = b.cycle_type !== undefined ? Number(b.cycle_type) : row.cycle_type;
  const enabled = b.enabled !== undefined ? (b.enabled ? 1 : 0) : row.enabled;
  db.prepare('UPDATE free_time SET start_time = ?, end_time = ?, cycle_type = ?, enabled = ? WHERE id = ?')
    .run(start, end, cycle, enabled, id);
  res.json({ ok: true });
});

router.delete('/:id', (req, res) => {
  const info = db.prepare('DELETE FROM free_time WHERE id = ?').run(Number(req.params.id));
  res.json({ ok: info.changes > 0 });
});

module.exports = router;