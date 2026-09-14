// AI 服务层：负责读取用户配置、渲染自定义请求模板、调用大模型接口
// 覆盖三类任务：笔记解析 / 复习时长预估 / 分层出题
// 容错策略：接口超时、额度耗尽、返回异常时降级为本地离线逻辑，不阻断流程
const { db } = require('./db');
const { decrypt } = require('./crypto');

const TIMEOUT_MS = 120000;
const RETRY_TIMES = 2;        // 网络层失败最多重试 2 次（原来一次都不重试，所以偶发抖动就直接报错）
const RETRY_DELAY_MS = 600;   // 重试间隔，逐次递增

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// 哪些 HTTP 状态码属于「临时故障」，值得重试
function isRetryableStatus(status) {
  return status === 408 || status === 429 || status >= 500;
}

// 标记为「最终错误」：已经带好说明，不再被重试或二次包装
function finalError(msg) {
  const e = new Error(msg);
  e.__final = true;
  return e;
}

// 把 fetch 的网络层失败翻译成能看懂的说明
function describeNetError(e) {
  if (e && e.__final) return e;
  if (e && (e.name === 'AbortError' || /aborted/i.test(String(e.message || '')))) {
    return finalError('接口请求超时（超过 ' + Math.round(TIMEOUT_MS / 1000) + ' 秒没有响应）');
  }
  const c = e && e.cause;
  if (c) {
    const code = String(c.code || '').toUpperCase();
    const raw = [c.code, c.message].filter(Boolean).join(' ').trim();
    let hint = '';
    if (code === 'ENOTFOUND' || code === 'EAI_AGAIN') hint = '域名解析失败：通常是断网、DNS 异常，或开了代理/VPN 导致解析不到';
    else if (code === 'ECONNREFUSED') hint = '连接被拒绝：可能被防火墙、安全软件或代理拦截';
    else if (code === 'ECONNRESET' || code === 'UND_ERR_SOCKET') hint = '连接被重置：常见于空闲连接被中途断开、代理/VPN 干扰或网络不稳定';
    else if (code === 'ETIMEDOUT' || code === 'UND_ERR_CONNECT_TIMEOUT') hint = '连接超时：网络不通或被拦截';
    else if (/CERT|SELF_SIGNED|UNABLE_TO_VERIFY|TLS|SSL/i.test(String(c.code || '') + ' ' + String(c.message || ''))) {
      hint = 'TLS 证书校验失败：可能被代理/抓包软件做了中间人拦截';
    }
    return finalError('网络请求失败（' + raw + '）' + (hint ? ' —— ' + hint : ''));
  }
  return finalError(String((e && e.message) || '网络请求失败'));
}

function getConfig() {
  return db.prepare('SELECT * FROM system_config WHERE id = 1').get() || null;
}

function deepReplace(node, vars) {
  if (typeof node === 'string') {
    let s = node;
    for (const [k, v] of Object.entries(vars)) {
      s = s.split('{{' + k + '}}').join(String(v));
    }
    return s;
  }
  if (Array.isArray(node)) return node.map((x) => deepReplace(x, vars));
  if (node && typeof node === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(node)) out[k] = deepReplace(v, vars);
    return out;
  }
  return node;
}

function templateHasAuth(tpl) {
  const s = JSON.stringify(tpl).toLowerCase();
  return s.includes('authorization') || s.includes('bearer') || s.includes('api_key') || s.includes('apikey');
}

function extractText(data) {
  if (typeof data === 'string') return data.trim();
  if (!data) return '';
  if (Array.isArray(data)) {
    for (const x of data) {
      const t = extractText(x);
      if (t) return t;
    }
    return '';
  }
  const keys = ['output_text', 'output', 'content', 'text', 'answer', 'result', 'message', 'data', 'choices'];
  for (const k of keys) {
    if (data[k] !== undefined) {
      const t = extractText(data[k]);
      if (t) return t;
    }
  }
  for (const v of Object.values(data)) {
    const t = extractText(v);
    if (t) return t;
  }
  return '';
}

function extractJson(text) {
  if (!text) return null;
  let candidate = String(text).trim();
  // 仅当整段以代码围栏开头时才剥除首尾围栏（JSON 内容里的代码示例含 ``` 时不能误剥）
  if (candidate.startsWith('```')) {
    const m = candidate.match(/^```(?:json)?[ \t]*\r?\n?([\s\S]*?)\r?\n?```\s*$/);
    if (m) candidate = m[1].trim();
  }
  const tryParse = (str) => {
    try { return JSON.parse(str); } catch (e) { return undefined; }
  };
  // 1) 整体就是 JSON
  let v = tryParse(candidate);
  if (v !== undefined) return v;
  // 2) 以 [ 开头优先按数组提取，以 { 开头优先按对象提取
  if (candidate[0] === '[') {
    const ae = candidate.lastIndexOf(']');
    if (ae > 0) { v = tryParse(candidate.slice(0, ae + 1)); if (v !== undefined) return v; }
  } else if (candidate[0] === '{') {
    const ce = candidate.lastIndexOf('}');
    if (ce > 0) { v = tryParse(candidate.slice(0, ce + 1)); if (v !== undefined) return v; }
  }
  // 3) 退而求其次：从第一个 { 截到最后一个 }
  const cs = candidate.indexOf('{');
  const ce = candidate.lastIndexOf('}');
  if (cs >= 0 && ce > cs) { v = tryParse(candidate.slice(cs, ce + 1)); if (v !== undefined) return v; }
  // 4) 从第一个 [ 截到最后一个 ]
  const as = candidate.indexOf('[');
  const ae2 = candidate.lastIndexOf(']');
  if (as >= 0 && ae2 > as) { v = tryParse(candidate.slice(as, ae2 + 1)); if (v !== undefined) return v; }
  return null;
}

