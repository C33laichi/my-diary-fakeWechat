/**
 * 原生外壳（Capacitor）分支验证。
 *
 * 手机装包后才能跑到的代码，这里用「注入假 Capacitor」的方式在桌面 Chrome 里验证：
 * 页面加载前先塞进一个 window.Capacitor，记录所有插件调用，
 * 于是返回键接管、原生导出、状态栏同步三条分支全部可断言 ——
 * 不用真机、不用模拟器、不用 gradle 构建。
 *
 * 产品代码一行都不为测试让步：注入的假对象走的就是真实的插件调用协议
 * （window.Capacitor.Plugins.<Name>.<method>()，函数由原生侧 JSExport 生成）。
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';

const CHROME = 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const BASE = 'http://127.0.0.1:7788/';
const PORT = 9336;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let pass = 0, fail = 0;
const check = (n, ok, extra = '') => { ok ? pass++ : fail++; console.log(`  ${ok ? '✓' : '✗'} ${n}${extra ? '  ' + extra : ''}`); };

/* ---------- 极简 PNG 生成（零依赖，用来造一张可入库的测试图） ---------- */
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

/* ---------- 注入的假原生桥 ---------- */
const FAKE_BRIDGE = `
window.__nativeCalls = [];
(function () {
  var rec = function (plugin, method, args) {
    window.__nativeCalls.push({ plugin: plugin, method: method, args: args });
  };
  var listeners = {};
  var Plugins = {
    App: {
      addListener: function (ev, cb) {
        (listeners[ev] = listeners[ev] || []).push(cb);
        rec('App', 'addListener', [ev]);
        return { remove: function () {} };
      },
      exitApp: function () { rec('App', 'exitApp', []); return Promise.resolve(); }
    },
    Filesystem: {
      writeFile: function (o) {
        rec('Filesystem', 'writeFile', [o]);
        return Promise.resolve({ uri: 'file:///data/user/0/com.chenchang.diary/cache/' + o.path });
      }
    },
    Share: {
      share: function (o) { rec('Share', 'share', [o]); return Promise.resolve({ activityType: '' }); }
    },
    StatusBar: {
      setStyle: function (o) { rec('StatusBar', 'setStyle', [o]); return Promise.resolve(); },
      setBackgroundColor: function (o) { rec('StatusBar', 'setBackgroundColor', [o]); return Promise.resolve(); }
    }
  };
  window.Capacitor = {
    Plugins: Plugins,
    getServerUrl: function () { return 'https://localhost'; },
    isNativePlatform: function () { return true; },
    getPlatform: function () { return 'android'; },
    isPluginAvailable: function (n) { return Object.prototype.hasOwnProperty.call(Plugins, n); }
  };
  window.__fireBack = function () {
    (listeners.backButton || []).forEach(function (cb) { cb({ canGoBack: false }); });
  };
  window.__backListenerCount = function () { return (listeners.backButton || []).length; };
})();
`;

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'diary-native-'));
const img = path.join(tmp, 'p.png');
makePng(800, 600, img);

