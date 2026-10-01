/**
 * Verify the three changes in index.html with headless Chrome over CDP.
 * Zero deps: Node built-in fetch/WebSocket + system Chrome.
 *   1. Photo viewer zoom (wheel / double-click / pinch / pan-while-zoomed)
 *   2. Landscape adaptation (390x844 -> 844x390)
 *   3. "Take photo" web fallback still works (native gallery save needs a real device)
 * Usage:  cd _verify && node verify_zoom_rotate.mjs
 *   (头文件里注释用英文是为了避开 PowerShell 控制台的编码问题，不影响运行)
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const CHROME = 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const FILE = 'file:///D:/WorkBuddy/WorkPlace/wechat-diary/index.html';
const PORT = 9377;
// 与同目录其它脚本一致：截图落在 _verify/shots/
const OUT = path.resolve('shots');
fs.mkdirSync(OUT, { recursive: true });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let pass = 0, fail = 0;
const check = (n, ok, extra = '') => { ok ? pass++ : fail++; console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${n}${extra ? '   ' + extra : ''}`); };

/* ---------- real image generator ----------
   BMP on purpose: 24-bit uncompressed BMP has no CRCs and no zlib stream, so the
   decoder can never reject it over format details. (A hand-rolled PNG can look
   structurally perfect and still be refused by Chrome's decoder.) */
