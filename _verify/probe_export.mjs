/**
 * 探针：走**真实**的「导出备份」路径，把落盘的 .json 抓下来逐字节看。
 * 目的：回答"用户导出的文件里到底是什么"——不是靠读代码猜。
 *
 * 覆盖两条路径：
 *   A. 浏览器：点「导出备份」-> Blob + <a download> -> 真实文件落盘
 *   B. App 内：注入假 Capacitor，看 writeFile 收到的 base64 解码后是不是可读 JSON
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';

const CHROME = 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const BASE = process.env.BASE || 'http://127.0.0.1:7788/';
const PORT = 9344;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* ---------- 造一张真 PNG（当日记配图，验证 _imageData 对文件体积的影响） ---------- */
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
  for (let y = 0; y < h; y++) { raw[o++] = 0; for (let x = 0; x < w; x++) { raw[o++] = (x * 255 / w) | 0; raw[o++] = (y * 255 / h) | 0; raw[o++] = 160; } }
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 2;
  const png = Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
  fs.writeFileSync(file, png);
  return png;
}

class CDP {
  constructor(ws) { this.ws = ws; this.id = 0; this.waiting = new Map(); }
  static async connect(wsUrl) {
    const ws = new WebSocket(wsUrl);
    await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
    const c = new CDP(ws);
    ws.onmessage = (ev) => {
      const msg = JSON.parse(ev.data);
      if (msg.id && c.waiting.has(msg.id)) {
        const { res, rej } = c.waiting.get(msg.id); c.waiting.delete(msg.id);
        msg.error ? rej(new Error(JSON.stringify(msg.error))) : res(msg.result);
      }
    };
    return c;
  }
  send(method, params = {}) {
    const id = ++this.id;
    return new Promise((res, rej) => {
      this.waiting.set(id, { res, rej });
      this.ws.send(JSON.stringify({ id, method, params }));
      setTimeout(() => { if (this.waiting.has(id)) { this.waiting.delete(id); rej(new Error('timeout ' + method)); } }, 20000);
    });
  }
  async evalJs(expr) {
    const r = await this.send('Runtime.evaluate', {
      expression: `(async () => { return (${expr}); })()`, awaitPromise: true, returnByValue: true
    });
    if (r.exceptionDetails) throw new Error('页面异常: ' + (r.exceptionDetails.exception?.description || r.exceptionDetails.text));
    return r.result.value;
  }
}

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'diary-probe-'));
const dl = path.join(tmp, 'downloads'); fs.mkdirSync(dl);
const pngBuf = makePng(900, 700, path.join(tmp, 'p.png'));
console.log(`配图 PNG: ${(pngBuf.length / 1024).toFixed(0)} KB`);
console.log(`下载目录: ${dl}`);

const chrome = spawn(CHROME, [
  '--headless=new', `--remote-debugging-port=${PORT}`, `--user-data-dir=${tmp}`,
  '--no-first-run', '--no-default-browser-check', '--disable-gpu', '--hide-scrollbars', 'about:blank'
], { stdio: 'ignore' });

