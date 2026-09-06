// API Key 加密存储：AES-256-GCM，密钥保存在本地数据目录
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const SECRET_FILE = path.join(__dirname, '..', 'data', '.secret');

function getKey() {
  if (fs.existsSync(SECRET_FILE)) {
    return Buffer.from(fs.readFileSync(SECRET_FILE, 'utf8').trim(), 'hex');
  }
  const key = crypto.randomBytes(32);
  fs.writeFileSync(SECRET_FILE, key.toString('hex'));
  return key;
}

function encrypt(plain) {
  if (!plain) return '';
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', getKey(), iv);
  const enc = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return [iv.toString('hex'), tag.toString('hex'), enc.toString('hex')].join(':');
}

function decrypt(stored) {
  if (!stored) return '';
  try {
    const [ivh, tagh, ench] = stored.split(':');
    const decipher = crypto.createDecipheriv('aes-256-gcm', getKey(), Buffer.from(ivh, 'hex'));
    decipher.setAuthTag(Buffer.from(tagh, 'hex'));
    return Buffer.concat([decipher.update(Buffer.from(ench, 'hex')), decipher.final()]).toString('utf8');
  } catch (e) {
    return '';
  }
}

module.exports = { encrypt, decrypt };