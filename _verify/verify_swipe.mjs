/**
 * 回归测试：修复「多图只能翻一次」。
 * 用真实触摸事件连续翻页，逐次断言：计数递增 + 命中测试仍是图片 + 画面非纯色。
 * Usage: node verify_swipe_fix.mjs
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';

const CHROME = 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const FILE = 'file:///D:/WorkBuddy/WorkPlace/wechat-diary/index.html';
// 测试用真实照片：把任意几张 JPEG 放进这个目录即可（留空则跳过数据准备用例）
const IMGDIR = process.env.WD_IMGDIR || 'D:/dshWorkPlace/backup-images';
const PORT = 9419;
const OUT = path.resolve('shots');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let pass = 0, fail = 0;
const check = (n, ok, extra = '') => { ok ? pass++ : fail++; console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${n}${extra ? '   ' + extra : ''}`); };

function decodePng(buf) {
  let o = 8, w = 0, h = 0, ct = 0; const idat = [];
  while (o + 8 <= buf.length) {
    const len = buf.readUInt32BE(o);
    const type = buf.slice(o + 4, o + 8).toString('ascii');
    const data = buf.slice(o + 8, o + 8 + len);
    if (type === 'IHDR') { w = data.readUInt32BE(0); h = data.readUInt32BE(4); ct = data[9]; }
    else if (type === 'IDAT') idat.push(data);
    else if (type === 'IEND') break;
    o += 12 + len;
  }
  const ch = ct === 6 ? 4 : 3;
  const raw = zlib.inflateSync(Buffer.concat(idat));
  const stride = w * ch, out = Buffer.alloc(h * stride);
  let p = 0;
  for (let y = 0; y < h; y++) {
    const f = raw[p++], line = raw.slice(p, p + stride); p += stride;
    const prev = y ? out.slice((y - 1) * stride, y * stride) : Buffer.alloc(stride);
    const cur = out.slice(y * stride, (y + 1) * stride);
    for (let x = 0; x < stride; x++) {
      const a = x >= ch ? cur[x - ch] : 0, b = prev[x], c = x >= ch ? prev[x - ch] : 0;
      let v = line[x];
      if (f === 1) v += a; else if (f === 2) v += b;
      else if (f === 3) v += (a + b) >> 1;
      else if (f === 4) { const pa = Math.abs(b - c), pb = Math.abs(a - c), pc = Math.abs(a + b - 2 * c);
        v += (pa <= pb && pa <= pc) ? a : (pb <= pc ? b : c); }
      cur[x] = v & 0xff;
    }
  }
  return { w, h, ch, data: out };
}
function colors(png) {
  const s = new Set();
  for (let y = Math.round(png.h * 0.25); y < Math.round(png.h * 0.75); y += 2)
    for (let x = Math.round(png.w * 0.08); x < Math.round(png.w * 0.92); x += 2) {
      const i = (y * png.w + x) * png.ch;
      s.add(((png.data[i] >> 4) << 8) | ((png.data[i + 1] >> 4) << 4) | (png.data[i + 2] >> 4));
    }
  return s.size;
}

const all = fs.readdirSync(IMGDIR).filter((f) => f.endsWith('.jpg'));
const five = all.filter((f) => f.startsWith('mu841bitcn0g6')).map((f) => path.join(IMGDIR, f));

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'swipefix-'));
const chrome = spawn(CHROME, ['--headless=new', `--remote-debugging-port=${PORT}`, `--user-data-dir=${tmp}`,
  '--no-first-run', '--no-default-browser-check', '--disable-gpu', '--allow-file-access-from-files', 'about:blank'], { stdio: 'ignore' });

let ws = null;
try {
  let wsUrl = null;
  for (let i = 0; i < 40; i++) {
    await sleep(300);
    try {
      const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
      const p = list.find((t) => t.type === 'page');
      if (p) { wsUrl = p.webSocketDebuggerUrl; break; }
    } catch (e) {}
  }
  if (!wsUrl) throw new Error('cannot connect to Chrome');
  ws = new WebSocket(wsUrl);
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
  let id = 0; const waiting = new Map(); const events = [];
  ws.onmessage = (e) => {
    const m = JSON.parse(e.data);
    if (m.id && waiting.has(m.id)) { const w = waiting.get(m.id); waiting.delete(m.id); m.error ? w.rej(new Error(JSON.stringify(m.error))) : w.res(m.result); }
    else if (m.method) events.push(m);
  };
  const send = (method, params = {}) => new Promise((res, rej) => {
    const i = ++id; waiting.set(i, { res, rej });
    ws.send(JSON.stringify({ id: i, method, params }));
    setTimeout(() => { if (waiting.has(i)) { waiting.delete(i); rej(new Error('timeout ' + method)); } }, 40000);
  });
  const ev = async (expr) => {
    const r = await send('Runtime.evaluate', { expression: `(async()=>{return (${expr});})()`, awaitPromise: true, returnByValue: true });
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text);
    return r.result.value;
  };
  const click = async (sel) => {
    const b = await ev(`(()=>{const e=document.querySelector('${sel}');if(!e)return null;const r=e.getBoundingClientRect();
      return {x:r.left+r.width/2,y:r.top+r.height/2};})()`);
    if (!b) throw new Error('not found ' + sel);
    for (const t of ['mousePressed', 'mouseReleased'])
      await send('Input.dispatchMouseEvent', { type: t, x: b.x, y: b.y, button: 'left', clickCount: 1, buttons: t === 'mousePressed' ? 1 : 0 });
  };
  const swipe = async (dir) => {
    // y 必须按当前视口取 —— 横屏只有 390 高，写死 460 会落在视口外
    const vh = await ev(`innerHeight`);
    const vw = await ev(`innerWidth`);
    const y = Math.round(vh / 2);
    const from = dir > 0 ? Math.round(vw * 0.82) : Math.round(vw * 0.18);
    const to = dir > 0 ? Math.round(vw * 0.18) : Math.round(vw * 0.82);
    await send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: from, y }] });
    await sleep(15);
    for (let k = 1; k <= 5; k++) {
      await send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x: Math.round(from + (to - from) * k / 5), y }] });
      await sleep(15);
    }
    await send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
    await sleep(800);
  };
  const shotColors = async (name) => {
    const r = await send('Page.captureScreenshot', { format: 'png' });
    const buf = Buffer.from(r.data, 'base64');
    if (name) fs.writeFileSync(path.join(OUT, name), buf);
    return colors(decodePng(buf));
  };
  const hit = () => ev(`(()=>{const e=document.elementFromPoint(195,460);return e?(e.tagName+(e.id?'#'+e.id:'')):'null';})()`);

  await send('Runtime.enable'); await send('Page.enable'); await send('DOM.enable');
  await send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 2, mobile: true });
  await send('Page.addScriptToEvaluateOnNewDocument', { source: 'window.__diaryNoAutoCover = true;' });

  await send('Page.navigate', { url: FILE });
  await sleep(2200);
  await ev(`window.__diary__.Store.clearAll()`);
  await sleep(400);
  await send('Page.navigate', { url: FILE });
  await sleep(2200);
  await click('#screen-cover');
  await sleep(700);
  await ev(`window.__diary__.openComposer(null)`);
  await sleep(500);
  const doc = await send('DOM.getDocument');
  const node = await send('DOM.querySelector', { nodeId: doc.root.nodeId, selector: '#filePicker' });
  await send('DOM.setFileInputFiles', { nodeId: node.nodeId, files: five });
  await sleep(5 * 2500);
  await ev(`window.__diary__.publishCore('swipe fix', window.__diary__.State.draftImages.slice())`);
  await sleep(2000);
  await ev(`window.__diary__.State.draftImages = []`);

  console.log('\n[准备] 5 张图一篇日记，重启后从库里加载');
  await send('Page.navigate', { url: FILE });
  await sleep(2500);
  await click('#screen-cover');
  await sleep(800);
  await ev(`window.__diary__.switchTab('timeline')`);
  await sleep(600);
  await click('#timeline .pgrid .ph:nth-child(1)');
  await sleep(1500);

  check('打开后在第 1 张', (await ev(`document.getElementById('viewerCount').textContent`)) === '1/5');
  check('第 1 张命中图片', (await hit()) === 'IMG', await hit());
  check('第 1 张有内容', (await shotColors('fix-1.png')) > 3);

  console.log('\n[连续向左翻页] 每次都应命中图片且有内容');
  for (let i = 2; i <= 5; i++) {
    await swipe(1);            // 向左 = 下一张
    const cnt = await ev(`document.getElementById('viewerCount').textContent`);
    const h = await hit();
    const c = await shotColors('fix-' + i + '.png');
    check(`翻到第 ${i} 张（计数=${cnt} 命中=${h} 颜色数=${c}）`,
      cnt === i + '/5' && h === 'IMG' && c > 3);
  }

  console.log('\n[连续向右翻页] 回退也应正常');
  for (let i = 4; i >= 2; i--) {
    await swipe(-1);           // 向右 = 上一张
    const cnt = await ev(`document.getElementById('viewerCount').textContent`);
    const h = await hit();
    const c = await shotColors(null);
    check(`回退到第 ${i} 张（计数=${cnt} 命中=${h} 颜色数=${c}）`,
      cnt === i + '/5' && h === 'IMG' && c > 3);
  }

  console.log('\n[从中间打开] 直接点第 4 张');
  await ev(`(()=>{document.getElementById('viewerClose').click(); return 1;})()`);
  await sleep(500);
  await click('#timeline .pgrid .ph:nth-child(4)');
  await sleep(1500);
  check('直接打开第 4 张', (await ev(`document.getElementById('viewerCount').textContent`)) === '4/5',
    await ev(`document.getElementById('viewerCount').textContent`));
  check('第 4 张命中图片', (await hit()) === 'IMG', await hit());
  check('第 4 张有内容', (await shotColors('fix-open4.png')) > 3);
  await swipe(1);
  check('从第 4 张继续翻到第 5 张', (await ev(`document.getElementById('viewerCount').textContent`)) === '5/5',
    await ev(`document.getElementById('viewerCount').textContent`));

  console.log('\n[横屏] 旋转后仍能翻页且图片不溢出');
  await send('Emulation.setDeviceMetricsOverride', { width: 844, height: 390, deviceScaleFactor: 2, mobile: true });
  await sleep(1000);
  const fit = await ev(`(()=>{const im=document.querySelectorAll('#viewerTrack img')[window.__diary__.State.viewerIndex];
    const r=im.getBoundingClientRect();
    return {w:Math.round(r.width),h:Math.round(r.height),vw:innerWidth,vh:innerHeight,hit:(function(){const e=document.elementFromPoint(innerWidth/2,innerHeight/2);return e?e.tagName:'null';})()};})()`);
  check('横屏下图片仍在视口内', fit.w <= 844 && fit.h <= 390, JSON.stringify(fit));
  check('横屏下命中图片', fit.hit === 'IMG', fit.hit);
  await swipe(-1);
  check('横屏下可回退', (await ev(`document.getElementById('viewerCount').textContent`)) === '4/5',
    await ev(`document.getElementById('viewerCount').textContent`));

  const exc = events.filter((e) => e.method === 'Runtime.exceptionThrown');
  check('无未捕获异常', exc.length === 0, exc.slice(0, 2).map((e) => e.params.exceptionDetails.text).join(' | '));

  console.log(`\n===== 结果：${pass} 通过 / ${fail} 失败 =====`);
} catch (e) {
  console.error('[script error]', e.message); fail++;
} finally {
  try { ws && ws.close(); } catch (e) {}
  try { chrome.kill(); } catch (e) {}
  await sleep(300);
  try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (e) {}
}
process.exit(fail ? 1 : 0);
