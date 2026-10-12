/*
 * apk_peek.mjs —— 从 .apk 里抽出 assets/public/index.html，与仓库根 index.html 逐字节比对。
 *
 * 为什么不用 unzip：本机沙箱里 unzip 会对临时目录报 EBUSY。
 * 这里手写 zip「中央目录扫描」——先找 EOCD（0x06054b50），再顺着中央目录拿到每个条目的
 * 压缩数据偏移，只解需要的那个 entry。
 *
 * 用法：node _verify/apk_peek.mjs <path-to.apk> [innerPath]
 */
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';

const apk = process.argv[2];
const inner = process.argv[3] || 'assets/public/index.html';
if (!apk) {
  console.error('usage: node apk_peek.mjs <path-to.apk> [innerPath]');
  process.exit(2);
}

const buf = fs.readFileSync(apk);

// ---- 1. 找 EOCD（从尾部倒着扫，注释最多 65535 字节）----
let eocd = -1;
for (let i = buf.length - 22; i >= Math.max(0, buf.length - 22 - 65535); i--) {
  if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
}
if (eocd < 0) { console.error('EOCD not found — not a zip/apk?'); process.exit(1); }

const cdCount = buf.readUInt16LE(eocd + 10);
const cdSize = buf.readUInt32LE(eocd + 12);
const cdOff = buf.readUInt32LE(eocd + 16);
console.log('zip entries :', cdCount);
console.log('central dir :', cdOff, '(', cdSize, 'bytes )');

// ---- 2. 遍历中央目录 ----
let p = cdOff;
let found = null;
for (let n = 0; n < cdCount; n++) {
  if (buf.readUInt32LE(p) !== 0x02014b50) { console.error('bad central header at', p); process.exit(1); }
  const method = buf.readUInt16LE(p + 10);
  const csize = buf.readUInt32LE(p + 20);
  const usize = buf.readUInt32LE(p + 24);
  const nameLen = buf.readUInt16LE(p + 28);
  const extraLen = buf.readUInt16LE(p + 30);
  const cmtLen = buf.readUInt16LE(p + 32);
  const lho = buf.readUInt32LE(p + 42);          // 本地头偏移
  const name = buf.toString('utf8', p + 46, p + 46 + nameLen);
  if (name === inner) { found = { method, csize, usize, lho, name }; break; }
  p += 46 + nameLen + extraLen + cmtLen;
}

if (!found) { console.error('entry not found in apk:', inner); process.exit(1); }

// ---- 3. 读本地头，定位数据 ----
const lho = found.lho;
if (buf.readUInt32LE(lho) !== 0x04034b50) { console.error('bad local header'); process.exit(1); }
const lNameLen = buf.readUInt16LE(lho + 26);
const lExtraLen = buf.readUInt16LE(lho + 28);
const dataOff = lho + 30 + lNameLen + lExtraLen;
const raw = buf.subarray(dataOff, dataOff + found.csize);
const data = found.method === 0 ? raw : zlib.inflateRawSync(raw);

console.log('inner path  :', inner);
console.log('method      :', found.method === 0 ? 'stored' : 'deflate');
console.log('apk size    :', data.length, 'bytes');

// ---- 4. 与源文件比对 ----
const src = fs.readFileSync(path.resolve(process.cwd(), 'index.html'));
console.log('source size :', src.length, 'bytes');

const same = data.length === src.length && Buffer.compare(Buffer.from(data), src) === 0;
console.log(same ? 'MATCH  ✅ APK 内的 index.html 与源文件逐字节一致'
                 : 'MISMATCH ❌ APK 内的 index.html 与源文件不同！');
process.exit(same ? 0 : 1);