// 发送一次 AI 请求
async function callAI(task, cfgOverride) {
  const cfg = cfgOverride || getConfig();
  if (!cfg || !cfg.api_url) throw new Error('未配置大模型接口地址');
  let template;
  try { template = JSON.parse(cfg.request_body_template || '{}'); } catch (e) { template = {}; }
  if (!template || typeof template !== 'object') template = {};

  const key = decrypt(cfg.encrypted_api_key || '');
  const vars = {
    system_prompt: task.systemPrompt || '',
    prompt: task.prompt || '',
    content: task.content || '',
    image_base64: task.imageBase64 || '',
    image_data_url: task.imageDataUrl || (task.imageBase64 ? 'data:image/png;base64,' + task.imageBase64 : ''),
    image_url: task.imageUrl || '',
    model: task.model || template.model || 'deepseek-chat',
    api_key: key
  };
  const body = deepReplace(template, vars);
  const headers = { 'Content-Type': 'application/json' };
  if (key && !templateHasAuth(template)) headers['Authorization'] = 'Bearer ' + key;

  // 带重试的请求：网络层抖动、5xx/429 这类临时故障再试几次，
  // 避免「第一次失败、刷新一下才好」。
  let lastErr = null;
  for (let attempt = 1; attempt <= RETRY_TIMES + 1; attempt++) {
    if (attempt > 1) await sleep(RETRY_DELAY_MS * (attempt - 1));
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
    try {
      const res = await fetch(cfg.api_url, {
        method: 'POST',
        headers,
        body: JSON.stringify(body),
        signal: controller.signal
      });
      if (!res.ok) {
        // 临时性状态码：先重试，别急着把错误抛给用户
        if (isRetryableStatus(res.status) && attempt <= RETRY_TIMES) {
          lastErr = new Error('接口返回状态码 ' + res.status);
          continue;
        }
        let detail = '';
        try { const t = await res.text(); detail = (t || '').slice(0, 200); } catch (e) {}
        let hint = '';
        if (res.status === 404) hint = '（接口地址可能不对：请确认以 /chat/completions 等完整路径结尾）';
        else if (res.status === 401 || res.status === 403) hint = '（API Key 无效或没有权限）';
        else if (res.status === 429) hint = '（额度或频率受限）';
        throw finalError('接口返回状态码 ' + res.status + hint + (detail ? '：' + detail : ''));
      }
      const data = await res.json();
      const text = extractText(data);
      if (!text) {
        if (attempt <= RETRY_TIMES) { lastErr = new Error('接口响应中未找到文本内容'); continue; }
        throw finalError('接口响应中未找到文本内容');
      }
      return text;
    } catch (e) {
      if (e && e.__final) throw e;              // 已经说明清楚的错误，直接上报，不重试
      lastErr = e;
      if (attempt <= RETRY_TIMES) continue;     // 网络层故障：重试
      throw describeNetError(e);
    } finally {
      clearTimeout(timer);
    }
  }
  throw describeNetError(lastErr);
}

// ---------- 任务 1：笔记解析为知识点 ----------
async function parseNote({ text, imageBase64, imageUrl, model }) {
  const systemPrompt = '你是一名学习笔记整理助手。请把用户提供的笔记内容拆解为独立的、可复习的知识点。';
  const instruction =
    '要求：1) 每个知识点必须彼此独立、边界清晰；2) 输出严格 JSON 数组，格式为 ' +
    '[{"name":"知识点名称","content":"知识点完整内容（保留原笔记核心信息）","tags":["学科","章节标签"]}]；' +
    '3) 不要输出 JSON 以外的任何文字；4) 若笔记为空，输出 []。';
  let prompt = '';
  if (text) {
    prompt = '以下是笔记文本：\n' + text + '\n\n' + instruction;
  } else {
    prompt = '以下是笔记图片。如果你无法查看图片内容（例如接口不支持图片），请只回复：__图片不可见__\n\n' + instruction;
  }

  try {
    const reply = await callAI({
      systemPrompt,
      prompt,
      content: text || '',
      imageBase64,
      imageUrl,
      model
    });
    if (/图片不可见|无法查看图片|无法识别图片|cannot see|can't see/i.test(reply)) {
      return { error: '当前接口不支持图片识别。建议：1) 在设置中启用本地 OCR；2) 配置支持图片的大模型；3) 手动粘贴笔记文字。', items: [] };
    }
    const items = extractJson(reply);
    if (!Array.isArray(items)) throw new Error('AI 返回内容不是知识点数组');
    return items
      .filter((x) => x && x.name)
      .map((x) => ({
        name: String(x.name).trim(),
        content: String(x.content || '').trim(),
        tags: Array.isArray(x.tags) ? x.tags.map((t) => String(t).trim()).filter(Boolean) : []
      }));
  } catch (e) {
    return { error: e.message, fallback: offlineParseNote(text || '') };
  }
}