let cdp = null;
try {
  let wsUrl = null;
  for (let i = 0; i < 40; i++) {
    await sleep(300);
    try {
      const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
      const t = list.find((x) => x.type === 'page');
      if (t) { wsUrl = t.webSocketDebuggerUrl; break; }
    } catch (e) {}
  }
  if (!wsUrl) throw new Error('无法连接 Chrome 调试端口');
  cdp = await CDP.connect(wsUrl);
  await cdp.send('Runtime.enable'); await cdp.send('Page.enable'); await cdp.send('DOM.enable');
  await cdp.send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 1, mobile: true });
  await cdp.send('Browser.setDownloadBehavior', { behavior: 'allow', downloadPath: dl, eventsEnabled: true });

  await cdp.send('Page.navigate', { url: BASE + '?t=' + Date.now() });
  for (let i = 0; i < 40; i++) {
    await sleep(300);
    try { if (await cdp.evalJs(`!!document.getElementById('screen-cover')`)) break; } catch (e) {}
  }
  await sleep(2000);
  if (await cdp.evalJs(`document.getElementById('screen-cover').classList.contains('show')`)) {
    await cdp.evalJs(`document.getElementById('screen-cover').click()`);
    await sleep(900);
  }
  console.log('已进入主界面，store 模式 =', await cdp.evalJs(`window.__diary__.Store.mode`));

  /* ---------- 造数据：一篇纯文字 + 一篇带图 ---------- */
  await cdp.evalJs(`window.__diary__.publishText('探针甲：今天去公园骑行。\\n\\n第二段有空行。\\n第三段结尾。')`);
  await sleep(1200);
  const b64 = pngBuf.toString('base64');
  await cdp.evalJs(`(async () => {
    const bytes = Uint8Array.from(atob(${JSON.stringify(b64)}), c => c.charCodeAt(0));
    const blob = new Blob([bytes], { type: 'image/png' });
    const S = window.__diary__.Store;
    await S.putImage({ id: 'probe-img-1', entryId: 'probe-entry-img', w: 900, h: 700, size: blob.size, order: 0, blob: blob });
    await S.saveEntry({ id: 'probe-entry-img', text: '探针乙：带一张配图。', images: ['probe-img-1'], createdAt: Date.now(), updatedAt: 0 });
    await window.__diary__.loadHome();
  })()`);
  await sleep(1200);

  const lib = await cdp.evalJs(`window.__diary__.State.entries.map(e => ({id:e.id, text:(e.text||'').slice(0,20), imgs:(e.images||[]).length}))`);
  console.log('库内条目:', JSON.stringify(lib));

  /* ---------- A. 真实点击「导出备份」 ---------- */
  console.log('\n=== A. 浏览器路径：真实点击导出备份 ===');
  await cdp.evalJs(`document.querySelector('#tabbar .tab[data-tab="mine"]').click()`);
  await sleep(700);
  const btnInfo = await cdp.evalJs(`(() => {
    const b = document.getElementById('setExport');
    return b ? { found: true, txt: (b.textContent||'').trim().slice(0,24), visible: !!b.offsetParent } : { found: false };
  })()`);
  console.log('导出按钮:', JSON.stringify(btnInfo));
  await cdp.evalJs(`document.getElementById('setExport').click()`);
  await sleep(3500);

  const files = fs.readdirSync(dl).filter((f) => !f.endsWith('.crdownload'));
  console.log('下载目录内容:', JSON.stringify(files));
  for (const f of files) {
    const p = path.join(dl, f);
    const buf = fs.readFileSync(p);
    console.log(`\n--- 落盘文件 ${f} (${buf.length} 字节) ---`);
    console.log('前 3 字节(hex):', [...buf.slice(0, 3)].map((b) => b.toString(16).padStart(2, '0')).join(' '),
      '(EF BB BF = UTF-8 BOM)');
    const txt = buf.toString('utf8');
    let parsedOk = false, parsed = null;
    try { parsed = JSON.parse(txt); parsedOk = true; } catch (e) { parsed = e.message; }
    console.log('JSON.parse 是否成功:', parsedOk, parsedOk ? '' : String(parsed).slice(0, 120));
    if (parsedOk) {
      console.log('  entryCount =', parsed.entryCount);
      const texts = (parsed.entries || []).map((e) => (e.text || '').slice(0, 24));
      console.log('  条目正文前 24 字:', JSON.stringify(texts));
      const hasProbe = (parsed.entries || []).some((e) => (e.text || '').includes('探针甲'));
      console.log('  含「探针甲」:', hasProbe);
    }
    // 中文是否原样（不是 \uXXXX 转义）
    console.log('  含未转义中文:', /探针甲/.test(txt));
    // base64 图片数据占比
    const b64 = txt.match(/data:image\/[a-z]+;base64,[A-Za-z0-9+/=]+/g) || [];
    const b64Len = b64.reduce((a, s) => a + s.length, 0);
    console.log(`  data URL 数量=${b64.length}  占字符数=${b64Len} (${(b64Len / txt.length * 100).toFixed(1)}%)`);
    console.log('  前 320 字符:');
    console.log(txt.slice(0, 320).split('\n').map((l) => '    | ' + l.replace(/[^\x20-\x7e\u4e00-\u9fa5：。，]/g, '.')).join('\n'));
  }

  /* ---------- B. 手动跑 buildBackup，看载荷本身 ---------- */
  console.log('\n=== B. buildBackup 载荷体检 ===');
  const inspect = await cdp.evalJs(`(async () => {
    const p = await window.__diary__.buildBackup();
    const s = JSON.stringify(p, null, 2);
    return {
      entryCount: p.entryCount,
      keys: Object.keys(p),
      jsonLen: s.length,
      head: s.slice(0, 400),
      imagesFieldLen: JSON.stringify(p.entries.map(e => (e._imageData||[]).map(i => (i.data||'').length))).length,
      perEntry: p.entries.map(e => ({ id: e.id, textLen: (e.text||'').length, imgDataLen: (e._imageData||[]).reduce((a,b)=>a+(b.data||'').length,0) }))
    };
  })()`);
  console.log('entryCount =', inspect.entryCount);
  console.log('顶层字段  =', JSON.stringify(inspect.keys));
  console.log('JSON 总长 =', inspect.jsonLen, '字符');
  console.log('各条目    =', JSON.stringify(inspect.perEntry));
  console.log('--- JSON 开头 ---');
  console.log(inspect.head.replace(/[^\x20-\x7e\n\u4e00-\u9fa5：。]/g, '.'));

  console.log('\n完事');
} finally {
  try { if (cdp) cdp.ws.close(); } catch (e) {}
  chrome.kill();
}
