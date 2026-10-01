/**
 * 定因探针：确认"导出到用户 Downloads"是谁触发的。
 * 思路：把 Chrome 的下载目录改到临时目录，并监听 downloadWillBegin，
 *       同时记录每一次鼠标点击的坐标 —— 这样既不污染用户目录，又能看到真凶。
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';

const CHROME = 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const FILE = 'file:///D:/WorkBuddy/WorkPlace/wechat-diary/index.html';
const PORT = 9355;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function crc32(buf) {
  let c, crc = 0xffffffff;
  for (let i = 0; i < buf.length; i++) { c = (crc ^ buf[i]) & 0xff; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; crc = (crc >>> 8) ^ c; }
  return (crc ^ 0xffffffff) >>> 0;
}
function chunk(type, data) {
  const l = Buffer.alloc(4); l.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const c = Buffer.alloc(4); c.writeUInt32BE(crc32(td));
  return Buffer.concat([l, td, c]);
}
function makePng(w, h, file) {
  const raw = Buffer.alloc((w * 3 + 1) * h); let o = 0;
  for (let y = 0; y < h; y++) { raw[o++] = 0; for (let x = 0; x < w; x++) { raw[o++] = (x * 255 / w) | 0; raw[o++] = (y * 255 / h) | 0; raw[o++] = 120; } }
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 2;
  fs.writeFileSync(file, Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]));
}

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'diary-dl-'));
const dl = path.join(tmp, 'dl'); fs.mkdirSync(dl);
const img = path.join(tmp, 'p.png'); makePng(800, 600, img);

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
  if (!wsUrl) throw new Error('无法连接 Chrome');
  ws = new WebSocket(wsUrl);
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
  let id = 0; const waiting = new Map(); const events = [];
  ws.onmessage = (e) => {
    const m = JSON.parse(e.data);
    if (m.id && waiting.has(m.id)) { const w = waiting.get(m.id); waiting.delete(m.id); m.error ? w.rej(new Error(JSON.stringify(m.error))) : w.res(m.result); }
    else if (m.method) {
      events.push(m);
      if (/download/i.test(m.method)) console.log(`  >>> [下载事件] ${m.method} ` + JSON.stringify(m.params).slice(0, 200));
    }
  };
  const T0 = Date.now();
  const send = (method, params = {}) => {
    if (method === 'Input.dispatchMouseEvent') {
      console.log(`  +${((Date.now() - T0) / 1000).toFixed(1)}s 鼠标 ${params.type} @ (${Math.round(params.x)},${Math.round(params.y)})`);
    }
    return new Promise((res, rej) => {
      const i = ++id; waiting.set(i, { res, rej });
      ws.send(JSON.stringify({ id: i, method, params }));
      setTimeout(() => { if (waiting.has(i)) { waiting.delete(i); rej(new Error('timeout ' + method)); } }, 15000);
    });
  };
  const ev = async (expr) => {
    const r = await send('Runtime.evaluate', { expression: `(async()=>{return (${expr});})()`, awaitPromise: true, returnByValue: true });
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text);
    return r.result.value;
  };
  const click = async (sel) => {
    const b = await ev(`(()=>{const e=document.querySelector('${sel}');if(!e)return null;
      e.scrollIntoView({block:'center'});const r=e.getBoundingClientRect();return {x:r.left+r.width/2,y:r.top+r.height/2};})()`);
    if (!b) throw new Error('找不到 ' + sel);
    // 关键：在**派发鼠标事件之前**记录一下这个坐标到底会命中谁
    const hit = await ev(`(()=>{const e=document.elementFromPoint(${b.x},${b.y});
      if(!e) return 'null';
      const t = e.closest('.tile');
      return e.tagName + (e.id?'#'+e.id:'') + (t ? '  <TILE data-go=' + t.getAttribute('data-go') + '>' : '');})()`);
    console.log(`      click(${sel}) @ (${Math.round(b.x)},${Math.round(b.y)}) 命中 -> ${hit}`);
    await send('Input.dispatchMouseEvent', { type: 'mousePressed', x: b.x, y: b.y, button: 'left', clickCount: 1, buttons: 1 });
    await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: b.x, y: b.y, button: 'left', clickCount: 1, buttons: 0 });
    return b;
  };
  /** 点完之后看 toast 说了什么——导出成功会写「已导出 N 篇日记」 */
  const toastAfter = async (ms) => {
    let last = '';
    for (let i = 0; i < ms / 200; i++) {
      await sleep(200);
      const t = (await ev(`document.getElementById('toast').textContent`)) || '';
      if (t && t !== last) { last = t; console.log(`      toast: ${t}`); }
    }
    return last;
  };

  await send('Runtime.enable'); await send('Page.enable'); await send('DOM.enable');
  await send('Browser.setDownloadBehavior', { behavior: 'allow', downloadPath: dl, eventsEnabled: true });
  await send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 2, mobile: true });

  console.log('\n=== 关键检查：封面关闭后，click(\'#screen-cover\') 会点到哪 ===');
  await send('Page.navigate', { url: FILE });
  await sleep(1800);
  await click('#screen-cover');
  await sleep(800);
  console.log('  当前是否在主桌面:', await ev(`document.getElementById('screen-home').classList.contains('active')`));

  console.log('\n=== 各磁贴的位置 ===');
  console.log(JSON.stringify(await ev(`[...document.querySelectorAll('#deskTiles .tile')].map(t => {
    const r = t.getBoundingClientRect();
    return { go: t.getAttribute('data-go'), cx: Math.round(r.left+r.width/2), cy: Math.round(r.top+r.height/2) };
  })`)));

  console.log('\n=== 复现文件里的流程：发布一篇 -> 刷新 -> 1800ms 后 click(封面) ===');
  await send('Page.navigate', { url: FILE });
  await sleep(1800);
  await click('#screen-cover');
  await sleep(800);
  await click('#fabWrite');
  await sleep(700);
  await ev(`document.getElementById('composerText').focus()`);
  await send('Input.insertText', { text: 'A：写入的一条日记。' });
  await sleep(200);
  const doc = await send('DOM.getDocument');
  const node = await send('DOM.querySelector', { nodeId: doc.root.nodeId, selector: '#filePicker' });
  await send('DOM.setFileInputFiles', { nodeId: node.nodeId, files: [img] });
  await sleep(1800);
  await click('#btnPublish');
  await sleep(1600);
  console.log('  已发布，下载目录:', JSON.stringify(fs.readdirSync(dl)));

  // ★ 和 file_boot.mjs 完全一样的时序：导航 -> 等 1800ms -> 点封面
  await send('Page.navigate', { url: FILE });
  await sleep(1800);
  console.log('  导航后 1800ms，封面 show =', await ev(`document.getElementById('screen-cover').classList.contains('show')`));
  await click('#screen-cover');
  const t = await toastAfter(3000);
  console.log('  点完封面的 toast:', JSON.stringify(t));
  console.log('  下载目录:', JSON.stringify(fs.readdirSync(dl)));
  console.log('  当前面板:', await ev(`document.getElementById('screen-home').classList.contains('active') ? 'home' : '其他'`));
} catch (e) {
  console.error('[脚本错误]', e.message);
} finally {
  try { ws && ws.close(); } catch (e) {}
  try { chrome.kill(); } catch (e) {}
  await sleep(400);
  console.log('\n临时目录（未污染用户 Downloads）:', tmp);
}
