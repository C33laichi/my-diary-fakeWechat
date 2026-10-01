/**
 * 把唯一源文件 ../index.html 同步到 Capacitor 的 web 目录 www/。
 *
 * 设计意图：index.html 始终是唯一源文件，这里只做「单向复制」，
 * 绝不手工编辑 www/index.html —— 否则会出现两份需要人肉同步的副本。
 *
 * 用法：node sync.mjs    （npm run sync / apk:debug 会自动先调用它）
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const SRC = path.resolve(here, '..', 'index.html');
const OUT_DIR = path.resolve(here, 'www');
const OUT = path.join(OUT_DIR, 'index.html');

if (!fs.existsSync(SRC)) {
  console.error('[sync] 找不到源文件：' + SRC);
  process.exit(1);
}

const html = fs.readFileSync(SRC, 'utf8');

// 守卫：单文件应用不允许出现外部资源，否则打进 APK 后必然白屏 / 缺资源。
// 允许 javascript: 这类伪协议，以及运行时动态生成的 blob: / data:。
const offenders = [];
const attrRe = /(?:src|href)\s*=\s*["']([^"']+)["']/gi;
let m;
while ((m = attrRe.exec(html)) !== null) {
  const url = m[1].trim();
  if (!url) continue;
  if (/^(javascript:|#|data:|blob:)/i.test(url)) continue;
  offenders.push(url);
}
const importRe = /@import\s+[^;]+;/gi;
while ((m = importRe.exec(html)) !== null) offenders.push(m[0].trim());

if (offenders.length) {
  console.error('[sync] 检测到外部资源引用，打包后可能缺失：');
  [...new Set(offenders)].forEach((u) => console.error('   · ' + u));
  console.error('[sync] 请把它们内联进 index.html，或改成从这里一起复制到 www/。');
  process.exit(1);
}

fs.mkdirSync(OUT_DIR, { recursive: true });
fs.copyFileSync(SRC, OUT);

const kb = (Buffer.byteLength(html) / 1024).toFixed(1);
const mtime = fs.statSync(SRC).mtime.toLocaleString('zh-CN');
console.log(`[sync] www/index.html ← ../index.html  (${kb} KB, 源文件修改于 ${mtime})`);
console.log('[sync] 外部资源引用检查：通过（0 处）');
