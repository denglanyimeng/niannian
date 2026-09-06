// 仪表盘统计
const express = require('express');
const { db } = require('../db');
const { planDueTasks, startOfDay } = require('../ebbinghaus');

const router = express.Router();
const DAY_MS = 24 * 60 * 60 * 1000;

router.get('/', (req, res) => {
  const now = Date.now();
  const total = db.prepare('SELECT COUNT(*) AS c FROM knowledge_point').get().c;
  const duePlan = planDueTasks(now);
  const avgRateRow = db.prepare('SELECT AVG(master_rate) AS a FROM knowledge_point').get();
  const mastered = db.prepare('SELECT COUNT(*) AS c FROM knowledge_point WHERE master_rate >= 80').get().c;
  const reviewTotal = db.prepare('SELECT COUNT(*) AS c FROM review_record').get().c;
  const errorTotal = db.prepare('SELECT COUNT(*) AS c FROM error_book').get().c;
  const slots = db.prepare('SELECT COUNT(*) AS c FROM free_time WHERE enabled = 1').get().c;

  // 未来 7 天复习计划
  const upcoming = [];
  const todayStart = startOfDay(now);
  for (let d = 1; d <= 7; d++) {
    const dayStart = todayStart + d * DAY_MS;
    const dayEnd = dayStart + DAY_MS;
    const kps = db.prepare('SELECT * FROM knowledge_point WHERE next_review_time IS NOT NULL').all()
      .filter((k) => {
        const t = Date.parse(k.next_review_time);
        return t >= dayStart && t < dayEnd;
      });
    upcoming.push({ date: new Date(dayStart).toISOString(), count: kps.length });
  }

  res.json({
    total_kps: total,
    due_today: duePlan.tasks.length,
    overdue_count: duePlan.tasks.filter((t) => t.urgency_hours > 0).length,
    overloaded_count: duePlan.overloaded.length,
    avg_master_rate: avgRateRow.a ? Math.round(avgRateRow.a) : 0,
    mastered_count: mastered,
    review_total: reviewTotal,
    error_total: errorTotal,
    free_slots: slots,
    upcoming
  });
});

module.exports = router;