// 仪表盘统计
const express = require('express');
const { db } = require('../db');
const { planDueTasks, startOfDay } = require('../ebbinghaus');

const router = express.Router();
const DAY_MS = 24 * 60 * 60 * 1000;
const MAX_TREND_DAYS = 90;
const RECENT_LIMIT = 20;

const pad2 = (n) => String(n).padStart(2, '0');

// 把时间戳格式化成「本机时区的日期」（YYYY-MM-DD）。
// review_time / create_time 存的是 ISO(UTC) 字符串，直接取前 10 位分组会把凌晨时段的
// 记录归到错误的日期上，所以这里统一按本机时区换算，和 startOfDay 保持一致。
function localDayKey(value) {
  const d = value instanceof Date ? value : new Date(value);
  if (isNaN(d.getTime())) return '';
  return d.getFullYear() + '-' + pad2(d.getMonth() + 1) + '-' + pad2(d.getDate());
}

// 最近若干条复习记录（带知识点名称），供仪表盘展示
function recentRecords(limit) {
  const rows = db.prepare(`
    SELECT r.id, r.kp_id, r.review_time, r.score, r.master_rate, k.name AS kp_name
    FROM review_record r
    LEFT JOIN knowledge_point k ON k.id = r.kp_id
    ORDER BY r.review_time DESC, r.id DESC
    LIMIT ?`).all(limit);
  return rows.map((r) => ({
    id: r.id,
    kp_id: r.kp_id,
    kp_name: r.kp_name || ('知识点 #' + r.kp_id),
    review_time: r.review_time,
    day: localDayKey(r.review_time),
    score: Number(r.score) || 0,
    master_rate: Number(r.master_rate) || 0
  }));
}

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
    upcoming,
    recent_records: recentRecords(RECENT_LIMIT)
  });
});

// 复习趋势：最近 days 天，每天复习了多少个知识点（去重）、复习次数、平均得分、新增错题
router.get('/trend', (req, res) => {
  const days = Math.min(MAX_TREND_DAYS, Math.max(3, Number(req.query.days) || 14));
  const todayStart = startOfDay(Date.now());
  const firstStart = todayStart - (days - 1) * DAY_MS;

  const buckets = [];
  const byKey = {};
  for (let i = 0; i < days; i++) {
    const d = new Date(firstStart + i * DAY_MS);
    const b = {
      date: localDayKey(d),
      month: d.getMonth() + 1,
      day: d.getDate(),
      week: d.getDay(),
      isToday: d.getTime() === todayStart,
      kpIds: new Set(),
      review_count: 0,
      scoreSum: 0,
      scoreCount: 0,
      error_count: 0
    };
    buckets.push(b);
    byKey[b.date] = b;
  }

  // 多取一天作为裕量，避免「本地日边界 ↔ UTC 存储」把边界日的记录漏掉
  const sinceIso = new Date(firstStart - DAY_MS).toISOString();

  const rows = db.prepare('SELECT kp_id, review_time, score FROM review_record WHERE review_time >= ?').all(sinceIso);
  for (const r of rows) {
    const b = byKey[localDayKey(r.review_time)];
    if (!b) continue;
    b.review_count++;
    if (r.kp_id != null) b.kpIds.add(r.kp_id);
    if (typeof r.score === 'number' && !isNaN(r.score)) { b.scoreSum += r.score; b.scoreCount++; }
  }

  const errRows = db.prepare('SELECT create_time FROM error_book WHERE create_time >= ?').all(sinceIso);
  for (const r of errRows) {
    const b = byKey[localDayKey(r.create_time)];
    if (b) b.error_count++;
  }

  const series = buckets.map((b) => ({
    date: b.date,
    month: b.month,
    day: b.day,
    week: b.week,
    is_today: b.isToday,
    kp_count: b.kpIds.size,      // 当天复习了几个知识点（去重）—— 图表主指标
    review_count: b.review_count, // 当天提交了几次批改
    avg_score: b.scoreCount ? Math.round(b.scoreSum / b.scoreCount) : 0,
    has_score: b.scoreCount > 0,  // 当天是否有得分数据（折线要断开没有数据的日子）
    error_count: b.error_count
  }));

  const totalKp = series.reduce((s, x) => s + x.kp_count, 0);
  const activeDays = series.filter((x) => x.kp_count > 0).length;
  const scoredDays = series.filter((x) => x.has_score);
  const totalReviews = series.reduce((s, x) => s + x.review_count, 0);

  res.json({
    days,
    series,
    summary: {
      total_kp: totalKp,
      total_reviews: totalReviews,
      active_days: activeDays,
      avg_per_active_day: activeDays ? Math.round((totalKp / activeDays) * 10) / 10 : 0,
      max_kp: series.reduce((m, x) => Math.max(m, x.kp_count), 0),
      avg_score: scoredDays.length
        ? Math.round(scoredDays.reduce((s, x) => s + x.avg_score, 0) / scoredDays.length)
        : 0,
      total_error: series.reduce((s, x) => s + x.error_count, 0)
    }
  });
});

module.exports = router;