function offlineParseNote(text) {
  const items = [];
  const lines = String(text || '').split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  let current = null;
  for (const line of lines) {
    const m = line.match(/^(\d+)[.、)．]\s*(.+)$/);
    if (m) {
      if (current && current.name) items.push(current);
      current = { name: m[2], content: line, tags: [] };
    } else if (current) {
      current.content += '\n' + line;
    } else {
      current = { name: line.slice(0, 30), content: line, tags: [] };
    }
  }
  if (current && current.name) items.push(current);
  if (!items.length && text) items.push({ name: text.slice(0, 30), content: text, tags: [] });
  return items;
}

// ---------- 任务 2：复习时长预估（分钟） ----------
async function estimateDuration(kp) {
  const systemPrompt = '你是一名学习规划助手。请估算复习一个知识点所需的分钟数（3 到 30 之间）。';
  const instruction = '输出严格 JSON：{"duration_minutes": 10}，不要输出其他文字。';
  const prompt = `知识点名称：${kp.name}\n知识点内容：${(kp.content || '').slice(0, 800)}\n\n${instruction}`;
  try {
    const reply = await callAI({ systemPrompt, prompt });
    const obj = extractJson(reply);
    const n = obj && obj.duration_minutes;
    if (typeof n === 'number' && n > 0) return Math.max(3, Math.min(30, Math.round(n)));
    return 10;
  } catch (e) {
    return 10;
  }
}

// ---------- 任务 2.5：整篇笔记总结与分点 ----------
// 总结整篇笔记，让用户先确认 AI 是否识别正确核心内容
async function summarizeNote(text) {
  const systemPrompt = '你是学习笔记整理助手。请通读整篇笔记，用简洁的语言总结这篇笔记的核心内容。';
  const instruction = '输出严格 JSON：{"title":"笔记标题（短，小于30字）","summary":"200字左右的核心内容总结，说明这篇笔记主要讲了什么、重点是什么"} 。不要输出其他文字。';
  const prompt = '以下是笔记全文：\n' + (text || '').slice(0, 8000) + '\n\n' + instruction;
  try {
    const reply = await callAI({ systemPrompt, prompt, content: text });
    const obj = extractJson(reply);
    if (obj && (obj.summary || obj.title)) {
      return {
        title: String(obj.title || '').trim() || '未命名笔记',
        summary: String(obj.summary || '').trim() || '（无总结）'
      };
    }
  } catch (e) {}
  const lines = String(text || '').split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  return {
    title: lines[0] ? lines[0].slice(0, 30) : '未命名笔记',
    summary: lines.slice(0, 5).join('；') || '（无内容）'
  };
}

// 结合整篇笔记进行概括分点（不是对原文机械分段）
async function splitNote(text, summary) {
  const systemPrompt = '你是学习规划助手。请把一篇笔记提炼成最经典的几个知识要点，供后续复习出题使用。';
  const instruction = '要求：1) 不是对原文机械分段，而是结合整篇笔记内容进行总结概括，提炼出最经典、最核心的要点；2) 每个要点包含名称与概括性内容，内容可以保留原文关键代码示例（用三个反引号和语言名围绕，如 ```go ... ```）；3) 输出严格 JSON：[{"name":"要点名称","content":"概括后的要点内容"}] ；4) 要点数量 3~8 个；5) 不要输出其他文字。';
  const prompt = '笔记标题/总结：' + (summary || '') + '\n\n笔记全文：\n' + (text || '').slice(0, 8000) + '\n\n' + instruction;
  try {
    const reply = await callAI({ systemPrompt, prompt, content: text });
    let arr = extractJson(reply);
    if (arr && !Array.isArray(arr) && Array.isArray(arr.points)) arr = arr.points;
    if (Array.isArray(arr) && arr.length) {
      return arr.filter((pt) => pt && pt.name).map((pt) => ({
        name: String(pt.name).trim(),
        content: String(pt.content || '').trim()
      }));
    }
  } catch (e) {}
  // 离线备用：按原文标号结构粗分
  const lines = String(text || '').split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  const out = [];
  let cur = null;
  for (const line of lines) {
    const m = line.match(/^(\d+)[.、)）]\s*(.+)$/) || line.match(/^([一二三四五六七八九十]+)[、.．]\s*(.+)$/);
    if (m && out.length < 8) {
      if (cur && cur.name) out.push(cur);
      cur = { name: m[2].slice(0, 24), content: line };
    } else if (cur) {
      cur.content += '\n' + line;
    } else {
      out.push({ name: line.slice(0, 20), content: line });
      cur = null;
    }
  }
  if (cur && cur.name) out.push(cur);
  return out.length ? out : [{ name: '核心要点', content: text || '' }];
}

