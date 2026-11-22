/**
 * 生成 README 用的效果图（docs/screenshots/*）。
 *
 * 为什么单独一个脚本：
 *   README 里的图是"给外人看的门面"，需要**真实感**的数据（跨多个月、有图有文），
 *   而 _verify/shots 里的回归截图是测试数据（"筛选测试 2026/9 #2"），不能见人。
 *   以前这批图是手工截的，发过几个版本就停在旧界面上了 —— README 里还挂着 10 月初
 *   的样子（没有年月日筛选条、查看器没有 0.25x 缩小）。这个脚本把"取图"变成可重跑的一步。
 *
 * 做法：
 *   起一个本地静态服务 + 系统 Chrome（CDP，零 npm 依赖，和 e2e 同一套思路），
 *   通过 window.__diary__ 暴露的 Store 直接写入 12 篇示例日记（含渐变占位照片），
 *   刷新页面后按屏幕状态逐张截图，再用页面里的 canvas 缩到 README 用的尺寸。
 *
 * 用法：node _verify/docs_shots.mjs
 *   （需要系统 Chrome；跑在受限沙箱里时 Chrome 起不来，见 README 的说明）
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..');
const OUT = path.join(ROOT, 'docs', 'screenshots');
const CHROME = process.env.CHROME || 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const PORT = 7791;
const DEBUG = 9336;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* ---------- 静态服务 ---------- */
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.png': 'image/png', '.jpg': 'image/jpeg' };
const server = http.createServer((req, res) => {
  let p = decodeURIComponent(req.url.split('?')[0]);
  if (p === '/') p = '/index.html';
  fs.readFile(path.join(ROOT, p), (err, buf) => {
    if (err) { res.writeHead(404); res.end('not found'); return; }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(p)] || 'application/octet-stream', 'Cache-Control': 'no-store' });
    res.end(buf);
  });
});

/* ---------- CDP 客户端（与 e2e 同款，最小实现） ---------- */
class CDP {
  constructor(ws) { this.ws = ws; this.id = 0; this.waiting = new Map(); }
  static async connect(url) {
    const ws = new WebSocket(url);
    await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
    const c = new CDP(ws);
    ws.onmessage = (ev) => {
      const msg = JSON.parse(ev.data);
      if (msg.id && c.waiting.has(msg.id)) {
        const { res, rej } = c.waiting.get(msg.id);
        c.waiting.delete(msg.id);
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
      setTimeout(() => { if (this.waiting.has(id)) { this.waiting.delete(id); rej(new Error('timeout ' + method)); } }, 30000);
    });
  }
  evalJs(expr) {
    return this.send('Runtime.evaluate', {
      expression: `(async () => { return (${expr}); })()`,
      awaitPromise: true, returnByValue: true
    }).then((r) => {
      if (r.exceptionDetails) throw new Error('页面异常: ' + (r.exceptionDetails.exception?.description || r.exceptionDetails.text));
      return r.result.value;
    });
  }
  async viewport(width, height, mobile, dsf = 2) {
    await this.send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: dsf, mobile });
    await sleep(450);
  }
  async click(sel) {
    const ok = await this.evalJs(`(() => { const e = document.querySelector(${JSON.stringify(sel)});
      if (!e) return false; e.click(); return true; })()`);
    if (!ok) throw new Error('找不到元素 ' + sel);
  }
  /** 截当前视口 → 缩放到目标尺寸（传 null 表示原尺寸）→ 写文件 */
  async snap(file, targetW, targetH, opts = {}) {
    const fmt = opts.format || 'jpeg';
    const q = opts.quality || 0.82;
    const shot = await this.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
    let b64 = shot.data;
    if (targetW) {
      const type = fmt === 'jpeg' ? 'image/jpeg' : 'image/png';
      b64 = await this.evalJs(`(async () => {
        const img = new Image();
        img.src = 'data:image/png;base64,${shot.data}';
        await img.decode();
        const c = document.createElement('canvas');
        c.width = ${targetW}; c.height = ${targetH};
        const g = c.getContext('2d');
        g.imageSmoothingEnabled = true; g.imageSmoothingQuality = 'high';
        g.drawImage(img, 0, 0, ${targetW}, ${targetH});
        return c.toDataURL(${JSON.stringify(type)}, ${q}).split(',')[1];
      })()`);
    }
    const buf = Buffer.from(b64, 'base64');
    fs.writeFileSync(path.join(OUT, file), buf);
    console.log(`  ✓ ${file}  ${(buf.length / 1024).toFixed(0)} KB`);
  }
}

