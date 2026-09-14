// 复习流程：今日任务规划 → 生成题目 → 提交批改 → 更新掌握度与下次复习时间
const express = require('express');
const { db, now } = require('../db');
const { generateQuestions, questionCountFor, generateBlockQuestions, normAnswer, findChoiceIndex, fillAnswerCorrect, looseKey } = require('../ai');
const {
  questionTypeForReview, scheduleNextReview, planDueTasks, planDayTasks,
  updateMasterRate, intensitySuggestion, startOfDay, quizModeForReview, modeBudget
} = require('../ebbinghaus');

const router = express.Router();
const TYPE_LABEL = { 0: '选择题', 1: '填空题', 2: '简答题' };
const DAY_MS = 24 * 60 * 60 * 1000;

// 今日待复习任务
router.get('/due', (req, res) => {
  const plan = planDueTasks(Date.now());
  plan.tomorrow = planDayTasks(startOfDay(Date.now()) + DAY_MS);
  res.json(plan);
});

// 复习记录（可按知识点过滤）
router.get('/records', (req, res) => {
  const kpId = Number(req.query.kp_id || 0);
  const rows = kpId
    ? db.prepare('SELECT * FROM review_record WHERE kp_id = ? ORDER BY review_time DESC').all(kpId)
    : db.prepare('SELECT * FROM review_record ORDER BY review_time DESC LIMIT 100').all();
  res.json(rows);
});

// 开始复习：为指定知识点生成题目（AI 优先，失败降级本地出题）
router.post('/start', async (req, res) => {
  const ids = Array.isArray(req.body && req.body.kp_ids) ? req.body.kp_ids.map(Number) : [];
  const maxCount = Number(req.body && req.body.count) || 0;
  if (!ids.length) return res.status(400).json({ ok: false, error: '请选择要复习的知识点' });
  const sessions = [];
  const warnings = [];
  for (const id of ids) {
    const kp = db.prepare('SELECT * FROM knowledge_point WHERE id = ?').get(id);
    if (!kp) continue;
    const reviewCount = (kp.review_count || 0) + 1;
    const mode = quizModeForReview(reviewCount);
    const qType = questionTypeForReview(kp, reviewCount);
    // 题量：用户手动选档位(8/16/24)用选的值；自动(0)则按复习模式预算(8/16/24)
    const effMax = maxCount > 0 ? maxCount : modeBudget(mode);
    const qCount = maxCount > 0
      ? Math.min(12, Math.max(questionCountFor(kp, ids.length), Math.ceil(maxCount / 4)))
      : Math.min(modeBudget(mode), Math.max(questionCountFor(kp, ids.length), 1));
    let generated = [];
    let blockPoints = [];
    try { blockPoints = JSON.parse(kp.points || '[]'); } catch (e) { blockPoints = []; }
    if (Array.isArray(blockPoints) && blockPoints.length) {
      generated = await generateBlockQuestions(kp, blockPoints, reviewCount, effMax, mode);
    } else {
      generated = await generateQuestions(kp, reviewCount, qType, qCount);
    }
    const ts = now();
    const questions = [];
    for (const q of generated) {
      const info = db.prepare(`INSERT INTO question
        (kp_id, question_text, answer, question_type, choices, hint, is_error, created_at)
        VALUES (?, ?, ?, ?, ?, ?, 0, ?)`)
        .run(id, q.question_text, q.answer, q.question_type || qType,
          q.choices ? JSON.stringify(q.choices) : null, q.hint || '', ts);
      questions.push({
        id: Number(info.lastInsertRowid),
        question_text: q.question_text,
        answer: q.answer || '',
        question_type: q.question_type || qType,
        choices: q.choices || null,
        hint: q.hint || ''
      });
    }
    // 降级/丢弃必须让用户看见（旧实现是静默降级，用户只会看到莫名其妙的烂题）
    if (generated.degraded) {
      warnings.push('「' + kp.name + '」AI 出题失败，已降级为本地出题：' + (generated.degradeReason || '原因未知'));
    }
    if (generated.invalidDropped) {
      warnings.push('「' + kp.name + '」有 ' + generated.invalidDropped + ' 道 AI 题因答案与选项对不上被丢弃');
    }
    sessions.push({
      kp_id: id,
      kp_name: kp.name,
      review_count: reviewCount,
      question_type: qType,
      question_type_label: TYPE_LABEL[qType] || '简答题',
      source: generated.degraded ? 'offline' : 'ai',
      questions
    });
  }
  res.json({ ok: true, sessions, warnings });
});

// 简答题打分。
// 标准答案常常是一整段（降级出的简答题甚至是整篇笔记），用户只会写要点，
// 因此不能要求逐字覆盖 —— 主要看「用户写的内容有多少是标准答案里也有的」（precision），
// 覆盖率（recall）只占小权重，避免「写对了要点却判 0 分」。
function gradeEssay(userAnswer, answer) {
  const U = looseKey(userAnswer);
  const A = looseKey(answer);
  if (!U) return 0;
  if (!A) return 50;
  if (U === A || U.includes(A)) return 100;      // 写全了
  if (A.includes(U)) {                            // 写出了其中一部分
    const r = U.length / A.length;
    return r >= 0.5 ? 100 : Math.max(60, Math.round(r * 200));
  }
  const bigrams = (s) => { const r = new Set(); for (let i = 0; i < s.length - 1; i++) r.add(s.slice(i, i + 2)); return r; };
  const a = bigrams(U);
  const b = bigrams(A);
  if (!a.size || !b.size) return 50;
  let hit = 0;
  for (const g of a) if (b.has(g)) hit++;
  const precision = hit / a.size;
  const recall = hit / b.size;
  const lenGuard = Math.min(1, U.length / 8);     // 短到没有信息量的答案不给高分
  const score = (0.85 * precision + 0.15 * recall) * lenGuard;
  return Math.round(Math.min(100, Math.max(0, score * 100)));
}

