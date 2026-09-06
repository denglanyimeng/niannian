// 艾宾浩斯智能时间规划引擎
// 包含：标准/自定义间隔、掌握度动态调节、空闲时段分配、过载优先级调度
const { db } = require('./db');

const DEFAULT_INTERVALS = [1, 2, 4, 7, 15, 30, 60];
const DAY_MS = 24 * 60 * 60 * 1000;
const DEFAULT_FLOW = [0, 0, 1, 1, 2, 2, 2, 2, 2]; // 0 选择 / 1 填空 / 2 简答

function getIntervals() {
  const cfg = db.prepare('SELECT ebbinghaus_default FROM system_config WHERE id = 1').get();
  try {
    const arr = JSON.parse(cfg.ebbinghaus_default || '[]');
    if (Array.isArray(arr) && arr.length) return arr;
  } catch (e) {}
  return DEFAULT_INTERVALS;
}

// 根据「本次复习之后的次数」和掌握度，计算下一次复习间隔（天）
function nextIntervalDays(reviewCountAfter, masterRate) {
  const intervals = getIntervals();
  const idx = Math.min(Math.max(reviewCountAfter - 1, 0), intervals.length - 1);
  const base = intervals[idx];
  // 第一次复习完成后固定安排次日复习，掌握度调节从第二次复习开始生效
  if (reviewCountAfter <= 1) return Math.max(base, 1);
  let factor = 1;
  if (masterRate >= 90) factor = 1.5;
  else if (masterRate >= 75) factor = 1.25;
  else if (masterRate >= 60) factor = 1;
  else if (masterRate >= 40) factor = 0.75;
  else factor = 0.5;
  return Math.max(Math.round(base * factor), 0);
}

// 知识点题型流程：优先使用自定义流程
function flowFor(kp) {
  if (kp.custom_exam_flow) {
    try {
      const f = JSON.parse(kp.custom_exam_flow);
      if (Array.isArray(f) && f.length) return f;
    } catch (e) {}
  }
  return DEFAULT_FLOW;
}

function questionTypeForReview(kp, reviewCount) {
  const flow = flowFor(kp);
  return flow[Math.min(Math.max(reviewCount - 1, 0), flow.length - 1)];
}

// 按复习次数返回出题模式：0=只选择题　1=选择题+填空题　2=选择题+填空题+简答题
// 第1、2次：只选择；第3、4次：选择+填空；第5、6次及以后：选择+填空+简答
function quizModeForReview(reviewCount) {
  const n = Number(reviewCount) || 1;
  if (n <= 2) return 0;
  if (n <= 4) return 1;
  return 2;
}

// 各模式默认题量预算（对应精简8题 / 标准16题 / 加量24题）
function modeBudget(mode) {
  return [8, 16, 24][(mode === 0 || mode === 1 || mode === 2) ? mode : 2];
}

// ---------- 空闲时段 ----------
function getSlots() {
  return db.prepare('SELECT * FROM free_time WHERE enabled = 1 ORDER BY start_time').all();
}

function parseHM(s) {
  const [h, m] = String(s || '00:00').split(':').map(Number);
  return [(h || 0), (m || 0)];
}

