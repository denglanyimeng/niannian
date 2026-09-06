// 知识点管理：增删改查、拆分、合并、自定义标签层级、统计
const express = require('express');
const { db, now } = require('../db');
const { scheduleFirstReview, scheduleNextReview } = require('../ebbinghaus');

const router = express.Router();

function decorate(kp) {
  if (!kp) return kp;
  return Object.assign({}, kp, {
    tag_tree: (() => { try { return JSON.parse(kp.tag_tree || '[]'); } catch (e) { return []; } })(),
    custom_exam_flow: (() => {
      if (!kp.custom_exam_flow) return null;
      try { return JSON.parse(kp.custom_exam_flow); } catch (e) { return null; }
    })(),
    estimate_duration: kp.estimate_duration || 10,
    manual_duration: kp.manual_duration,
    master_rate: kp.master_rate || 0,
    review_count: kp.review_count || 0,
    summary: kp.summary || '',
    points: (() => { try { return JSON.parse(kp.points || '[]'); } catch (e) { return []; } })()
  });
}

// 列表（支持 ?tag= 与 ?q= 过滤）
router.get('/', (req, res) => {
  const tag = (req.query.tag || '').trim();
  const q = (req.query.q || '').trim();
  let rows = db.prepare('SELECT * FROM knowledge_point ORDER BY created_at DESC').all();
  if (tag) rows = rows.filter((k) => (k.tag_tree || '').includes(tag));
  if (q) {
    rows = rows.filter((k) => k.name.includes(q) || k.content.includes(q));
  }
  res.json(rows.map(decorate));
});

// 单个知识点详情
router.get('/:id', (req, res) => {
  const kp = db.prepare('SELECT * FROM knowledge_point WHERE id = ?').get(Number(req.params.id));
  if (!kp) return res.status(404).json({ ok: false, error: '知识点不存在' });
  const records = db.prepare('SELECT * FROM review_record WHERE kp_id = ? ORDER BY review_time DESC LIMIT 20').all(Number(req.params.id));
  res.json({ kp: decorate(kp), records });
});

// 新建知识点（自动分配首次复习时间）
router.post('/', async (req, res) => {
  const b = req.body || {};
  const name = String(b.name || '').trim();
  if (!name) return res.status(400).json({ ok: false, error: '知识点名称不能为空' });
  const content = String(b.content || '').trim();
  const tags = Array.isArray(b.tags) ? b.tags : [];
  const ts = now();
  const info = db.prepare(`INSERT INTO knowledge_point
    (name, content, summary, points, tag_tree, estimate_duration, manual_duration, custom_exam_flow, master_rate, next_review_time, last_study_time, review_count, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0, NULL, NULL, 0, ?)`)
    .run(name, content, String(b.summary || ''), JSON.stringify(Array.isArray(b.points) ? b.points : []), JSON.stringify(tags), b.estimate_duration || 10,
      b.manual_duration ? Number(b.manual_duration) : null,
      b.custom_exam_flow ? JSON.stringify(b.custom_exam_flow) : null, ts);
  const id = Number(info.lastInsertRowid);
  const kp = db.prepare('SELECT * FROM knowledge_point WHERE id = ?').get(id);
  const first = scheduleFirstReview(kp, Date.now());
  db.prepare('UPDATE knowledge_point SET next_review_time = ?, last_study_time = ? WHERE id = ?').run(first, ts, id);
  res.json({ ok: true, id, next_review_time: first });
});

// 更新知识点
router.put('/:id', (req, res) => {
  const id = Number(req.params.id);
  const kp = db.prepare('SELECT * FROM knowledge_point WHERE id = ?').get(id);
  if (!kp) return res.status(404).json({ ok: false, error: '知识点不存在' });
  const b = req.body || {};
  const next = {
    name: b.name !== undefined ? String(b.name).trim() : kp.name,
    content: b.content !== undefined ? String(b.content).trim() : kp.content,
    summary: b.summary !== undefined ? String(b.summary).trim() : kp.summary,
    points: b.points !== undefined ? JSON.stringify(b.points) : kp.points,
    tag_tree: b.tags !== undefined ? JSON.stringify(b.tags) : kp.tag_tree,
    estimate_duration: b.estimate_duration !== undefined ? Number(b.estimate_duration) : kp.estimate_duration,
    manual_duration: b.manual_duration !== undefined ? (b.manual_duration ? Number(b.manual_duration) : null) : kp.manual_duration,
    custom_exam_flow: b.custom_exam_flow !== undefined
      ? (b.custom_exam_flow ? JSON.stringify(b.custom_exam_flow) : null) : kp.custom_exam_flow,
    master_rate: b.master_rate !== undefined ? Number(b.master_rate) : kp.master_rate,
    next_review_time: b.next_review_time !== undefined ? b.next_review_time : kp.next_review_time
  };
  if (!next.name) return res.status(400).json({ ok: false, error: '知识点名称不能为空' });
  db.prepare(`UPDATE knowledge_point SET name=?, content=?, summary=?, points=?, tag_tree=?, estimate_duration=?, manual_duration=?,
    custom_exam_flow=?, master_rate=?, next_review_time=? WHERE id=?`)
    .run(next.name, next.content, next.summary, next.points, next.tag_tree, next.estimate_duration, next.manual_duration,
      next.custom_exam_flow, next.master_rate, next.next_review_time, id);
  res.json({ ok: true });
});