// ---------- 任务 3：分层出题 ----------
const TYPE_LABEL = { 0: '选择题', 1: '填空题', 2: '简答题' };

// 根据知识点内容长度与本次复习的知识点数量，动态分配出题数量
// 内容越多题越多；知识点少时单个知识点多出题；知识点多时每个适量
function questionCountFor(kp, totalKps) {
  const len = (kp.content || '').length;
  let n = 1;
  if (len > 300) n = 2;
  if (len > 700) n = 3;
  if (len > 1200) n = 4;
  if (len > 1800) n = 5;
  if (len > 2500) n = 6;
  if (len > 3500) n = 7;
  const t = totalKps || 1;
  if (t === 1) n = Math.max(n, 5);
  else if (t <= 3) n = Math.max(n, 3);
  else if (t <= 6) n = Math.max(n, 2);
  return Math.min(n, 8);
}

async function generateQuestions(kp, reviewCount, questionType, count, point) {
  const n = Math.max(1, Math.min(12, count || 1));
  const typeLabel = TYPE_LABEL[questionType] || '简答题';
  const sourceName = (point && point.name) ? point.name : kp.name;
  const sourceContent = (point && point.content) ? point.content : (kp.content || '');
  const systemPrompt = '你是一名严谨的出题老师，根据知识点内容出题，答案必须严格来自知识点内容，不得编造，多道题目之间不要重复。';
  const spec =
    questionType === 0
      ? '出 ' + n + ' 道单选题，每题包含 4 个互不相同、不能重复的选项（干扰项要贴近知识点、有迷惑性）。输出严格 JSON：[{"question_text":"题干","choices":["选项A","选项B","选项C","选项D"],"answer":"正确选项的完整文本（必须与 choices 中某一项完全一致）","question_type":0}]'
      : questionType === 1
      ? '出 ' + n + ' 道填空题（用____表示挖空位置，每题答案要精确）。输出严格 JSON：[{"question_text":"题目","answer":"标准答案","question_type":1}]'
      : '出 ' + n + ' 道简答题（覆盖要点的不同方面，尽量用与笔记原文一致的语言提问，必要时引用原文代码示例）。输出严格 JSON：[{"question_text":"题目","answer":"标准答案要点","question_type":2}]';
  const prompt = '知识点/要点名称：' + sourceName + '\n内容：' + sourceContent.slice(0, 3000) + '\n\n这是该知识点的第 ' + reviewCount + ' 次复习，请出 ' + n + ' 道' + typeLabel + '。' + spec + '\n不要输出 JSON 以外的任何文字。';

  try {
    const reply = await callAI({ systemPrompt, prompt, content: kp.content });
    let arr = extractJson(reply);
    if (arr && !Array.isArray(arr) && Array.isArray(arr.questions)) arr = arr.questions;
    if (!Array.isArray(arr) || !arr.length) throw new Error('AI 未返回题目');
    const shaped = arr
      .filter((q) => q && q.question_text)
      .slice(0, n)
      .map((q) => sanitizeChoices(normalizeChoiceAnswer(normalizeQuestionShape({
        question_text: String(q.question_text).trim(),
        answer: String(q.answer || '').trim(),
        question_type: questionType,
        choices: Array.isArray(q.choices) ? q.choices.map((c) => String(c).trim()).filter(Boolean) : null,
        hint: point
          ? '【' + (point.name || '') + '】' + String(point.content || '').slice(0, 400)
          : (kp.summary || String(kp.content || '').slice(0, 300))
      }))));
    const items = shaped.filter((q) => !q._invalid);
    const dropped = shaped.length - items.length;
    if (!items.length) throw new Error('AI 返回的题目全部无效（答案与它自己的选项对不上）');
    // 部分题目因答案/选项对不上被丢弃 —— 把数量带出去，供上层提示用户
    if (dropped) items.invalidDropped = dropped;
    return items;
  } catch (e) {
    return tagDegraded(offlineQuestions(kp, reviewCount, questionType, n), e);
  }
}

// 给降级结果打标记：数组上挂属性，JSON 序列化时不会带出去，
// 由路由层显式读取后转成给用户的提示（旧实现是静默降级，用户根本不知道 AI 失败了）
function tagDegraded(list, err) {
  const arr = Array.isArray(list) ? list : [];
  arr.degraded = true;
  arr.degradeReason = (err && err.message) ? String(err.message).slice(0, 300) : '原因未知';
  return arr;
}

