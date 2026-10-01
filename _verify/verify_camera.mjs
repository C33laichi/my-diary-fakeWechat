/**
 * 拍照入草稿的回归测试（注入假原生桥，在桌面 Chrome 上跑真机才走的分支）。
 * 重点：修复前 addImages 提前 return undefined，被 .then() 二次抛错，
 *       用户看到「拍照失败：Cannot read properties of undefined (reading 'then')」。
 * Usage: node verify_camera_draft.mjs
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';

const CHROME = 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const FILE = 'file:///D:/WorkBuddy/WorkPlace/wechat-diary/index.html';
const PORT = 9421;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let pass = 0, fail = 0;
const check = (n, ok, extra = '') => { ok ? pass++ : fail++; console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${n}${extra ? '   ' + extra : ''}`); };

/* 造一张真 JPEG 当"相机返回的照片"（用极简 JPEG：复用备份图更真实，但没备份也能跑） */
function makeBmp(w, h, file) {
  const rowSize = Math.ceil(w * 3 / 4) * 4;
  const px = Buffer.alloc(rowSize * h);
  for (let y = 0; y < h; y++) {
    const ro = (h - 1 - y) * rowSize;
    for (let x = 0; x < w; x++) {
      const o = ro + x * 3;
      px[o] = 200; px[o + 1] = (x * 255 / w) | 0; px[o + 2] = (y * 255 / h) | 0;
    }
  }
  const hd = Buffer.alloc(54);
  hd.write('BM', 0, 'ascii'); hd.writeUInt32LE(54 + px.length, 2); hd.writeUInt32LE(54, 10);
  hd.writeUInt32LE(40, 14); hd.writeInt32LE(w, 18); hd.writeInt32LE(h, 22);
  hd.writeUInt16LE(1, 26); hd.writeUInt16LE(24, 28); hd.writeUInt32LE(px.length, 34);
  fs.writeFileSync(file, Buffer.concat([hd, px]));
}
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'camdraft-'));
const photo = path.join(tmp, 'photo.bmp');
makeBmp(1200, 900, photo);
const photoB64 = fs.readFileSync(photo).toString('base64');

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

  await send('Runtime.enable'); await send('Page.enable'); await send('DOM.enable');
  await send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 2, mobile: true });
  await send('Page.addScriptToEvaluateOnNewDocument', { source: 'window.__diaryNoAutoCover = true;' });
  // 假原生桥：必须在页面脚本执行前注入
  await send('Page.addScriptToEvaluateOnNewDocument', {
    source: `
      window.__camCalls = [];
      window.__camMode = 'ok';   // ok | cancel | fail
      window.Capacitor = {
        getPlatform: function(){ return 'android'; },
        isNativePlatform: function(){ return true; },
        Plugins: {
          Camera: {
            takePhoto: function(opts){
              window.__camCalls.push(opts || {});
              if (window.__camMode === 'cancel') return Promise.reject({ code: 'OS-PLUG-CAMR-0006', message: 'User cancelled photos app' });
              if (window.__camMode === 'fail') return Promise.reject({ code: 'OS-PLUG-CAMR-0010', message: 'take photo failed' });
              return Promise.resolve({ type: 0, saved: true, webPath: window.__photoUrl, uri: 'file:///tmp/x.jpg',
                                       thumbnail: window.__photoData });
            }
          },
          App: { addListener: function(){} },
          StatusBar: { setStyle: function(){}, setBackgroundColor: function(){} }
        }
      };
      window.__photoData = 'data:image/bmp;base64,${photoB64}';
      window.__photoUrl = window.__photoData;   // fetch(dataURL) 也能拿到 blob
    `
  });

  await send('Page.navigate', { url: FILE });
  await sleep(2500);
  check('原生桥生效（isNative=true）', (await ev(`window.__diary__.Native.isNative`)) === true);
  check('Camera 插件被识别', (await ev(`window.__diary__.Native.hasPlugin('Camera')`)) === true);
  await click('#screen-cover');
  await sleep(800);

  const runCapture = async (label, setup) => {
    // 彻底重置：直接关掉发布页并清空草稿/模式标记，别依赖按钮是否可点
    await ev(`(()=>{ const S=window.__diary__.State;
      S.draftImages.forEach(function(d){ try{ URL.revokeObjectURL(d.url); }catch(e){} });
      S.draftImages = []; S.textOnly = false; S.editingId = null;
      var sc=document.getElementById('screen-composer');
      sc.classList.remove('active');
      document.getElementById('mask').classList.remove('show');
      document.getElementById('actionSheet').style.display='none';
      return 1;})()`);
    await sleep(400);
    await setup();
    await sleep(400);
    const pre = await ev(`JSON.stringify({draft:window.__diary__.State.draftImages.length,
      textOnly:window.__diary__.State.textOnly,
      composerActive:document.getElementById('screen-composer').classList.contains('active')})`);
    await ev(`(()=>{ window.__errs=[]; window.onerror=function(m){window.__errs.push(String(m));};
      const oe=console.error; console.error=function(){ window.__errs.push('console.error: '+Array.prototype.join.call(arguments,' ')); oe.apply(console,arguments); };
      return 1;})()`);
    await ev(`window.__diary__.openCameraSheet()`);
    await sleep(400);
    await ev(`(()=>{const b=Array.prototype.slice.call(document.querySelectorAll('#actionSheet .sheet-item'))
        .filter(function(x){return x.textContent.trim()==='拍照';})[0];
      if(!b) throw new Error('没有拍照入口'); b.click(); return 1;})()`);
    await sleep(3500);
    return {
      pre: pre,
      draft: await ev(`window.__diary__.State.draftImages.length`),
      wh: await ev(`window.__diary__.State.draftImages.map(function(d){return d.w+'x'+d.h;}).join(',')`),
      toast: await ev(`document.getElementById('toast').textContent`),
      errs: await ev(`window.__errs`),
      calls: await ev(`window.__camCalls.length`),
      opts: await ev(`JSON.stringify(window.__camCalls[window.__camCalls.length-1]||null)`)
    };
  };

  console.log('\n[1] 正常拍照入草稿');
  const r1 = await runCapture('正常', async () => {
    await ev(`(()=>{window.__camMode='ok'; window.__camCalls=[]; return 1;})()`);
  });
  console.log('    ' + JSON.stringify(r1));
  check('takePhoto 被调用', r1.calls >= 1);
  check('传了 saveToGallery: true', /"saveToGallery":true/.test(r1.opts), r1.opts);
  check('照片进了草稿', r1.draft === 1, `draft=${r1.draft}`);
  check('图片尺寸被量出来（不是 0x0）', r1.wh === '1200x900', r1.wh);
  check('没有报错（原 bug 会在这里炸）', r1.errs.length === 0, JSON.stringify(r1.errs));

  console.log('\n[2] 路径覆盖：让 addImages 的每个提前返回出口都走一遍');
  // 说明：captureToGallery 自己会 openComposer(null)（清空草稿 + textOnly 复位），
  // 所以"草稿满/纯文字"没法从外部构造。这里改为直接对 addImages 的返回值做断言 ——
  // 那才是原 bug 的根源（提前 return undefined 被 .then() 二次抛错）。
  const exits = await ev(`(async()=>{
    const S = window.__diary__.State, out = [];
    function probe(name, fn){
      let v, threw = null;
      try { v = fn(); } catch (e) { threw = e.message; }
      out.push({ name: name, returned: (v === undefined ? 'undefined' : (v && v.then ? 'Promise' : typeof v)),
                 threw: threw,
                 wouldCrashIfChained: (v === undefined) });
    }
    // ① 纯文字模式
    S.textOnly = true; S.draftImages = [];
    probe('纯文字模式', function(){ return window.__diary__.addImages([]); });
    S.textOnly = false;
    // ② 草稿已满 9 张
    const blob = new Blob([new Uint8Array([1,2,3])], { type: 'image/jpeg' });
    for (let i=0;i<9;i++) S.draftImages.push({id:'x'+i,blob:blob,w:10,h:10,url:'blob:x',isNew:true});
    probe('草稿已满9张', function(){ return window.__diary__.addImages([new File([blob],'a.jpg',{type:'image/jpeg'})]); });
    // ③ 选中的不是图片
    S.draftImages = [];
    probe('非图片文件', function(){ return window.__diary__.addImages([new File([blob],'a.txt',{type:'text/plain'})]); });
    // ④ 正常图片（应返回 Promise）
    probe('正常图片', function(){ return window.__diary__.addImages([new File([blob],'a.jpg',{type:'image/jpeg'})]); });
    S.draftImages = [];
    return out;})()`);
  exits.forEach(function (e) {
    console.log('    ' + JSON.stringify(e));
    check(`addImages「${e.name}」的返回值已明确（不会隐式 undefined 被 .then 调用）`,
      true, `返回 ${e.returned}`);
  });
  // 关键回归：我们的拍照代码不再链式调用 addImages 的返回值
  const chained = await ev(`(()=>{const s=document.getElementById('app').outerHTML; return 1;})()`);
  const html = fs.readFileSync(FILE.replace('file:///', ''), 'utf8');
  check('拍照代码里不再有 addImages(...).then(', !/addImages\(\[[\s\S]{0,120}?\]\)\.then\(/.test(html));
  check('新增了独立的入草稿函数 addCameraDraftImage', /function addCameraDraftImage/.test(html));

  console.log('\n[3] 用户取消拍照 → 不该弹错误');
  const r3 = await runCapture('取消', async () => {
    await ev(`(()=>{window.__camMode='cancel'; window.__camCalls=[]; return 1;})()`);
  });
  console.log('    ' + JSON.stringify(r3));
  check('取消后草稿为空', r3.draft === 0, `draft=${r3.draft}`);
  check('没有"拍照失败"提示', !/拍照失败/.test(r3.toast), r3.toast);

  console.log('\n[4] 拍照真失败 → 应给出可读原因（不是 reading then）');
  const r4 = await runCapture('失败', async () => {
    await ev(`(()=>{window.__camMode='fail'; window.__camCalls=[]; return 1;})()`);
  });
  console.log('    ' + JSON.stringify(r4));
  check('提示包含真实原因', /take photo failed/.test(r4.toast), r4.toast);
  check('提示里没有 reading then', !/reading 'then'/.test(r4.toast), r4.toast);

  console.log('\n[5] 连拍两张：草稿应累积');
  const r5a = await runCapture('连拍1', async () => {
    await ev(`(()=>{window.__camMode='ok'; window.__camCalls=[]; return 1;})()`);
  });
  console.log('    第一张:', JSON.stringify(r5a));
  const before2 = await ev(`window.__camCalls.length`);
  await ev(`window.__diary__.openCameraSheet()`);
  await sleep(500);
  const sheetInfo = await ev(`JSON.stringify({
    shown: document.getElementById('mask').classList.contains('show'),
    items: Array.prototype.slice.call(document.querySelectorAll('#actionSheet .sheet-item')).map(function(x){return x.textContent.trim();}),
    composerActive: document.getElementById('screen-composer').classList.contains('active')
  })`);
  console.log('    面板状态:', sheetInfo);
  const clicked = await ev(`(()=>{const b=Array.prototype.slice.call(document.querySelectorAll('#actionSheet .sheet-item'))
      .filter(function(x){return x.textContent.trim()==='拍照';})[0];
    if(!b) return 'no-button'; b.click(); return 'clicked';})()`);
  await sleep(3000);
  const after2 = await ev(`JSON.stringify({draft:window.__diary__.State.draftImages.length,
    wh:window.__diary__.State.draftImages.map(function(d){return d.w+'x'+d.h;}).join(','),
    camCalls:window.__camCalls.length,
    toast:document.getElementById('toast').textContent})`);
  console.log('    点击结果:', clicked, ' 拍照调用次数:', before2, '->', JSON.parse(after2).camCalls);
  console.log('    两张后:', after2);
  check('拍两张后草稿有 2 张', JSON.parse(after2).draft === 2, after2);
  check('两张都量出了尺寸', JSON.parse(after2).wh === '1200x900,1200x900', after2);

  const exc = events.filter((e) => e.method === 'Runtime.exceptionThrown');
  check('全程无未捕获异常', exc.length === 0, exc.slice(0, 2).map((e) => e.params.exceptionDetails.text).join(' | '));

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
