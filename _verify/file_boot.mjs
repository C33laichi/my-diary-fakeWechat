/**
 * file:// 场景验证：用户直接双击 HTML 打开时，IndexedDB 可能不可用，
 * 此时应自动降级（localStorage / 内存）且核心功能仍可用。
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';

const CHROME = 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const FILE = 'file:///D:/WorkBuddy/WorkPlace/wechat-diary/index.html';
const PORT = 9334;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let pass = 0, fail = 0;
const check = (n, ok, extra = '') => { ok ? pass++ : fail++; console.log(`  ${ok ? '✓' : '✗'} ${n}${extra ? '  ' + extra : ''}`); };

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

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'diary-file-'));
const img = path.join(tmp, 'p.png');
makePng(800, 600, img);

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
    else if (m.method) events.push(m);
  };
  const send = (method, params = {}) => new Promise((res, rej) => {
    const i = ++id; waiting.set(i, { res, rej });
    ws.send(JSON.stringify({ id: i, method, params }));
    setTimeout(() => { if (waiting.has(i)) { waiting.delete(i); rej(new Error('timeout ' + method)); } }, 15000);
  });
  const ev = async (expr) => {
    const r = await send('Runtime.evaluate', { expression: `(async()=>{return (${expr});})()`, awaitPromise: true, returnByValue: true });
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text);
    return r.result.value;
  };
  /**
   * 点击并**校验真的点到了目标**。
   * 不校验的话，"点了个已经隐藏的元素"会静默落到它下面的东西上 —— 曾经就是这样
   * 误点中了桌面上的「备份」磁贴，把测试数据当备份导出到了用户的下载目录。
   */
  const click = async (sel) => {
    const b = await ev(`(()=>{const e=document.querySelector('${sel}');if(!e)return null;
      e.scrollIntoView({block:'center'});const r=e.getBoundingClientRect();return {x:r.left+r.width/2,y:r.top+r.height/2};})()`);
    if (!b) throw new Error('找不到 ' + sel);
    const hit = await ev(`(()=>{const e=document.elementFromPoint(${b.x},${b.y});
      return e && e.closest('${sel}') ? 'ok' : (e ? e.tagName + (e.id?'#'+e.id:'') + '.' + (e.className || '') : 'null');})()`);
    if (hit !== 'ok') throw new Error(`点击位置被遮挡: ${sel} @ (${Math.round(b.x)},${Math.round(b.y)}) -> 实际命中 ${hit}`);
    await send('Input.dispatchMouseEvent', { type: 'mousePressed', x: b.x, y: b.y, button: 'left', clickCount: 1, buttons: 1 });
    await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: b.x, y: b.y, button: 'left', clickCount: 1, buttons: 0 });
  };
  /**
   * 点封面提前进入（等价于等满停留时间）。
   * 封面是"停一下就自动进入"的，可能已经自己走了；此时它虽然还铺满屏幕但已不可点，
   * 硬点会穿到下面的磁贴上去。所以先确认它真的可点，不可点就当作已经进来了。
   */
  const enterByCover = async () => {
    const ok = await ev(`(()=>{const c = document.getElementById('screen-cover');
      if (!c.classList.contains('show')) return false;
      const r = c.getBoundingClientRect();
      const e = document.elementFromPoint(r.left + r.width/2, r.top + r.height/2);
      return !!(e && e.closest('#screen-cover'));})()`);
    if (!ok) return false;
    await click('#screen-cover');
    return true;
  };

  await send('Runtime.enable'); await send('Log.enable'); await send('Page.enable'); await send('DOM.enable');
  await send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 2, mobile: true });
  // ★ 必须把下载目录钉到临时目录：无头 Chrome 的默认下载目录就是系统「下载」文件夹，
  //   一旦用例误触发了 `exportBackup()`，就会往用户真实的下载目录里丢备份文件（踩过）。
  const dlDir = path.join(tmp, 'downloads');
  fs.mkdirSync(dlDir, { recursive: true });
  await send('Browser.setDownloadBehavior', { behavior: 'allow', downloadPath: dlDir, eventsEnabled: true });
  // ★ 让封面"停住不动"（生产环境不会走这个开关）。
  //   封面现在是停 1800ms 自动进入：进入瞬间它会加 `.leaving` 并保持铺满屏幕 450ms 但不可点，
  //   这 450ms 里若去点它，事件会直接穿到下面的桌面磁贴 —— 正好落在「备份」上，触发一次真实导出。
  //   把自动进入关掉，封面只由我们的点击驱动，就不存在这个竞态了。
  await send('Page.addScriptToEvaluateOnNewDocument', { source: 'window.__diaryNoAutoCover = true;' });
  console.log('\n[file://] 直接双击打开 HTML 文件');
  await send('Page.navigate', { url: FILE });
  await sleep(1800);

  check('页面成功启动（未白屏）', await ev(`document.querySelectorAll('#keypad button').length`) === 11);

  /** 跑一遍核心流程：封面 -> 进入 -> 直接进桌面（密码默认不开启） -> 发布图文日记 -> 刷新 -> 数据仍在 */
  const runFlow = async (label, expectMode) => {
    const mode = await ev(`window.__diary__.Store.mode`);
    check(`${label}：存储后端 = ${expectMode}`, mode === expectMode, `实际 ${mode}`);
    if (mode === 'local') {
      check(`${label}：降级时给出用户提示`, /降级/.test(await ev(`document.getElementById('toast').textContent`)));
    }

    check(`${label}：先显示封面页`, await ev(`document.getElementById('screen-cover').classList.contains('show')`));
    // 封面是"停一下就自动进入"，没有进入按钮了；这里点一下封面提前进入，等价于等满停留时间
    await enterByCover();
    await sleep(800);
    check(`${label}：封面可进入`, !await ev(`document.getElementById('screen-cover').classList.contains('show')`));
    check(`${label}：不强制设密码，直接进主桌面`,
      !await ev(`document.getElementById('screen-lock').classList.contains('show')`)
      && await ev(`document.getElementById('screen-home').classList.contains('active')`));

    await click('#fabWrite');
    await sleep(700);
    await ev(`document.getElementById('composerText').focus()`);
    await send('Input.insertText', { text: label + '：写入的一条日记。' });
    await sleep(200);
    const doc = await send('DOM.getDocument');
    const node = await send('DOM.querySelector', { nodeId: doc.root.nodeId, selector: '#filePicker' });
    await send('DOM.setFileInputFiles', { nodeId: node.nodeId, files: [img] });
    await sleep(1800);
    check(`${label}：图片处理成功`, await ev(`document.querySelectorAll('#composerGrid .cell img').length`) === 1);
    await click('#btnPublish');
    await sleep(1600);
    check(`${label}：日记发表成功`, await ev(`document.querySelectorAll('#timeline .post').length`) === 1);
    check(`${label}：图片渲染有真实尺寸`, await ev(`(()=>{const im=document.querySelector('#timeline .pgrid img');
      if(!im) return false; const r=im.getBoundingClientRect(); return r.width>40 && r.height>40;})()`));
    await send('Page.navigate', { url: FILE });
    await sleep(1800);
    await enterByCover();
    await sleep(800);
    check(`${label}：刷新后仍无需密码直接进入`, !await ev(`document.getElementById('screen-lock').classList.contains('show')`));
    check(`${label}：刷新后数据仍在（持久化可用）`, await ev(`document.querySelectorAll('#timeline .post').length`) === 1);
    check(`${label}：刷新后存储后端一致`, await ev(`window.__diary__.Store.mode`) === expectMode);
    return mode;
  };

  console.log('\n[A] 正常打开（IndexedDB 可用）');
  await runFlow('A', 'idb');
  const r1 = await send('Page.captureScreenshot', { format: 'png' });
  fs.writeFileSync(path.join('shots', '08-file-protocol.png'), Buffer.from(r1.data, 'base64'));

  console.log('\n[B] 强制禁用 IndexedDB（模拟 iOS Safari / 隐私模式）');
  // 同时按住封面自动进入：B 阶段是导航新开页面，接着要断言"先显示封面页"，
  // 不按住的话 1.8s 停留会和 runFlow 里的等待抢跑（A 阶段侥幸没撞上）。
  await send('Page.addScriptToEvaluateOnNewDocument', {
    source: `Object.defineProperty(window, 'indexedDB', { value: undefined, configurable: true });
             window.__diaryNoAutoCover = true;`
  });
  await send('Page.navigate', { url: FILE });
  await sleep(1800);
  check('B：已确认页面内 indexedDB 不可用', await ev(`typeof window.indexedDB`) === 'undefined');
  await ev(`window.__diary__.Store.clearAll()`);   // 清掉上一阶段数据，保证计数断言干净
  await ev(`window.__diary__.loadHome()`);
  await sleep(500);
  await runFlow('B', 'local');
  const r2 = await send('Page.captureScreenshot', { format: 'png' });
  fs.writeFileSync(path.join('shots', '09-localStorage-fallback.png'), Buffer.from(r2.data, 'base64'));

  const errs = events.filter((e) => e.method === 'Runtime.exceptionThrown')
    .map((e) => e.params.exceptionDetails.exception?.description || e.params.exceptionDetails.text);
  check('无未捕获 JS 异常', errs.length === 0, errs.slice(0, 2).join(' | '));

  // ★ 用例全程不应该触发任何"下载"。真的触发了，说明某次点击误点到了桌面「备份」磁贴，
  //   进而调用了 exportBackup() —— 无头 Chrome 的默认下载目录就是用户的「下载」文件夹，
  //   于是一份测试数据会被导成 JSON 丢到用户机器上（真实踩过，必须拦住）。
  const dls = events.filter((e) => e.method === 'Page.downloadWillBegin');
  check('全程没有触发文件下载（不会往用户下载目录丢备份文件）', dls.length === 0,
    dls.map((d) => d.params.suggestedFilename).join(' | '));

  console.log(`\n===== file:// 结果：${pass} 通过 / ${fail} 失败 =====`);
} catch (e) {
  console.error('[脚本错误]', e.message); fail++;
} finally {
  try { chrome.kill(); } catch (e) {}
  await sleep(400);
  try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (e) {}
}
process.exit(fail ? 1 : 0);