// 删除知识点（级联删除相关记录）
router.delete('/:id', (req, res) => {
  const id = Number(req.params.id);
  db.prepare('DELETE FROM error_book WHERE kp_id = ?').run(id);
  db.prepare('DELETE FROM question WHERE kp_id = ?').run(id);
  db.prepare('DELETE FROM review_record WHERE kp_id = ?').run(id);
  const info = db.prepare('DELETE FROM knowledge_point WHERE id = ?').run(id);
  res.json({ ok: info.changes > 0 });
});

// 拆分知识点：拆成多个独立知识点，原知识点删除
router.post('/:id/split', (req, res) => {
  const id = Number(req.params.id);
  const kp = db.prepare('SELECT * FROM knowledge_point WHERE id = ?').get(id);
  if (!kp) return res.status(404).json({ ok: false, error: '知识点不存在' });
  const parts = Array.isArray(req.body && req.body.parts) ? req.body.parts : [];
  const valid = parts.filter((p) => p && String(p.name || '').trim());
  if (!valid.length) return res.status(400).json({ ok: false, error: '请至少提供一个拆分后的知识点' });
  const tags = (() => { try { return JSON.parse(kp.tag_tree || '[]'); } catch (e) { return []; } })();
  const created = [];
  for (const p of valid) {
    const ts = now();
    const info = db.prepare(`INSERT INTO knowledge_point
      (name, content, tag_tree, estimate_duration, manual_duration, custom_exam_flow, master_rate, next_review_time, last_study_time, review_count, created_at)
      VALUES (?, ?, ?, ?, NULL, NULL, 0, NULL, NULL, 0, ?)`)
      .run(String(p.name).trim(), String(p.content || '').trim(), JSON.stringify(tags), kp.estimate_duration || 10, ts);
    const nid = Number(info.lastInsertRowid);
    const nkp = db.prepare('SELECT * FROM knowledge_point WHERE id = ?').get(nid);
    const first = scheduleFirstReview(nkp, Date.now());
    db.prepare('UPDATE knowledge_point SET next_review_time = ?, last_study_time = ? WHERE id = ?').run(first, ts, nid);
    created.push(nid);
  }
  db.prepare('DELETE FROM error_book WHERE kp_id = ?').run(id);
  db.prepare('DELETE FROM question WHERE kp_id = ?').run(id);
  db.prepare('DELETE FROM review_record WHERE kp_id = ?').run(id);
  db.prepare('DELETE FROM knowledge_point WHERE id = ?').run(id);
  res.json({ ok: true, created });
});

// 合并知识点：合并到第一个 id，其余删除
router.post('/merge', (req, res) => {
  const ids = Array.isArray(req.body && req.body.ids) ? req.body.ids.map(Number).filter(Boolean) : [];
  if (ids.length < 2) return res.status(400).json({ ok: false, error: '请至少选择两个知识点' });
  const main = db.prepare('SELECT * FROM knowledge_point WHERE id = ?').get(ids[0]);
  if (!main) return res.status(404).json({ ok: false, error: '主知识点不存在' });
  const others = ids.slice(1).map((id) => db.prepare('SELECT * FROM knowledge_point WHERE id = ?').get(id)).filter(Boolean);
  const contents = [main.content, ...others.map((k) => k.content)].filter(Boolean).join('\n');
  let mainPoints = [];
  try { mainPoints = JSON.parse(main.points || '[]'); } catch (e) {}
  const mergedPoints = [].concat(mainPoints);
  for (const k of others) {
    try { const pts = JSON.parse(k.points || '[]'); if (Array.isArray(pts)) mergedPoints.push(...pts); } catch (e) {}
  }
  const totalRate = main.master_rate + others.reduce((s, k) => s + (k.master_rate || 0), 0);
  const avgRate = Math.round(totalRate / (1 + others.length));
  const totalCount = main.review_count + others.reduce((s, k) => s + (k.review_count || 0), 0);
  db.prepare('UPDATE knowledge_point SET content = ?, points = ?, master_rate = ?, review_count = ? WHERE id = ?')
    .run(contents, JSON.stringify(mergedPoints), avgRate, totalCount, main.id);
  for (const k of others) {
    db.prepare('UPDATE question SET kp_id = ? WHERE kp_id = ?').run(main.id, k.id);
    db.prepare('UPDATE review_record SET kp_id = ? WHERE kp_id = ?').run(main.id, k.id);
    db.prepare('UPDATE error_book SET kp_id = ? WHERE kp_id = ?').run(main.id, k.id);
    db.prepare('DELETE FROM knowledge_point WHERE id = ?').run(k.id);
  }
  const mkp = db.prepare('SELECT * FROM knowledge_point WHERE id = ?').get(main.id);
  const nextTime = scheduleNextReview(mkp, Date.now());
  db.prepare('UPDATE knowledge_point SET next_review_time = ? WHERE id = ?').run(nextTime, main.id);
  res.json({ ok: true, id: main.id, next_review_time: nextTime });
});

// 全部标签
router.get('/meta/tags', (req, res) => {
  const rows = db.prepare('SELECT tag_tree FROM knowledge_point').all();
  const set = new Set();
  for (const r of rows) {
    try {
      for (const t of JSON.parse(r.tag_tree || '[]')) set.add(String(t));
    } catch (e) {}
  }
  res.json(Array.from(set).sort());
});

module.exports = router;