// 本地自动批改。
// 选择题一律按"选项下标"判定：旧实现用删掉标点的文本直接比对，
// 会把 {{ .FieldName }} / {{ FieldName }} / {{ .fieldname() }} 视为同一个答案，
// 于是又乱判又乱标（B、D 同时"正确"）。
function gradeAnswer(q, userAnswer) {
  const ua = String(userAnswer || '').trim();
  if (!ua) return 0;
  const qa = String(q.answer || '').trim();

  if (q.question_type === 0) {
    let choices = [];
    try { choices = JSON.parse(q.choices || '[]'); } catch (e) { choices = []; }
    if (!Array.isArray(choices)) choices = [];
    const ci = findChoiceIndex(choices, qa);
    const ui = findChoiceIndex(choices, ua);
    if (ci >= 0 && ui >= 0) return ci === ui ? 100 : 0;
    // 选项定位不到（历史脏数据）→ 退化为严格文本比对，宁可判错也不乱判对
    return normAnswer(ua) === normAnswer(qa) ? 100 : 0;
  }

  if (q.question_type === 2) return gradeEssay(ua, qa);

  // 填空题：符号类答案（如 {{ .FieldName }}）严格比对；
  // 纯文字答案容忍标点、连词、个别字差异（「正确性、有效性、完整性」≈「正确性、有效性和完整性」）
  return fillAnswerCorrect(ua, qa) ? 100 : 0;
}

// 提交批改
router.post('/submit', async (req, res) => {
  const answers = Array.isArray(req.body && req.body.answers) ? req.body.answers : [];
  if (!answers.length) return res.status(400).json({ ok: false, error: '没有可批改的作答' });

  const byQ = {};
  for (const a of answers) byQ[Number(a.q_id)] = String(a.user_answer || '');

  const ids = Object.keys(byQ).map(Number);
  const placeholders = ids.map(() => '?').join(',');
  const questions = db.prepare(`SELECT q.*, k.name AS kp_name, k.master_rate AS old_rate, k.review_count, k.estimate_duration, k.manual_duration
    FROM question q JOIN knowledge_point k ON k.id = q.kp_id WHERE q.id IN (${placeholders})`).all(...ids);
  if (!questions.length) return res.status(404).json({ ok: false, error: '题目不存在' });

  const ts = now();
  const results = [];
  const kpAgg = {};
  const detailScores = {};

  for (const q of questions) {
    const score = gradeAnswer(q, byQ[q.id]);
    detailScores[q.id] = score;
    const isError = score < 60;
    if (!kpAgg[q.kp_id]) kpAgg[q.kp_id] = { scores: [], kp_name: q.kp_name, old_rate: q.old_rate || 0, review_count: q.review_count || 0 };
    kpAgg[q.kp_id].scores.push(score);
    if (isError) {
      db.prepare('UPDATE question SET is_error = 1 WHERE id = ?').run(q.id);
      db.prepare('INSERT INTO error_book (q_id, kp_id, create_time, reason) VALUES (?, ?, ?, ?)')
        .run(q.id, q.kp_id, ts, score === 0 ? '作答错误' : '得分偏低');
    }
  }

  for (const [kpId, agg] of Object.entries(kpAgg)) {
    const id = Number(kpId);
    const score = Math.round(agg.scores.reduce((s, x) => s + x, 0) / agg.scores.length);
    const newRate = updateMasterRate(agg.old_rate, score);
    const reviewCountAfter = agg.review_count + 1;
    db.prepare('UPDATE knowledge_point SET master_rate = ?, review_count = ? WHERE id = ?').run(newRate, reviewCountAfter, id);
    const kp = db.prepare('SELECT * FROM knowledge_point WHERE id = ?').get(id);
    const nextTime = scheduleNextReview(kp, Date.now());
    db.prepare('UPDATE knowledge_point SET next_review_time = ? WHERE id = ?').run(nextTime, id);
    db.prepare('INSERT INTO review_record (kp_id, review_time, score, master_rate, question_type, note) VALUES (?, ?, ?, ?, ?, ?)')
      .run(id, ts, score, newRate, null, agg.scores.length ? '平均得分' : '');
    results.push({
      kp_id: id,
      kp_name: agg.kp_name,
      score,
      master_rate: newRate,
      next_review_time: nextTime,
      suggestion: intensitySuggestion(score, newRate)
    });
  }

  res.json({
    ok: true,
    results,
    details: questions.map((q) => ({
      q_id: q.id,
      kp_id: q.kp_id,
      kp_name: q.kp_name,
      question_text: q.question_text,
      question_type: q.question_type,
      choices: (() => { try { return JSON.parse(q.choices); } catch (e) { return null; } })(),
      answer: q.answer,
      hint: q.hint || '',
      your_answer: byQ[q.id] || '',
      score: detailScores[q.id]
    }))
  });
});

module.exports = router;
// 导出判题函数便于自动化验证（不影响 Express 路由挂载）
module.exports.gradeAnswer = gradeAnswer;