function startOfDay(ms) {
  const d = new Date(ms);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

// 循环周期判断：0 每日、1 每两天、2 每三天（以该时段的创建日为基准）
function slotMatchesDay(slot, dayMs) {
  if (slot.cycle_type === 0) return true;
  const createdMs = Date.parse(slot.created_at);
  const diff = Math.round((dayMs - startOfDay(createdMs)) / DAY_MS);
  if (diff < 0) return false;
  return diff % (slot.cycle_type + 1) === 0;
}

function findNextSlot(startMs, slots) {
  const nowMs = Date.now();
  for (let d = 0; d < 90; d++) {
    const dayMs = startOfDay(startMs + d * DAY_MS);
    const dayEnd = dayMs + DAY_MS;
    for (const s of slots) {
      if (!s.enabled) continue;
      if (!slotMatchesDay(s, dayMs)) continue;
      const [sh, sm] = parseHM(s.start_time);
      const [eh, em] = parseHM(s.end_time);
      const t0 = dayMs + sh * 3600000 + sm * 60000;
      const t1 = dayMs + eh * 3600000 + em * 60000;
      if (t1 <= Math.max(startMs, nowMs)) continue;
      const target = Math.max(t0, startMs, nowMs);
      if (target < dayEnd && target <= t1) return new Date(target);
      if (t0 < dayEnd) return new Date(t0);
    }
  }
  return new Date(Math.max(startMs, nowMs));
}

// 计算某知识点下一次复习时间（复习完成后调用）
function scheduleNextReview(kp, reviewedAtMs) {
  const days = nextIntervalDays(kp.review_count, kp.master_rate);
  const ideal = new Date(reviewedAtMs + days * DAY_MS);
  const slots = getSlots();
  if (!slots.length) {
    ideal.setHours(20, 0, 0, 0); // 无空闲时段配置时，默认安排在晚上 8 点
    return ideal.toISOString();
  }
  return findNextSlot(ideal.getTime(), slots).toISOString();
}

// 新建知识点时分配首个复习时间：保存当天即可开始第一次复习
function scheduleFirstReview(kp, createdMs) {
  const startMs = createdMs || Date.now();
  const todayEnd = startOfDay(startMs) + DAY_MS;
  const slots = getSlots();
  if (slots.length) {
    const slot = findNextSlot(startMs, slots);
    if (slot.getTime() < todayEnd) return slot.toISOString();
  }
  // 今天没有可用的空闲时段（或未配置时段）时，直接安排在当前时间，保证保存后即可开始第一次复习
  return new Date(startMs).toISOString();
}

// ---------- 今日待复习与过载调度 ----------
function durationOf(kp) {
  return kp.manual_duration || kp.estimate_duration || 10;
}

function urgencyHours(kp, nowMs) {
  const due = Date.parse(kp.next_review_time);
  return (nowMs - due) / 3600000;
}

function todayCapacityMinutes(nowMs) {
  const slots = getSlots();
  let total = 0;
  const dayMs = startOfDay(nowMs);
  for (const s of slots) {
    if (!s.enabled) continue;
    if (!slotMatchesDay(s, dayMs)) continue;
    const [sh, sm] = parseHM(s.start_time);
    const [eh, em] = parseHM(s.end_time);
    const mins = (eh * 60 + em) - (sh * 60 + sm);
    if (mins > 0) total += mins;
  }
  return total;
}

// 规划今日任务：优先临近遗忘临界点的知识点；超容量的顺延到后续安排
function planDueTasks(nowMs) {
  const now = nowMs || Date.now();
  const todayEnd = startOfDay(now) + DAY_MS;
  const kps = db.prepare("SELECT * FROM knowledge_point WHERE next_review_time IS NOT NULL AND next_review_time != ''").all()
    .map((k) => Object.assign({}, k, {
      estimate_duration: k.estimate_duration || 10,
      manual_duration: k.manual_duration,
      master_rate: k.master_rate || 0
    }));
  const due = kps.filter((k) => Date.parse(k.next_review_time) < todayEnd);
  due.sort((a, b) => urgencyHours(b, now) - urgencyHours(a, now));
  const capacity = todayCapacityMinutes(now);
  const tasks = [];
  const overloaded = [];
  let used = 0;
  for (const k of due) {
    const d = durationOf(k);
    const item = {
      kp_id: k.id,
      name: k.name,
      due_at: k.next_review_time,
      urgency_hours: Math.round(urgencyHours(k, now) * 10) / 10,
      duration_minutes: d,
      review_count: k.review_count,
      master_rate: k.master_rate,
      question_type: questionTypeForReview(k, k.review_count + 1)
    };
    if (used + d <= capacity) {
      tasks.push(item);
      used += d;
    } else {
      overloaded.push(item);
    }
  }
  return { tasks, overloaded, capacity_minutes: capacity, used_minutes: used };
}

// 规划指定某天的待复习任务（用于展示明日计划）
function planDayTasks(dayMs) {
  const start = startOfDay(dayMs);
  const end = start + DAY_MS;
  return db.prepare("SELECT * FROM knowledge_point WHERE next_review_time IS NOT NULL AND next_review_time != ''").all()
    .map((k) => Object.assign({}, k, {
      estimate_duration: k.estimate_duration || 10,
      manual_duration: k.manual_duration,
      master_rate: k.master_rate || 0
    }))
    .filter((k) => {
      const t = Date.parse(k.next_review_time);
      return t >= start && t < end;
    })
    .map((k) => ({
      kp_id: k.id,
      name: k.name,
      due_at: k.next_review_time,
      duration_minutes: durationOf(k),
      review_count: k.review_count,
      master_rate: k.master_rate,
      question_type: questionTypeForReview(k, k.review_count + 1)
    }))
    .sort((a, b) => Date.parse(a.due_at) - Date.parse(b.due_at));
}

// 掌握度更新：本次得分与历史掌握度加权
function updateMasterRate(oldRate, score) {
  const blended = Math.round(oldRate * 0.65 + score * 0.35);
  const boosted = score >= 85 ? Math.max(blended, oldRate + 5) : blended;
  return Math.max(0, Math.min(100, boosted));
}

// 复习强度建议文案
function intensitySuggestion(score, masterRate) {
  if (score < 60) return '加强复习：建议明天再次巩固，重新学习后重做题目';
  if (masterRate < 50) return '重点强化：缩短复习间隔，尽快安排下一次复习';
  if (masterRate < 75) return '正常复习：按计划继续，保持当前间隔';
  return '巩固保持：掌握良好，可适当拉长复习间隔';
}

module.exports = {
  getIntervals,
  nextIntervalDays,
  questionTypeForReview,
  quizModeForReview,
  modeBudget,
  scheduleNextReview,
  scheduleFirstReview,
  planDueTasks,
  planDayTasks,
  updateMasterRate,
  intensitySuggestion,
  durationOf,
  urgencyHours,
  getSlots,
  startOfDay
};