// 笔记录入：图片 / PDF / 手动文本 → AI 解析为知识点 → 保存（自动合并重复知识点）
const express = require('express');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const pdfParse = require('pdf-parse');
const { db, now } = require('../db');
const { parseNote, estimateDuration, templateSupportsImage, summarizeNote, summarizeNoteFromImage, splitNote } = require('../ai');
const { runOcr } = require('../ocr');
const { scheduleFirstReview } = require('../ebbinghaus');

const router = express.Router();
const UPLOAD_DIR = path.join(__dirname, '..', '..', 'data', 'uploads');
if (!fs.existsSync(UPLOAD_DIR)) fs.mkdirSync(UPLOAD_DIR, { recursive: true });

const upload = multer({
  storage: multer.diskStorage({
    destination: UPLOAD_DIR,
    filename: (req, file, cb) => cb(null, Date.now() + '-' + Math.random().toString(36).slice(2, 8) + path.extname(file.originalname || ''))
  }),
  limits: { fileSize: 20 * 1024 * 1024 }
});

function normName(s) {
  return String(s || '').replace(/\s+/g, '').toLowerCase();
}

// 查找与已有知识点重复的项
function findDuplicates(items) {
  const all = db.prepare('SELECT id, name, content FROM knowledge_point').all();
  const dups = [];
  for (const item of items) {
    const n = normName(item.name);
    const hit = all.find((k) => normName(k.name) === n || (n && k.content && item.content && normName(k.content).includes(normName(k.content))));
    const hit2 = all.find((k) => normName(k.name).includes(n) || n.includes(normName(k.name)));
    const found = hit || hit2;
    if (found && normName(found.name) === n) {
      dups.push({ index: items.indexOf(item), existing: { id: found.id, name: found.name } });
    }
  }
  return dups;
}