function makeBmp(w, h, file) {
  const rowSize = Math.ceil(w * 3 / 4) * 4;
  const pixels = Buffer.alloc(rowSize * h);
  for (let y = 0; y < h; y++) {
    const rowOff = (h - 1 - y) * rowSize;          // BMP rows are bottom-up
    for (let x = 0; x < w; x++) {
      const diag = Math.abs((x / w) - (y / h)) < 0.03;
      const corner = (x < w * 0.12 || x > w * 0.88) && (y < h * 0.12 || y > h * 0.88);
      const o = rowOff + x * 3;
      pixels[o] = diag ? 60 : 150;                 // blue
      pixels[o + 1] = corner ? 200 : (y * 255 / h) | 0;  // green
      pixels[o + 2] = diag ? 255 : corner ? 40 : (x * 255 / w) | 0;  // red
    }
  }
  const header = Buffer.alloc(54);
  header.write('BM', 0, 'ascii');
  header.writeUInt32LE(54 + pixels.length, 2);
  header.writeUInt32LE(54, 10);
  header.writeUInt32LE(40, 14);
  header.writeInt32LE(w, 18);
  header.writeInt32LE(h, 22);
  header.writeUInt16LE(1, 26);
  header.writeUInt16LE(24, 28);
  header.writeUInt32LE(pixels.length, 34);
  fs.writeFileSync(file, Buffer.concat([header, pixels]));
}

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'diary-zoom-'));
const img = path.join(tmp, 'probe.bmp');
makeBmp(1200, 900, img);
console.log('test image:', img, fs.existsSync(img) ? fs.statSync(img).size + ' bytes' : 'MISSING');

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
    setTimeout(() => { if (waiting.has(i)) { waiting.delete(i); rej(new Error('timeout ' + method)); } }, 15000);
  });
  const ev = async (expr) => {
    const r = await send('Runtime.evaluate', { expression: `(async()=>{return (${expr});})()`, awaitPromise: true, returnByValue: true });
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text);
    return r.result.value;
  };
  const click = async (sel) => {
    const b = await ev(`(()=>{const e=document.querySelector('${sel}');if(!e)return null;
      e.scrollIntoView({block:'center'});const r=e.getBoundingClientRect();return {x:r.left+r.width/2,y:r.top+r.height/2};})()`);
    if (!b) throw new Error('selector not found: ' + sel);
    const hit = await ev(`(()=>{const e=document.elementFromPoint(${b.x},${b.y});
      return e && e.closest('${sel}') ? 'ok' : (e ? e.tagName + (e.id?'#'+e.id:'') : 'null');})()`);
    if (hit !== 'ok') throw new Error(`click target covered: ${sel} -> hit ${hit}`);
    await send('Input.dispatchMouseEvent', { type: 'mousePressed', x: b.x, y: b.y, button: 'left', clickCount: 1, buttons: 1 });
    await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: b.x, y: b.y, button: 'left', clickCount: 1, buttons: 0 });
  };
  const shot = async (name) => {
    const r = await send('Page.captureScreenshot', { format: 'png' });
    fs.writeFileSync(path.join(OUT, name), Buffer.from(r.data, 'base64'));
  };
  /** one round-trip for many element rects */
  const rects = (sels) => ev(`(()=>{const m={};for(const [k,s] of ${JSON.stringify(sels)}){const e=document.querySelector(s);
    m[k]= e ? (()=>{const r=e.getBoundingClientRect();return {x:Math.round(r.left),y:Math.round(r.top),w:Math.round(r.width),h:Math.round(r.height)};})() : null;}return m;})()`);
  const imgTf = () => ev(`(()=>{const im=document.querySelector('#viewerTrack .slide img');return im?im.style.transform:'';})()`);
  const scaleOf = (t) => { const m = /scale\(([\d.]+)\)/.exec(t || ''); return m ? parseFloat(m[1]) : 1; };

  await send('Runtime.enable'); await send('Page.enable'); await send('DOM.enable');
  await send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 2, mobile: true });
  await send('Page.addScriptToEvaluateOnNewDocument', { source: 'window.__diaryNoAutoCover = true;' });
  await send('Page.navigate', { url: FILE });
  await sleep(2000);

  console.log('\n[0] boot / sanity');
  check('page booted', (await ev(`document.querySelectorAll('#keypad button').length`)) === 11);
  check('Native.hasPlugin exists', await ev(`typeof window.__diary__.Native.hasPlugin === 'function'`));
  check('web build is not treated as native (camera uses fallback)', (await ev(`window.__diary__.Native.isNative`)) === false);

  /* ---------- seed one post with one image ----------
     Order matters: openComposer() clears the draft synchronously, so the composer must be
     opened FIRST and the file injected afterwards (that is also the real user path:
     tap the composer, then pick a photo). */
  await click('#screen-cover');
  await sleep(700);
  await click('#fabWrite');
  await sleep(700);
  await ev(`document.getElementById('composerText').focus()`);
  await send('Input.insertText', { text: 'zoom-verify post' });
  const doc = await send('DOM.getDocument');
  const node = await send('DOM.querySelector', { nodeId: doc.root.nodeId, selector: '#filePicker' });
  check('file input found in DOM', !!node && !!node.nodeId, JSON.stringify(node));
  await send('DOM.setFileInputFiles', { nodeId: node.nodeId, files: [img] });
  await sleep(3000);
  const draftN = await ev(`document.querySelectorAll('#composerGrid .cell img').length`);
  const draftUrls = await ev(`[...document.querySelectorAll('#composerGrid .cell img')].map(i=>i.src.slice(0,12))`);
  check('image added to composer draft', draftN === 1, `count=${draftN} urls=${JSON.stringify(draftUrls)}`);
  await click('#btnPublish');
  await sleep(1800);
  check('post published', (await ev(`document.querySelectorAll('#timeline .post').length`)) === 1);
  const entryImgs = await ev(`(window.__diary__.State.entries[0]||{}).images || []`);
  check('published entry really carries an image', Array.isArray(entryImgs) && entryImgs.length === 1, JSON.stringify(entryImgs));
  const tlImgs = await ev(`document.querySelectorAll('#timeline .pgrid img').length`);
  check('timeline grid rendered the image', tlImgs === 1, `count=${tlImgs}`);

  /* ================= item 1: in-app gallery ================= */
  console.log('\n[1] in-app gallery shows the image');
  await ev(`window.__diary__.switchTab('gallery')`);
  await sleep(900);
  const galDiag = await ev(`(()=>{const inner=document.getElementById('galInner');
    return {html: inner ? inner.innerHTML.slice(0,160) : null,
            imgs: document.querySelectorAll('#galInner .gal-grid img').length,
            links: document.querySelectorAll('#galInner .gal-grid a').length,
            anyImg: document.querySelectorAll('#galInner img').length};})()`);
  console.log('    gallery diag:', JSON.stringify(galDiag));
  const galCount = await ev(`document.querySelectorAll('#galInner img').length`);
  check('gallery has images', galCount > 0, `found ${galCount}`);
  check('gallery image has real size', await ev(`(()=>{const im=document.querySelector('#galInner img');
    if(!im) return false; const r=im.getBoundingClientRect(); return r.width>20 && r.height>20;})()`));
  await shot('v0-gallery.png');

  /* ================= item 2: photo zoom ================= */
  console.log('\n[2] photo viewer zoom');
  await ev(`window.__diary__.switchTab('timeline')`);
  await sleep(600);
  await click('#timeline .pgrid .ph img');
  await sleep(700);
  check('viewer opened', await ev(`document.getElementById('viewer').classList.contains('show')`));
  check('not zoomed before input', scaleOf(await imgTf()) === 1);
  await shot('v1-viewer-normal.png');

  const vc = await ev(`(()=>{const r=document.getElementById('viewerTrack').getBoundingClientRect();
    return {x:Math.round(r.left+r.width/2), y:Math.round(r.top+r.height/2)};})()`);

  // 2a wheel zoom (desktop path; also self-checks vApplyScale)
  await send('Input.dispatchMouseEvent', { type: 'mouseWheel', x: vc.x, y: vc.y, deltaX: 0, deltaY: -120, modifiers: 0 });
  await sleep(300);
  const t1 = await imgTf();
  const s1 = scaleOf(t1);
  check('wheel-up zooms in', s1 > 1.05, `scale=${s1.toFixed(3)}`);
  check('zoom carries a translation (zooms around pointer)', /translate\(/.test(t1), t1);
  check('counter shows zoom factor', /x$/.test((await ev(`document.getElementById('viewerCount').textContent`)) || ''),
    await ev(`document.getElementById('viewerCount').textContent`));
  await shot('v2-viewer-zoomed.png');

  // 2b pan while zoomed must move the image, not flip pages
  const before = await imgTf();
  await send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: vc.x, y: vc.y }] });
  await send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x: vc.x - 60, y: vc.y }] });
  await send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x: vc.x - 120, y: vc.y }] });
  await send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  await sleep(300);
  const after = await imgTf();
  check('drag while zoomed changes translation', after !== before, `${before} -> ${after}`);
  check('drag while zoomed does not flip page', (await ev(`window.__diary__.State.viewerIndex`)) === 0);

  // 2c pinch zoom (touchstart/touchmove vPinch branch)
  await ev(`window.__diary__.State.viewerReset && window.__diary__.State.viewerReset()`);
  await sleep(200);
  await send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: vc.x - 40, y: vc.y }, { x: vc.x + 40, y: vc.y }] });
  await send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x: vc.x - 80, y: vc.y }, { x: vc.x + 80, y: vc.y }] });
  await send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x: vc.x - 140, y: vc.y }, { x: vc.x + 140, y: vc.y }] });
  await send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  await sleep(350);
  const s2 = scaleOf(await imgTf());
  check('pinch zooms in', s2 > 1.5, `scale=${s2.toFixed(3)}`);
  await shot('v3-viewer-pinch.png');

  // 2d regression: zoom by pinch, close the viewer, reopen it.
  // The zoom state lives in the bindEvents closure, so before the fix it survived the
  // close: the DOM looked 1x but vScale was still 4.02, and the first double-click was
  // swallowed by the "cancel zoom" branch. This asserts one double-click is enough.
  await ev(`document.getElementById('viewerClose').click()`);
  await sleep(400);
  await click('#timeline .pgrid .ph img');
  await sleep(800);
  check('reopened viewer is rendered at 1x', scaleOf(await imgTf()) === 1);
  check('reopened viewer reports 1x of internal state too', (await ev(`window.__diary__.State.viewerZoom`)) === 1);
  const vc2 = await ev(`(()=>{const r=document.getElementById('viewerTrack').getBoundingClientRect();
    return {x:Math.round(r.left+r.width/2), y:Math.round(r.top+r.height/2)};})()`);
  const dblClick = async (pt) => {
    for (let i = 0; i < 2; i++) {
      await send('Input.dispatchMouseEvent', { type: 'mousePressed', x: pt.x, y: pt.y, button: 'left', clickCount: i + 1, buttons: 1 });
      await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: pt.x, y: pt.y, button: 'left', clickCount: i + 1, buttons: 0 });
      await sleep(60);
    }
  };
  await dblClick(vc2);
  await sleep(500);
  const s3 = scaleOf(await imgTf());
  check('first double-click after reopen zooms in (state leaked before fix)', s3 > 1.5, `scale=${s3.toFixed(3)}`);
  await dblClick(vc2);
  await sleep(500);
  const s4 = scaleOf(await imgTf());
  check('second double-click returns to 1x', s4 === 1, `scale=${s4.toFixed(3)}`);

  check('reset cleared zoom', scaleOf(await imgTf()) === 1);
  await ev(`document.getElementById('viewerClose').click()`);
  await sleep(400);
  check('viewer closed with no leftovers', (await ev(`document.querySelectorAll('#viewerTrack img').length`)) === 0);

  /* ================= item 3: landscape ================= */
  console.log('\n[3] landscape (390x844 -> 844x390)');
  const p1 = await rects([['nav', '#screen-timeline .nav'], ['cover', '#screen-timeline .cover'],
    ['scroll', '#homeScroll'], ['tabbar', '.tabbar'], ['app', '#app']]);
  await send('Emulation.setDeviceMetricsOverride', { width: 844, height: 390, deviceScaleFactor: 2, mobile: true });
  await sleep(1000);
  const l1 = await rects([['nav', '#screen-timeline .nav'], ['cover', '#screen-timeline .cover'],
    ['scroll', '#homeScroll'], ['tabbar', '.tabbar'], ['app', '#app']]);
  console.log('    portrait :', JSON.stringify(p1));
  console.log('    landscape:', JSON.stringify(l1));
  check('app height matches viewport', l1.app && Math.abs(l1.app.h - 390) <= 2, `h=${l1.app && l1.app.h}`);
  check('nav squeezed to 38px', l1.nav && l1.nav.h === 38, `h=${l1.nav && l1.nav.h}`);
  check('cover no longer eats half the screen', l1.cover && l1.cover.h <= 235, `h=${l1.cover && l1.cover.h}`);
  const visible = l1.scroll && l1.scroll.h;
  check('content viewport >= 200px', visible >= 200, `h=${visible}`);
  check('content viewport ratio >= 55%', visible / 390 >= 0.55, `${Math.round(visible / 390 * 100)}%`);
  check('tabbar labels hidden in landscape', await ev(`(()=>{const s=document.querySelector('.tabbar .tab span');
    return s ? getComputedStyle(s).display === 'none' : false;})()`));
  await shot('v4-landscape-timeline.png');

  await ev(`window.__diary__.switchTab('home')`);
  await sleep(500);
  await shot('v5-landscape-home.png');
  await ev(`window.__diary__.switchTab('gallery')`);
  await sleep(500);
  await shot('v6-landscape-gallery.png');

  await ev(`window.__diary__.switchTab('timeline')`);
  await sleep(500);
  await click('#timeline .pgrid .ph img');
  await sleep(700);
  const vdiag = await ev(`(()=>{const v=document.getElementById('viewer'), t=document.getElementById('viewerTrack'),
    s=document.querySelector('#viewerTrack .slide'), im=document.querySelector('#viewerTrack .slide img');
    const R=e=>{if(!e)return null;const r=e.getBoundingClientRect();return {w:Math.round(r.width),h:Math.round(r.height)};};
    return {viewer:R(v), track:R(t), slide:R(s), img:R(im),
      imgNatural: im?im.naturalWidth+'x'+im.naturalHeight:null,
      imgInlineStyle: im?im.getAttribute('style'):null,
      imgMaxH: im?getComputedStyle(im).maxHeight:null,
      imgMaxW: im?getComputedStyle(im).maxWidth:null,
      trackH: t?getComputedStyle(t).height:null,
      slideH: s?getComputedStyle(s).height:null,
      open: v?v.classList.contains('show'):null};})()`);
  console.log('    viewer diag:', JSON.stringify(vdiag));
  const vfit = await ev(`(()=>{const im=document.querySelector('#viewerTrack .slide img');if(!im)return null;
    const r=im.getBoundingClientRect();return {w:Math.round(r.width),h:Math.round(r.height),vw:innerWidth,vh:innerHeight};})()`);
  check('viewer image fits inside landscape viewport', !!vfit && vfit.w <= 844 && vfit.h <= 390, JSON.stringify(vfit));
  await shot('v7-landscape-viewer.png');
  await ev(`document.getElementById('viewerClose').click()`);

  await send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 2, mobile: true });
  await sleep(1000);
  const back = await rects([['nav', '#screen-timeline .nav'], ['cover', '#screen-timeline .cover'], ['scroll', '#homeScroll']]);
  check('back to portrait: nav 46px again', back.nav && back.nav.h === 46, `h=${back.nav && back.nav.h}`);
  check('back to portrait: cover 250px again', back.cover && back.cover.h === 250, `h=${back.cover && back.cover.h}`);
  check('back to portrait: tabbar labels visible again', await ev(`(()=>{const s=document.querySelector('.tabbar .tab span');
    return s ? getComputedStyle(s).display !== 'none' : false;})()`));

  /* ================= camera entry (web fallback) ================= */
  console.log('\n[4] camera entry, web fallback');
  await ev(`window.__diary__.openCameraSheet()`);
  await sleep(400);
  const sheetLabels = await ev(`[...document.querySelectorAll('#actionSheet .sheet-item')].map(b=>b.textContent.trim())`);
  check('sheet has both camera entries', sheetLabels.length >= 2, JSON.stringify(sheetLabels));
  await ev(`document.querySelectorAll('#actionSheet .sheet-item')[0].click()`);
  await sleep(700);
  const errsAll = events.filter((e) => e.method === 'Runtime.exceptionThrown');
  check('tapping the first entry throws nothing', errsAll.length === 0,
    errsAll.map((e) => e.params.exceptionDetails.exception?.description || e.params.exceptionDetails.text).slice(0, 2).join(' | '));
  await ev(`window.__diary__.closeMask()`);

  console.log(`\n===== result: ${pass} passed / ${fail} failed =====`);
  console.log('screenshots: ' + OUT);
} catch (e) {
  console.error('[script error]', e.message); fail++;
} finally {
  try { ws && ws.close(); } catch (e) {}
  try { chrome.kill(); } catch (e) {}
  await sleep(400);
  try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (e) {}
}
process.exit(fail ? 1 : 0);