// 从原文的一行里挖一个空，用于生成"答案直接来自笔记"的填空题。
// 优先挖反引号代码 / 英文标识符 / 数字；纯中文笔记则挖掉最长的子句。
function makeBlank(line) {
  const text = String(line || '');
  const tokenRes = [/`[^`]+`/g, /[A-Za-z_][A-Za-z0-9_.]*/g, /\d+(?:\.\d+)?/g];
  for (const re of tokenRes) {
    const ms = text.match(re);
    if (ms && ms.length) {
      const target = ms[0];
      if (target.length >= 2) return { text: text.replace(target, '____'), answer: target };
    }
  }
  const segs = text.split(/[，,；;。：:]/).map((s) => s.trim()).filter((s) => s.length >= 4);
  if (segs.length >= 2) {
    const target = segs.reduce((a, b) => (b.length > a.length ? b : a), '');
    return { text: text.replace(target, '____'), answer: target };
  }
  return null;
}

// 离线降级出题。
// 旧实现会伪造「下列哪项是「X」的正确内容？」这类选择题，选项里塞
// 「以上选项均不正确 / 以上选项都正确 / 无法确定」——三者自相矛盾、题目无法作答，
// 而且正确答案被放在第 0 位（永远显示成 A）。现已彻底废弃伪造选择题的做法：
// 降级时宁可换题型（改为从原文挖空的填空题，或简答题），也绝不编造选项。
function offlineQuestions(kp, reviewCount, questionType, count) {
  const name = kp.name || '本知识点';
  const content = String(kp.content || kp.name || '').trim();
  const hint = kp.summary || content.slice(0, 300);
  const lines = content.split(/\r?\n/).map((l) => l.trim()).filter((l) => l.length >= 6);

  // 从原文收集若干可挖空的行
  const blanks = [];
  for (const line of lines) {
    const b = makeBlank(line);
    if (b) blanks.push(b);
    if (blanks.length >= count) break;
  }

  const out = [];
  for (let i = 0; i < count; i++) {
    if (questionType === 2) {
      const prompts = [
        '请用自己的话复述「' + name + '」的要点。',
        '请总结「' + name + '」中最容易出错的地方。',
        '请举例说明「' + name + '」的一个应用场景。',
        '「' + name + '」的核心结论是什么？请简要说明。'
      ];
      out.push({
        question_text: prompts[i % prompts.length],
        answer: content || name,
        question_type: 2,
        choices: null,
        hint
      });
    } else if (blanks[i]) {
      // 填空题：题干与答案都直接取自原文
      out.push({
        question_text: '请补全「' + name + '」中的空缺：\n' + blanks[i].text,
        answer: blanks[i].answer,
        question_type: 1,
        choices: null,
        hint
      });
    } else {
      // 连可挖空的内容都没有 → 退化为简答题，同样不编造选项
      out.push({
        question_text: '请用自己的话复述「' + name + '」的要点。',
        answer: content || name,
        question_type: 2,
        choices: null,
        hint
      });
    }
  }
  return out;
}

// 出题数量分配：根据复习模式(mode)决定题型范围——0 只选择 / 1 选择+填空 / 2 全部
// 每个分点至少 1 道选择题；填空、简答仅在对应模式启用
function allocateQuestions(pointCount, customFlow, mode) {
  const P = Math.max(1, pointCount || 1);
  const list = [];
  if (Array.isArray(customFlow) && customFlow.length) {
    for (let i = 0; i < customFlow.length; i++) list.push({ point: i % P, type: customFlow[i] });
    return list.slice(0, 15);
  }
  const m = (mode === 0 || mode === 1 || mode === 2) ? mode : 2;
  const allowFill = m >= 1;
  const allowEssay = m >= 2;
  // 每个分点至少 1 道选择题
  for (let i = 0; i < P; i++) list.push({ point: i, type: 0 });
  // 补充选择题（点少时多几道）
  const extraChoice = Math.min(3, Math.max(1, P - 1));
  for (let i = 0; i < extraChoice; i++) list.push({ point: i % P, type: 0 });
  // 填空题：约半数点，最多 4 道（仅模式≥1）
  if (allowFill) {
    const fillCount = Math.min(4, Math.max(1, Math.ceil(P / 2)));
    for (let i = 0; i < fillCount; i++) list.push({ point: ((i * 2) + 1) % P, type: 1 });
  }
  // 简答题：最多 2 道（仅模式≥2）
  if (allowEssay) {
    const essayCount = Math.min(2, Math.max(1, Math.floor(P / 3)));
    for (let i = 0; i < essayCount; i++) list.push({ point: (P - 1 - i + P) % P, type: 2 });
  }
  return list.slice(0, 15);
}

// 按复习块批量出题：一次 AI 调用覆盖所有分点，失败时回退逐点生成
async function generateBlockQuestions(kp, points, reviewCount, maxCount, mode) {
  const P = points.length;
  let alloc = allocateQuestions(P, kp.custom_exam_flow, mode);
  if (maxCount > 0 && alloc.length > maxCount) {
    const choice = alloc.filter((a) => a.type === 0);
    const fill = alloc.filter((a) => a.type === 1);
    const essay = alloc.filter((a) => a.type === 2);
    const trimmed = [];
    for (const bucket of [choice, fill, essay]) {
      for (const item of bucket) {
        if (trimmed.length >= maxCount) break;
        trimmed.push(item);
      }
      if (trimmed.length >= maxCount) break;
    }
    alloc = trimmed;
  }
  const label = { 0: '选择题', 1: '填空题', 2: '简答题' };
  const pointLines = points.map((pt, i) => '【' + (i + 1) + '】' + (pt.name || '要点' + (i + 1)) + '\n' + (pt.content || '').slice(0, 1200)).join('\n\n');
  const specLines = alloc.map((a, i) => (i + 1) + '. 基于第 ' + (a.point + 1) + ' 个要点「' + (points[a.point].name || '') + '」，出 1 道' + label[a.type]).join('\n');
  const essayRule = alloc.some((a) => a.type === 2)
    ? '\n简答题必须使用与笔记原文一致的语言提问，必要时直接引用原文中的代码示例。'
    : '';
  const systemPrompt = '你是一名严谨的出题老师。根据给出的要点内容出题，答案必须严格来自要点内容，不得编造；选择题的干扰项要真实贴近知识点，不要敷衍。';
  const prompt = '笔记名称：' + kp.name + '\n\n分点内容：\n' + pointLines +
    '\n\n请按以下清单出题：\n' + specLines +
    '\n\n要求：选择题包含 4 个互不相同、不能重复的选项（干扰项要贴近知识点）；填空题用____表示挖空；' + essayRule +
    '\n输出严格 JSON 数组，每道题一个对象：[{"point_index":0,"question_text":"题干","choices":["选项A","选项B","选项C","选项D"],"answer":"正确选项的完整文本（必须与 choices 中某一项完全一致）","question_type":0}]。question_type：0选择/1填空/2简答。不要输出 JSON 以外的任何文字。';
  try {
    const reply = await callAI({ systemPrompt, prompt, content: points.map((pt) => pt.content).join('\n') });
    let arr = extractJson(reply);
    if (arr && !Array.isArray(arr) && Array.isArray(arr.questions)) arr = arr.questions;
    if (!Array.isArray(arr) || !arr.length) throw new Error('AI 未返回题目');
    const buckets = {};
    let droppedInvalid = 0;
    arr.forEach((q, i) => {
      if (!q || !q.question_text) return;
      let pi = parseInt(q.point_index);
      if (isNaN(pi) || pi < 0 || pi >= P) pi = i % P;
      const item = sanitizeChoices(normalizeChoiceAnswer(normalizeQuestionShape({
        point_index: pi,
        question_text: String(q.question_text).trim(),
        answer: String(q.answer || '').trim(),
        question_type: [0, 1, 2].includes(parseInt(q.question_type)) ? parseInt(q.question_type) : 0,
        choices: Array.isArray(q.choices) ? q.choices.map((c) => String(c).trim()).filter(Boolean) : null,
        hint: '【' + (points[pi].name || '') + '】' + String(points[pi].content || '').slice(0, 400)
      })));
      // 旧代码漏检 _invalid，坏题会被直接塞进结果并入库
      if (item && item._invalid) { droppedInvalid++; return; }
      (buckets[pi] = buckets[pi] || []).push(item);
    });
    const final = [];
    let degraded = false;
    let degradeReason = '';
    for (const a of alloc) {
      let item = buckets[a.point] ? buckets[a.point].shift() : null;
      if (item && (item.question_type !== a.type || (a.type === 0 && !(item.choices && item.choices.length >= 2)))) item = null;
      if (!item) {
        const qs = await generateQuestions(kp, reviewCount, a.type, 1, points[a.point]);
        if (qs.degraded && !degraded) { degraded = true; degradeReason = qs.degradeReason || ''; }
        item = qs.length ? qs[0] : null;
      }
      if (item) final.push(item);
    }
    if (!final.length) throw new Error('AI 未返回有效题目');
    if (degraded) { final.degraded = true; final.degradeReason = degradeReason; }
    if (droppedInvalid) final.invalidDropped = droppedInvalid;
    return final;
  } catch (e) {
    const out = [];
    let degraded = false;
    let degradeReason = '';
    for (const a of alloc) {
      const qs = await generateQuestions(kp, reviewCount, a.type, 1, points[a.point]);
      if (qs.degraded && !degraded) { degraded = true; degradeReason = qs.degradeReason || ''; }
      if (qs.length) out.push(qs[0]);
    }
    if (degraded) { out.degraded = true; out.degradeReason = degradeReason; }
    return out;
  }
}

// 判断当前请求模板是否包含图片占位符（即配置了支持图片的视觉模型）
function templateSupportsImage() {
  const cfg = getConfig();
  if (!cfg) return false;
  return (cfg.request_body_template || '').includes('{{image_data_url}}');
}


// 视觉模型：直接读图片生成摘要（模板需包含 {{image_data_url}} 占位符）
async function summarizeNoteFromImage(imageBase64) {
  const systemPrompt = '你是学习笔记整理助手。请通读图片中的笔记内容，用简洁的语言总结这篇笔记的核心内容。';
  const instruction = '输出严格 JSON：{"title":"笔记标题（短，小于30字）","summary":"200字左右的核心内容总结，说明这篇笔记主要讲了什么、重点是什么"} 。不要输出其他文字。';
  const prompt = '以下是笔记图片，请识别并总结核心内容。' + instruction;
  try {
    const reply = await callAI({ systemPrompt, prompt, content: '', imageBase64 });
    const obj = extractJson(reply);
    if (obj && (obj.summary || obj.title)) {
      return {
        title: String(obj.title || '').trim() || '未命名笔记',
        summary: String(obj.summary || '').trim() || '（无法识别图片内容）'
      };
    }
  } catch (e) {}
  return { title: '未命名笔记', summary: '（图片内容无法识别，请换更清晰的图片或手动粘贴文字）' };
}

// 选择题答案归一化：AI 若只返回 A/B/C/D，替换为完整选项文本（保证展示与批改一致）
function normalizeChoiceAnswer(q) {
  if (q && q.question_type === 0 && Array.isArray(q.choices) && q.choices.length) {
    const a = String(q.answer || '').trim().toUpperCase();
    if (/^[A-D]$/.test(a)) {
      const idx = a.charCodeAt(0) - 65;
      if (q.choices[idx]) q.answer = q.choices[idx];
    }
  }
  return q;
}

// 题型归一化：有≥2个选项就按选择题处理；选择题缺选项则转为填空题
function normalizeQuestionShape(q) {
  if (!q) return q;
  const hasChoices = Array.isArray(q.choices) && q.choices.length >= 2;
  if (hasChoices && q.question_type !== 0) q.question_type = 0;
  else if (!hasChoices && q.question_type === 0) {
    q.question_type = 1;
    q.choices = null;
  }
  return q;
}
// ---------- 答案比对与选项清洗 ----------

// 答案归一化：只抹平"无意义"的差异（大小写、空白、全角/半角、首尾标点）。
// 关键：绝不能删掉 . ( ) { } = " ; 这类有语义的符号 ——
// 旧实现把它们一并删除，导致 {{ .FieldName }} 与 {{ FieldName }} 归一化后完全相同，
// 于是多个选项同时被判为正确（历史 bug：B 和 D 同时打勾、选 A 也算对）。
function normAnswer(s) {
  return String(s == null ? '' : s)
    .replace(/[\uFF01-\uFF5E]/g, (ch) => String.fromCharCode(ch.charCodeAt(0) - 0xFEE0)) // 全角 → 半角
    .replace(/\u3000/g, ' ')
    .toLowerCase()
    .replace(/\s+/g, '')
    .replace(/^[。，,；;：:、"'“”‘’!！?？]+/, '')
    .replace(/[。，,；;：:、"'“”‘’!！?？]+$/, '');
}

// 把答案文本定位到"唯一"的选项下标：先精确匹配，再归一化匹配；定位不到返回 -1。
// 调用方拿到 -1 时走退化逻辑，而不是"随便挑一个"或"全都算对"。
function findChoiceIndex(choices, answer) {
  if (!Array.isArray(choices) || !choices.length) return -1;
  const list = choices.map((c) => String(c == null ? '' : c));
  const raw = String(answer == null ? '' : answer).trim();
  if (!raw) return -1;
  const exact = list.findIndex((c) => c.trim() === raw);
  if (exact >= 0) return exact;
  const key = normAnswer(raw);
  if (!key) return -1;
  return list.findIndex((c) => normAnswer(c) === key);
}

// 填空题判分用的「宽松键」：抹掉所有标点与空白（含全角），只留下文字本身。
// 纯文字答案不能按标点严格比对 —— 用户写「正确性、有效性和完整性」，
// 标准答案是「正确性、有效性、完整性」，只差一个顿号，不该算错。
function looseKey(s) {
  return String(s == null ? '' : s)
    .replace(/[\uFF01-\uFF5E]/g, (ch) => String.fromCharCode(ch.charCodeAt(0) - 0xFEE0))
    .replace(/\u3000/g, ' ')
    .toLowerCase()
    .replace(/[\s，。、,.！!？?：:；;""''（）()【】\[\]]/g, '');
}

// 编辑距离（Levenshtein），用于判断「只差个别字」的填空题答案
function editDistance(a, b) {
  const s = String(a || '');
  const t = String(b || '');
  if (!s.length) return t.length;
  if (!t.length) return s.length;
  let prev = new Array(t.length + 1);
  let cur = new Array(t.length + 1);
  for (let j = 0; j <= t.length; j++) prev[j] = j;
  for (let i = 1; i <= s.length; i++) {
    cur[0] = i;
    for (let j = 1; j <= t.length; j++) {
      const cost = s[i - 1] === t[j - 1] ? 0 : 1;
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + cost);
    }
    const tmp = prev; prev = cur; cur = tmp;
  }
  return prev[t.length];
}

// 标准答案是否「吃符号」：含 {} () = < > 反引号 引号 时，符号本身就是答案的一部分，
// 判分必须严格 —— 例如 {{ .FieldName }} 绝不能被当成 {{ FieldName }}。
function isSymbolSensitive(answer) {
  return /[{}()=<>\`"']/.test(String(answer == null ? '' : answer));
}

// 填空题判分：
//   有语义符号的答案 → 严格比对，符号不同就是不同；
//   纯文字答案 → 容忍标点、连词、少量字词的写法差异。
function fillAnswerCorrect(userAnswer, answer) {
  const ua = String(userAnswer == null ? '' : userAnswer).trim();
  const qa = String(answer == null ? '' : answer).trim();
  if (!ua || !qa) return false;
  if (normAnswer(ua) === normAnswer(qa)) return true;   // 严格一致，直接算对
  if (isSymbolSensitive(qa)) return false;              // 符号敏感，不放松
  // 点号数量必须一致：宽松比对会抹掉 "."，否则 io.EOF 会被当成 ioEOF
  const dotCount = (s) => (String(s).match(/\./g) || []).length;
  if (dotCount(ua) !== dotCount(qa)) return false;
  const U = looseKey(ua);
  const A = looseKey(qa);
  if (!U || !A) return false;
  if (U === A) return true;
  if (A.length >= 4 && U.includes(A)) return true;                          // 用户答案里含标准答案
  if (U.length >= 4 && A.includes(U) && U.length / A.length >= 0.6) return true; // 写出了其中大部分
  const dist = editDistance(U, A);
  return 1 - dist / Math.max(U.length, A.length) >= 0.8;                    // 只差个别字也算对
}

function shuffle(arr) {
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    const t = a[i]; a[i] = a[j]; a[j] = t;
  }
  return a;
}

const MAX_CHOICES = 4;

// 选择题选项清洗。与旧实现的三点关键差异：
//  1) 答案若不在选项里，旧代码用 unshift 把答案插到数组第 0 位 —— 那正是"正确答案永远是 A"的成因；
//     现在改为判定该题无效，交由上层重出，绝不伪造选项。
//  2) 旧代码用「以上选项均不正确 / 以上选项都正确 / 无法确定」凑满 4 个选项，
//     这三者自相矛盾、题目根本没法作答；现在一律不再填充这类废话选项。
//  3) 新增随机打乱，消除正确答案的位置偏置（模型本来也倾向把答案写在第一个）。
function sanitizeChoices(q) {
  if (!q || q.question_type !== 0) return q;

  let choices = (Array.isArray(q.choices) ? q.choices : [])
    .map((c) => String(c == null ? '' : c).trim())
    .filter(Boolean);
  // 去重（归一化后相同视为重复；这里用 normAnswer，不会误合并 . 和 () 不同的选项）
  const seen = new Set();
  choices = choices.filter((c) => {
    const k = normAnswer(c);
    if (!k || seen.has(k)) return false;
    seen.add(k);
    return true;
  });

  let ans = String(q.answer == null ? '' : q.answer).trim();
  // 答案写成 A/B/C/D：按字母换成对应选项原文
  const letter = ans.toUpperCase().match(/^[A-D]$/);
  if (letter) {
    const idx = letter[0].charCodeAt(0) - 65;
    if (choices[idx]) ans = choices[idx];
  }
  // 与选项做宽松对齐，统一采用选项原文，保证"答案文本 === 某个选项文本"
  if (ans) {
    const idx = findChoiceIndex(choices, ans);
    if (idx >= 0) ans = choices[idx];
  }

  const inChoices = !!ans && choices.some((c) => normAnswer(c) === normAnswer(ans));
  if (!inChoices) {
    // 答案与选项对不上 → 这道题本身是坏的（答案在选项里根本选不到）。
    // 不伪造、不硬塞，标记无效交给上层重出。
    q.answer = ans;
    q.choices = choices.length >= 2 ? choices : null;
    q._invalid = true;
    q._invalidReason = 'AI 给的答案与它自己的选项对不上';
    return q;
  }

  // 选项多于 4 个：保留正确答案 + 随机抽 3 个干扰项（避免 slice 把答案裁掉）
  if (choices.length > MAX_CHOICES) {
    const ai = choices.findIndex((c) => normAnswer(c) === normAnswer(ans));
    const rest = choices.filter((_, i) => i !== ai);
    choices = [choices[ai]].concat(shuffle(rest).slice(0, MAX_CHOICES - 1));
  }

  q.choices = shuffle(choices);
  q.answer = ans;
  if (q.choices.length < 2) {
    q._invalid = true;
    q._invalidReason = '有效选项不足 2 个';
  }
  return q;
}

module.exports = {
  callAI, parseNote, estimateDuration, summarizeNote, summarizeNoteFromImage, splitNote,
  generateQuestions, generateBlockQuestions, allocateQuestions, questionCountFor,
  getConfig, templateSupportsImage, sanitizeChoices,
  // 供判题与自测复用
  normAnswer, findChoiceIndex, makeBlank, offlineQuestions,
  looseKey, editDistance, isSymbolSensitive, fillAnswerCorrect
};