// 解析笔记：支持 text 字段或上传文件（图片 / PDF）
router.post('/parse', upload.single('file'), async (req, res) => {
  try {
    const textInput = (req.body && req.body.text || '').trim();
    let result;
    let source = 'manual';

    if (req.file) {
      const ext = path.extname(req.file.originalname || '').toLowerCase();
      const buf = fs.readFileSync(req.file.path);
      if (['.png', '.jpg', '.jpeg', '.webp', '.gif', '.bmp'].includes(ext)) {
        source = 'image';
        // 优先本地 OCR 提取文字，再交给 AI 解析（兼容 DeepSeek 等纯文字模型）
        const ocrRes = await runOcr(req.file.path);
        if (ocrRes.ok && ocrRes.text.trim()) {
          source = 'image-ocr';
          result = await parseNote({ text: ocrRes.text, model: req.body.model });
        } else if (templateSupportsImage()) {
          // 配置了支持图片的视觉模型时，直接把图片发给 AI
          source = 'image-ai';
          result = await parseNote({ imageBase64: buf.toString('base64'), imageUrl: null, model: req.body.model });
        } else if (ocrRes.ok && !ocrRes.text.trim()) {
          result = { error: '图片中没有识别到文字（可能是图表、公式或图片不清晰）。请换更清晰的图片，或改用手动粘贴文字。', items: [] };
        } else {
          result = { error: '本地 OCR 不可用：' + (ocrRes.error || '') + '。可运行 pip install rapidocr-onnxruntime 启用离线识别，或在设置中配置支持图片的大模型。', items: [] };
        }
      } else if (ext === '.pdf') {
        source = 'pdf';
        try {
          const pdfData = await pdfParse(buf);
          const pdfText = pdfData.text || '';
          if (!pdfText.trim()) throw new Error('PDF 未解析出文本');
          result = await parseNote({ text: pdfText, model: req.body.model });
        } catch (e) {
          return res.status(400).json({ ok: false, error: 'PDF 解析失败：' + e.message });
        }
      } else {
        return res.status(400).json({ ok: false, error: '不支持的文件类型：' + ext });
      }
    } else if (textInput) {
      result = await parseNote({ text: textInput, model: req.body.model });
    } else {
      return res.status(400).json({ ok: false, error: '请上传文件或输入文本' });
    }

    if (result && result.error) {
      return res.json({ ok: true, source, error: result.error, items: result.fallback || [] });
    }
    const items = result || [];
    const duplicates = findDuplicates(items);
    res.json({ ok: true, source, items, duplicates });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// 保存解析出的知识点（重复项自动合并到已有知识点）
router.post('/save', async (req, res) => {
  const items = Array.isArray(req.body && req.body.items) ? req.body.items : [];
  if (!items.length) return res.status(400).json({ ok: false, error: '没有可保存的知识点' });

  const created = [];
  const merged = [];
  for (const item of items) {
    const name = String(item.name || '').trim();
    const content = String(item.content || '').trim();
    if (!name) continue;
    const tags = Array.isArray(item.tags) ? item.tags.map((t) => String(t).trim()).filter(Boolean) : [];

    // 重复检测：名称一致或高度相似 → 合并（追加内容）
    const all = db.prepare('SELECT id, name, content FROM knowledge_point').all();
    const nn = normName(name);
    const existing = all.find((k) => normName(k.name) === nn) ||
      all.find((k) => normName(k.name).includes(nn) && nn.length >= 2);
    if (existing) {
      const mergedContent = existing.content.includes(content) ? existing.content : existing.content + '\n' + content;
      db.prepare('UPDATE knowledge_point SET content = ? WHERE id = ?').run(mergedContent, existing.id);
      merged.push({ id: existing.id, name: existing.name });
      continue;
    }

    const ts = now();
    const info = db.prepare(`INSERT INTO knowledge_point
      (name, content, tag_tree, estimate_duration, manual_duration, custom_exam_flow, master_rate, next_review_time, last_study_time, review_count, created_at)
      VALUES (?, ?, ?, ?, NULL, NULL, 0, NULL, NULL, 0, ?)`).run(name, content, JSON.stringify(tags), 10, ts);
    const kpId = Number(info.lastInsertRowid);
    // AI 时长预估（失败则保持默认 10 分钟）
    const est = await estimateDuration({ name, content }).catch(() => 10);
    db.prepare('UPDATE knowledge_point SET estimate_duration = ? WHERE id = ?').run(est, kpId);
    const kp = db.prepare('SELECT * FROM knowledge_point WHERE id = ?').get(kpId);
    const firstReview = scheduleFirstReview(kp, Date.now());
    db.prepare('UPDATE knowledge_point SET next_review_time = ?, last_study_time = ? WHERE id = ?').run(firstReview, ts, kpId);
    created.push({ id: kpId, name });
  }

  res.json({ ok: true, created, merged });
});


// ---------- 复习块三步录入：全文+摘要 → 分点 → 保存 ----------

// 步骤 1：解析全文并生成 AI 摘要（返回全文供确认识别是否正确）
router.post('/analyze', upload.single('file'), async (req, res) => {
  try {
    const textInput = (req.body && req.body.text || '').trim();
    let fullText = '';
    let source = 'manual';
    if (req.file) {
      const ext = path.extname(req.file.originalname || '').toLowerCase();
      const buf = fs.readFileSync(req.file.path);
      if (['.png', '.jpg', '.jpeg', '.webp', '.gif', '.bmp'].includes(ext)) {
        source = 'image';
        const ocrRes = await runOcr(req.file.path);
        if (ocrRes.ok && ocrRes.text.trim()) {
          source = 'image-ocr';
          fullText = ocrRes.text;
        } else if (templateSupportsImage()) {
          source = 'image-ai';
          const summary = await summarizeNoteFromImage(buf.toString('base64'));
          return res.json({ ok: true, source, text: '', summary });
        } else if (ocrRes.ok && !ocrRes.text.trim()) {
          return res.json({ ok: true, source, error: '图片中没有识别到文字（可能是图表、公式或图片不清晰）。请换更清晰的图片，或改用手动粘贴文字。', text: '' });
        } else {
          return res.json({ ok: true, source, error: '本地 OCR 不可用：' + (ocrRes.error || '') + '。可运行 pip install rapidocr-onnxruntime 启用离线识别，或在设置中配置支持图片的大模型。', text: '' });
        }
      } else if (ext === '.pdf') {
        source = 'pdf';
        try {
          const pdfData = await pdfParse(buf);
          fullText = pdfData.text || '';
          if (!fullText.trim()) throw new Error('PDF 未解析出文本');
        } catch (e) {
          return res.status(400).json({ ok: false, error: 'PDF 解析失败：' + e.message });
        }
      } else {
        return res.status(400).json({ ok: false, error: '不支持的文件类型：' + ext });
      }
    } else if (textInput) {
      fullText = textInput;
    } else {
      return res.status(400).json({ ok: false, error: '请上传文件或输入文本' });
    }
    const summary = await summarizeNote(fullText);
    res.json({ ok: true, source, text: fullText, summary });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// 步骤 2：基于摘要与全文生成概括性要点（可反复调用调整）
router.post('/split', async (req, res) => {
  const text = String(req.body && req.body.text || '').trim();
  const summary = String(req.body && req.body.summary || '');
  if (!text) return res.status(400).json({ ok: false, error: '缺少笔记全文' });
  const points = await splitNote(text, summary);
  res.json({ ok: true, points });
});

// 步骤 3：整篇笔记保存为一个复习块（单条记录）
router.post('/save-block', async (req, res) => {
  const b = req.body || {};
  const name = String(b.name || '').trim();
  const content = String(b.content || '').trim();
  if (!name) return res.status(400).json({ ok: false, error: '复习块名称不能为空' });
  const summary = String(b.summary || '').trim();
  const points = Array.isArray(b.points) ? b.points.filter((pt) => pt && String(pt.name || '').trim()) : [];
  const tags = Array.isArray(b.tags) ? b.tags.map((t) => String(t).trim()).filter(Boolean) : [];
  const ts = now();
  const info = db.prepare(`INSERT INTO knowledge_point
    (name, content, summary, points, tag_tree, estimate_duration, manual_duration, custom_exam_flow, master_rate, next_review_time, last_study_time, review_count, created_at)
    VALUES (?, ?, ?, ?, ?, 10, NULL, NULL, 0, NULL, NULL, 0, ?)`)
    .run(name, content, summary, JSON.stringify(points), JSON.stringify(tags), ts);
  const id = Number(info.lastInsertRowid);
  const kp = db.prepare('SELECT * FROM knowledge_point WHERE id = ?').get(id);
  const est = await estimateDuration({ name, content: (summary || content).slice(0, 800) }).catch(() => 10);
  db.prepare('UPDATE knowledge_point SET estimate_duration = ? WHERE id = ?').run(est, id);
  const firstReview = scheduleFirstReview(kp, Date.now());
  db.prepare('UPDATE knowledge_point SET next_review_time = ?, last_study_time = ? WHERE id = ?').run(firstReview, ts, id);
  res.json({ ok: true, id, next_review_time: firstReview, point_count: points.length });
});

module.exports = router;