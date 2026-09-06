// 本地 OCR：调用 Python 脚本识别图片文字
const { execFile } = require('child_process');
const path = require('path');

const OCR_SCRIPT = path.join(__dirname, '..', 'tools', 'ocr.py');
const fs = require('fs');

// 读取 data/ocr.config.json 中的本机 Python 路径（可选）
function readLocalConfig() {
  try {
    return JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'data', 'ocr.config.json'), 'utf8'));
  } catch (e) {
    return {};
  }
}

function runOcr(imagePath) {
  return new Promise((resolve) => {
    const cfg = readLocalConfig();
    const candidates = [process.env.OCR_PYTHON, cfg.python, 'python', 'python3'].filter(Boolean);
    const libs = process.env.OCR_LIBS || cfg.libs || '';
    const env = Object.assign({}, process.env, libs ? { OCR_LIBS: libs } : {});
    let idx = 0;
    const tryNext = () => {
      if (idx >= candidates.length) {
        return resolve({ ok: false, error: '未找到 Python，本地 OCR 不可用（可在启动时设置 OCR_PYTHON 环境变量）' });
      }
      const cmd = candidates[idx++];
      execFile(cmd, [OCR_SCRIPT, imagePath], {
        timeout: 120000,
        maxBuffer: 32 * 1024 * 1024,
        windowsHide: true,
        env
      }, (err, stdout, stderr) => {
        if (err) {
          const msg = (stderr || err.message || '').toString();
          if (err.code === 'ENOENT' || /not recognized|不是内部|无法将|No such file/i.test(msg)) return tryNext();
          if (/ModuleNotFoundError|No module named/i.test(msg)) {
            return resolve({ ok: false, error: 'OCR 组件未安装，请先运行：pip install rapidocr-onnxruntime' });
          }
          return resolve({ ok: false, error: msg.slice(0, 300) || 'OCR 运行失败' });
        }
        try {
          resolve(JSON.parse(stdout));
        } catch (e) {
          resolve({ ok: false, error: 'OCR 输出解析失败' });
        }
      });
    };
    tryNext();
  });
}

module.exports = { runOcr };