const chrome = spawn(CHROME, [
  '--headless=new', `--remote-debugging-port=${PORT}`, `--user-data-dir=${tmp}`,
  '--no-first-run', '--no-default-browser-check', '--disable-gpu', '--hide-scrollbars', 'about:blank'
], { stdio: 'ignore' });

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
    setTimeout(() => { if (waiting.has(i)) { waiting.delete(i); rej(new Error('timeout ' + method)); } }, 20000);
  });
  const ev = async (expr) => {
    const r = await send('Runtime.evaluate', { expression: `(async()=>{return (${expr});})()`, awaitPromise: true, returnByValue: true });
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text);
    return r.result.value;
  };
  /**
   * 点击并**校验真的点到了目标**。
   * 不校验的话，"点了个已经隐藏的元素"会静默落到它下面的东西上 —— 桌面「备份」磁贴
   * 就在视口中心 (195,422)，封面淡出期间点封面会穿到它身上，触发一次真实导出。
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
  /** 点封面提前进入；封面若已自动进入（正在淡出、不可点）就什么都不做，避免穿到下面的磁贴 */
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
  const longPress = async (sel, ms) => {
    const b = await ev(`(()=>{const e=document.querySelector('${sel}');if(!e)return null;
      const r=e.getBoundingClientRect();return {x:r.left+24,y:r.top+r.height/2};})()`);
    if (!b) throw new Error('找不到 ' + sel);
    await send('Input.dispatchMouseEvent', { type: 'mousePressed', x: b.x, y: b.y, button: 'left', clickCount: 1, buttons: 1 });
    await sleep(ms);
    await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: b.x, y: b.y, button: 'left', clickCount: 1, buttons: 0 });
  };
  const callCount = (plugin, method) => ev(
    `window.__nativeCalls.filter(c => c.plugin === '${plugin}' && c.method === '${method}').length`);
  const lastCall = (plugin, method) => ev(
    `(window.__nativeCalls.filter(c => c.plugin === '${plugin}' && c.method === '${method}').pop() || {}).args`);

  await send('Runtime.enable'); await send('Log.enable'); await send('Page.enable'); await send('DOM.enable');
  await send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 2, mobile: true });
  // ★ 把下载目录钉到临时目录：无头 Chrome 默认就往系统「下载」文件夹写，
  //   万一误触发了网页版导出路径，就会把测试数据丢进用户真实的下载目录（踩过）。
  const dlDir = path.join(tmp, 'downloads');
  fs.mkdirSync(dlDir, { recursive: true });
  await send('Browser.setDownloadBehavior', { behavior: 'allow', downloadPath: dlDir, eventsEnabled: true });

  console.log('\n[A] 注入假原生桥后加载');
  await send('Page.addScriptToEvaluateOnNewDocument', { source: FAKE_BRIDGE });
  // 封面停住不动：它自动进入时会先铺满屏幕淡出 450ms 且不可点，这段时间点它会穿到桌面磁贴上
  await send('Page.addScriptToEvaluateOnNewDocument', { source: 'window.__diaryNoAutoCover = true;' });
  await send('Page.navigate', { url: BASE + '?t=' + Date.now() });
  await sleep(1900);

  const det = await ev(`(() => { const N = window.__diary__.Native;
    return { isNative: N.isNative, platform: N.platform,
             appReady: N.plugin('App') !== null, fsReady: N.plugin('Filesystem') !== null,
             shareReady: N.plugin('Share') !== null, sbReady: N.plugin('StatusBar') !== null,
             listeners: window.__backListenerCount() }; })()`);
  check('识别为原生环境', det.isNative === true);
  check('平台为 android', det.platform === 'android', det.platform);
  check('四个原生插件全部就绪', det.appReady && det.fsReady && det.shareReady && det.sbReady);
  check('已注册系统返回键监听', det.listeners === 1, `${det.listeners} 个`);

  console.log('\n[B] 系统返回键：分层消费');
  // 封面现在是"停一下就自动进入"，没有进入按钮，点封面提前进入
  await enterByCover();
  await sleep(900);
  const exit0 = await callCount('App', 'exitApp');
  await ev(`window.__fireBack()`);
  await sleep(300);
  check('主桌面按返回 → 交还系统（退出 App）',
    await callCount('App', 'exitApp') === exit0 + 1, `exitApp ${exit0} → ${await callCount('App', 'exitApp')}`);

  await click('#fabWrite');
  await sleep(700);
  await ev(`window.__fireBack()`);
  await sleep(500);
  check('发布页按返回 → 收起发布页，不退出',
    !await ev(`document.getElementById('screen-composer').classList.contains('active')`)
    && await ev(`document.getElementById('screen-home').classList.contains('active')`)
    && await callCount('App', 'exitApp') === exit0 + 1);

  await click('#deskTiles .tile[data-go="search"]');
  await sleep(700);
  await ev(`window.__fireBack()`);
  await sleep(500);
  check('搜索页按返回 → 收起搜索页，不退出',
    !await ev(`document.getElementById('screen-search').classList.contains('active')`)
    && await callCount('App', 'exitApp') === exit0 + 1);

  await click('#deskTiles .tile[data-go="stats"]');
  await sleep(700);
  await ev(`window.__fireBack()`);
  await sleep(500);
  check('统计页按返回 → 收起统计页，不退出',
    !await ev(`document.getElementById('screen-stats').classList.contains('active')`)
    && await callCount('App', 'exitApp') === exit0 + 1);

  console.log('\n[C] 系统返回键：弹层与查看器优先');
  await click('#fabWrite');
  await sleep(600);
  await ev(`document.getElementById('composerText').focus()`);
  await send('Input.insertText', { text: '原生返回键验证：这条日记带一张图。' });
  await sleep(200);
  const doc = await send('DOM.getDocument');
  const node = await send('DOM.querySelector', { nodeId: doc.root.nodeId, selector: '#filePicker' });
  await send('DOM.setFileInputFiles', { nodeId: node.nodeId, files: [img] });
  await sleep(1800);
  await click('#btnPublish');
  await sleep(1800);
  check('已发表一条带图日记', await ev(`document.querySelectorAll('#timeline .post').length`) === 1);

  await click('#tabbar .tab[data-tab="timeline"]');
  await sleep(600);
  await click('#timeline .pgrid .ph');
  await sleep(700);
  check('大图查看器已打开', await ev(`document.getElementById('viewer').classList.contains('show')`));
  await ev(`window.__fireBack()`);
  await sleep(500);
  check('查看器按返回 → 先关查看器，不退出',
    !await ev(`document.getElementById('viewer').classList.contains('show')`)
    && await callCount('App', 'exitApp') === exit0 + 1);

  await longPress('#timeline .post .post-text', 700);
  await sleep(600);
  check('长按弹出操作面板', await ev(`document.getElementById('mask').classList.contains('show')`));
  await ev(`window.__fireBack()`);
  await sleep(600);
  check('操作面板按返回 → 先关面板，不退出',
    !await ev(`document.getElementById('mask').classList.contains('show')`)
    && await callCount('App', 'exitApp') === exit0 + 1);

  console.log('\n[D] 系统返回键：锁屏不可绕过');
  await ev(`window.__diary__.showLock('verify')`);
  await sleep(500);
  await ev(`window.__fireBack()`);
  await sleep(500);
  check('锁屏时按返回 → 被吞掉，不退出且锁屏仍在',
    await ev(`document.getElementById('screen-lock').classList.contains('show')`)
    && await callCount('App', 'exitApp') === exit0 + 1);
  await ev(`window.__diary__.hideLock()`);
  await sleep(300);

  console.log('\n[E] 导出备份：先选格式（默认 JSON）→ 确认 → 改写原生文件 + 系统分享');
  await ev(`window.__nativeCalls = []`);
  await click('#tabbar .tab[data-tab="mine"]');
  await sleep(700);
  await click('#setExport');
  await sleep(500);
  // ★ 导出是「先选格式（默认 JSON）→ 再确认」两步：磁贴就在屏幕正中央，
  //   一点就写文件很容易误触，两步都在给用户反悔的机会
  const firstItem = await ev(`document.querySelector('#actionSheet .sheet-item').textContent`);
  check('点导出先弹格式面板（不直接写文件）',
    await ev(`document.getElementById('mask').classList.contains('show')`)
    && await ev(`document.getElementById('actionSheet').style.display !== 'none'`));
  check('JSON 排第一且被标为推荐（默认口径可见）',
    firstItem.indexOf('JSON') === 0 && /推荐/.test(firstItem), firstItem);
  check('选格式前还没写任何文件', await callCount('Filesystem', 'writeFile') === 0);
  // 选 JSON → 进入二次确认框
  await click('#actionSheet .sheet-item[data-i="0"]');
  await sleep(500);
  check('选 JSON 后弹确认框',
    await ev(`document.getElementById('dialog').style.display !== 'none'`));
  check('确认框里报明了条目数',
    /\d+\s*篇日记/.test(await ev(`document.getElementById('dialogText').textContent`)),
    (await ev(`document.getElementById('dialogText').textContent`)).replace(/\n/g, ' '));
  check('确认前还没有写任何文件', await callCount('Filesystem', 'writeFile') === 0);
  // 点「导出」确认
  await click('#dialogBtns button.primary');
  await sleep(2200);
  check('调用了 Filesystem.writeFile', await callCount('Filesystem', 'writeFile') === 1);
  check('调用了 Share.share', await callCount('Share', 'share') === 1);
  const wf = await lastCall('Filesystem', 'writeFile');
  const sh = await lastCall('Share', 'share');
  check('写入 App 缓存目录', wf && wf[0] && wf[0].directory === 'CACHE', wf && wf[0] && wf[0].directory);
  // ★★ 这一组就是那个真实事故的护栏。
  //    Capacitor 8 的 Encoding 枚举**只剩 utf8 / ascii / utf16**，`base64` 已被移除。
  //    以前这里传 `encoding:'base64'` + base64 数据，插件不认这个值，
  //    就把 base64 字符串**原样按文本写盘** —— 用户拿到的 .json 里全是 base64，
  //    任何解析器都读不出来，看起来"根本不是我的日记"。
  check('编码参数是 utf8（不能是已移除的 base64）', wf && wf[0] && wf[0].encoding === 'utf8',
    wf && wf[0] && String(wf[0].encoding));
  check('写盘内容是明文 JSON，不是 base64', wf && /^\s*\{/.test(wf[0].data),
    wf ? JSON.stringify(String(wf[0].data).slice(0, 24)) : '');
  check('文件名是 .json', wf && /\.json$/.test(wf[0].path), wf && wf[0].path);
  check('分享的是文件 URI', sh && typeof sh[0].url === 'string' && sh[0].url.startsWith('file://'), sh && sh[0].url);
  // 直接解析「写进文件的那段文本」—— 用户把这个文件交给任何 JSON 解析器都应当立刻读得懂
  const decoded = await ev(`(() => { try {
      var o = JSON.parse(${JSON.stringify(wf[0].data)});
      return { app: o.app, schema: o.schema, n: o.entryCount, ok: true };
    } catch (e) { return { ok: false, msg: String(e) }; } })()`);
  check('写盘文本本身就是合法备份 JSON（原样可解析）',
    decoded.ok && decoded.app === 'wechat-diary' && decoded.schema === 1,
    decoded.ok ? `app=${decoded.app} schema=${decoded.schema} 篇数=${decoded.n}` : decoded.msg);
  check('中文原样写入，无乱码',
    await ev(`(${JSON.stringify(wf[0].data)}).indexOf('原生返回键验证') >= 0`));
  check('写盘文本不是 base64（首字符是 { 而不是 e/B 之类）',
    await ev(`/^[A-Za-z0-9+/]/.test(${JSON.stringify(String(wf[0].data).slice(0, 8))}) === false`));

  console.log('\n[F] 状态栏跟随主题');
  await ev(`window.__nativeCalls = []`);
  await ev(`window.__diary__.applyTheme('dark')`);
  await sleep(400);
  const sbDark = await lastCall('StatusBar', 'setStyle');
  const bgDark = await lastCall('StatusBar', 'setBackgroundColor');
  check('深色模式 → 状态栏用浅色图标（Style DARK）', sbDark && sbDark[0].style === 'DARK', sbDark && sbDark[0].style);
  check('深色模式 → 状态栏底色 #0F0F0F', bgDark && bgDark[0].color === '#0F0F0F', bgDark && bgDark[0].color);
  await ev(`window.__nativeCalls = []`);
  await ev(`window.__diary__.applyTheme('light')`);
  await sleep(400);
  const sbLight = await lastCall('StatusBar', 'setStyle');
  check('浅色模式 → 状态栏用深色图标（Style LIGHT）', sbLight && sbLight[0].style === 'LIGHT', sbLight && sbLight[0].style);
  check('主题切换不产生重复的返回键监听', await ev(`window.__backListenerCount()`) === 1);

  console.log('\n[G] 控制台异常');
  const errs = events.filter((e) => e.method === 'Runtime.exceptionThrown')
    .map((e) => e.params.exceptionDetails.exception?.description || e.params.exceptionDetails.text);
  check('无未捕获 JS 异常', errs.length === 0, errs.slice(0, 2).join(' | '));

  // ★ App 内导出必须走原生写文件 + 系统分享；一旦出现"浏览器下载事件"，
  //   说明误走了网页版 <a download> 路径，会把文件丢进用户的下载目录。
  const dls = events.filter((e) => e.method === 'Page.downloadWillBegin');
  check('导出全程走原生通道，没有触发浏览器下载', dls.length === 0,
    dls.map((d) => d.params.suggestedFilename).join(' | '));

  console.log(`\n===== 原生外壳结果：${pass} 通过 / ${fail} 失败 =====`);
} catch (e) {
  console.error('[脚本错误]', e.message); fail++;
} finally {
  try { chrome.kill(); } catch (e) {}
  await sleep(400);
  try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (e) {}
}
process.exit(fail ? 1 : 0);
