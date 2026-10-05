/**
 * wechat-diary 端到端验证（零依赖：Node 内置 fetch/WebSocket + 系统 Chrome CDP）
 * 覆盖：封面页 -> 锁屏 -> 主桌面 -> 发布图文 -> 时间线 -> 相册 -> 搜索 -> 统计
 *       -> 编辑/删除 -> 刷新持久化 -> 我的 -> 三档响应式 -> 控制台异常
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';

const CHROME = 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const BASE = process.env.BASE || 'http://127.0.0.1:7788/';
const PORT = 9333;
const PIN = '135792';
const NEWPIN = '246801';   // 改密码用例用，必须与 PIN 不同且是 6 位
const OUT = path.resolve('shots');
fs.mkdirSync(OUT, { recursive: true });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let pass = 0, fail = 0;
function check(name, ok, extra = '') {
  if (ok) { pass++; console.log(`  ✓ ${name}${extra ? '  ' + extra : ''}`); }
  else { fail++; console.log(`  ✗ ${name}  ${extra}`); }
}

/* ---------- 生成真实 PNG（测试图片压缩与存储链路） ---------- */
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
  return png.length;
}

/* ---------- CDP 客户端 ---------- */
class CDP {
  constructor(ws) { this.ws = ws; this.id = 0; this.waiting = new Map(); this.events = []; }
  static async connect(wsUrl) {
    const ws = new WebSocket(wsUrl);
    await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
    const c = new CDP(ws);
    ws.onmessage = (ev) => {
      const msg = JSON.parse(ev.data);
      if (msg.id && c.waiting.has(msg.id)) {
        const { res, rej } = c.waiting.get(msg.id);
        c.waiting.delete(msg.id);
        msg.error ? rej(new Error(JSON.stringify(msg.error))) : res(msg.result);
      } else if (msg.method) c.events.push(msg);
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
      expression: `(async () => { return (${expr}); })()`,
      awaitPromise: true, returnByValue: true
    });
    if (r.exceptionDetails) throw new Error('页面异常: ' + (r.exceptionDetails.exception?.description || r.exceptionDetails.text));
    return r.result.value;
  }
  async viewport(w, h, mobile = false) {
    await this.send('Emulation.setDeviceMetricsOverride', { width: w, height: h, deviceScaleFactor: 1, mobile });
  }
  async shot(file) {
    const r = await this.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
    fs.writeFileSync(path.join(OUT, file), Buffer.from(r.data, 'base64'));
  }
  async clickPoint(x, y, holdMs = 0) {
    await this.send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', clickCount: 1, buttons: 1 });
    if (holdMs) await sleep(holdMs);
    await this.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', clickCount: 1, buttons: 0 });
  }
  async clickSel(sel) {
    const box = await this.evalJs(`(() => { const e = document.querySelector('${sel}');
      if (!e) return null; e.scrollIntoView({block:'center'});
      const r = e.getBoundingClientRect(); return {x: r.left + r.width/2, y: r.top + r.height/2}; })()`);
    if (!box) throw new Error('找不到元素 ' + sel);
    // 断言点击真的命中目标，把"点了空"和"点了没反应"区分开；
    // 报错时把真正压在上面的元素带出来，不然只能靠猜
    const diag = await this.evalJs(`(() => { const el = document.elementFromPoint(${box.x}, ${box.y});
      if (el && el.closest('${sel}')) return { ok: true };
      return { ok: false, got: el ? (el.tagName + '.' + (el.className || '') + '#' + (el.id || '')) : 'null',
               path: el ? (() => { const p = []; let n = el; while (n && n !== document.body) { p.push(n.tagName + '.' + (n.className || '')); n = n.parentNode; } return p.slice(0,4).join(' < '); })() : '' }; })()`);
    if (!diag.ok) throw new Error('点击位置被遮挡: ' + sel + ' -> 实际命中 ' + diag.got + ' | ' + diag.path);
    await this.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: box.x, y: box.y, buttons: 0 });
    await this.clickPoint(box.x, box.y);
    return true;
  }
  /**
   * 按**文案**点确认框里的按钮。
   * 别用 `#dialogBtns button[data-i="1"]` 这种下标：按钮一多（或多一个「暂不设置」
   * 之类的新项），下标就漂了，用例会点到隔壁那个按钮上去，还可能一路"假通过"。
   */
  async clickDialog(label) {
    const ok = await this.evalJs(`(() => {
      const bs = Array.from(document.querySelectorAll('#dialogBtns button'));
      const b = bs.find(x => x.textContent.trim() === ${JSON.stringify(label)});
      if (!b) return false; b.click(); return true; })()`);
    if (!ok) throw new Error('确认框里找不到按钮「' + label + '」');
    await sleep(320);
  }
  /** 当前弹层里有哪些按钮，用于断言"该有的有、不该有的没有" */
  dialogBtns() {
    return this.evalJs(`Array.from(document.querySelectorAll('#dialogBtns button')).map(b => b.textContent.trim())`);
  }
  async setFiles(sel, files) {
    const doc = await this.send('DOM.getDocument');
    const node = await this.send('DOM.querySelector', { nodeId: doc.root.nodeId, selector: sel });
    if (!node.nodeId) throw new Error('找不到 input ' + sel);
    await this.send('DOM.setFileInputFiles', { nodeId: node.nodeId, files });
  }
  pageErrors() {
    return this.events.filter((e) => {
      if (e.method === 'Runtime.exceptionThrown') return true;
      if (e.method !== 'Log.entryAdded' || e.params.entry.level !== 'error') return false;
      const text = (e.params.entry.text || '') + ' ' + (e.params.entry.url || '');
      return !/favicon/i.test(text);
    }).map((e) => e.method === 'Runtime.exceptionThrown'
      ? (e.params.exceptionDetails.exception?.description || e.params.exceptionDetails.text)
      : e.params.entry.text + ' @ ' + (e.params.entry.url || ''));
  }
}

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'diary-cdp-'));
const testImg = path.join(tmp, 'photo.png');
const imgBytes = makePng(1200, 900, testImg);
const manyImgs = [];
for (let i = 1; i <= 9; i++) { const f = path.join(tmp, `g${i}.png`); makePng(600 + i * 40, 500 + i * 30, f); manyImgs.push(f); }
console.log(`测试图片: ${(imgBytes / 1024).toFixed(0)} KB 1200x900 + 9 张九宫格图`);

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
  await cdp.send('Runtime.enable'); await cdp.send('Log.enable');
  await cdp.send('Page.enable'); await cdp.send('DOM.enable');
  await cdp.viewport(390, 844, true);
  // ★ 把下载目录钉到临时目录。无头 Chrome 不设这个就会用系统「下载」文件夹当默认目录，
  //   一旦用例误触发网页版导出（<a download>），测试数据就会被丢到用户真实下载目录里。
  const dlDir = path.join(tmp, 'downloads');
  fs.mkdirSync(dlDir, { recursive: true });
  await cdp.send('Browser.setDownloadBehavior', { behavior: 'allow', downloadPath: dlDir, eventsEnabled: true });

  /** 完整进入流程：封面（停一下自动进）-> (可选) 输入密码 */
  const boot = async (pin) => {
    await cdp.send('Page.navigate', { url: BASE + '?t=' + Date.now() });
    // 封面改成"停一下就进"，等 1.8s 停留 + 0.45s 淡出 + 余量
    await sleep(3200);
    if (await cdp.evalJs(`document.getElementById('screen-cover').classList.contains('show')`)) {
      await cdp.clickSel('#screen-cover');
      await sleep(800);
    }
    if (pin) {
      for (const k of pin) await cdp.clickSel(`.keypad button[data-k="${k}"]`);
      await sleep(800);
    }
  };

  /**
   * 进到封面并"按住"它（关掉自动进入的定时器）。
   * 封面现在是自动走的，不按住的话断言会在半路上被切走，测出来的东西不可信。
   * 开关用 addScriptToEvaluateOnNewDocument 注入，保证在 boot() 之前生效。
   *
   * ⚠️ 这类注入脚本是**累积**的：每调用一次就多注册一段，导航后按注册顺序依次执行，
   *    靠后的覆盖靠前的。所以按住/放行必须成对出现，且每次导航前都要重新声明意图，
   *    否则会残留上一节的 `true`，让封面永久停住。
   */
  const gotoCoverHeld = async () => {
    await cdp.send('Page.addScriptToEvaluateOnNewDocument', {
      source: 'window.__diaryNoAutoCover = true;'
    });
    await cdp.send('Page.navigate', { url: BASE + '?t=' + Date.now() });
    await sleep(1600);
  };
  /** 放行：让封面重新自动进入（导航后立刻返回，停留时长由调用方自己掌握） */
  const releaseCoverHold = async () => {
    await cdp.send('Page.addScriptToEvaluateOnNewDocument', {
      source: 'window.__diaryNoAutoCover = false;'
    });
    await cdp.send('Page.navigate', { url: BASE + '?t=' + Date.now() });
    await sleep(250);
  };

  console.log('\n[1] 封面页');
  await gotoCoverHeld();
  check('封面页显示', await cdp.evalJs(`document.getElementById('screen-cover').classList.contains('show')`));
  check('封面页有标题「我的日记」', (await cdp.evalJs(`document.querySelector('.cover-title').textContent`)).trim() === '我的日记');
  check('封面页有品牌副标题', /写给自己的日子/.test(await cdp.evalJs(`document.querySelector('.cover-sub').textContent`)));
  check('封面页底部有隐私说明', /仅保存在本机/.test(await cdp.evalJs(`document.querySelector('.cover-foot').textContent`)));
  check('背景为纯 CSS 图层（无外部图片请求）',
    await cdp.evalJs(`getComputedStyle(document.getElementById('screen-cover'),'::before').backgroundImage.includes('linear-gradient')`));
  check('启动决策完成（booting 已解除，不挡主界面）',
    await cdp.evalJs(`document.getElementById('app').classList.contains('booting') === false`));
  // ★ 本次改动重点：不再需要点按钮，停一下就自动进入
  check('没有多余的「进入」按钮', await cdp.evalJs(`!document.getElementById('btnEnter')`));
  check('有自动进入的进度条', await cdp.evalJs(`!!document.getElementById('coverProgress')`));
  check('进度条正在跑自动进入动画',
    await cdp.evalJs(`document.getElementById('coverProgress').classList.contains('run')`));
  check('有「正在进入」的提示文案', /正在进入/.test(await cdp.evalJs(`document.querySelector('.cover-enter-hint').textContent`)));
  const pbarW = await cdp.evalJs(`Math.round(document.querySelector('.cover-auto').getBoundingClientRect().width)`);
  check('进度条尺寸合理', pbarW > 60 && pbarW < 320, `${pbarW}px`);
  await cdp.shot('10-cover.png');

  console.log('\n[1b] 停一下就自动进入（不需要任何点击）');
  // 注意：[1] 用 addScriptToEvaluateOnNewDocument 把自动进入"按住"了，
  // 而这类注入脚本会一直累积生效（后注册的覆盖先注册的），所以本节要显式放行一次，
  // 否则导航后 __diaryNoAutoCover 仍是 true，永久停在封面上。
  await releaseCoverHold();
  await sleep(1200);
  check('停留 1.2s 时仍在封面（确实是"停一下"而不是闪一下）',
    await cdp.evalJs(`document.getElementById('screen-cover').classList.contains('show')`));
  await sleep(2600);   // 累计 3.8s > 1.8s 停留 + 0.45s 淡出
  check('未做任何点击，已自动离开封面',
    !await cdp.evalJs(`document.getElementById('screen-cover').classList.contains('show')`),
    `noAutoCover=${await cdp.evalJs('String(window.__diaryNoAutoCover)')}`);
  check('自动进入后落在首页', await cdp.evalJs(`document.getElementById('screen-home').classList.contains('active')`));

  console.log('\n[1c] 点击可以提前进入（不必等满 1.8s）');
  await gotoCoverHeld();
  await cdp.clickSel('#screen-cover');
  await sleep(900);
  check('点击封面后立即进入', !await cdp.evalJs(`document.getElementById('screen-cover').classList.contains('show')`));
  check('重复点击不会出错（enterApp 幂等）',
    await cdp.evalJs(`(() => { try { window.__diary__.enterApp(); window.__diary__.enterApp(); return true; } catch (e) { return false; } })()`));

  console.log('\n[2] 进入 -> 不强制设密码，直接进首页');
  await cdp.send('Page.addScriptToEvaluateOnNewDocument', { source: 'window.__diaryNoAutoCover = false;' });
  await cdp.clickSel('#tabbar .tab[data-tab="mine"]');
  await sleep(600);
  check('不再强制设置密码（锁屏不出现）',
    !await cdp.evalJs(`document.getElementById('screen-lock').classList.contains('show')`));
  check('标签栏第一项文案为「首页」',
    (await cdp.evalJs(`document.querySelector('#tabbar .tab[data-tab="home"] span').textContent`)).trim() === '首页');
  check('密码默认未开启（pinEnabled=false）', await cdp.evalJs(`!window.__diary__.Meta.data.pinEnabled`));
  check('密码默认为空（pinHash 为空）', await cdp.evalJs(`!window.__diary__.Meta.data.pinHash`));
  check('入口右侧状态显示「未设置」', (await cdp.evalJs(`document.getElementById('pinStateText').textContent`)) === '未设置');
  check('开关默认关闭', !await cdp.evalJs(`document.getElementById('switchLock').classList.contains('on')`));
  check('说明文案点明密码是可选功能', /可选功能/.test(await cdp.evalJs(`document.getElementById('lockNote').textContent`)));
  await cdp.shot('11-lock-optional.png');
  await cdp.clickSel('#tabbar .tab[data-tab="home"]');
  await sleep(500);

  console.log('\n[2b] 左上返回键（微信式）');
  await cdp.clickSel('#fabWrite');
  await sleep(700);
  const backGeo = await cdp.evalJs(`(() => {
    const b = document.getElementById('btnCancelCompose');
    const r = b.getBoundingClientRect();
    const ico = b.querySelector('svg').getBoundingClientRect();
    const nav = b.closest('.nav').getBoundingClientRect();
    return { cls: b.className, w: Math.round(r.width), h: Math.round(r.height),
             icoLeft: Math.round(ico.left - nav.left), first: b.closest('.nav').firstElementChild === b,
             path: b.querySelector('svg path').getAttribute('d'),
             label: b.getAttribute('aria-label') }; })()`);
  check('发布页左上是返回键（导航栏第一个元素）', backGeo.first, backGeo.cls);
  check('返回键用 nav-back 定位类', /nav-back/.test(backGeo.cls));
  check('返回键是左箭头图标（非文字）', /^M9\.5 1\.5 2 9\.5l7\.5 8$/.test(backGeo.path), backGeo.path);
  check('图标贴左缘约 16px', Math.abs(backGeo.icoLeft - 16) <= 4, backGeo.icoLeft + 'px');
  check('触控热区不小于 44×44', backGeo.w >= 44 && backGeo.h >= 44, `${backGeo.w}x${backGeo.h}`);
  check('返回键有无障碍标签', backGeo.label === '返回');
  await cdp.shot('11b-composer-back.png');
  await cdp.clickSel('#btnCancelCompose');
  await sleep(700);
  check('返回键收起发布页、回到主桌面',
    !await cdp.evalJs(`document.getElementById('screen-composer').classList.contains('active')`)
    && await cdp.evalJs(`document.getElementById('screen-home').classList.contains('active')`));

  console.log('\n[2c] 网页版不加载任何原生逻辑');
  const nb = await cdp.evalJs(`(() => { const N = window.__diary__.Native;
    return { hasCapacitor: typeof window.Capacitor !== 'undefined', isNative: N.isNative,
             platform: N.platform, appP: N.plugin('App') === null, fsP: N.plugin('Filesystem') === null,
             statusP: N.plugin('StatusBar') === null }; })()`);
  check('浏览器里没有 window.Capacitor', nb.hasCapacitor === false);
  check('Native.isNative 为 false', nb.isNative === false);
  check('平台识别为 web', nb.platform === 'web', nb.platform);
  check('原生插件全部取不到（自动回退网页实现）', nb.appP && nb.fsP && nb.statusP);
  check('主桌面按返回键不消费（交还给浏览器）',
    await cdp.evalJs(`window.__diary__.handleBackKey() === false`));
  check('网页版导出仍走 Blob 下载路径',
    await cdp.evalJs(`window.__diary__.Native.toBase64('我的日记')`) ===
    Buffer.from('我的日记', 'utf8').toString('base64'),
    await cdp.evalJs(`window.__diary__.Native.toBase64('我的日记')`));

  console.log('\n[3] 主桌面');
  check('桌面为默认面板', await cdp.evalJs(`document.getElementById('screen-home').classList.contains('active')`));
  check('问候语带昵称', /我$/.test(await cdp.evalJs(`document.getElementById('deskGreet').textContent`)),
    await cdp.evalJs(`document.getElementById('deskGreet').textContent`));
  check('日期行显示月日与星期', /月\d+日 · 星期/.test(await cdp.evalJs(`document.getElementById('deskDate').textContent`)));
  check('空状态给出引导', /还没有记录/.test(await cdp.evalJs(`document.getElementById('deskSub').textContent`)));
  const tileInfo = await cdp.evalJs(`(() => {
    const tiles = [...document.querySelectorAll('#deskTiles .tile')];
    const cols = getComputedStyle(document.getElementById('deskTiles')).gridTemplateColumns.split(' ').length;
    const sizes = tiles.map(t => { const i = t.querySelector('.tile-ico').getBoundingClientRect(); return Math.round(i.width) + 'x' + Math.round(i.height); });
    return { n: tiles.length, cols, uni: [...new Set(sizes)],
      labels: tiles.map(t => t.querySelector('.tile-label').textContent),
      radius: getComputedStyle(tiles[0].querySelector('.tile-ico')).borderRadius,
      stroke: tiles[0].querySelector('.tile-ico svg').getAttribute('stroke-width') }; })()`);
  check('桌面有 6 个功能磁贴', tileInfo.n === 6);
  check('磁贴标签齐全', tileInfo.labels.join('/') === '时间线/相册/搜索/统计/备份/设置', tileInfo.labels.join('/'));
  check('手机档磁贴 3 列', tileInfo.cols === 3);
  check('图标底统一 46x46', tileInfo.uni.join(',') === '46x46', tileInfo.uni.join(','));
  check('图标底统一圆角 14px', tileInfo.radius === '14px', tileInfo.radius);
  check('图标描边统一 1.7', tileInfo.stroke === '1.7', tileInfo.stroke);
  check('空状态最近记录有占位文案', /会显示你最新写下/.test(await cdp.evalJs(`document.getElementById('deskRecent').textContent`)));
  check('底部导航 4 项', await cdp.evalJs(`document.querySelectorAll('#tabbar .tab').length`) === 4);
  check('手机档导航为横向', await cdp.evalJs(`getComputedStyle(document.getElementById('tabbar')).flexDirection`) === 'row');
  check('悬浮写日记按钮 56px', await cdp.evalJs(`document.getElementById('fabWrite').getBoundingClientRect().width`) === 56);
  await cdp.shot('11-desktop-empty.png');

  console.log('\n[4] 时间线空状态');
  await cdp.clickSel('#tabbar .tab[data-tab="timeline"]');
  await sleep(500);
  check('切到时间线面板', await cdp.evalJs(`document.getElementById('screen-timeline').classList.contains('active')`)
    && !await cdp.evalJs(`document.getElementById('screen-home').classList.contains('active')`));
  check('导航高亮跟随', await cdp.evalJs(`document.querySelector('#tabbar .tab[data-tab="timeline"]').classList.contains('on')`));
  check('空状态文案出现', /还没有任何记录/.test(await cdp.evalJs(`document.getElementById('timeline').textContent`)));
  check('说明无社交互动', /没有点赞、没有评论、没有好友/.test(await cdp.evalJs(`document.getElementById('timeline').textContent`)));

  console.log('\n[5] 发布图文日记（悬浮按钮入口）');
  await cdp.clickSel('#fabWrite');
  await sleep(700);
  check('进入发布页', await cdp.evalJs(`document.getElementById('screen-composer').classList.contains('active')`));
  check('发布页层级高于底部导航（悬浮球不遮挡）',
    await cdp.evalJs(`+getComputedStyle(document.getElementById('screen-composer')).zIndex > +getComputedStyle(document.getElementById('tabbar')).zIndex`
      + ` && +getComputedStyle(document.getElementById('screen-composer')).zIndex > +getComputedStyle(document.getElementById('fabWrite')).zIndex`));
  const TEXT = '今天把阳台的薄荷修了一遍，顺手擦干净了玻璃。\n晚上风很大，坐着看完了一整章书。';
  await cdp.evalJs(`document.getElementById('composerText').focus()`);
  await cdp.send('Input.insertText', { text: TEXT });
  await sleep(200);
  check('正文已输入', (await cdp.evalJs(`document.getElementById('composerText').value`)).length > 10);
  await cdp.setFiles('#filePicker', [testImg]);
  await sleep(1800);
  check('图片加入草稿网格', await cdp.evalJs(`document.querySelectorAll('#composerGrid .cell img').length`) === 1);
  const beforeSize = await cdp.evalJs(`window.__diary__.Store.usage()`);
  await cdp.clickSel('#btnPublish');
  await sleep(1500);

  console.log('\n[6] 时间线渲染');
  check('发表后自动切到时间线', await cdp.evalJs(`document.getElementById('screen-timeline').classList.contains('active')`));
  check('时间线出现 1 篇日记', await cdp.evalJs(`document.querySelectorAll('#timeline .post').length`) === 1);
  // 换行用 <br> 表达（容器是 white-space:normal），所以 textContent 里不会有 \n。
  // 断言要落到"真的渲染成了几行"，而不是 DOM 里有没有换行符 —— 后者测的是实现细节。
  // 注意：窄屏下长句会自己折行，视觉行数 ≥ 逻辑行数，所以只断言"不少于输入行数且没翻倍"。
  const tlText = await cdp.evalJs(`(() => {
    const el = document.querySelector('#timeline .post-text');
    const lh = parseFloat(getComputedStyle(el).lineHeight) || 24;
    return { text: el.textContent, brs: el.querySelectorAll('br').length,
             ws: getComputedStyle(el).whiteSpace,
             rows: Math.round(el.getBoundingClientRect().height / lh) }; })()`);
  check('正文文字与输入完全一致', tlText.text === TEXT.replace(/\n/g, ''), JSON.stringify(tlText.text).slice(0, 40));
  check('正文换行数与输入一致（不吞行、不翻倍）', tlText.brs === TEXT.split('\n').length - 1, `${tlText.brs} 个 <br>`);
  check('正文渲染行数不少于输入行数（换行真的生效了）', tlText.rows >= 2, `${tlText.rows} 行`);
  check('正文容器不再叠 pre-wrap（否则行距翻倍）', tlText.ws === 'normal', tlText.ws);
  const timeText = await cdp.evalJs(`document.querySelector('#timeline .post-time').textContent`);
  check('显示发布时间', /刚刚|今天|月|年/.test(timeText), `time="${timeText}"`);
  check('时间带完整时间戳', /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/.test(await cdp.evalJs(`document.querySelector('#timeline .post-time').getAttribute('title')`)));
  check('卡片标注「仅自己可见」', /仅自己可见/.test(await cdp.evalJs(`document.querySelector('#timeline .post-foot').textContent`)));
  check('无点赞/评论等社交元素', !/点赞|评论/.test(await cdp.evalJs(`document.querySelector('#timeline .post').textContent`)));
  const imgInfo = await cdp.evalJs(`(() => { const im = document.querySelector('#timeline .pgrid img');
    if (!im) return {ok:false};
    const r = im.getBoundingClientRect();
    return {ok: im.src.startsWith('blob:') && im.naturalWidth > 0 && r.width > 40 && r.height > 40
             && getComputedStyle(im).display !== 'none', w: Math.round(r.width), h: Math.round(r.height)}; })()`);
  check('缩略图真实渲染（有尺寸、非隐藏）', imgInfo.ok, imgInfo.ok ? `${imgInfo.w}x${imgInfo.h}px` : '');
  const afterSize = await cdp.evalJs(`window.__diary__.Store.usage()`);
  check(`图片已压缩入库（${(imgBytes / 1024).toFixed(0)} KB → ${(afterSize / 1024).toFixed(0)} KB）`,
    afterSize > 0 && afterSize < imgBytes, `${(beforeSize / 1024).toFixed(0)} → ${(afterSize / 1024).toFixed(0)} KB`);
  await cdp.shot('12-timeline.png');

  console.log('\n[6b] 正文过长折叠 + 「更多」展开（微信式）');
  // 先发一篇超长日记，验证 > POST_FOLD_LINES 行时被折起来
  const FOLD_LINES = await cdp.evalJs(`window.__diary__.POST_FOLD_LINES`);
  const LONG = Array.from({ length: FOLD_LINES + 4 }, (_, i) => `第${i + 1}行内容`).join('\n');
  await cdp.evalJs(`window.__diary__.publishText(${JSON.stringify(LONG)})`);
  await sleep(1400);
  // 时间线是最新在前，长文那篇应该排第一；用 data-id 精确锁定，避免抓到别的卡片
  const fold = await cdp.evalJs(`(() => {
    const p = document.querySelector('#timeline .post');
    const body = p.querySelector('.post-text');
    const btn = p.querySelector('.post-moretext');
    const lh = parseFloat(getComputedStyle(body).lineHeight) || 24;
    return { exists: !!btn, folded: body.classList.contains('folded'),
             brs: body.querySelectorAll('br').length,
             rows: Math.round(body.getBoundingClientRect().height / lh),
             label: btn ? btn.textContent.replace(/\\s+/g, '') : '',
             hidden: btn ? btn.getAttribute('data-hidden') : '',
             text: body.textContent }; })()`);
  check('长文排在最前（确认抓到的是这篇）', fold.text.startsWith('第1行内容'), fold.text.slice(0, 12));
  check('超过 6 行的正文被折叠', fold.folded);
  check('折叠时出现「更多」', fold.exists);
  check('「更多」提示还有几行', fold.hidden === '4', `data-hidden=${fold.hidden}`);
  check('「更多」文案含行数', /更多/.test(fold.label) && /还有4行/.test(fold.label), fold.label);
  // 折叠只靠 CSS 裁切，DOM 里仍是完整 10 行（换行一个都不少），这样展开才能还原
  check('折叠不丢内容：DOM 里保留完整换行', fold.brs === (FOLD_LINES + 4) - 1, `${fold.brs} 个 <br>（应 9）`);
  check('折叠后可见行数被压到 6 行', fold.rows === FOLD_LINES, `${fold.rows} 行`);
  const truncH = await cdp.evalJs(`Math.round(document.querySelector('#timeline .post-text').getBoundingClientRect().height)`);
  await cdp.clickSel('#timeline .post-moretext');
  await sleep(500);
  const exp = await cdp.evalJs(`(() => {
    const p = document.querySelector('#timeline .post');
    const body = p.querySelector('.post-text');
    const btn = p.querySelector('.post-moretext');
    const lh = parseFloat(getComputedStyle(body).lineHeight) || 24;
    return { expanded: body.classList.contains('expanded'), folded: body.classList.contains('folded'),
             rows: Math.round(body.getBoundingClientRect().height / lh),
             label: btn.textContent.trim(), done: /收起/.test(btn.textContent) }; })()`);
  const fullH = await cdp.evalJs(`Math.round(document.querySelector('#timeline .post-text').getBoundingClientRect().height)`);
  check('点「更多」后展开', exp.expanded && !exp.folded);
  check('展开后按钮变成「收起」', exp.done, exp.label);
  check('展开后显示出全部 10 行', exp.rows === FOLD_LINES + 4, `${exp.rows} 行`);
  check('展开后高度明显增加', fullH > truncH, `${truncH}px → ${fullH}px`);
  await cdp.shot('12b-fold-more.png');
  await cdp.clickSel('#timeline .post-moretext');
  await sleep(500);
  check('再点「收起」可折回去',
    await cdp.evalJs(`document.querySelector('#timeline .post-text').classList.contains('folded')`));
  check('收起后按钮文案还原成「更多」',
    /更多/.test(await cdp.evalJs(`document.querySelector('#timeline .post-moretext').textContent`)));

  console.log('\n[6c] 查看详情：时间与正文都按原文换行');
  await cdp.evalJs(`window.__diary__.showDetail(window.__diary__.State.entries[0])`);
  await sleep(500);
  const dlg = await cdp.evalJs(`(() => {
    const t = document.getElementById('dialogText');
    const lh = parseFloat(getComputedStyle(t).lineHeight) || 22;
    return { shown: document.getElementById('mask').classList.contains('show'),
             brs: t.querySelectorAll('br').length,
             ws: getComputedStyle(t).whiteSpace,
             rows: Math.round(t.getBoundingClientRect().height / lh),
             text: t.textContent }; })()`);
  check('详情弹窗打开', dlg.shown);
  check('详情里时间与正文之间有换行', dlg.brs >= FOLD_LINES, `${dlg.brs} 个 <br>`);
  check('详情正文按原文占多行（不是挤成一行）', dlg.rows >= FOLD_LINES, `${dlg.rows} 行`);
  check('详情容器不开 pre-wrap', dlg.ws === 'normal', dlg.ws);
  check('详情含发布时间', /\d{4}-\d{2}-\d{2} \d{2}:\d{2}/.test(dlg.text));
  check('详情含第一行正文', /第1行内容/.test(dlg.text));
  await cdp.shot('12c-detail-dialog.png');
  await cdp.evalJs(`window.__diary__.closeMask()`);
  await sleep(400);
  // 这篇长文只是用来验证折叠的，用完删掉，免得把后面所有计数断言都带偏（保持 1 篇的基线）
  await cdp.evalJs(`window.__diary__.Store.listEntries().then(list => {
    const long = list.find(e => (e.text || '').startsWith('第1行内容'));
    return long ? window.__diary__.Store.deleteEntryCascade(long.id) : null;
  }).then(() => window.__diary__.loadHome())`);
  await sleep(1200);
  check('清掉折叠用的长文，回到 1 篇基线',
    await cdp.evalJs(`document.querySelectorAll('#timeline .post').length`) === 1,
    `${await cdp.evalJs(`document.querySelectorAll('#timeline .post').length`)} 篇`);

  console.log('\n[7] 图片查看器');
  await cdp.clickSel('#timeline .pgrid .ph');
  await sleep(600);
  check('查看器打开且计数 1/1', await cdp.evalJs(`document.getElementById('viewer').classList.contains('show')`)
    && (await cdp.evalJs(`document.getElementById('viewerCount').textContent`)).trim() === '1/1');
  check('大图真实渲染', await cdp.evalJs(`(() => { const im = document.querySelector('#viewerTrack img');
    const r = im.getBoundingClientRect(); return im.naturalWidth > 0 && r.width > 200; })()`));
  await cdp.clickSel('#viewerClose');
  await sleep(400);

  console.log('\n[8] 桌面回访（徽标 / 最近记录 / 概览）');
  await cdp.clickSel('#tabbar .tab[data-tab="home"]');
  await sleep(600);
  check('概览显示篇数与连续记录', /已记录 1 篇 · 连续记录 1 天/.test(await cdp.evalJs(`document.getElementById('deskSub').textContent`)),
    await cdp.evalJs(`document.getElementById('deskSub').textContent`));
  check('时间线徽标 1 且已点亮', await cdp.evalJs(`document.getElementById('badgeTimeline').textContent`) === '1'
    && await cdp.evalJs(`document.getElementById('badgeTimeline').getAttribute('data-zero')`) === '0');
  check('相册徽标 1', await cdp.evalJs(`document.getElementById('badgeGallery').textContent`) === '1');
  check('最近记录显示摘录', /薄荷/.test(await cdp.evalJs(`document.getElementById('deskRecent').textContent`)));
  check('最近记录缩略图真实渲染', await cdp.evalJs(`(() => { const im = document.querySelector('#deskRecent img');
    const r = im.getBoundingClientRect(); return im.naturalWidth > 0 && r.width > 40; })()`));
  await cdp.shot('13-desktop-filled.png');
  await cdp.evalJs(`document.getElementById('drMore').click()`);
  await sleep(600);
  check('「查看全部」跳到时间线', await cdp.evalJs(`document.getElementById('screen-timeline').classList.contains('active')`));

  console.log('\n[9] 相册');
  await cdp.clickSel('#tabbar .tab[data-tab="gallery"]');
  await sleep(700);
  const gal = await cdp.evalJs(`(() => { const g = document.querySelector('#galInner');
    const grid = document.querySelector('.gal-grid');
    const imgs = [...document.querySelectorAll('.gal-grid img')];
    const rendered = imgs.filter(im => { const r = im.getBoundingClientRect(); return r.width > 20 && im.naturalWidth > 0; });
    return { months: document.querySelectorAll('.gal-month').length,
             title: (document.querySelector('.gal-month-title') || {}).textContent || '',
             count: (g.textContent.match(/共 (\\d+) 张/) || [])[1],
             rendered: rendered.length,
             cols: grid ? getComputedStyle(grid).gridTemplateColumns.split(' ').length : 0 }; })()`);
  check('按月份分组并标注张数', gal.months === 1 && /年\d+月（\d+ 张）$/.test(gal.title), `${gal.months} 组 / ${gal.title}`);
  check('统计共 1 张', gal.count === '1');
  check('月份汇总行含分组数', await cdp.evalJs(`/共 \\d+ 张 · \\d+ 个月份/.test(document.querySelector('.pane-head').textContent)`));
  check('相册页标题不重复（仅导航栏一处）',
    await cdp.evalJs(`document.querySelectorAll('#screen-gallery h2').length`) === 0);
  check('图片真实渲染', gal.rendered === 1, `渲染 ${gal.rendered}`);
  check('手机档相册 3 列', gal.cols === 3);
  await cdp.shot('14-gallery.png');
  await cdp.clickSel('.gal-grid a');
  await sleep(600);
  check('点图进入查看器', await cdp.evalJs(`document.getElementById('viewer').classList.contains('show')`)
    && (await cdp.evalJs(`document.getElementById('viewerCount').textContent`)).trim() === '1/1');
  await cdp.clickSel('#viewerClose');
  await sleep(400);

  console.log('\n[10] 搜索');
  await cdp.clickSel('#tabbar .tab[data-tab="home"]');
  await sleep(500);
  await cdp.clickSel('#deskTiles .tile[data-go="search"]');
  await sleep(700);
  check('搜索页打开且输入框自动聚焦',
    await cdp.evalJs(`document.getElementById('screen-search').classList.contains('active')`)
    && await cdp.evalJs(`document.activeElement.id`) === 'searchInput');
  await cdp.send('Input.insertText', { text: '薄荷' });
  await sleep(400);
  check('命中 1 条', await cdp.evalJs(`document.querySelectorAll('.search-hit').length`) === 1);
  check('关键词高亮', await cdp.evalJs(`!!document.querySelector('.search-hit mark')`));
  check('结果带完整时间与图片数',
    /\d{4}-\d{2}-\d{2} \d{2}:\d{2} · 1 张图片/.test(await cdp.evalJs(`document.querySelector('.search-hit .sh-meta').textContent`)));
  await cdp.shot('15-search.png');
  await cdp.clickSel('.search-hit');
  await sleep(900);
  check('跳回时间线并高亮该篇',
    await cdp.evalJs(`document.getElementById('screen-timeline').classList.contains('active')`)
    && await cdp.evalJs(`!!document.querySelector('#timeline .post.hl')`));
  await cdp.clickSel('#tabbar .tab[data-tab="home"]');
  await sleep(400);
  await cdp.clickSel('#deskTiles .tile[data-go="search"]');
  await sleep(600);
  await cdp.send('Input.insertText', { text: 'zzz不存在的词' });
  await sleep(400);
  check('无命中给出提示', /没有找到包含/.test(await cdp.evalJs(`document.getElementById('searchResults').textContent`)));
  const sBack = await cdp.evalJs(`(() => { const b = document.getElementById('btnSearchBack');
    const ico = b.querySelector('svg').getBoundingClientRect();
    const nav = b.closest('.nav').getBoundingClientRect();
    const r = b.getBoundingClientRect();
    return { cls: b.className, icoLeft: Math.round(ico.left - nav.left),
             w: Math.round(r.width), h: Math.round(r.height) }; })()`);
  check('搜索页左上是微信式返回键', /nav-back/.test(sBack.cls) && Math.abs(sBack.icoLeft - 16) <= 4,
    `${sBack.icoLeft}px / ${sBack.cls}`);
  check('搜索页返回键热区 44×44', sBack.w >= 44 && sBack.h >= 44, `${sBack.w}x${sBack.h}`);
  await cdp.clickSel('#btnSearchBack');
  await sleep(500);
  check('返回后回到桌面',
    await cdp.evalJs(`document.getElementById('screen-home').classList.contains('active')`)
    && !await cdp.evalJs(`document.getElementById('screen-search').classList.contains('active')`));

  console.log('\n[11] 统计');
  await cdp.clickSel('#deskTiles .tile[data-go="stats"]');
  await sleep(700);
  const st = await cdp.evalJs(`(() => { const cards = [...document.querySelectorAll('.stat-card .stat-num')].map(e => e.textContent.trim());
    const titles = [...document.querySelectorAll('.chart-title span')].map(e => e.textContent.trim());
    return { cards, bars: document.querySelectorAll('.bars-month .bar-col').length,
             filled: document.querySelectorAll('.bars-month .bar.has').length,
             heatCols: document.querySelectorAll('.heat-col').length,
             heatCells: document.querySelectorAll('.heat-grid .heat-c').length,
             heatLit: [...document.querySelectorAll('.heat-grid .heat-c')].filter(e => /l[1-4]/.test(e.className)).length,
             heatNote: titles[0] || '', rhythmNote: titles[2] || '',
             slotBars: document.querySelectorAll('.bars.sm .bar-col').length,
             sections: [...document.querySelectorAll('.stat-sec-head b')].map(e => e.textContent.trim()),
             rows: document.querySelectorAll('.stat-row').length,
             labels: [...document.querySelectorAll('.stat-row .sr-label')].map(e => e.textContent.trim()),
             values: [...document.querySelectorAll('.stat-row .sr-value')].map(e => e.textContent.replace(/[\\s\\u00a0]+/g, ' ').trim()),
             text: document.getElementById('statInner').textContent.replace(/\\s/g, '') }; })()`);
  check('三张数字卡（篇/张/连续天数）',
    st.cards.length === 3 && st.cards[0] === '1篇' && st.cards[1] === '1张' && st.cards[2] === '1天', st.cards.join(' | '));
  check('分三段：概况 / 节奏 / 内容', st.sections.join('/') === '概况/节奏/内容', st.sections.join('/'));
  check('月度柱状图 12 根', st.bars === 12);
  check('有记录的月份被点亮', st.filled === 1);
  // ★ 写作热力图：53 周 × 7 天 = 371 格。像素格子铺满，不是 SVG 缩放（缩放会把月份标签缩到读不出来）
  check('热力图 53 周 × 7 天 = 371 格', st.heatCols === 53 && st.heatCells === 371,
    `${st.heatCols} 周 / ${st.heatCells} 格`);
  // 图例里的色块也是 .heat-c，所以上面两条一律限定 .heat-grid 内，别把图例算成格子
  check('今天那一格亮着', st.heatLit === 1, `${st.heatLit} 格亮着`);
  check('热力图标题如实报篇数', /近一年 1 篇/.test(st.heatNote), st.heatNote);
  // ★ 写作时段：24 根（一天）+ 7 根（一周），共用一张卡片
  check('时段图 = 24 + 7 根柱', st.slotBars === 31, `${st.slotBars} 根`);
  check('样本不足时不硬说「最多：X 点」', /再写几篇/.test(st.rhythmNote), st.rhythmNote);
  // ★ 「最常写的时间 / 日子」已从明细升级成图，行数由 17 降到 15
  check('明细 15 行', st.rows === 15, `${st.rows} 行`);
  const needLabels = ['记录天数', '累计字数', '平均每篇', '累计记录时长', '第一篇写于', '最近一篇',
    '今天记录', '本周记录', '本月记录', '最长空档',
    '最长一篇', '每篇平均配图', '带图日记', '本月字数变化', '标点习惯'];
  const missing = needLabels.filter((l) => !st.labels.includes(l));
  check('明细左侧名目齐全', missing.length === 0, missing.length ? '缺 ' + missing.join('/') : `${st.labels.length} 个名目`);
  check('明细每行都有左侧名目与右侧数值', st.rows === st.labels.length && st.rows === st.values.length,
    `${st.labels.length} 名目 / ${st.values.length} 数值`);
  check('名目互不重复（卡片算过的三项不在明细里再来一遍）',
    new Set(st.labels).size === st.labels.length
    && !st.labels.includes('日记总数') && !st.labels.includes('图片总数') && !st.labels.includes('连续记录'),
    `${st.labels.length} 行 / ${new Set(st.labels).size} 个不同名目`);
  // 只有 1 篇时不该硬下结论 —— 样本不够的行如实显示 —
  check('样本不足时分布类不给结论',
    st.values.filter((v) => v === '—').length >= 3,
    st.values.filter((v) => v === '—').join(' | '));
  check('名目在数值左边',
    await cdp.evalJs(`(() => { const r = document.querySelector('.stat-row');
      if (!r) return false;
      const l = r.querySelector('.sr-label').getBoundingClientRect();
      const v = r.querySelector('.sr-value').getBoundingClientRect();
      return l.left < v.left; })()`));
  // 名目「平均每篇」+ 数值「33字」拆在两个元素里，所以断言要看整行文本，不能只看 nameInner
  check('本月记录 1 篇', st.text.includes('本月记录1篇'));
  check('平均每篇字数已计算', /平均每篇\d+字/.test(st.text));
  check('今天记录为 1 篇', /今天记录1篇/.test(st.text));
  check('记录天数为 1 天', /记录天数1天/.test(st.text));
  await cdp.shot('16-stats.png');
  // 页子变长了（多了热力图和时段图），再拍一张底部，
  // 让「节奏 / 内容」两段在截图里也能被看见，然后滚回顶部收尾
  const scrollStat = `(() => { let el = document.getElementById('statInner');
    while (el && el.scrollHeight <= el.clientHeight + 4) el = el.parentElement;
    if (el) el.scrollTop = ARG; return true; })()`;
  await cdp.evalJs(scrollStat.replace('ARG', 'el.scrollHeight'));
  await sleep(350);
  await cdp.shot('16b-stats-bottom.png');
  await cdp.evalJs(scrollStat.replace('ARG', '0'));
  const stBack = await cdp.evalJs(`(() => { const b = document.getElementById('btnStatsBack');
    const ico = b.querySelector('svg').getBoundingClientRect();
    const nav = b.closest('.nav').getBoundingClientRect();
    const r = b.getBoundingClientRect();
    return { cls: b.className, icoLeft: Math.round(ico.left - nav.left),
             w: Math.round(r.width), h: Math.round(r.height) }; })()`);
  check('统计页左上是微信式返回键', /nav-back/.test(stBack.cls) && Math.abs(stBack.icoLeft - 16) <= 4,
    `${stBack.icoLeft}px / ${stBack.cls}`);
  check('统计页返回键热区 44×44', stBack.w >= 44 && stBack.h >= 44, `${stBack.w}x${stBack.h}`);
  await cdp.clickSel('#btnStatsBack');
  await sleep(500);

  console.log('\n[12] 密码为可选：可在设置里自行添加');
  await cdp.clickSel('#tabbar .tab[data-tab="mine"]');
  await sleep(600);
  await cdp.clickSel('#setChangePin');            // 未设置时该行标题是「设置密码」
  await sleep(800);
  check('从设置进入设置密码流程', await cdp.evalJs(`document.getElementById('screen-lock').classList.contains('show')`));
  check('锁屏标题为「设置 6 位数字密码」',
    /设置 6 位数字密码/.test(await cdp.evalJs(`document.getElementById('lockTitle').textContent`)));
  check('设置流程提供「暂不设置」出口',
    await cdp.evalJs(`getComputedStyle(document.getElementById('lockSkip')).display !== 'none'`)
    && (await cdp.evalJs(`document.getElementById('lockSkip').textContent`)).trim() === '暂不设置');
  await cdp.shot('12b-lock-setup.png');
  await cdp.clickSel('#lockSkip');
  await sleep(700);
  check('点「暂不设置」退出且不写入密码',
    !await cdp.evalJs(`document.getElementById('screen-lock').classList.contains('show')`)
    && !await cdp.evalJs(`window.__diary__.Meta.data.pinEnabled`)
    && !await cdp.evalJs(`window.__diary__.Meta.data.pinHash`));

  await cdp.clickSel('#setLock');                 // 用开关开启
  await sleep(800);
  check('用开关开启时同样进入设置密码流程',
    /设置 6 位数字密码/.test(await cdp.evalJs(`document.getElementById('lockTitle').textContent`)));
  for (const k of PIN) await cdp.clickSel(`.keypad button[data-k="${k}"]`);
  await sleep(450);
  check('第一次输入后要求确认',
    /再次输入确认/.test(await cdp.evalJs(`document.getElementById('lockTitle').textContent`)));
  for (const k of PIN) await cdp.clickSel(`.keypad button[data-k="${k}"]`);
  await sleep(1000);
  check('确认后密码已写入', await cdp.evalJs(`!!window.__diary__.Meta.data.pinHash`));
  check('确认后密码验证已开启', await cdp.evalJs(`window.__diary__.Meta.data.pinEnabled`));
  check('锁屏已关闭回到设置页',
    !await cdp.evalJs(`document.getElementById('screen-lock').classList.contains('show')`)
    && await cdp.evalJs(`document.getElementById('screen-settings').classList.contains('active')`));
  check('开关点亮、状态为「已设置」',
    await cdp.evalJs(`document.getElementById('switchLock').classList.contains('on')`)
    && (await cdp.evalJs(`document.getElementById('pinStateText').textContent`)) === '已设置');
  check('行标题变为「修改密码」',
    (await cdp.evalJs(`document.getElementById('pinRowLabel').textContent`)) === '修改密码');

  console.log('\n[13] 刷新后持久化 + 重新上锁');
  await boot(PIN);
  check('刷新后数据仍在', await cdp.evalJs(`document.querySelectorAll('#timeline .post').length`) === 1);
  check('刷新后落在主桌面', await cdp.evalJs(`document.getElementById('screen-home').classList.contains('active')`));
  check('概览数据不丢', /已记录 1 篇/.test(await cdp.evalJs(`document.getElementById('deskSub').textContent`)));
  await cdp.clickSel('#tabbar .tab[data-tab="timeline"]');   // 隐藏面板内元素量不到尺寸，先切过去
  await sleep(600);
  check('刷新后图片仍可渲染', await cdp.evalJs(`(() => { const im = document.querySelector('#timeline .pgrid img');
    const r = im.getBoundingClientRect(); return r.width > 40 && im.naturalWidth > 0; })()`));

  console.log('\n[14] 编辑日记');
  await cdp.clickSel('#tabbar .tab[data-tab="timeline"]');
  await sleep(500);
  await cdp.clickSel('#timeline .post-more');
  await sleep(500);
  check('更多菜单打开', /编辑这篇日记/.test(await cdp.evalJs(`document.getElementById('actionSheet').textContent`)));
  await cdp.clickSel('#actionSheet .sheet-item[data-i="0"]');
  await sleep(800);
  check('编辑态带入原文与图片',
    (await cdp.evalJs(`document.getElementById('composerText').value`)).length > 10
    && await cdp.evalJs(`document.querySelectorAll('#composerGrid .cell img').length`) === 1);
  await cdp.evalJs(`(() => { const t = document.getElementById('composerText');
    t.value = t.value + ' 补一句：明天把书还了。';
    t.dispatchEvent(new Event('input', {bubbles:true})); })()`);
  await sleep(200);
  await cdp.clickSel('#btnPublish');
  await sleep(1300);
  check('修改已保存', /明天把书还了/.test(await cdp.evalJs(`document.querySelector('#timeline .post-text').textContent`)));
  check('标注「已编辑」', /已编辑/.test(await cdp.evalJs(`document.querySelector('#timeline .post-time').textContent`)));

  console.log('\n[15] 九图九宫格 + 相册累计');
  await cdp.clickSel('#fabWrite');
  await sleep(600);
  await cdp.evalJs(`document.getElementById('composerText').focus()`);
  await cdp.send('Input.insertText', { text: '九宫格布局检查：一次发满 9 张图。' });
  await cdp.setFiles('#filePicker', manyImgs);
  await sleep(4200);
  check('9 张图片全部进入草稿', await cdp.evalJs(`document.querySelectorAll('#composerGrid .cell img').length`) === 9);
  check('满 9 张后隐藏「+」', await cdp.evalJs(`!document.getElementById('btnAddImage')`));
  await cdp.clickSel('#btnPublish');
  await sleep(2600);
  const grid = await cdp.evalJs(`(() => { const g = document.querySelector('#timeline .pgrid');
    const imgs = [...g.querySelectorAll('img')];
    const rendered = imgs.filter(im => { const r = im.getBoundingClientRect(); return r.width > 20 && im.naturalWidth > 0; });
    return { cls: g.className, count: imgs.length, rendered: rendered.length,
             ratio: (() => { const r = imgs[0].getBoundingClientRect(); return r.width / r.height; })() }; })()`);
  check('使用 3 列九宫格', grid.cls.includes('n9') && grid.count === 9, `${grid.cls} / ${grid.count} 张`);
  check('9 张缩略图全部真实渲染', grid.rendered === 9, `渲染 ${grid.rendered}/9`);
  check('九宫格单元为正方形', Math.abs(grid.ratio - 1) < 0.05, grid.ratio.toFixed(3));
  await cdp.shot('17-grid9.png');
  await cdp.clickSel('#tabbar .tab[data-tab="gallery"]');
  await sleep(800);
  check('相册累计 10 张', /共 10 张/.test(await cdp.evalJs(`document.getElementById('galInner').textContent`)));
  check('相册渲染 10 张', await cdp.evalJs(`document.querySelectorAll('.gal-grid img').length`) === 10);
  await cdp.clickSel('#tabbar .tab[data-tab="home"]');
  await sleep(600);
  check('相册徽标更新为 10', await cdp.evalJs(`document.getElementById('badgeGallery').textContent`) === '10');
  check('时间线徽标更新为 2', await cdp.evalJs(`document.getElementById('badgeTimeline').textContent`) === '2');

  console.log('\n[16] 长按删除与级联清理');
  await cdp.clickSel('#tabbar .tab[data-tab="timeline"]');
  await sleep(500);
  // 长按点必须落在卡片文字上：图片区域被有意排除（点图是打开查看器）
  const box = await cdp.evalJs(`(() => { const t = document.querySelector('#timeline .post .post-text');
    const r = t.getBoundingClientRect(); return {x: r.left + 24, y: r.top + r.height / 2}; })()`);
  await cdp.clickPoint(box.x, box.y, 700);
  await sleep(600);
  check('长按弹出操作面板', await cdp.evalJs(`document.getElementById('mask').classList.contains('show')`)
    && await cdp.evalJs(`document.getElementById('actionSheet').style.display !== 'none'`),
    await cdp.evalJs(`document.getElementById('actionSheet').textContent.slice(0, 12)`));
  check('松手不会误关面板', await cdp.evalJs(`document.getElementById('mask').classList.contains('show')`));
  await cdp.clickSel('#actionSheet .sheet-item[data-i="2"]');
  await sleep(500);
  check('删除前二次确认', /删除这篇日记/.test(await cdp.evalJs(`document.getElementById('dialog').textContent`)));
  await cdp.clickDialog('删除');
  await sleep(1500);
  check('日记已删除', await cdp.evalJs(`document.querySelectorAll('#timeline .post').length`) === 1);
  check('图片级联清理（10 → 1）',
    await cdp.evalJs(`window.__diary__.Store.listImages().then(a => a.filter(r => r.entryId !== '__profile__').length)`) === 1);
  await cdp.clickSel('#tabbar .tab[data-tab="home"]');
  await sleep(600);
  check('桌面徽标同步回 1', await cdp.evalJs(`document.getElementById('badgeTimeline').textContent`) === '1'
    && await cdp.evalJs(`document.getElementById('badgeGallery').textContent`) === '1');

  console.log('\n[17] 我的：主题、封面与密码开关');
  await cdp.clickSel('#tabbar .tab[data-tab="mine"]');
  await sleep(600);
  check('我的面板打开', await cdp.evalJs(`document.getElementById('screen-settings').classList.contains('active')`));
  await cdp.clickSel('#setTheme');
  await sleep(400);
  check('切到深色模式', await cdp.evalJs(`document.getElementById('app').getAttribute('data-theme')`) === 'dark');
  await cdp.shot('18-mine-dark.png');
  await cdp.clickSel('#setCover');
  await sleep(400);
  check('可关闭启动封面页', await cdp.evalJs(`window.__diary__.Meta.data.showCover`) === false);
  await cdp.clickSel('#setCover');
  await sleep(400);
  check('可再次开启', await cdp.evalJs(`window.__diary__.Meta.data.showCover`) === true);
  await cdp.clickSel('#setTheme');
  await sleep(400);
  check('切回浅色', await cdp.evalJs(`document.getElementById('app').getAttribute('data-theme')`) === 'light');

  /* ── 关闭 / 重新开启密码 ────────────────────────────────────────────────
     语义按微信来（用户点名要的）：
       · 设置页那条「打开时验证密码」开关，只管"验不验证"，关掉它密码还留着
       · 「关闭密码」是一条**独立的行**（危险色），点了才真的删密码
       · 两条路都必须先输一次当前密码，防"手机被别人拿走点两下就解了"
     本段跑的是「关闭密码」这条独立入口的完整流程。 */
  check('有密码时出现独立的「关闭密码」行',
    await cdp.evalJs(`getComputedStyle(document.getElementById('setClosePin')).display !== 'none'`));
  await cdp.clickSel('#setClosePin');
  await sleep(600);
  check('关闭密码前二次确认',
    /关闭密码/.test(await cdp.evalJs(`document.getElementById('dialog').textContent`)));
  check('确认框讲清密码会被一并清除（不只是关掉开关）',
    /密码也会一并清除/.test(await cdp.evalJs(`document.getElementById('dialogText').textContent`)));
  check('确认框提前讲清"还要输一次密码"（不提前讲用户会以为出错了）',
    /需要输入一次当前密码/.test(await cdp.evalJs(`document.getElementById('dialogText').textContent`)));
  // 先验一次"点取消什么都不变"，避免用户误触就丢密码
  await cdp.clickDialog('取消');
  await sleep(500);
  check('确认框点「取消」密码原封不动',
    await cdp.evalJs(`!!window.__diary__.Meta.data.pinHash`)
    && await cdp.evalJs(`window.__diary__.Meta.data.pinEnabled`));
  await cdp.clickSel('#setClosePin');
  await sleep(600);
  check('确认框按钮为「取消 / 关闭密码」',
    (await cdp.dialogBtns()).join('/') === '取消/关闭密码', (await cdp.dialogBtns()).join('/'));
  await cdp.clickDialog('关闭密码');
  await sleep(700);
  // ★ 本次修的就是这里：以前点「关闭」只是把开关翻成 false，锁屏没有任何出口，
  //   想真关掉只能"输密码 → 又开回来"地打转。现在关闭必须验一次密码。
  check('点「关闭密码」跳到验证锁屏，不是直接生效',
    await cdp.evalJs(`document.getElementById('screen-lock').classList.contains('show')`)
    && await cdp.evalJs(`window.__diary__.Meta.data.pinEnabled`));
  check('关闭密码时锁屏上出现「关闭密码」出口', await cdp.evalJs(
    `getComputedStyle(document.getElementById('lockOff')).display !== 'none'`));
  check('关闭密码时锁屏上还有「取消」（不想关也能体面退出）', await cdp.evalJs(
    `getComputedStyle(document.getElementById('lockCancel')).display !== 'none'`));
  const closeSub = await cdp.evalJs(`document.getElementById('lockSub').textContent.trim()`);
  check('关闭密码时副标题说明意图', closeSub === '验证后关闭密码', closeSub);
  await cdp.shot('17j-close-pin-lock.png');
  // 输错不生效
  for (const k of '000000') await cdp.clickSel(`.keypad button[data-k="${k}"]`);
  await sleep(900);
  check('密码输错时不会关闭（开关仍亮）',
    await cdp.evalJs(`window.__diary__.Meta.data.pinEnabled`)
    && await cdp.evalJs(`document.getElementById('screen-lock').classList.contains('show')`));
  for (const k of PIN) await cdp.clickSel(`.keypad button[data-k="${k}"]`);
  await sleep(1000);
  check('输对密码后验证关闭', !await cdp.evalJs(`window.__diary__.Meta.data.pinEnabled`));
  check('关闭后锁屏收起', !await cdp.evalJs(`document.getElementById('screen-lock').classList.contains('show')`));
  // 微信式语义：关闭密码 = 密码本体一起删掉（不再是"留着以后好开回来"）
  check('密码本体被清空（真的删掉了，不是只关开关）',
    !await cdp.evalJs(`!!window.__diary__.Meta.data.pinHash`));
  // ★ 界面上要"看得见关掉了"：状态文字与开关必须同步，不能一个已关一个还写已设置
  check('设置页状态显示「未设置」（不再是含糊的"已设置，未开启"）',
    (await cdp.evalJs(`document.getElementById('pinStateText').textContent`)) === '未设置',
    await cdp.evalJs(`document.getElementById('pinStateText').textContent`));
  check('开关熄灭', !await cdp.evalJs(`document.getElementById('switchLock').classList.contains('on')`));
  check('「关闭密码」行随之消失（没密码可关）',
    await cdp.evalJs(`getComputedStyle(document.getElementById('setClosePin')).display === 'none'`));
  check('入口回到「打开密码」（密码已删，点它去设一个新的）',
    (await cdp.evalJs(`document.getElementById('pinRowLabel').textContent`)) === '打开密码');
  // 关掉之后这个锁屏就不该再打扰人：刷新后不进锁屏
  await cdp.send('Page.navigate', { url: BASE + '?t=' + Date.now() });
  await sleep(3400);
  check('关闭后重开应用不再弹锁屏（保护真的撤了）',
    !await cdp.evalJs(`document.getElementById('screen-lock').classList.contains('show')`));
  check('关闭状态跨刷新持久化', !await cdp.evalJs(`window.__diary__.Meta.data.pinEnabled`)
    && !await cdp.evalJs(`!!window.__diary__.Meta.data.pinHash`));
  // 关掉之后还能重新设一个：功能没被搞死
  await cdp.clickSel('#tabbar .tab[data-tab="mine"]');
  await sleep(700);
  await cdp.clickSel('#setChangePin');
  await sleep(700);
  check('关闭后重设：直接进设置流程（密码已删，不需要先验证）',
    /设置 6 位数字密码/.test(await cdp.evalJs(`document.getElementById('lockTitle').textContent`)));
  for (const k of PIN) await cdp.clickSel(`.keypad button[data-k="${k}"]`);
  await sleep(900);
  for (const k of PIN) await cdp.clickSel(`.keypad button[data-k="${k}"]`);
  await sleep(1200);
  check('重设成功、验证重新开启', await cdp.evalJs(`window.__diary__.Meta.data.pinEnabled`));
  check('状态回到「已设置」',
    (await cdp.evalJs(`document.getElementById('pinStateText').textContent`)) === '已设置');
  check('开关旁的提示同步回「已开启」',
    (await cdp.evalJs(`document.getElementById('pinSwitchHint').textContent`)) === '已开启');

  /* 「打开时验证密码」开关只负责开关验证，不动密码本体；而且要求先输密码 */
  await cdp.clickSel('#setLock');
  await sleep(600);
  check('开关关闭也要先确认（标题为「关闭密码验证」）',
    /关闭密码验证/.test(await cdp.evalJs(`document.getElementById('dialog').textContent`)));
  check('确认框说明密码会保留、可再开启',
    /密码会保留/.test(await cdp.evalJs(`document.getElementById('dialogText').textContent`)));
  await cdp.clickDialog('关闭验证');
  await sleep(700);
  check('关闭验证也要先输一次当前密码',
    await cdp.evalJs(`document.getElementById('screen-lock').classList.contains('show')`)
    && /验证后关闭/.test(await cdp.evalJs(`document.getElementById('lockSub').textContent`)));
  for (const k of PIN) await cdp.clickSel(`.keypad button[data-k="${k}"]`);
  await sleep(1000);
  check('关掉开关：验证停止但密码仍在', !await cdp.evalJs(`window.__diary__.Meta.data.pinEnabled`)
    && await cdp.evalJs(`!!window.__diary__.Meta.data.pinHash`));
  check('状态与开关同步为「未设置」',
    (await cdp.evalJs(`document.getElementById('pinStateText').textContent`)) === '未设置'
    && !await cdp.evalJs(`document.getElementById('switchLock').classList.contains('on')`));
  check('开关旁注明密码仍保留、可再开启（否则会以为要重设）',
    /已关闭.*密码保留/.test(await cdp.evalJs(`document.getElementById('pinSwitchHint').textContent`)),
    await cdp.evalJs(`document.getElementById('pinSwitchHint').textContent`));
  // ★ 按用户要求：只要密码开关是关着的，就不摆「关闭密码」、标签也回到「打开密码」。
  //   密码本体确实还在（没被删），但界面上呈现的就是"未打开"这一种状态 —— 开关、
  //   状态文字、行标签、有没有那条危险色行，四者必须完全一致。
  check('开关关掉后不再摆「关闭密码」（没打开就没得关）',
    await cdp.evalJs(`getComputedStyle(document.getElementById('setClosePin')).display === 'none'`));
  check('标签回到「打开密码」（而不是「修改密码」）',
    (await cdp.evalJs(`document.getElementById('pinRowLabel').textContent`)) === '打开密码');
  // 「打开密码」这条行必须真能把密码开回来，且不必重设
  await cdp.clickSel('#setChangePin');
  await sleep(700);
  check('点「打开密码」是验一次原密码就开回来，不用重设',
    await cdp.evalJs(`document.getElementById('screen-lock').classList.contains('show')`)
    && /验证后开启密码验证/.test(await cdp.evalJs(`document.getElementById('lockSub').textContent.trim()`)));
  await cdp.clickSel('#lockCancel');
  await sleep(500);
  check('取消后仍是「打开密码」、密码仍在',
    (await cdp.evalJs(`document.getElementById('pinRowLabel').textContent`)) === '打开密码'
    && await cdp.evalJs(`!!window.__diary__.Meta.data.pinHash`));
  await cdp.send('Page.navigate', { url: BASE + '?t=' + Date.now() });
  await sleep(3400);
  check('关掉开关后重开应用也不弹锁屏',
    !await cdp.evalJs(`document.getElementById('screen-lock').classList.contains('show')`));
  await cdp.clickSel('#tabbar .tab[data-tab="mine"]');
  await sleep(700);
  await cdp.clickSel('#setLock');
  await sleep(700);
  check('重新开启需先验证已有密码（不要求重设）',
    /验证后开启密码验证/.test(await cdp.evalJs(`document.getElementById('lockSub').textContent`)));
  check('「开启密码」这条路上不出现「关闭密码」（别一眼看错方向）',
    await cdp.evalJs(`getComputedStyle(document.getElementById('lockOff')).display === 'none'`));
  check('「开启密码」这条路上也不给「暂不设置」（避免误绕开保护）',
    await cdp.evalJs(`getComputedStyle(document.getElementById('lockSkip')).display === 'none'`));
  for (const k of PIN) await cdp.clickSel(`.keypad button[data-k="${k}"]`);
  await sleep(900);
  check('验证通过后重新开启', await cdp.evalJs(`window.__diary__.Meta.data.pinEnabled`));
  check('状态回到「已设置」',
    (await cdp.evalJs(`document.getElementById('pinStateText').textContent`)) === '已设置');
  check('开关旁的提示同步回「已开启」',
    (await cdp.evalJs(`document.getElementById('pinSwitchHint').textContent`)) === '已开启');

  // 修改密码：先验旧密码，再设新的；全程不动开关
  await cdp.clickSel('#setChangePin');
  await sleep(700);
  check('修改密码也要先验证旧密码（防止拿到手机的人直接改）',
    await cdp.evalJs(`document.getElementById('screen-lock').classList.contains('show')`)
    && /验证后修改密码/.test(await cdp.evalJs(`document.getElementById('lockSub').textContent`)));
  check('修改密码这条路上不出现「关闭密码」',
    await cdp.evalJs(`getComputedStyle(document.getElementById('lockOff')).display === 'none'`));
  check('修改密码这条路上有「取消」出口',
    await cdp.evalJs(`getComputedStyle(document.getElementById('lockCancel')).display !== 'none'`));
  await cdp.clickSel('#lockCancel');
  await sleep(600);
  check('取消修改后开关与密码都保持不变',
    await cdp.evalJs(`window.__diary__.Meta.data.pinEnabled`)
    && await cdp.evalJs(`!!window.__diary__.Meta.data.pinHash`)
    && !await cdp.evalJs(`document.getElementById('screen-lock').classList.contains('show')`));
  // 改密码真的走完一遍：开关必须保持开启（别把"改密码"退化成"关密码"）
  await cdp.clickSel('#setChangePin');
  await sleep(700);
  for (const k of PIN) await cdp.clickSel(`.keypad button[data-k="${k}"]`);
  await sleep(1000);
  check('验过旧密码后进入设置新密码',
    /设置 6 位数字密码/.test(await cdp.evalJs(`document.getElementById('lockTitle').textContent`)));
  await cdp.shot('17k-change-pin.png');
  for (const k of NEWPIN) await cdp.clickSel(`.keypad button[data-k="${k}"]`);
  await sleep(900);
  check('新密码已写入（第一步完成，进入"再次输入确认"）',
    await cdp.evalJs(`document.getElementById('lockTitle').textContent`) === '再次输入确认',
    await cdp.evalJs(`document.getElementById('lockTitle').textContent`));
  for (const k of NEWPIN) await cdp.clickSel(`.keypad button[data-k="${k}"]`);
  await sleep(1600);
  check('改完密码后开关仍然是「已开启」',
    await cdp.evalJs(`window.__diary__.Meta.data.pinEnabled`)
    && (await cdp.evalJs(`document.getElementById('pinStateText').textContent`)) === '已设置',
    `pinEnabled=${await cdp.evalJs(`window.__diary__.Meta.data.pinEnabled`)} 状态=${await cdp.evalJs(`document.getElementById('pinStateText').textContent`)}`);
  check('新密码生效（锁屏能用新密码通过）',
    await cdp.evalJs(`window.__diary__.Lock.verify('${NEWPIN}')`) === true);
  check('旧密码已失效', await cdp.evalJs(`window.__diary__.Lock.verify('${PIN}')`) === false);
  // 改回去，别把后面依赖 PIN 的用例带偏
  await cdp.evalJs(`(async () => {
    await window.__diary__.Lock.setPin('${PIN}');
    window.__diary__.enableLock(); })()`);
  await sleep(600);
  check('恢复成原密码 + 开启状态',
    await cdp.evalJs(`window.__diary__.Lock.verify('${PIN}')`) === true
    && await cdp.evalJs(`window.__diary__.Meta.data.pinEnabled`));

  console.log('\n[17b] 头像 / 背景：点击可打开大图，且不与「更换封面」打架');
  // 封面在「时间线」屏里，不是首页磁贴屏 —— 先切过去，否则点到的是 desk-inner
  await cdp.clickSel('#tabbar .tab[data-tab="timeline"]');
  await sleep(700);
  check('已切到时间线（封面所在屏）',
    await cdp.evalJs(`document.getElementById('screen-timeline').classList.contains('active')`));
  // 封面按钮的"更换"语义必须保留：点它只应弹文件选择器，不该同时弹预览
  const coverBtn = await cdp.evalJs(`(() => {
    const b = document.getElementById('btnCover');
    return { text: b.textContent.trim() }; })()`);
  check('封面区仍有「更换封面」按钮', /更换封面/.test(coverBtn.text), coverBtn.text);
  await cdp.clickSel('#btnCover');
  await sleep(600);
  check('点「更换封面」不会误开大图预览',
    !await cdp.evalJs(`document.getElementById('viewer').classList.contains('show')`));
  await cdp.evalJs(`window.__diary__.closeMask()`);
  await sleep(300);
  // 点封面空白处应能打开大图（先种一张封面，否则只会弹"还没设置"的提示）
  await cdp.evalJs(`(async () => {
    const cv = document.createElement('canvas'); cv.width = 300; cv.height = 200;
    const g = cv.getContext('2d');
    g.fillStyle = '#3C4A5E'; g.fillRect(0, 0, 300, 200);
    g.fillStyle = '#8797A8'; g.fillRect(0, 140, 300, 60);
    const blob = await new Promise(r => cv.toBlob(r, 'image/png'));
    await window.__diary__.Store.putImage({ id: 'cover', entryId: '__profile__', w: 300, h: 200, size: blob.size, blob });
    await window.__diary__.loadHome();
    return true; })()`);
  await sleep(900);
  check('封面图已就位（种子图）', await cdp.evalJs(`(() => {
    const im = document.getElementById('coverImg');
    return !!im && im.style.display === 'block' && im.src.length > 0; })()`));
  // 用真实鼠标事件点封面中上部（避开右上角的「更换封面」按钮，
  // 也避开底部 —— .me 用负 margin 压上来 44px，点太低会命中头像）
  const covPt = await cdp.evalJs(`(() => { const c = document.querySelector('.cover');
    if (!c) return null; c.scrollIntoView({ block: 'center' });
    const r = c.getBoundingClientRect();
    return { x: Math.round(r.left + 40), y: Math.round(r.top + r.height * 0.45) }; })()`);
  if (!covPt) throw new Error('找不到封面元素 .cover');
  await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: covPt.x, y: covPt.y, buttons: 0 });
  await cdp.clickPoint(covPt.x, covPt.y);
  await sleep(800);
  const covView = await cdp.evalJs(`(() => {
    const v = document.getElementById('viewer');
    const im = document.querySelector('#viewerTrack img');
    return { shown: v.classList.contains('show'), imgOk: !!im && im.src.length > 0 }; })()`);
  check('点封面可以打开大图', covView.shown);
  check('封面大图有真实内容', covView.imgOk);
  await cdp.shot('19b-cover-viewer.png');
  await cdp.clickSel('#viewerClose');
  await sleep(400);
  // 先用 canvas 现画一张小图种进头像（正常路径是「我的」里选图，这里直接入库，等价且更快，
  // 也不用给测试服务端加特殊路由）
  await cdp.evalJs(`(async () => {
    const cv = document.createElement('canvas'); cv.width = 96; cv.height = 96;
    const g = cv.getContext('2d');
    g.fillStyle = '#2E4A63'; g.fillRect(0, 0, 96, 96);
    g.fillStyle = '#f5c451'; g.beginPath(); g.arc(48, 48, 26, 0, Math.PI * 2); g.fill();
    const blob = await new Promise(r => cv.toBlob(r, 'image/png'));
    await window.__diary__.Store.putImage({ id: 'avatar', entryId: '__profile__', w: 96, h: 96, size: blob.size, blob });
    await window.__diary__.loadHome();
    return true; })()`);
  await sleep(900);
  check('头像已就位（种子图）', await cdp.evalJs(`(() => {
    const im = document.getElementById('avatarImg');
    return !!im && im.style.display === 'block' && im.src.length > 0; })()`));
  await cdp.evalJs(`document.getElementById('meAvatar').click()`);
  await sleep(700);
  const avView = await cdp.evalJs(`(() => {
    const v = document.getElementById('viewer');
    const im = document.querySelector('#viewerTrack img');
    return { shown: v.classList.contains('show'), count: document.getElementById('viewerCount').textContent.trim(),
             imgOk: !!im && im.src.length > 0 }; })()`);
  check('点头像可以打开大图', avView.shown, `${avView.count}`);
  check('头像大图有真实内容', avView.imgOk);
  await cdp.shot('19b-avatar-viewer.png');
  await cdp.clickSel('#viewerClose');
  await sleep(400);
  check('关闭头像大图后回到首页', !await cdp.evalJs(`document.getElementById('viewer').classList.contains('show')`));
  // 没有设置头像时的兜底提示（清掉头像记录后点）
  await cdp.evalJs(`window.__diary__.Store.deleteImage('avatar').then(() => true)`);
  await sleep(400);
  await cdp.evalJs(`document.getElementById('meAvatar').click()`);
  await sleep(600);
  check('未设置头像时给出提示而非静默无反应',
    /还没有设置头像/.test(await cdp.evalJs(`document.getElementById('toast').textContent`)),
    await cdp.evalJs(`document.getElementById('toast').textContent`));
  await sleep(1600);

  console.log('\n[17c] 时间线下拉：封面放大 + 松手回弹（微信手势）');
  await cdp.clickSel('#tabbar .tab[data-tab="timeline"]');
  await sleep(600);
  const pullSetup = await cdp.evalJs(`(() => { const sc = document.getElementById('homeScroll');
    const cv = document.querySelector('#screen-timeline .cover');
    const cs = getComputedStyle(sc);
    return { overscroll: cs.overscrollBehaviorY || cs.overscrollBehavior,
             baseH: Math.round(cv.getBoundingClientRect().height),
             origin: getComputedStyle(cv).transformOrigin,
             coverBase: window.__diary__.COVER_BASE_H }; })()`);
  // 自定义手势和原生回弹必须二选一，否则两个位移会叠在一起「飘」
  check('时间线关掉原生回弹（不与自定义手势叠加）', /contain/.test(pullSetup.overscroll), pullSetup.overscroll);
  check('封面高度 = COVER_BASE_H（CSS 与 JS 常量没脱钩）',
    pullSetup.baseH === pullSetup.coverBase, `${pullSetup.baseH} / ${pullSetup.coverBase}`);
  check('封面缩放锚点在顶部（y 分量为 0）',
    /0px\s*$/.test(pullSetup.origin.trim()), pullSetup.origin);

  // 真实触摸事件驱动：手指从顶部往下拖 -> 内容下移 + 封面放大 -> 松手一起弹回
  const pulled = await cdp.evalJs(`(async () => {
    const sc = document.getElementById('homeScroll');
    const cv = document.querySelector('#screen-timeline .cover');
    const pl = document.getElementById('tlPull');
    sc.scrollTop = 0;
    const scTop = () => Math.round(sc.getBoundingClientRect().top);
    const mk = (type, y) => new TouchEvent(type, { bubbles: true, cancelable: true,
      touches: type === 'touchend' ? [] : [new Touch({ identifier: 1, target: sc, clientX: 120, clientY: y })] });
    sc.dispatchEvent(mk('touchstart', 100));
    sc.dispatchEvent(mk('touchmove', 260));
    await new Promise(r => setTimeout(r, 60));
    const mid = { sc: sc.style.transform, pull: pl.style.transform, cover: cv.style.transform,
                  coverH: Math.round(cv.getBoundingClientRect().height),
                  // 封面视口顶边 − 滚动区视口顶边。必须≈0：
                  // 说明下拉露出的空隙被放大后的封面填住了，没有露出背景色。
                  gap: Math.round(cv.getBoundingClientRect().top) - scTop(),
                  scTopMoved: scTop() - 46 };
    sc.dispatchEvent(mk('touchend', 260));
    await new Promise(r => setTimeout(r, 700));
    return { mid, pullAfter: pl.style.transform, coverAfter: cv.style.transform,
             coverHAfter: Math.round(cv.getBoundingClientRect().height), scrollTop: sc.scrollTop }; })()`);

  check('位移加在内容层上，滚动区自己不动（动了会露出背景）',
    !pulled.mid.sc && Math.abs(pulled.mid.scTopMoved) <= 1, `sc="${pulled.mid.sc}" 顶边位移 ${pulled.mid.scTopMoved}px`);
  check('下拉时内容跟手位移', /translateY\((\d+(\.\d+)?)px\)/.test(pulled.mid.pull), pulled.mid.pull);
  const pulledPx = parseFloat((pulled.mid.pull.match(/translateY\(([\d.]+)px\)/) || [0, '0'])[1]);
  check('位移量有阻尼（不会 1:1 跟到底）', pulledPx > 0 && pulledPx < 160, `${pulledPx}px / 拖动 160px`);
  check('下拉时封面被放大（scale > 1）', /scale\(1\.\d+\)/.test(pulled.mid.cover), pulled.mid.cover);
  const midScale = parseFloat((pulled.mid.cover.match(/scale\(([\d.]+)\)/) || [0, '1'])[1]);
  check('放大倍数与位移匹配 (BASE+d)/BASE',
    Math.abs(midScale - (pullSetup.coverBase + pulledPx) / pullSetup.coverBase) < 0.01, `scale=${midScale}`);
  check('封面视觉高度确实变大', pulled.mid.coverH > pullSetup.baseH, `${pullSetup.baseH}px → ${pulled.mid.coverH}px`);
  check('封面反向位移，上边缘钉住、空隙被填满',
    /translateY\(-\d/.test(pulled.mid.cover) && Math.abs(pulled.mid.gap) <= 1,
    `${pulled.mid.cover} / 顶边差 ${pulled.mid.gap}px`);
  check('松手后内容归位', !pulled.pullAfter || /translateY\(0(px)?\)|^$/.test(pulled.pullAfter), pulled.pullAfter || '(已清空)');
  check('松手后封面恢复原大小', !pulled.coverAfter || /scale\(1\)|^$/.test(pulled.coverAfter), pulled.coverAfter || '(已清空)');
  check('回弹后封面高度复原', pulled.coverHAfter === pullSetup.baseH, `${pulled.coverHAfter}px`);
  check('回弹后仍在顶部', pulled.scrollTop === 0, `scrollTop=${pulled.scrollTop}`);

  // 单独再拉一次并「停在跟手状态」上截图 —— 放大效果只有中途才看得到
  await cdp.evalJs(`(async () => {
    const sc = document.getElementById('homeScroll');
    sc.scrollTop = 0;
    const mk = (type, y) => new TouchEvent(type, { bubbles: true, cancelable: true,
      touches: type === 'touchend' ? [] : [new Touch({ identifier: 1, target: sc, clientX: 120, clientY: y })] });
    sc.dispatchEvent(mk('touchstart', 100));
    sc.dispatchEvent(mk('touchmove', 250));
    await new Promise(r => setTimeout(r, 90));
    return true; })()`);
  await cdp.shot('19e-pull-cover-zoom.png');
  await cdp.evalJs(`(() => { const sc = document.getElementById('homeScroll');
    sc.dispatchEvent(new TouchEvent('touchend', { bubbles: true, cancelable: true, touches: [] }));
    return true; })()`);
  await sleep(700);

  // 已经滚下去时不应再触发下拉放大。
  // 先把视口压矮逼出可滚动高度 —— 否则 scrollTop 赋值被忽略，测的根本不是这个分支（踩过）。
  await cdp.viewport(390, 320, true);
  await sleep(500);
  const scrolledPull = await cdp.evalJs(`(async () => {
    const sc = document.getElementById('homeScroll');
    const cv = document.querySelector('#screen-timeline .cover');
    const pl = document.getElementById('tlPull');
    sc.scrollTop = 0;
    const canScroll = sc.scrollHeight > sc.clientHeight + 20;
    sc.scrollTop = 40;
    const at = sc.scrollTop;
    const mk = (type, y) => new TouchEvent(type, { bubbles: true, cancelable: true,
      touches: type === 'touchend' ? [] : [new Touch({ identifier: 1, target: sc, clientX: 120, clientY: y })] });
    sc.dispatchEvent(mk('touchstart', 100));
    sc.dispatchEvent(mk('touchmove', 300));
    await new Promise(r => setTimeout(r, 60));
    const plT = pl.style.transform, cvT = cv.style.transform;
    sc.dispatchEvent(mk('touchend', 300));
    await new Promise(r => setTimeout(r, 500));
    sc.scrollTop = 0;
    return { canScroll, at, plT, cvT }; })()`);
  check('测试前提：压矮视口后内容确实可滚动',
    scrolledPull.canScroll && scrolledPull.at > 0, `canScroll=${scrolledPull.canScroll} scrollTop=${scrolledPull.at}`);
  check('已经滚下去时不做下拉放大（不跟正常滚动打架）',
    !scrolledPull.plT && !scrolledPull.cvT, `pull="${scrolledPull.plT}" cover="${scrolledPull.cvT}"`);
  await cdp.viewport(390, 844, true);
  await sleep(400);

  console.log('\n[17e] 时间线相机：单击出菜单 / 长按写纯文字（微信手势）');
  await cdp.clickSel('#tabbar .tab[data-tab="timeline"]');
  await sleep(600);
  check('时间线右上角有相机按钮', await cdp.evalJs(`!!document.getElementById('btnCamera')`));
  check('存在带 capture 的拍照入口（手机上调起系统相机）',
    await cdp.evalJs(`(() => { const i = document.getElementById('fileCamera');
      return !!i && i.getAttribute('capture') === 'environment' && /image/.test(i.getAttribute('accept')); })()`));

  // 单击 -> 菜单（微信上是「拍照 / 从手机相册选择」）
  await cdp.clickSel('#btnCamera');
  await sleep(500);
  const sheet = await cdp.evalJs(`(() => {
    const s = document.getElementById('actionSheet');
    return { shown: document.getElementById('mask').classList.contains('show'),
             items: [...s.querySelectorAll('.sheet-item')].map(b => b.textContent.trim()) }; })()`);
  check('单击相机弹出菜单', sheet.shown);
  check('菜单含「拍照」', sheet.items.indexOf('拍照') >= 0, sheet.items.join(' / '));
  check('菜单含「从手机相册选择」', sheet.items.indexOf('从手机相册选择') >= 0, sheet.items.join(' / '));
  check('菜单可取消', sheet.items.indexOf('取消') >= 0);
  await cdp.shot('19c-camera-sheet.png');

  // 菜单里的两个入口分别去打「拍照」和「相册」两个选择器
  const pickerFlow = await cdp.evalJs(`(() => {
    const counters = { album: 0, camera: 0 };
    const a = document.getElementById('filePicker'), c = document.getElementById('fileCamera');
    const oa = a.click.bind(a), oc = c.click.bind(c);
    a.click = function () { counters.album++; }; c.click = function () { counters.camera++; };
    const hit = (label) => [...document.querySelectorAll('#actionSheet .sheet-item')]
      .find(b => b.textContent.trim() === label).click();
    window.__diary__.openCameraSheet(); hit('从手机相册选择');
    window.__diary__.openCameraSheet(); hit('拍照');
    a.click = oa; c.click = oc;
    return counters; })()`);
  check('选「从手机相册选择」走多选选择器', pickerFlow.album === 1, `${pickerFlow.album} 次`);
  check('选「拍照」走 capture 选择器', pickerFlow.camera === 1, `${pickerFlow.camera} 次`);
  // 上面同一帧里连开了两次面板，openSheet 内部的 requestAnimationFrame 还没执行，
  // 会在我关掉之后又把遮罩加回来。所以先等一帧再关，然后断言确实关干净了 ——
  // 不然后面「长按不该弹菜单」会被这个残留遮罩误判成失败（白查一轮）。
  await sleep(320);
  await cdp.evalJs(`window.__diary__.closeMask()`);
  await sleep(500);
  check('测试前提：面板已关闭', !await cdp.evalJs(`document.getElementById('mask').classList.contains('show')`));

  // 长按 -> 直接进发布页写纯文字
  const longPress = await cdp.evalJs(`(async () => {
    const btn = document.getElementById('btnCamera');
    const r = btn.getBoundingClientRect();
    const pd = (type) => btn.dispatchEvent(new PointerEvent(type, {
      bubbles: true, cancelable: true,
      clientX: r.left + r.width / 2, clientY: r.top + r.height / 2 }));
    pd('pointerdown');
    await new Promise(res => setTimeout(res, window.__diary__.CAMERA_LONG_MS + 140));
    const openedOnHold = document.getElementById('screen-composer').classList.contains('active');
    pd('pointerup');
    // 浏览器在长按抬手后还会补发一次 click —— 必须被吞掉，否则菜单会盖上来
    btn.click();
    await new Promise(res => setTimeout(res, 320));
    return { openedOnHold,
             sheetAfterClick: document.getElementById('mask').classList.contains('show'),
             title: document.getElementById('composerTitle').textContent,
             textOnly: window.__diary__.State.textOnly,
             gridDisplay: getComputedStyle(document.getElementById('composerGrid')).display }; })()`);
  check('长按相机直接进发布页', longPress.openedOnHold);
  check('长按后补发的 click 不会弹出菜单', !longPress.sheetAfterClick);
  check('纯文字模式标题为「写文字」', longPress.title === '写文字', longPress.title);
  check('State.textOnly 已置位', longPress.textOnly);
  check('纯文字模式不显示配图入口', longPress.gridDisplay === 'none', longPress.gridDisplay);
  check('纯文字模式草稿里没有图片', await cdp.evalJs(`window.__diary__.State.draftImages.length === 0`));
  check('纯文字模式的提示不提图片',
    !/图片/.test(await cdp.evalJs(`document.getElementById('composerTip').textContent`)));
  await cdp.shot('19d-camera-textonly.png');

  // 纯文字也能正常发表
  await cdp.evalJs(`document.getElementById('composerText').focus()`);
  await cdp.send('Input.insertText', { text: '长按相机写的一条纯文字日记。' });
  await sleep(300);
  await cdp.clickSel('#btnPublish');
  await sleep(1500);
  const textOnlyPost = await cdp.evalJs(`(() => {
    const p = document.querySelector('#timeline .post');
    return { text: p.querySelector('.post-text').textContent,
             hasImg: !!p.querySelector('.pgrid') }; })()`);
  check('纯文字日记发表成功', /长按相机写的一条纯文字日记/.test(textOnlyPost.text), textOnlyPost.text.slice(0, 20));
  check('纯文字日记没有图片区', !textOnlyPost.hasImg);
  // 收尾：删掉这条 + 恢复非纯文字模式，保持后面用例的基线
  await cdp.evalJs(`window.__diary__.Store.listEntries().then(list => {
    const e = list.find(x => (x.text || '').indexOf('长按相机写的') === 0);
    return e ? window.__diary__.Store.deleteEntryCascade(e.id) : null;
  }).then(() => window.__diary__.loadHome())`);
  await sleep(1200);
  check('清掉测试日记，回到 1 篇基线',
    await cdp.evalJs(`document.querySelectorAll('#timeline .post').length`) === 1,
    `${await cdp.evalJs(`document.querySelectorAll('#timeline .post').length`)} 篇`);

  // 再点一次相机（不选东西）不应该进发布页 —— 取消选择是空操作
  await cdp.evalJs(`window.__diary__.openCameraSheet()`);
  await sleep(300);
  await cdp.evalJs(`(() => { const a = document.getElementById('filePicker');
    a.dispatchEvent(new Event('change')); return true; })()`);
  await sleep(400);
  check('取消图片选择不会误进发布页',
    !await cdp.evalJs(`document.getElementById('screen-composer').classList.contains('active')`));
  await cdp.evalJs(`window.__diary__.closeMask()`);
  await sleep(300);

  console.log('\n[17d] 导出备份：JSON 里的文本与原文逐字一致');
  // 先造一篇换行明确的日记，别去猜库里第一篇是什么
  const EXP_TEXT = '第一段：今天天气不错。\n\n第二段：中间空了一行。\n第三段：结尾。';
  await cdp.evalJs(`window.__diary__.publishText(${JSON.stringify(EXP_TEXT)})`);
  await sleep(1300);
  const expJson = await cdp.evalJs(`(() => {
    const e = window.__diary__.State.entries.find(x => (x.text || '').startsWith('第一段'));
    if (!e) return null;
    return { raw: e.text, id: e.id, lines: e.text.split('\\n').length,
             hasCR: /\\r/.test(e.text),
             blankLine: /\\n\\n/.test(e.text) }; })()`);
  if (!expJson) throw new Error('没找到刚发布的多行日记');
  check('库里存的正文没有 \\r 残留（换行已统一）', !expJson.hasCR);
  check('空行被完整保留（没被折叠掉）', expJson.blankLine);
  check('库里存的行数与输入一致', expJson.lines === 4, `${expJson.lines} 行`);
  // 走真实导出逻辑拿 JSON（与用户点「导出备份」完全同一条路）
  const backup = await cdp.evalJs(`(async () => {
    const payload = await window.__diary__.buildBackup();
    return JSON.stringify(payload); })()`);
  const parsed = JSON.parse(backup);
  const found = (parsed.entries || parsed.diary || []).find((e) => e.id === expJson.id);
  check('导出的 JSON 里能找到这篇', !!found);
  check('导出文本与写的逐字一致（换行、空行都在）',
    !!found && found.text === EXP_TEXT,
    found ? JSON.stringify(found.text).slice(0, 60) : '未找到');
  check('导出文本行数与原文一致', !!found && found.text.split('\n').length === 4);
  const fname = await cdp.evalJs(`window.__diary__.backupFileName()`);
  check('备份文件名是纯 ASCII（安卓文件应用不乱码）',
    /^[\x20-\x7e]+$/.test(fname) && /^my-diary-backup-\d{8}-\d{4}\.json$/.test(fname), fname);

  console.log('\n[17f] 导出：先选格式（默认 JSON）→ 再确认，两步都不落文件');
  const dlCount = () => cdp.events.filter((e) => e.method === 'Page.downloadWillBegin').length;
  await cdp.clickSel('#tabbar .tab[data-tab="home"]');
  await sleep(600);
  await cdp.clickSel('#deskTiles .tile[data-go="backup"]');
  await sleep(600);
  check('点「备份」磁贴先弹格式面板，不直接下载',
    await cdp.evalJs(`document.getElementById('mask').classList.contains('show')`)
    && await cdp.evalJs(`document.getElementById('actionSheet').style.display !== 'none'`));
  const fmtLabels = await cdp.evalJs(`Array.from(document.querySelectorAll('#actionSheet .sheet-item')).map(b => b.textContent.trim())`);
  check('格式面板给了 JSON / 纯文本 / Markdown 三个选项（外加取消）',
    fmtLabels.length === 4 && /JSON/.test(fmtLabels[0]) && /txt/.test(fmtLabels[1]) && /md/.test(fmtLabels[2]),
    JSON.stringify(fmtLabels));
  check('JSON 被标为「推荐」（默认口径对用户可见）', /推荐/.test(fmtLabels[0]));
  check('纯文本 / Markdown 明确标注「仅文字」（导完才发现没图片最坑）',
    /仅文字/.test(fmtLabels[1]) && /仅文字/.test(fmtLabels[2]));
  check('格式面板阶段尚未产生任何下载', dlCount() === 0);
  await cdp.shot('17f-export-format-sheet.png');
  // 选 JSON：仍然要走二次确认
  await cdp.clickSel('#actionSheet .sheet-item[data-i="0"]');
  await sleep(700);
  check('选 JSON 后弹二次确认框',
    await cdp.evalJs(`document.getElementById('mask').classList.contains('show')`)
    && await cdp.evalJs(`document.getElementById('dialog').style.display !== 'none'`));
  check('确认框标题是「导出备份」',
    (await cdp.evalJs(`document.getElementById('dialogTitle').textContent`)).trim() === '导出备份');
  check('确认框报明了要导出几篇',
    /\d+\s*篇日记/.test(await cdp.evalJs(`document.getElementById('dialogText').textContent`)),
    (await cdp.evalJs(`document.getElementById('dialogText').textContent`)).replace(/\n/g, ' '));
  check('确认框弹出时尚未产生任何下载', dlCount() === 0);
  // 取消：不应该有任何文件落地
  await cdp.clickSel('#dialogBtns button:not(.primary)');
  await sleep(700);
  check('点「取消」不导出任何文件', dlCount() === 0);
  check('取消后确认框收起', !await cdp.evalJs(`document.getElementById('mask').classList.contains('show')`));
  // 选纯文本：确认框要说清"不含图片、要恢复请用 JSON"
  await cdp.clickSel('#deskTiles .tile[data-go="backup"]');
  await sleep(600);
  await cdp.clickSel('#actionSheet .sheet-item[data-i="1"]');
  await sleep(700);
  const txtConfirm = await cdp.evalJs(`document.getElementById('dialogText').textContent`);
  check('选纯文本时确认框说明「不含图片」', /不含图片/.test(txtConfirm), txtConfirm.replace(/\n/g, ' '));
  check('选纯文本时确认框指向 JSON 备份', /JSON 备份/.test(txtConfirm));
  await cdp.clickSel('#dialogBtns button:not(.primary)');
  await sleep(700);
  check('取消文本导出也不落文件', dlCount() === 0);

  console.log('\n[17h] 纯文本 / Markdown 导出：内容、文件名、能被自己读回来');
  // [17d] 收尾把那篇删了，这里重新造一篇换行明确的（含空行）来断言"逐字一致"
  const TXT_TEXT = '第一段：今天天气不错。\n\n第二段：中间空了一行。\n第三段：结尾。';
  await cdp.evalJs(`window.__diary__.publishText(${JSON.stringify(TXT_TEXT)})`);
  await sleep(1300);
  const txtOut = await cdp.evalJs(`(async () => {
    const list = await window.__diary__.Store.listEntries();
    return window.__diary__.buildTextBackup(list, 'txt'); })()`);
  check('纯文本导出带表头与篇数', /导出备份（纯文本）/.test(txtOut) && /共 \d+ 篇日记/.test(txtOut));
  check('纯文本导出写明不含图片、要恢复请用 JSON 备份',
    /不含图片/.test(txtOut) && /JSON 备份/.test(txtOut));
  check('纯文本导出正文逐字一致（空行都在）', txtOut.indexOf(TXT_TEXT) >= 0,
    JSON.stringify(txtOut.slice(0, 40)));
  check('纯文本头部行含日期（自己读得回来）',
    /^———————— 第 \d+ 篇 · \d{4}-\d{2}-\d{2} \d{2}:\d{2} ————————$/m.test(txtOut));
  const mdOut = await cdp.evalJs(`(async () => {
    const list = await window.__diary__.Store.listEntries();
    return window.__diary__.buildTextBackup(list, 'md'); })()`);
  check('Markdown 导出有 # 标题与 ## 日期小标题',
    /^# 我的日记$/m.test(mdOut) && /^## \d{4}-\d{2}-\d{2} \d{2}:\d{2}$/m.test(mdOut));
  check('Markdown 导出正文逐字一致（空行都在）', mdOut.indexOf(TXT_TEXT) >= 0);
  // 文件名后缀跟随格式，且仍是纯 ASCII（安卓文件应用不乱码）
  check('txt 文件名后缀是 .txt',
    /^my-diary-backup-\d{8}-\d{4}\.txt$/.test(await cdp.evalJs(`window.__diary__.backupFileName('txt')`)));
  check('md 文件名后缀是 .md',
    /^my-diary-backup-\d{8}-\d{4}\.md$/.test(await cdp.evalJs(`window.__diary__.backupFileName('md')`)));
  check('不传格式时默认 .json（老行为不变）',
    /^my-diary-backup-\d{8}-\d{4}\.json$/.test(await cdp.evalJs(`window.__diary__.backupFileName()`)));
  // 往返：导出的 txt 再读回来，篇数与正文都要对得上
  const entryN = await cdp.evalJs(`window.__diary__.State.entries.length`);
  const round = await cdp.evalJs(`window.__diary__.parseTextBackup(${JSON.stringify(txtOut)}, 'txt').map(e => ({ text: e.text, ts: e.createdAt }))`);
  check('导出的纯文本能被自己读回来，篇数一致', round.length === entryN, `${round.length} vs ${entryN}`);
  check('往返后正文逐字一致（空行都在）', round.some((e) => e.text === TXT_TEXT));
  check('往返后没把头部行吃进正文', round.every((e) => !/^—{4,}|^#{1,2}\s/.test(e.text)));
  check('往返后没把「（附 N 张图片）」提示吃进正文', round.every((e) => !/张图片/.test(e.text)));
  check('往返后时间戳取自头部行（时间线顺序不乱）',
    round.every((e) => e.ts > 0 && new Date(e.ts).getFullYear() >= 2020));
  // md 走同一套往返
  check('Markdown 导出也能被自己读回来',
    await cdp.evalJs(`window.__diary__.parseTextBackup(${JSON.stringify(mdOut)}, 'md').length`) === entryN);
  // 认不出头部就整份当一篇（用户手上的可能是自己随手写的 txt）
  check('手写 txt（无头部行）整份当一篇',
    await cdp.evalJs(`window.__diary__.parseTextBackup('随手记一段话。\\n\\n没有头部行。', 'txt').length`) === 1,
    JSON.stringify(await cdp.evalJs(`window.__diary__.parseTextBackup('随手记一段话。\\n\\n没有头部行。', 'txt')`)));
  check('只有空白/空的文件不产生任何日记',
    await cdp.evalJs(`window.__diary__.parseTextBackup('   \\n\\n ', 'txt').length`) === 0);
  const noted = await cdp.evalJs(`window.__diary__.parseTextBackup(${JSON.stringify('———————— 第 1 篇 · 2026-09-17 15:30 ————————\n\n正文甲。\n\n（附 3 张图片）\n')}, 'txt')`);
  check('txt 里的图片张数提示不会被当成正文',
    noted.length === 1 && noted[0].text === '正文甲。', JSON.stringify(noted));
  // 导入也有格式选择面板
  await cdp.evalJs(`window.__diary__.pickImportFormat()`);
  await sleep(400);
  const impLabels = await cdp.evalJs(`Array.from(document.querySelectorAll('#actionSheet .sheet-item')).map(b => b.textContent.trim())`);
  check('导入也有格式选择面板（JSON 排第一）',
    impLabels.length === 4 && /JSON/.test(impLabels[0]) && /txt/.test(impLabels[1]) && /md/.test(impLabels[2]),
    JSON.stringify(impLabels));
  await cdp.evalJs(`window.__diary__.closeMask()`);
  await sleep(400);
  // 格式选错也要兜住：内容是备份 JSON 就按 JSON 走，别把好备份退回去
  const mismatch = await cdp.evalJs(`(() => new Promise(res => {
    const payload = JSON.stringify({ app: 'wechat-diary', schema: 1, entryCount: 0, entries: [] });
    const f = new File([payload], 'backup.txt', { type: 'text/plain' });
    window.__diary__.importBackup(f, 'txt');
    setTimeout(() => res(document.getElementById('dialogTitle').textContent), 500); }))()`);
  check('格式选错但内容是备份 JSON 时，仍按 JSON 导入流程走',
    mismatch.trim() === '导入备份', mismatch);
  await cdp.evalJs(`window.__diary__.closeMask()`);
  await sleep(400);
  check('这一串导出/导入操作全程仍没落过任何文件', dlCount() === 0);
  // 收尾：删掉本篇，保持后续用例的基线
  await cdp.evalJs(`window.__diary__.Store.listEntries().then(list => {
    const e = list.find(x => (x.text || '').startsWith('第一段'));
    return e ? window.__diary__.Store.deleteEntryCascade(e.id) : null;
  }).then(() => window.__diary__.loadHome())`);
  await sleep(1200);

  console.log('\n[17i] 返回首页：磁贴进来的有、底部栏进来的没有');
  // 口径：从首页磁贴跳到某个标签页 = 进了个"下级页"，得有明确的回头路；
  //      从底部栏切过去 = 本来就在底部栏里，再给个返回键是多余的。
  await cdp.clickSel('#tabbar .tab[data-tab="home"]');
  await sleep(700);
  check('首页：三个面板的返回键都收着',
    await cdp.evalJs(`Array.from(document.querySelectorAll('[data-back-home]')).every(b => b.hidden)`)
    && await cdp.evalJs(`Array.from(document.querySelectorAll('[data-back-home]')).every(b => getComputedStyle(b).display === 'none')`));
  // 磁贴 → 时间线
  await cdp.clickSel('#deskTiles .tile[data-go="timeline"]');
  await sleep(700);
  const tl = await cdp.evalJs(`(() => {
    const b = document.getElementById('btnTimelineHome');
    const r = b.getBoundingClientRect();
    return { hidden: b.hidden, shown: getComputedStyle(b).display !== 'none',
             w: Math.round(r.width), h: Math.round(r.height), left: Math.round(r.left) }; })()`);
  check('磁贴进时间线：左上角出现返回首页', tl.hidden === false && tl.shown);
  check('返回键是 44×44 的点按热区、贴左缘（微信式）',
    tl.w >= 44 && tl.h >= 44 && tl.left < 12, JSON.stringify(tl));
  await cdp.shot('17i-timeline-from-tile.png');
  check('加了返回键，标题仍然居中（absolute 布局没被挤走）',
    await cdp.evalJs(`(() => {
      const t = document.querySelector('#screen-timeline .nav-title').getBoundingClientRect();
      const s = document.getElementById('screen-timeline').getBoundingClientRect();
      return Math.abs((t.left + t.right) / 2 - (s.left + s.right) / 2) < 2; })()`));
  await cdp.clickSel('#btnTimelineHome');
  await sleep(700);
  check('点返回键回到首页',
    await cdp.evalJs(`document.getElementById('screen-home').classList.contains('active')`));
  check('回到首页后返回键自动收起',
    await cdp.evalJs(`Array.from(document.querySelectorAll('[data-back-home]')).every(b => b.hidden)`));
  // 底部栏 → 相册：不该有返回键
  await cdp.clickSel('#tabbar .tab[data-tab="gallery"]');
  await sleep(700);
  check('底部栏进相册：不显示返回键',
    await cdp.evalJs(`document.getElementById('btnGalleryHome').hidden === true`)
    && await cdp.evalJs(`getComputedStyle(document.getElementById('btnGalleryHome')).display === 'none'`));
  await cdp.shot('17i-gallery-from-tabbar.png');
  // 同一个标签，两种进法要给出不同结果
  await cdp.clickSel('#tabbar .tab[data-tab="home"]');
  await sleep(700);
  await cdp.clickSel('#deskTiles .tile[data-go="gallery"]');
  await sleep(700);
  check('同一标签（相册）改从磁贴进：返回键出现',
    await cdp.evalJs(`document.getElementById('btnGalleryHome').hidden === false`));
  await cdp.clickSel('#tabbar .tab[data-tab="gallery"]');
  await sleep(600);
  check('再点一次底部栏当前标签：返回键也收起（口径统一为"底部栏不用返回"）',
    await cdp.evalJs(`document.getElementById('btnGalleryHome').hidden === true`));
  // 时间线 → 齿轮 → 设置：来源标记不能丢，返回键要还在
  await cdp.clickSel('#tabbar .tab[data-tab="home"]');
  await sleep(700);
  await cdp.clickSel('#deskTiles .tile[data-go="timeline"]');
  await sleep(700);
  await cdp.clickSel('#btnSettings');
  await sleep(800);
  check('时间线→齿轮→设置：返回键仍在（来源标记没丢）',
    await cdp.evalJs(`window.__diary__.State.tab`) === 'mine'
    && await cdp.evalJs(`document.getElementById('btnMineHome').hidden === false`));
  await cdp.shot('17i-mine-from-tile.png');
  await cdp.clickSel('#btnMineHome');
  await sleep(700);
  check('设置页的返回键同样回首页',
    await cdp.evalJs(`document.getElementById('screen-home').classList.contains('active')`));
  // 系统返回键（安卓）：磁贴进来的应先回首页，别直接退 App
  await cdp.clickSel('#deskTiles .tile[data-go="timeline"]');
  await sleep(700);
  check('磁贴进来时按系统返回键 → 被消费并回首页',
    await cdp.evalJs(`window.__diary__.handleBackKey() === true`)
    && await cdp.evalJs(`document.getElementById('screen-home').classList.contains('active')`));
  await cdp.clickSel('#tabbar .tab[data-tab="mine"]');
  await sleep(700);
  check('底部栏进来时系统返回键不消费（保持"再按一次退出"）',
    await cdp.evalJs(`window.__diary__.handleBackKey() === false`));
  // 收尾：回首页，保持后续响应式用例的基线
  await cdp.clickSel('#tabbar .tab[data-tab="home"]');
  await sleep(700);
  check('收尾：回到首页且返回键收着',
    await cdp.evalJs(`document.getElementById('screen-home').classList.contains('active')`)
    && await cdp.evalJs(`Array.from(document.querySelectorAll('[data-back-home]')).every(b => b.hidden)`));
  check('这一节全程没触发文件下载', dlCount() === 0);

  console.log('\n[17g] 备份文本解析：明文 / BOM / 历史 base64 文件都要能读');
  const pp = `window.__diary__.parseBackupText`;
  const plain = JSON.stringify({ app: 'wechat-diary', schema: 1, entryCount: 0, entries: [] });
  check('明文 JSON 直接解析',
    await cdp.evalJs(`(${pp})(${JSON.stringify(plain)}).app`) === 'wechat-diary');
  check('带 BOM 的 JSON 也能解析',
    await cdp.evalJs(`(${pp})('\\uFEFF' + ${JSON.stringify(plain)}).app`) === 'wechat-diary');
  // ★ 历史事故护栏：Capacitor 8 的 Encoding 枚举没有 base64，插件把 base64 字符串
  //   原样写进了 .json 文件。这种文件其实是完整备份，必须能救回来，不能白白作废。
  const b64 = Buffer.from(plain, 'utf8').toString('base64');
  check('被 base64 包了一层的备份（历史文件）也能救回来',
    await cdp.evalJs(`(${pp})(${JSON.stringify(b64)}).app`) === 'wechat-diary',
    await cdp.evalJs(`String((${pp})(${JSON.stringify(b64)}) && (${pp})(${JSON.stringify(b64)}).app)`));
  check('含中文的 base64 备份解出来不乱码',
    await cdp.evalJs(`(${pp})(${JSON.stringify(Buffer.from(JSON.stringify({ app: 'wechat-diary', entries: [{ text: '今天去公园骑行' }] }), 'utf8').toString('base64'))}).entries[0].text`) === '今天去公园骑行');
  check('真正不是备份的文本返回 null', await cdp.evalJs(`(${pp})('这不是备份') === null`));
  check('空文本返回 null', await cdp.evalJs(`(${pp})('') === null`));

  // 收尾：删掉这篇，保持后续断言的基线
  await cdp.evalJs(`window.__diary__.Store.deleteEntryCascade(${JSON.stringify(expJson.id)})
    .then(() => window.__diary__.loadHome())`);
  await sleep(1000);

  console.log('\n[18] 响应式：三档断点');
  // 隐藏面板内的元素量不到真实栅格，先切回桌面
  await cdp.clickSel('#tabbar .tab[data-tab="home"]');
  await sleep(600);
  await cdp.viewport(390, 844, true);
  await sleep(700);
  const m = await cdp.evalJs(`(() => { const tb = document.getElementById('tabbar'); const r = tb.getBoundingClientRect();
    const app = document.getElementById('app').getBoundingClientRect();
    return { dir: getComputedStyle(tb).flexDirection, top: Math.round(r.top), vh: window.innerHeight,
             appW: Math.round(app.width), fabX: Math.round(document.getElementById('fabWrite').getBoundingClientRect().left),
             fits: r.bottom <= window.innerHeight + 1 && r.height >= 44 }; })()`);
  check('手机档：导航在屏幕下方', m.dir === 'row' && m.top > m.vh * 0.8, `top=${m.top}/${m.vh}`);
  check('手机档：铺满屏宽', m.appW === 390, `${m.appW}px`);
  check('手机档：悬浮球在右下', m.fabX > 300, `left=${m.fabX}`);
  check('手机档：导航整体可见未被裁切', m.fits);

  await cdp.viewport(768, 900, false);
  await sleep(700);
  const t = await cdp.evalJs(`(() => { const app = document.getElementById('app').getBoundingClientRect();
    return { w: Math.round(app.width), left: Math.round(app.left),
             dir: getComputedStyle(document.getElementById('tabbar')).flexDirection,
             tiles: getComputedStyle(document.getElementById('deskTiles')).gridTemplateColumns.split(' ').length }; })()`);
  check('平板档：内容收成居中一列（≤600px）', t.w <= 600 && t.left > 60, `宽 ${t.w} 左偏移 ${t.left}`);
  check('平板档：仍是底部标签栏', t.dir === 'row');
  check('平板档：磁贴 3 列', t.tiles === 3);

  await cdp.viewport(1280, 900, false);
  await sleep(800);
  const d = await cdp.evalJs(`(() => { const tb = document.getElementById('tabbar'); const r = tb.getBoundingClientRect();
    const body = document.querySelector('.desk-body');
    return { dir: getComputedStyle(tb).flexDirection, w: Math.round(r.width), left: Math.round(r.left),
             height: Math.round(r.height), vh: window.innerHeight,
             panePadLeft: getComputedStyle(document.getElementById('screen-home')).paddingLeft,
             bodyCols: body ? getComputedStyle(body).gridTemplateColumns.split(' ').length : 0,
             fabX: Math.round(document.getElementById('fabWrite').getBoundingClientRect().left),
             brand: getComputedStyle(document.querySelector('#tabbar .brand')).display !== 'none' }; })()`);
  check('桌面档：导航变左侧栏', d.dir === 'column' && d.w === 84 && d.left === 0, `方向=${d.dir} 宽=${d.w} 左=${d.left}`);
  check('桌面档：左侧栏撑满高度', d.height >= d.vh - 1, `${d.height}/${d.vh}`);
  check('桌面档：左侧栏显示品牌标', d.brand);
  check('桌面档：内容区让出 84px', d.panePadLeft === '84px', d.panePadLeft);
  check('桌面档：桌面改为「磁贴 + 最近记录」两栏', d.bodyCols === 2, `${d.bodyCols} 列`);
  check('桌面档：悬浮球移入左侧栏', d.fabX < 90, `left=${d.fabX}`);
  await cdp.shot('19-desktop-1280.png');
  await cdp.clickSel('#tabbar .tab[data-tab="timeline"]');
  await sleep(700);
  const tlW = await cdp.evalJs(`Math.round(document.querySelector('#screen-timeline .timeline').getBoundingClientRect().width)`);
  check('桌面档：时间线收成阅读列（≤720px）', tlW <= 720 && tlW > 400, `${tlW}px`);
  await cdp.shot('20-timeline-1280.png');
  await cdp.clickSel('#tabbar .tab[data-tab="gallery"]');
  await sleep(700);
  const dg = await cdp.evalJs(`getComputedStyle(document.querySelector('.gal-grid')).gridTemplateColumns.split(' ').length`);
  check('桌面档：相册 6 列', dg === 6, `${dg} 列`);

  console.log('\n[19] 控制台异常');
  const errs = cdp.pageErrors();
  check('无未捕获 JS 异常 / 控制台错误', errs.length === 0, errs.slice(0, 3).join(' | '));

  // ★ 用例全程不应该产生"浏览器下载"。真产生了，说明某次点击误点到了桌面「备份」磁贴，
  //   而网页版导出是 <a download> + Blob —— 无头 Chrome 默认就写到系统「下载」文件夹，
  //   等于把测试数据丢进用户机器（真实踩过：Downloads 里出现 my-diary-backup-*.json）。
  const dls = cdp.events.filter((e) => e.method === 'Page.downloadWillBegin');
  check('全程没有触发文件下载（不会往用户下载目录丢备份文件）', dls.length === 0,
    dls.map((d) => d.params.suggestedFilename).join(' | '));

  console.log(`\n===== 结果：${pass} 通过 / ${fail} 失败 =====`);
} catch (e) {
  console.error('\n[脚本错误]', e.message);
  fail++;
} finally {
  try { chrome.kill(); } catch (e) {}
  await sleep(500);
  try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (e) {}
}
process.exit(fail ? 1 : 0);
