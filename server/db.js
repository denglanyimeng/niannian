// 数据持久层：Node 内置 SQLite，共 6 张业务表
const { DatabaseSync } = require('node:sqlite');
const path = require('path');
const fs = require('fs');

const DATA_DIR = path.join(__dirname, '..', 'data');
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

const db = new DatabaseSync(path.join(DATA_DIR, 'review-planner.db'));
db.exec('PRAGMA journal_mode = WAL;');
db.exec('PRAGMA foreign_keys = ON;');

db.exec(`
  CREATE TABLE IF NOT EXISTS system_config (
    id INTEGER PRIMARY KEY,
    api_url TEXT DEFAULT '',
    encrypted_api_key TEXT DEFAULT '',
    request_body_template TEXT DEFAULT '',
    ebbinghaus_default TEXT DEFAULT '[1,2,4,7,15,30,60]',
    updated_at TEXT DEFAULT ''
  );

  CREATE TABLE IF NOT EXISTS free_time (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    start_time TEXT NOT NULL,
    end_time TEXT NOT NULL,
    cycle_type INTEGER NOT NULL DEFAULT 0,
    enabled INTEGER NOT NULL DEFAULT 1,
    created_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS knowledge_point (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    content TEXT DEFAULT '',
    tag_tree TEXT DEFAULT '[]',
    estimate_duration INTEGER DEFAULT 10,
    manual_duration INTEGER,
    custom_exam_flow TEXT,
    master_rate INTEGER NOT NULL DEFAULT 0,
    next_review_time TEXT,
    last_study_time TEXT,
    review_count INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS review_record (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    kp_id INTEGER NOT NULL,
    review_time TEXT NOT NULL,
    score INTEGER NOT NULL,
    master_rate INTEGER NOT NULL,
    question_type INTEGER,
    note TEXT DEFAULT ''
  );

  CREATE TABLE IF NOT EXISTS question (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    kp_id INTEGER NOT NULL,
    question_text TEXT NOT NULL,
    answer TEXT NOT NULL,
    question_type INTEGER NOT NULL,
    choices TEXT,
    hint TEXT DEFAULT '',
    is_error INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS error_book (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    q_id INTEGER NOT NULL,
    kp_id INTEGER NOT NULL,
    create_time TEXT NOT NULL,
    reason TEXT DEFAULT ''
  );

  CREATE INDEX IF NOT EXISTS idx_kp_next_review ON knowledge_point(next_review_time);
  CREATE INDEX IF NOT EXISTS idx_review_kp ON review_record(kp_id);
  CREATE INDEX IF NOT EXISTS idx_question_kp ON question(kp_id);
`);

// 初始化系统配置（单行，含默认 DeepSeek 请求模板与默认艾宾浩斯间隔）
const cfg = db.prepare('SELECT id FROM system_config LIMIT 1').get();
if (!cfg) {
  db.prepare(`INSERT INTO system_config
    (id, api_url, encrypted_api_key, request_body_template, ebbinghaus_default, updated_at)
    VALUES (1, '', '', ?, ?, '')`)
    .run(JSON.stringify({
      model: 'deepseek-chat',
      messages: [
        { role: 'system', content: '{{system_prompt}}' },
        { role: 'user', content: '{{prompt}}' }
      ],
      temperature: 0.7
    }), '[1,2,4,7,15,30,60]');
}

// 复习块增强字段（整篇笔记 + AI 总结 + AI 分点）
(() => {
  const cols = db.prepare('PRAGMA table_info(knowledge_point)').all().map((c) => c.name);
  if (!cols.includes('summary')) db.exec("ALTER TABLE knowledge_point ADD COLUMN summary TEXT DEFAULT ''");
  if (!cols.includes('points')) db.exec("ALTER TABLE knowledge_point ADD COLUMN points TEXT DEFAULT '[]'");
})();

(() => {
  const qcols = db.prepare('PRAGMA table_info(question)').all().map((c) => c.name);
  if (!qcols.includes('hint')) db.exec("ALTER TABLE question ADD COLUMN hint TEXT DEFAULT ''");
})();

function now() {
  return new Date().toISOString();
}

module.exports = { db, now };