/* ---------- 启动 ---------- */
fs.mkdirSync(OUT, { recursive: true });
await new Promise((r) => server.listen(PORT, '127.0.0.1', r));
console.log(`静态服务: http://127.0.0.1:${PORT}`);

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'diary-shots-'));
const chrome = spawn(CHROME, [
  '--headless=new', `--remote-debugging-port=${DEBUG}`, `--user-data-dir=${tmp}`,
  '--no-first-run', '--no-default-browser-check', '--disable-gpu', '--hide-scrollbars', 'about:blank'
], { stdio: 'ignore' });

let cdp = null;
try {
  let wsUrl = null;
  for (let i = 0; i < 40; i++) {
    await sleep(300);
    try {
      const list = await (await fetch(`http://127.0.0.1:${DEBUG}/json/list`)).json();
      const t = list.find((x) => x.type === 'page');
      if (t) { wsUrl = t.webSocketDebuggerUrl; break; }
    } catch (e) { /* 还没起来 */ }
  }
  if (!wsUrl) throw new Error('无法连接 Chrome 调试端口（受限沙箱里 Chrome 起不来，需要完全权限）');
  cdp = await CDP.connect(wsUrl);
  await cdp.send('Runtime.enable');
  await cdp.send('Page.enable');

  const base = `http://127.0.0.1:${PORT}/`;
  /** 封面（停一下就自动进）→ 首次启动的「设置密码」直接跳过 */
  const enter = async () => {
    await cdp.send('Page.navigate', { url: base + '?t=' + Date.now() });
    await sleep(3400);
    if (await cdp.evalJs(`document.getElementById('screen-cover').classList.contains('show')`)) {
      await cdp.evalJs(`document.getElementById('screen-cover').click()`);
      await sleep(900);
    }
    if (await cdp.evalJs(`document.getElementById('screen-lock').classList.contains('show')`)) {
      await cdp.evalJs(`(() => { const b = document.getElementById('lockSkip'); if (b) b.click(); return !!b; })()`);
      await sleep(700);
    }
  };

  await cdp.viewport(390, 844, true, 2);
  await enter();

  /** chip 行横向滚动：把选中的那枚露出来（否则最右一枚会被截成半截） */
  const revealChips = (hostSel) => cdp.evalJs(`(() => {
    document.querySelectorAll('${hostSel} .tb-row').forEach(function (row) {
      const on = row.querySelector('.tb-chip.on');
      if (!on) return;
      row.scrollLeft = Math.max(0, on.offsetLeft + on.offsetWidth - row.clientWidth + 14);
    });
    return true; })()`);

  /* ---------- 写入示例数据 ---------- */
  console.log('写入示例数据…');
  await cdp.evalJs(`(async () => {
    const D = window.__diary__;
    const S = D.Store;
    // 清掉可能残留的旧数据（含图片）
    const old = await S.listEntries();
    for (const e of old) await S.deleteEntryCascade(e.id);

    const palettes = [
      ['#7B5EA7', '#B06AB3', '#4568DC'],
      ['#F2994A', '#F2C94C', '#EB5757'],
      ['#2193B0', '#6DD5ED', '#2C5364'],
      ['#8E2DE2', '#4A00E0', '#00C9FF'],
      ['#11998E', '#38EF7D', '#0B7A6B'],
      ['#C33764', '#E96443', '#F2C14E'],
      ['#355C7D', '#6C5B7B', '#C06C84'],
      ['#2C3E50', '#4CA1AF', '#87C7C0']
    ];
    /** 渐变照片：比纯色块更接近"随手拍的图"，也不会有版权问题 */
    const grad = (w, h, p) => new Promise((res) => {
      const cv = document.createElement('canvas');
      cv.width = w; cv.height = h;
      const x = cv.getContext('2d');
      const g = x.createLinearGradient(0, 0, w, h);
      g.addColorStop(0, p[0]); g.addColorStop(0.55, p[1]); g.addColorStop(1, p[2]);
      x.fillStyle = g; x.fillRect(0, 0, w, h);
      const rg = x.createRadialGradient(w * 0.78, h * 0.2, 0, w * 0.78, h * 0.2, w * 0.75);
      rg.addColorStop(0, 'rgba(255,255,255,.32)');
      rg.addColorStop(1, 'rgba(255,255,255,0)');
      x.fillStyle = rg; x.fillRect(0, 0, w, h);
      cv.toBlob(res, 'image/jpeg', 0.86);
    });

    const now = new Date();
    const at = (daysAgo, hh, mm) => {
      const d = new Date(now);
      d.setDate(d.getDate() - daysAgo);
      d.setHours(hh, mm, 0, 0);
      return d.getTime();
    };

    // 越靠前越新：时间线从上往下就按这个顺序
    // 前几篇刻意落在连续的几天里，首页的「连续记录」才不是 1 天
    // 末位字段：配图数；location 单独在下面挑几篇补上（展示 📍 地点行）
    const rows = [
      [0, 9, 12, '早上醒来还有点困，泡了杯咖啡，把今天的待办写在便签上。窗外的天亮得很慢。', 1],
      [1, 21, 14, '晚上整理书架，翻到三年前买的《夜航西飞》。扉页上还留着一行小字：慢一点也没关系。窗外起风了，泡了杯热茶，把最后两章重读了一遍。', 1],
      [2, 8, 30, '早起去河边走了四十分钟，雾还没散。柳树的影子被拉得很长，水面上浮着一层很薄的光。', 2],
      [4, 19, 45, '把阳台的薄荷修了一遍，顺手擦干净了玻璃。晚饭是番茄牛腩，炖得有点久，但味道刚刚好。', 3],
      [7, 12, 10, '午休时在楼下拍了几张银杏，黄得很彻底。风一吹就落一片，捡了两片夹进书里。', 9],
      [9, 22, 5, '今天终于把拖了很久的方案写完了。中间推翻重来了两次：第一版太贪心，什么都想塞进去；第二版又太保守，读起来像一份说明书。第三版删掉了一半的段落，只留下真正想说的那几句话，反而顺了。\\n\\n写长文和过日子有点像：不是把所有事情都安排进去才叫充实，能删掉的才是自己的。晚上十点关掉电脑，下楼买了个烤红薯，站在路边吃完才回家。', 0],
      [12, 7, 20, '假前的最后一天班，地铁里几乎没人。买了杯豆浆，坐在工位上把待办一条条划掉，像给自己发了一串小红花。', 1],
      [15, 16, 40, '周末去看了场展，出口处的光很好，站了一会儿。回来的路上买了束小雏菊，插在玻璃瓶里，房间一下子亮了一点。', 4],
      [18, 10, 5, '傍晚下了场雨，关窗的时候闻到泥土味。今年的第一场秋雨，比往年来得早一些。', 1],
      [21, 23, 10, '失眠。把窗帘拉开一条缝，路灯把天花板照出一块暖黄。想着明天要早起，反而更清醒了，最后爬起来看了二十页书。', 0],
      [24, 20, 15, '楼下的桂花开了，一路走过去都是甜的。买了杯冰美式，坐在小区长椅上发了会儿呆，什么也没想。', 2],
      [27, 9, 30, '把夏天的衣服收进箱子，翻出来一件去年很喜欢的衬衫。时间过得比想象中快。', 1],
      [34, 21, 40, '开始记日记的第一天。希望这次能坚持久一点：不用写得多好，把当天最想记住的一件小事写下来就够了。', 0]
    ];

    // 再补一批更早的短记，让热力图 / 月度柱状图 / 写作时段有东西可画（不然统计页空得可怜）
    const fillerDays = [30, 33, 37, 41, 45, 50, 54, 58, 62, 66, 71, 76, 80, 85, 90, 96, 102, 108, 115, 121, 128, 135, 143, 151, 160, 169, 178, 188, 199, 210];
    const fillerTexts = [
      '加班到九点，下楼时雨刚停，路面反着光。',
      '把冰箱清了一遍，扔掉两颗发芽的土豆。',
      '和朋友通了四十分钟电话，聊到上学时候的事。',
      '路边的猫今天肯让我摸了，尾巴绕了绕。',
      '煮了锅粥，配一碟咸菜，意外的舒服。',
      '看了半部电影就睡着了，醒来字幕还在滚。',
      '把阳台的花搬进来，怕夜里降温。',
      '买了新的笔记本，第一页空着，舍不得写。',
      '中午没睡，下午在工位上发困，靠一杯茶撑过去。',
      '把旧照片翻出来看，很多地方已经记不清了。',
      '学会了新的做法，煎蛋终于不粘锅。',
      '把欠的邮件一封封回完，心里踏实了不少。',
      '散步时听到有人在练琴，站着听完了整首。',
      '换了新的枕套，睡得很沉，一夜没醒。',
      '整理抽屉，找到一张很旧的车票，留着当书签。'
    ];
    // 一篇稍长的，给热力图一个深色格子
    const longOne = '翻出去年写的计划本，一页页看下来，发现真正做到的只有三件事：早起、读完十二本书、把厨房收拾干净。其余的计划像被风刮走了一样，连当时为什么写下它们都记不清了。\\n\\n倒也不觉得失败。计划本的作用可能不是逼着自己完成，而是让人在写下的那一刻，认真想过接下来要过什么样的日子。晚上把它合上，放回书架的同一个位置，明年再打开。';

    fillerDays.forEach(function (daysAgo, i) {
      if (i === 9) { rows.push([daysAgo, 22, 20, longOne, 0]); return; }
      rows.push([daysAgo, 8 + (i * 3) % 13, (i * 7) % 60, fillerTexts[i % fillerTexts.length], i % 6 === 2 ? 1 : 0]);
    });

    // 挑前几篇带上地点，时间线昵称行右侧会出现 📍 地点
    const locs = ['湖南省长沙市芙蓉区文艺路街道', '湖南省长沙市岳麓区橘子洲', '湖南省长沙市天心区湘江中路', '', ''];
    for (let i = 0; i < rows.length; i++) {
      const [daysAgo, hh, mm, text, n] = rows[i];
      const id = 'demo-' + i;
      const p = palettes[i % palettes.length];
      const imgs = [];
      for (let k = 0; k < n; k++) {
        const pid = id + '-p' + k;
        const portrait = n === 1 && k === 1;
        const w = portrait ? 900 : 1200;
        const h = portrait ? 1200 : 900;
        const blob = await grad(w, h, palettes[(i + k) % palettes.length] || p);
        await S.putImage({ id: pid, entryId: id, w: w, h: h, size: blob.size, blob: blob });
        imgs.push(pid);
      }
      await S.saveEntry({ id: id, text: text, images: imgs, location: locs[i] || '', createdAt: at(daysAgo, hh, mm), updatedAt: 0 });
    }

    D.Meta.save({ nickname: '我', sign: '把日子写成一行行字，只有自己看得到。' });
    return true;
  })()`);

  // 重新加载，让首页按真实启动流程把数据读进来（封面图 / 单图比例都靠这一步）
  await enter();

  /* ---------- 截图 ---------- */
  const T = {
    phone: [300, 649],
    landscape: [480, 222]
  };

  console.log('截图：');

  // 1) 时间线：选中最新的月份 → 月份行 + 日期行同时出现（本版重点）
  await cdp.evalJs(`window.__diary__.switchTab('timeline')`);
  await sleep(600);
  await cdp.evalJs(`(() => {
    const b = [...document.querySelectorAll('#tlTimebar .tb-chip[data-tb="m"]')]
      .filter(function (x) { return x.getAttribute('data-v'); }).pop();
    if (b) b.click(); return !!b; })()`);
  await sleep(700);
  await revealChips('#tlTimebar');
  await cdp.evalJs(`(() => { const s = document.querySelector('#screen-timeline .scroll'); if (s) s.scrollTop = 0; return true; })()`);
  await sleep(800);
  await cdp.snap('timeline.jpg', T.phone[0], T.phone[1]);

  // 1b) 带地点的时间线：昵称行右侧出现 📍 地点（前几篇示例数据已带 location）
  await cdp.evalJs(`(() => { const s = document.querySelector('#screen-timeline .scroll'); if (s) s.scrollTop = 0; return true; })()`);
  await sleep(600);
  await cdp.snap('location-timeline.jpg', T.phone[0], T.phone[1]);

  // 2) 相册：同样选中最新月份
  await cdp.evalJs(`window.__diary__.switchTab('gallery')`);
  await sleep(650);
  await cdp.evalJs(`(() => {
    const b = [...document.querySelectorAll('#galTimebar .tb-chip[data-tb="m"]')]
      .filter(function (x) { return x.getAttribute('data-v'); }).pop();
    if (b) b.click(); return !!b; })()`);
  await sleep(800);
  await revealChips('#galTimebar');
  await cdp.snap('gallery.jpg', T.phone[0], T.phone[1]);

  // 3) 九宫格：回到时间线、放开筛选，把九图那篇滚到导航栏下方
  await cdp.evalJs(`window.__diary__.switchTab('timeline')`);
  await sleep(500);
  await cdp.evalJs(`(() => {
    const b = document.querySelector('#tlTimebar .tb-chip[data-tb="m"][data-v=""]');
    if (b) b.click(); return !!b; })()`);
  await sleep(600);
  await cdp.evalJs(`(() => {
    const sc = document.querySelector('#screen-timeline .scroll');
    const post = [...document.querySelectorAll('#timeline .post')]
      .find(function (p) { return p.querySelectorAll('.pgrid a').length === 9; });
    if (!post) return false;
    sc.scrollTop += post.getBoundingClientRect().top - 64;
    return true; })()`);
  await sleep(900);
  await cdp.snap('nine-grid.jpg', T.phone[0], T.phone[1]);

  // 4) 长文折叠：把带「更多」那篇滚到导航栏下方
  await cdp.evalJs(`(() => {
    const sc = document.querySelector('#screen-timeline .scroll');
    const post = [...document.querySelectorAll('#timeline .post')]
      .find(function (p) { return p.querySelector('.post-moretext'); });
    if (!post) return false;
    sc.scrollTop += post.getBoundingClientRect().top - 64;
    return true; })()`);
  await sleep(700);
  await cdp.snap('fold-more.jpg', T.phone[0], T.phone[1]);

  // 5) 大图查看器：点开九图那篇的第一张
  await cdp.evalJs(`(() => {
    const post = [...document.querySelectorAll('#timeline .post')]
      .find(function (p) { return p.querySelectorAll('.pgrid a').length === 9; });
    if (!post) return false;
    post.querySelector('.pgrid a').click();
    return true; })()`);
  await sleep(900);
  await cdp.snap('photo-viewer.jpg', T.phone[0], T.phone[1]);
  await cdp.click('#viewerClose');
  await sleep(500);

  // 6) 统计：首页磁贴进入（手机档也有这排磁贴）
  await cdp.evalJs(`window.__diary__.switchTab('home')`);
  await sleep(500);
  await cdp.click('[data-go="stats"]');
  await sleep(900);
  await cdp.evalJs(`(() => { const s = document.querySelector('#screen-stats .scroll'); if (s) s.scrollTop = 0; return true; })()`);
  await sleep(500);
  await cdp.snap('stats-heatmap.png', T.phone[0], T.phone[1], { format: 'png' });

  // 7) 节奏：滚到「节奏」那一段（月度字数 / 近 6 月走势 / 写作时段）
  await cdp.evalJs(`(() => {
    const sc = document.querySelector('#screen-stats .scroll');
    const sec = [...document.querySelectorAll('#statInner .stat-sec')]
      .find(function (s) { return /节奏/.test(s.textContent.slice(0, 60)); });
    if (!sec) return false;
    sc.scrollTop += sec.getBoundingClientRect().top - 56;
    return true; })()`);
  await sleep(600);
  await cdp.snap('stats-rhythm.png', T.phone[0], T.phone[1], { format: 'png' });
  await cdp.click('#btnStatsBack');
  await sleep(500);

  // 8) 深色：时间线（选中最新的月份，筛选条在深色下也要看得清）
  await cdp.evalJs(`(() => { const D = window.__diary__; D.Meta.save({ theme: 'dark' }); D.applyTheme('dark'); return true; })()`);
  await cdp.evalJs(`window.__diary__.switchTab('timeline')`);
  await sleep(600);
  await cdp.evalJs(`(() => {
    const b = [...document.querySelectorAll('#tlTimebar .tb-chip[data-tb="m"]')]
      .filter(function (x) { return x.getAttribute('data-v'); }).pop();
    if (b) b.click(); return !!b; })()`);
  await sleep(700);
  await revealChips('#tlTimebar');
  await cdp.evalJs(`(() => { const s = document.querySelector('#screen-timeline .scroll'); if (s) s.scrollTop = 0; return true; })()`);
  await sleep(700);
  await cdp.snap('dark-mode.jpg', T.phone[0], T.phone[1]);

  // 9) 设置页（深色）。拍之前先收起右下角的悬浮球，免得它压住「导出备份」那一行
  await cdp.evalJs(`window.__diary__.switchTab('mine')`);
  await sleep(700);
  await cdp.evalJs(`(() => { const f = document.getElementById('fabWrite'); if (f) f.style.display = 'none'; return true; })()`);
  await cdp.snap('settings-dark.png', T.phone[0], T.phone[1], { format: 'png' });
  await cdp.evalJs(`(() => { const f = document.getElementById('fabWrite'); if (f) f.style.display = ''; return true; })()`);

  // 10) 横屏：手机横屏单独适配
  await cdp.evalJs(`(() => { const D = window.__diary__; D.Meta.save({ theme: 'light' }); D.applyTheme('light'); return true; })()`);
  await cdp.viewport(844, 390, true, 2);
  await cdp.evalJs(`window.__diary__.switchTab('timeline')`);
  await sleep(700);
  await cdp.evalJs(`(() => {
    const sc = document.querySelector('#screen-timeline .scroll');
    const me = document.querySelector('#screen-timeline .me');
    if (!sc || !me) return false;
    sc.scrollTop = me.offsetTop - 56;   // 让个人资料卡贴着导航栏，下面正好露出筛选条和第一条
    return true; })()`);
  await sleep(700);
  await cdp.snap('landscape.png', T.landscape[0], T.landscape[1], { format: 'png' });

  // 11) 桌面：1280×900 的磁贴首页（原尺寸 PNG）
  await cdp.viewport(1280, 900, false, 1);
  await cdp.evalJs(`window.__diary__.switchTab('home')`);
  await sleep(800);
  await cdp.snap('desktop-1280.png', null, null, { format: 'png' });

  // 12) 启动封面：自定义背景图（独立于首页封面），保留遮罩与标题层
  await cdp.viewport(390, 844, true, 2);
  await cdp.evalJs(`(async () => {
    const D = window.__diary__;
    const cv = document.createElement('canvas');
    cv.width = 720; cv.height = 1280;
    const x = cv.getContext('2d');
    const g = x.createLinearGradient(0, 0, 720, 1280);
    g.addColorStop(0, '#2C5364'); g.addColorStop(0.55, '#203A43'); g.addColorStop(1, '#0F2027');
    x.fillStyle = g; x.fillRect(0, 0, 720, 1280);
    const rg = x.createRadialGradient(540, 260, 20, 540, 260, 520);
    rg.addColorStop(0, 'rgba(255,255,255,.28)'); rg.addColorStop(1, 'rgba(255,255,255,0)');
    x.fillStyle = rg; x.fillRect(0, 0, 720, 1280);
    const blob = await new Promise((res) => cv.toBlob(res, 'image/jpeg', 0.86));
    await D.Store.putImage({ id: 'coverbg', entryId: '__profile__', w: 720, h: 1280, size: blob.size, blob: blob });
    D.Meta.save({ coverBgId: 'coverbg', coverHideOverlay: false, coverHideTitle: false });
    return true;
  })()`);
  await cdp.evalJs(`window.__diaryNoAutoCover = true`);
  await cdp.evalJs(`window.__diary__.showCover()`);
  await sleep(900);
  await cdp.snap('cover-custom.jpg', T.phone[0], T.phone[1]);
  await cdp.evalJs(`window.__diaryNoAutoCover = false`);
  await cdp.evalJs(`window.__diary__.enterApp()`);

  console.log('\n完成：docs/screenshots 已更新');
} catch (e) {
  console.error('\n[脚本错误]', e.message);
  process.exitCode = 1;
} finally {
  try { chrome.kill(); } catch (e) { /* ignore */ }
  try { server.close(); } catch (e) { /* ignore */ }
  await sleep(400);
  try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (e) { /* ignore */ }
}
