/**
 * .env 加载（必须在所有其他 import 之前 import）。
 * 读 repo 根的 .env 填进 process.env；不存在也没关系（生产走 PM2/Docker env）。
 */
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
try {
  const envContent = readFileSync(join(ROOT, '.env'), 'utf-8');
  for (const line of envContent.split('\n')) {
    const match = line.match(/^([^#=]+)=(.*)$/);
    if (match) process.env[match[1].trim()] = match[2].trim();
  }
} catch { /* .env 不存在也没关系 */ }
