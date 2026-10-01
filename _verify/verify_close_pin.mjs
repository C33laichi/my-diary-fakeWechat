/**
 * 专项验证：微信式「关闭密码」入口。
 *
 * 背景（真实反馈）：用户设置了密码后想关掉，可无论怎么点都停在「已设置」。
 * 上一轮我给锁屏加了「关闭密码」按钮，但用户仍然觉得"一直要输入密码"——
 * 因为出口藏在锁屏里、且必须先输一次密码才看得到，心理上就是没关掉。
 *
 * 这次改成微信的做法：设置页里直接多一条独立的「关闭密码」行，
 * 点它 → 确认框 → 输一次当前密码 → 密码真的被删掉、状态变「未设置」。
 *
 * 本脚本只跑这一件事，覆盖：
 *   1. 没设密码时「关闭密码」行不出现
 *   2. 设了密码后该行出现、文案正确、是危险色
 *   3. 点它弹确认框，文案明说"密码会一并清除""需要输入一次当前密码"
 *   4. 点取消什么都不变
 *   5. 点「关闭密码」→ 锁屏副标题「验证后关闭密码」+ 有「关闭密码」「取消」两个出口
 *   6. 锁屏点「取消」→ 密码还在、开关还亮
 *   7. 输错密码 → 不关，且停在锁屏
 *   8. 输对密码 → pinHash 被清空、pinEnabled=false、状态「未设置」、开关熄灭、该行消失
 *   9. 刷新后仍然不进锁屏（持久化）
 *  10. 重新设置密码 → 状态回到「已设置」（可逆，没把功能搞死）
 *  11. 改了密码之后再关闭 → 关的必须是新密码
 *  12. 「修改密码」现在也要先验旧密码
 *  13. 普通解锁（进 App 输密码）不会顺手把密码删掉
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const CHROME = 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const BASE = process.env.BASE || 'http://127.0.0.1:7788/';
const PORT = 9411;
const PIN = '135792';
const NEWPIN = '246801';
const OUT = path.resolve('shots');
fs.mkdirSync(OUT, { recursive: true });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let pass = 0, fail = 0;
function check(name, ok, extra = '') {
  if (ok) { pass++; console.log(`  ✓ ${name}${extra ? '  ' + extra : ''}`); }
  else { fail++; console.log(`  ✗ ${name}  ${extra}`); }
}
function section(t) { console.log('\n' + t); }

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
    // 断言点击真的命中目标，避免"点到已隐藏元素静默穿透"（踩过的事故）
    const diag = await this.evalJs(`(() => { const el = document.elementFromPoint(${box.x}, ${box.y});
      if (el && el.closest('${sel}')) return { ok: true };
      return { ok: false, got: el ? (el.tagName + '.' + (el.className || '') + '#' + (el.id || '')) : 'null' }; })()`);
    if (!diag.ok) throw new Error('点击位置被遮挡: ' + sel + ' -> 实际命中 ' + diag.got);
    await this.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: box.x, y: box.y, buttons: 0 });
    await this.clickPoint(box.x, box.y);
  }
  /** 弹层里的按钮按 label 点，比按下标稳（下标会随新增项漂移） */
  async clickDialog(label) {
    const ok = await this.evalJs(`(() => {
      const bs = Array.from(document.querySelectorAll('#dialogBtns button'));
      const b = bs.find(x => x.textContent.trim() === ${JSON.stringify(label)});
      if (!b) return false; b.click(); return true; })()`);
    if (!ok) throw new Error('确认框里找不到按钮「' + label + '」');
    await sleep(320);
  }
  async typePin(pin) {
    for (const k of pin) { await this.clickSel(`.keypad button[data-k="${k}"]`); await sleep(70); }
    await sleep(700);
  }
  meta() { return this.evalJs(`JSON.parse(localStorage.getItem('wd_meta')||'{}')`); }
  pinUI() {
    return this.evalJs(`(() => {
      const sc = document.getElementById('setClosePin');
      return {
        /* 必须看计算样式：.set-row 自带 display:flex，会把 hidden 的 UA 样式压掉，
           hidden=true 但照样子式上显示 —— 这种"假隐藏"只有看 computed 才抓得住 */
        rowHidden: !sc || sc.hidden && getComputedStyle(sc).display === 'none',
        rowText: sc ? sc.textContent.trim() : '',
        rowDanger: sc ? sc.classList.contains('danger') : false,
        state: document.getElementById('pinStateText').textContent.trim(),
        hint: document.getElementById('pinSwitchHint').textContent.trim(),
        swOn: document.getElementById('switchLock').classList.contains('on'),
        rowLabel: document.getElementById('pinRowLabel').textContent.trim()
      }; })()`);
  }
  lockUI() {
    return this.evalJs(`(() => {
      const vis = (id) => { const e = document.getElementById(id);
        return !!e && e.style.display !== 'none' && getComputedStyle(e).display !== 'none'; };
      return {
        shown: document.getElementById('screen-lock').classList.contains('show'),
        sub: document.getElementById('lockSub').textContent.trim(),
        title: document.getElementById('lockTitle').textContent.trim(),
        off: vis('lockOff'), cancel: vis('lockCancel'), skip: vis('lockSkip'), forgot: vis('lockForgot')
      }; })()`);
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

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'diary-closepin-'));
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
  // 下载目录钉到临时目录：防止误触发 <a download> 把测试文件丢进用户「下载」文件夹
  const dlDir = path.join(tmp, 'downloads');
  fs.mkdirSync(dlDir, { recursive: true });
  await cdp.send('Browser.setDownloadBehavior', { behavior: 'allow', downloadPath: dlDir, eventsEnabled: true });

  const boot = async (pin) => {
    await cdp.send('Page.navigate', { url: BASE + '?t=' + Date.now() });
    await sleep(3200);
    if (await cdp.evalJs(`document.getElementById('screen-cover').classList.contains('show')`)) {
      await cdp.clickSel('#screen-cover');
      await sleep(800);
    }
    if (pin) await cdp.typePin(pin);
  };
  const toSettings = async () => {
    await cdp.evalJs(`window.__diary__.switchTab('mine', 'tab')`);
    await sleep(400);
  };
  const reset = async () => {
    // 回到"没设过密码"的干净状态
    await cdp.evalJs(`window.__diary__.Meta.save({ pinHash:'', pinSalt:'', pinEnabled:false, autoLockSec:60 })`);
    await sleep(150);
  };

  /* ================= 1. 没有密码时，不该出现「关闭密码」 ================= */
  section('[1] 未设密码：不给「关闭密码」这条行');
  await boot();
  await toSettings();
  await reset();
  await cdp.evalJs(`window.__diary__.renderSettings()`);
  await sleep(200);
  let ui = await cdp.pinUI();
  check('没有密码时「关闭密码」行隐藏', ui.rowHidden === true);
  check('状态是「未设置」', ui.state === '未设置', ui.state);
  check('行为「打开密码」', ui.rowLabel === '打开密码', ui.rowLabel);

  /* ================= 2. 打开密码后：行变「修改密码」+「关闭密码」出现 ================= */
  section('[2] 打开密码后：行变「修改密码」，并出现「关闭密码」');
  await cdp.evalJs(`(async () => {
    await window.__diary__.Lock.setPin('${PIN}');
    window.__diary__.renderSettings(); })()`);
  await sleep(400);
  ui = await cdp.pinUI();
  check('打开后「关闭密码」行出现', ui.rowHidden === false);
  check('行文案就是「关闭密码」', ui.rowText === '关闭密码', ui.rowText);
  check('是危险色（danger）', ui.rowDanger === true);
  check('状态「已设置」', ui.state === '已设置', ui.state);
  check('开关是亮的', ui.swOn === true);
  check('标签变「修改密码」', ui.rowLabel === '修改密码', ui.rowLabel);
  await cdp.shot('cp-1-close-row.png');

  /* ========== 2b. 只关开关（暂停验证）：行回到「打开密码」且「关闭密码」消失 ========== */
  section('[2b] 关掉开关后：行回到「打开密码」，且不再摆「关闭密码」');
  await cdp.evalJs(`(() => {
    window.__diary__.Meta.save({ pinEnabled: false });
    window.__diary__.renderSettings();
    return true; })()`);
  await sleep(250);
  ui = await cdp.pinUI();
  check('开关关掉后行变「打开密码」', ui.rowLabel === '打开密码', ui.rowLabel);
  check('开关关掉后「关闭密码」行消失', ui.rowHidden === true);
  check('开关关掉后状态「未设置」', ui.state === '未设置', ui.state);
  check('密码仍在（只是没打开）', await cdp.evalJs(`!!window.__diary__.Meta.data.pinHash`));
  // 「打开密码」这条行必须真的能把密码开回来（不是只换个字）
  await cdp.clickSel('#setChangePin');
  await sleep(500);
  check('点「打开密码」进验证锁屏（要求输原密码）',
    (await cdp.lockUI()).shown === true
    && /验证后开启密码验证/.test(await cdp.evalJs(`document.getElementById('lockSub').textContent.trim()`)));
  check('这条路上不给「关闭密码」（此时还没打开）',
    (await cdp.lockUI()).off === false);
  await cdp.typePin(PIN);
  await sleep(700);
  ui = await cdp.pinUI();
  check('输对原密码后打开成功', ui.swOn === true && ui.state === '已设置');
  check('打开后标签变「修改密码」', ui.rowLabel === '修改密码', ui.rowLabel);
  check('打开后「关闭密码」行出现', ui.rowHidden === false);

  /* ================= 3. 真设一次密码（走完整流程） ================= */
  section('[3] 真实设置密码：设置页 → 打开密码 → 两次输入');
  await reset();
  await cdp.evalJs(`window.__diary__.renderSettings()`);
  await sleep(150);
  await cdp.clickSel('#setChangePin');
  await sleep(500);
  let lock = await cdp.lockUI();
  check('进入设置密码锁屏', lock.shown === true && lock.title === '设置 6 位数字密码', lock.title);
  check('设置页有「暂不设置」出口', lock.skip === true);
  check('设置页不显示「关闭密码」', lock.off === false);
  check('设置页不显示「取消」', lock.cancel === false);
  check('设置页不显示「忘记密码」（还没有密码）', lock.forgot === false);
  await cdp.typePin(PIN);
  check('第一步后进入「再次输入确认」', (await cdp.lockUI()).title === '再次输入确认');
  await cdp.typePin(PIN);
  await sleep(600);
  let m = await cdp.meta();
  check('密码已写入（pinHash 非空）', !!m.pinHash);
  check('开关已打开', m.pinEnabled === true);
  ui = await cdp.pinUI();
  check('状态变「已设置」', ui.state === '已设置', ui.state);
  check('标签变「修改密码」', ui.rowLabel === '修改密码', ui.rowLabel);
  check('「关闭密码」行出现', ui.rowHidden === false);

  /* ================= 4. 点「关闭密码」→ 确认框 ================= */
  section('[4] 点「关闭密码」：先给确认框，把后果和下一步讲清');
  await cdp.clickSel('#setClosePin');
  await sleep(400);
  let dlg = await cdp.evalJs(`(() => { const d = document.getElementById('dialog');
    return { shown: document.getElementById('mask').classList.contains('show'),
             title: d.querySelector('.dialog-title').textContent.trim(),
             text: d.querySelector('.dialog-text').textContent.trim(),
             btns: Array.from(d.querySelectorAll('button')).map(b => b.textContent.trim()) }; })()`);
  check('弹出了确认框', dlg.shown === true);
  check('标题是「关闭密码？」', dlg.title === '关闭密码？', dlg.title);
  check('文案讲清「密码也会一并清除」', /密码也会一并清除/.test(dlg.text));
  check('文案讲清「需要输入一次当前密码」', /需要输入一次当前密码/.test(dlg.text));
  check('按钮是「取消 / 关闭密码」', dlg.btns.includes('取消') && dlg.btns.includes('关闭密码'), dlg.btns.join('/'));
  await cdp.shot('cp-2-close-confirm.png');

  /* ================= 5. 点取消 → 什么都不变 ================= */
  section('[5] 确认框点「取消」：密码原封不动');
  await cdp.clickDialog('取消');
  await sleep(300);
  m = await cdp.meta();
  check('取消后密码还在', !!m.pinHash);
  check('取消后开关仍开着', m.pinEnabled === true);
  check('取消后没有跳锁屏', (await cdp.lockUI()).shown === false);
  ui = await cdp.pinUI();
  check('取消后状态仍「已设置」', ui.state === '已设置', ui.state);

  /* ================= 6. 确认「关闭密码」→ 进验证锁屏 ================= */
  section('[6] 确认关闭：跳到验证锁屏，并给出「关闭密码 / 取消」两个出口');
  await cdp.clickSel('#setClosePin');
  await sleep(400);
  await cdp.clickDialog('关闭密码');
  await sleep(500);
  lock = await cdp.lockUI();
  check('跳到了验证锁屏', lock.shown === true, lock.shown);
  check('副标题说明「验证后关闭密码」', lock.sub === '验证后关闭密码', lock.sub);
  check('有「关闭密码」按钮', lock.off === true);
  check('有「取消」按钮（不想关也能退出来）', lock.cancel === true);
  check('没有「暂不设置」按钮', lock.skip === false);
  check('有「忘记密码」按钮（已设过密码）', lock.forgot === true);
  await cdp.shot('cp-3-lock-close.png');

  /* ================= 7. 锁屏点「取消」 → 保持开启 ================= */
  section('[7] 锁屏点「取消」：密码验证保持开启');
  await cdp.clickSel('#lockCancel');
  await sleep(400);
  check('已退出锁屏', (await cdp.lockUI()).shown === false);
  m = await cdp.meta();
  check('取消后密码还在', !!m.pinHash);
  check('取消后开关仍开着', m.pinEnabled === true);
  const toastText = await cdp.evalJs(`(document.getElementById('toast')||{}).textContent || ''`);
  check('提示「保持开启」', /保持开启/.test(toastText), toastText);

  /* ================= 8. 输错密码 → 不关 ================= */
  section('[8] 输错密码：不给关，停在锁屏');
  await cdp.clickSel('#setClosePin');
  await sleep(400);
  await cdp.clickDialog('关闭密码');
  await sleep(450);
  await cdp.typePin('000000');
  m = await cdp.meta();
  lock = await cdp.lockUI();
  check('输错后密码还在', !!m.pinHash);
  check('输错后开关仍开着', m.pinEnabled === true);
  check('输错后停在锁屏', lock.shown === true);
  check('输错有提示', /不正确/.test(lock.sub), lock.sub);

  /* ================= 9. 输对密码 → 真的关掉 ================= */
  section('[9] 输对密码：密码被清除，状态变「未设置」');
  await cdp.typePin(PIN);
  await sleep(600);
  m = await cdp.meta();
  check('pinHash 被清空', !m.pinHash, JSON.stringify(m.pinHash));
  check('pinSalt 被清空', !m.pinSalt);
  check('pinEnabled 变 false', m.pinEnabled === false);
  check('已退出锁屏', (await cdp.lockUI()).shown === false);
  ui = await cdp.pinUI();
  check('状态变「未设置」', ui.state === '未设置', ui.state);
  check('开关熄灭', ui.swOn === false);
  check('「关闭密码」行消失', ui.rowHidden === true);
  check('标签回到「打开密码」', ui.rowLabel === '打开密码', ui.rowLabel);
  check('开关旁不再挂"已关闭（密码保留）"', ui.hint === '', ui.hint);
  const closeToast = await cdp.evalJs(`(document.getElementById('toast')||{}).textContent || ''`);
  check('提示「已关闭密码」', /已关闭密码/.test(closeToast), closeToast);
  await cdp.shot('cp-4-after-close.png');

  /* ================= 10. 刷新后真的不再要密码 ================= */
  section('[10] 刷新验证：打开应用不再拦人（这才是用户要的"关掉了"）');
  await boot();
  lock = await cdp.lockUI();
  check('刷新后不进锁屏', lock.shown === false);
  check('刷新后能直接看到首页', await cdp.evalJs(`document.getElementById('screen-home').classList.contains('active')`));
  m = await cdp.meta();
  check('刷新后持久化为未设置', !m.pinHash && m.pinEnabled === false);

  /* ================= 11. 可逆：还能重新设置 ================= */
  section('[11] 可逆：关掉之后还能重新设一个（没把功能搞死）');
  await toSettings();
  await cdp.clickSel('#setChangePin');
  await sleep(500);
  check('无密码时点「打开密码」直接进设置流程', (await cdp.lockUI()).title === '设置 6 位数字密码');
  await cdp.typePin(PIN);
  await cdp.typePin(PIN);
  await sleep(600);
  m = await cdp.meta();
  check('重新设置成功', !!m.pinHash && m.pinEnabled === true);
  ui = await cdp.pinUI();
  check('状态回到「已设置」', ui.state === '已设置');
  check('「关闭密码」行重现', ui.rowHidden === false);

  /* ================= 12. 改密码要先验旧密码 ================= */
  section('[12] 「修改密码」也需要先验旧密码，且改密码不动开关');
  await cdp.clickSel('#setChangePin');
  await sleep(500);
  lock = await cdp.lockUI();
  check('点「修改密码」先跳到验证', lock.shown === true, lock.shown);
  check('副标题说明「验证后修改密码」', lock.sub === '验证后修改密码', lock.sub);
  check('这条路上不给「关闭密码」', lock.off === false);
  check('有「取消」出口', lock.cancel === true);
  await cdp.shot('cp-5-change-verify.png');
  await cdp.typePin(PIN);
  await sleep(700);
  lock = await cdp.lockUI();
  check('验证通过后进入「设置 6 位数字密码」', lock.title === '设置 6 位数字密码', lock.title);
  check('并提示输入新密码', lock.sub === '输入新的 6 位数字密码', lock.sub);
  await cdp.typePin(NEWPIN);
  check('进入「再次输入确认」', (await cdp.lockUI()).title === '再次输入确认');
  await cdp.typePin(NEWPIN);
  await sleep(700);
  m = await cdp.meta();
  check('新密码已生效', !!m.pinHash);
  check('改完密码开关仍然是开着的', m.pinEnabled === true);
  ui = await cdp.pinUI();
  check('改完密码状态仍「已设置」', ui.state === '已设置', ui.state);

  /* ================= 13. 关掉新密码（旧密码应失效） ================= */
  section('[13] 关闭刚改的新密码：旧密码不再能关');
  await cdp.clickSel('#setClosePin');
  await sleep(400);
  await cdp.clickDialog('关闭密码');
  await sleep(450);
  await cdp.typePin(PIN);
  m = await cdp.meta();
  check('旧密码已经关不掉了', !!m.pinHash && m.pinEnabled === true);
  await cdp.typePin(NEWPIN);
  await sleep(600);
  m = await cdp.meta();
  check('新密码能关掉', !m.pinHash && m.pinEnabled === false);

  /* ================= 14. 普通解锁不会删密码 ================= */
  section('[14] 普通解锁：进 App 时输密码不能顺手把密码删掉');
  await cdp.evalJs(`window.__diary__.Lock.setPin(${JSON.stringify(PIN)})`);
  await sleep(400);
  await cdp.evalJs(`window.__diary__.Meta.save({ pinEnabled: true })`);
  await boot(PIN);
  m = await cdp.meta();
  check('解锁后密码还在', !!m.pinHash);
  check('解锁后开关仍开着', m.pinEnabled === true);
  check('解锁后进了首页', await cdp.evalJs(`document.getElementById('screen-home').classList.contains('active')`));

  /* ================= 15. 锁屏 footer 上的「关闭密码」也能关 ================= */
  section('[15] 锁屏 footer 的「关闭密码」：不用再输一遍就能关');
  await cdp.evalJs(`window.__diary__.showUnlock('disableLock')`);
  await sleep(450);
  check('锁屏显示「关闭密码」出口', (await cdp.lockUI()).off === true);
  await cdp.clickSel('#lockOff');
  await sleep(500);
  m = await cdp.meta();
  check('点锁屏上的「关闭密码」直接关掉', !m.pinHash && m.pinEnabled === false);
  check('已退出锁屏', (await cdp.lockUI()).shown === false);
  ui = await cdp.pinUI();
  check('状态变「未设置」', ui.state === '未设置');

  /* ================= 16. 控制台无异常 ================= */
  section('[16] 控制台');
  const errs = cdp.pageErrors();
  check('全程无页面异常', errs.length === 0, errs.slice(0, 3).join(' | '));

  await cdp.shot('cp-6-final.png');
} catch (e) {
  fail++;
  console.log('\n✗ 用例异常终止: ' + (e && e.stack ? e.stack : e));
} finally {
  if (cdp) { try { await cdp.send('Browser.close'); } catch (e) {} }
  chrome.kill();
  await sleep(200);
  try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (e) {}
}

console.log(`\n========== 关闭密码专项：${pass} 通过 / ${fail} 失败 ==========`);
process.exit(fail ? 1 : 0);
