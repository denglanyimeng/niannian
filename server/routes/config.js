// API 配置管理：密钥加密存储、自定义请求模板管理、连通性测试
const express = require('express');
const { db, now } = require('../db');
const { encrypt, decrypt } = require('../crypto');
const { callAI } = require('../ai');

const router = express.Router();

function sanitize(row) {
  return {
    api_url: row.api_url || '',
    has_api_key: !!(row.encrypted_api_key || ''),
    request_body_template: (() => {
      try { return JSON.parse(row.request_body_template || '{}'); } catch (e) { return {}; }
    })(),
    ebbinghaus_default: (() => {
      try { return JSON.parse(row.ebbinghaus_default || '[]'); } catch (e) { return []; }
    })(),
    updated_at: row.updated_at || ''
  };
}

// 读取配置
router.get('/', (req, res) => {
  const row = db.prepare('SELECT * FROM system_config WHERE id = 1').get();
  res.json(sanitize(row));
});

// 保存配置（api_key 为空字符串表示不修改；填入新值则加密保存）
router.put('/', (req, res) => {
  const body = req.body || {};
  const row = db.prepare('SELECT * FROM system_config WHERE id = 1').get();
  const fields = {
    api_url: typeof body.api_url === 'string' ? body.api_url : row.api_url,
    request_body_template: body.request_body_template !== undefined
      ? JSON.stringify(body.request_body_template) : row.request_body_template,
    ebbinghaus_default: body.ebbinghaus_default !== undefined
      ? JSON.stringify(body.ebbinghaus_default) : row.ebbinghaus_default
  };
  if (typeof body.api_key === 'string' && body.api_key !== '') {
    fields.encrypted_api_key = encrypt(body.api_key);
  } else {
    fields.encrypted_api_key = row.encrypted_api_key;
  }
  db.prepare(`UPDATE system_config SET api_url = ?, encrypted_api_key = ?, request_body_template = ?, ebbinghaus_default = ?, updated_at = ? WHERE id = 1`)
    .run(fields.api_url, fields.encrypted_api_key, fields.request_body_template, fields.ebbinghaus_default, now());
  const updated = db.prepare('SELECT * FROM system_config WHERE id = 1').get();
  res.json(sanitize(updated));
});

// 连通性测试
router.post('/test', async (req, res) => {
  const body = req.body || {};
  const row = db.prepare('SELECT * FROM system_config WHERE id = 1').get();
  const apiUrl = body.api_url !== undefined ? body.api_url : row.api_url;
  const apiKey = body.api_key !== undefined ? body.api_key : (row.encrypted_api_key ? decrypt(row.encrypted_api_key) : '');
  const template = body.request_body_template !== undefined ? body.request_body_template : (() => {
    try { return JSON.parse(row.request_body_template || '{}'); } catch (e) { return {}; }
  })();
  if (!apiUrl) return res.status(400).json({ ok: false, error: '请先填写大模型接口地址' });
  try {
    const override = {
      api_url: apiUrl,
      encrypted_api_key: encrypt(apiKey),
      request_body_template: JSON.stringify(template)
    };
    const reply = await callAI({
      systemPrompt: '你是连接测试助手。',
      prompt: '请只回复两个字：连接成功',
      content: ''
    }, override);
    res.json({ ok: true, reply: reply.slice(0, 200) });
  } catch (e) {
    res.status(502).json({ ok: false, error: e.message });
  }
});

module.exports = router;