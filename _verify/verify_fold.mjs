/**
 * 「更多 / 收起」折叠判定的回归测试。
 *
 * 修复前判定数的是 \n 个数（逻辑行），而 CSS 折的是视觉行，两个真实后果：
 *   · 一段没换行的长文会被裁到第 6 行却**不显示「更多」**（内容被吞、无法展开）
 *   · 「还有 N 行」的数字严重偏小
 * 现在改为量真实视觉行数。
 *
 * 校验方式：把正文**克隆**一份放到同宽容器里量真实全文行数（克隆不受 line-clamp 影响），
 * 再和折叠态行数相减，与按钮上的数字比对。
 * Usage: node verify_fold.mjs
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const CHROME = 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const FILE = 'file:///D:/WorkBuddy/WorkPlace/wechat-diary/index.html';
const PORT = 9423;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let pass = 0, fail = 0;
const check = (n, ok, extra = '') => { ok ? pass++ : fail++; console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${n}${extra ? '   ' + extra : ''}`); };

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'fold-'));
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
  let evIndex = 0;
  const ev = async (expr) => {
    evIndex++;
    const r = await send('Runtime.evaluate', { expression: `(async()=>{return (${expr});})()`, awaitPromise: true, returnByValue: true });
    if (r.exceptionDetails) {
      const d = r.exceptionDetails.exception?.description || r.exceptionDetails.text;
      console.error(`[ev #${evIndex} 失败] ${d}`);
      console.error('[表达式前 300 字] ' + String(expr).slice(0, 300).replace(/\n/g, ' ⏎ '));
      throw new Error(d);
    }
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
  await send('Page.navigate', { url: FILE });
  await sleep(2500);
  await click('#screen-cover');
  await sleep(800);

  // 直接用 Store 写入，绕开 textarea 的 maxlength 截断；长文用 repeat 拼
  const setup = await ev(`(async()=>{
    await window.__diary__.Store.clearAll();
    const mk = function(n, txt){ return Array.from({length:n}, function(){ return txt; }).join(''); };
    const cases = {
      noNewlineLong: mk(8, '这一段没有任何换行符，但在手机上会被折成很多行。'),
      nineShort: Array.from({length:9}, function(_,i){ return '短行'+(i+1); }).join('\\n'),
      multiParaLong: mk(14, '第一段很长的文字。') + '\\n' + mk(14, '第二段同样很长。'),
      sixShort: Array.from({length:6}, function(_,i){ return '行'+(i+1); }).join('\\n'),
      short: '短日记。'
    };
    const now = Date.now();
    let k = 0;
    for (const key of Object.keys(cases)) {
      await window.__diary__.Store.saveEntry({ id: 'test' + (k++), text: cases[key], images: [],
        createdAt: now - k * 60000, updatedAt: 0 });
    }
    window.__diary__.loadHome();
    window.__diary__.switchTab('timeline');
    await new Promise(function(res){ setTimeout(res, 900); });
    return { keys: Object.keys(cases), lens: Object.keys(cases).map(function(x){ return cases[x].length; }) };
  })()`);
  console.log('\n用例:', JSON.stringify(setup));
  await sleep(800);

  // 关键：用克隆量"真实全文行数"（克隆不带 folded，不受 line-clamp 影响）
  const rows = await ev(`(()=>{
    function rangeLines(el){
      if(!el.firstChild) return 0;
      const r=document.createRange(); r.selectNodeContents(el);
      const rects=r.getClientRects(); let n=0,last=null;
      for(let i=0;i<rects.length;i++){ if(!rects[i].width && !rects[i].height) continue;
        const t=Math.round(rects[i].top); if(last===null||t>last){n++;last=t;} }
      return n;
    }
    function heightLines(el){
      const lh=parseFloat(getComputedStyle(el).lineHeight) || 24;
      return Math.max(1, Math.round(el.getBoundingClientRect().height/lh));
    }
    return Array.prototype.slice.call(document.querySelectorAll('#timeline .post')).map(function(p){
      const body=p.querySelector('.post-text');
      const btn=p.querySelector('.post-moretext');
      const folded=body.classList.contains('folded');
      const shownLines = folded ? heightLines(body) : rangeLines(body);
      // 克隆到同宽容器量全文行数
      const holder=document.createElement('div');
      holder.style.cssText='position:absolute;visibility:hidden;left:-9999px;width:'+body.clientWidth+'px;'
        + 'font-size:'+getComputedStyle(body).fontSize+';line-height:'+getComputedStyle(body).lineHeight
        + ';word-break:'+getComputedStyle(body).wordBreak+';white-space:normal';
      const clone=document.createElement('div');
      clone.innerHTML=body.innerHTML;
      holder.appendChild(clone); document.body.appendChild(holder);
      const openLines=rangeLines(clone);
      holder.remove();
      return { textId: body.getAttribute('data-text-id'),
        domLen: body.textContent.length,
        // 换行在 DOM 里是 br 元素，textContent 里不会变成换行符 —— 必须数 br
        brCount: body.querySelectorAll('br').length,
        logicalLines: body.querySelectorAll('br').length + 1,
        folded: folded, shownLines: shownLines, openLines: openLines,
        expectHidden: Math.max(openLines - shownLines, 0),
        btnHidden: btn?Number(btn.getAttribute('data-hidden')):null,
        btnText: btn?btn.textContent.replace(/\\s+/g,' ').trim():null,
        btnFollows: btn?(btn.previousElementSibling===body):null };
    });})()`);

  console.log('\n渲染结果（按时间线顺序 = 最新在前）:');
  rows.forEach(function (r) {
    console.log(`  ${String(r.domLen).padStart(4)}字 逻辑${String(r.logicalLines).padStart(2)}行(br=${r.brCount})  展开${String(r.openLines).padStart(2)}行 ` +
      `显示${String(r.shownLines).padStart(2)}行  folded=${String(r.folded).padEnd(5)} 按钮=${r.btnText || '无'}`);
  });

  console.log('');

  // ① 无换行长文：必须折叠 + 有按钮（修复前：没有按钮，内容被吞）
  const c1 = rows.find(function (r) { return r.brCount === 0 && r.openLines > 6; });
  check('① 无换行长文被折叠', !!c1 && c1.folded === true, c1 ? `openLines=${c1.openLines}` : '没找到用例');
  check('① 无换行长文有「更多」按钮（修复前没有）', !!c1 && !!c1.btnText, c1 ? (c1.btnText || '没有') : '');
  check('① 按钮行数 = 真实隐藏行数', !!c1 && c1.btnHidden === c1.expectHidden,
    c1 ? `按钮=${c1.btnHidden} 实际=${c1.expectHidden}（展开${c1.openLines}/显示${c1.shownLines}）` : '');

  // ② 9 个短行（8 个 br）
  const c2 = rows.find(function (r) { return r.brCount === 8; });
  check('② 9 个短行被折叠且行数正确', !!c2 && c2.folded && c2.btnHidden === c2.expectHidden,
    c2 ? `按钮=${c2.btnHidden} 实际=${c2.expectHidden}（展开${c2.openLines}/显示${c2.shownLines}）` : '没找到');

  // ③ 多段长文（换行少、视觉行多）
  const c3 = rows.find(function (r) { return r.brCount === 1; });
  check('③ 多段长文：按钮数字是视觉行差（修复前会算成 1）', !!c3 && c3.folded && c3.btnHidden === c3.expectHidden,
    c3 ? `按钮=${c3.btnHidden} 实际=${c3.expectHidden}（展开${c3.openLines}/显示${c3.shownLines}）` : '没找到');

  // ④ 6 个短行（5 个 br）：正好等于上限，不该折叠
  const c4 = rows.find(function (r) { return r.brCount === 5; });
  check('④ 正好 6 行：不折叠、无按钮', !!c4 && c4.folded === false && !c4.btnText,
    c4 ? `folded=${c4.folded} 按钮=${c4.btnText || '无'}` : '没找到');

  // ⑤ 短文
  const c5 = rows.find(function (r) { return r.domLen < 10; });
  check('⑤ 短文：不折叠、无按钮', !!c5 && c5.folded === false && !c5.btnText);

  check('所有按钮都紧跟正文之后', rows.filter(function (r) { return r.btnText; }).every(function (r) { return r.btnFollows; }));

  console.log('\n[展开/收起] 点最长那篇的「更多」');
  const longest = rows.slice().sort(function (a, b) { return b.openLines - a.openLines; })[0];
  await ev(`(()=>{const p=Array.prototype.slice.call(document.querySelectorAll('#timeline .post'))
      .filter(function(x){return x.querySelector('.post-text').getAttribute('data-text-id')===${JSON.stringify(longest.textId)};})[0];
    const b=p.querySelector('.post-moretext'); if(b) b.click(); return 1;})()`);
  await sleep(600);
  const after = await ev(`(()=>{
    const p=Array.prototype.slice.call(document.querySelectorAll('#timeline .post'))
      .filter(function(x){return x.querySelector('.post-text').getAttribute('data-text-id')===${JSON.stringify(longest.textId)};})[0];
    const body=p.querySelector('.post-text'); const btn=p.querySelector('.post-moretext');
    return {expanded:body.classList.contains('expanded'), folded:body.classList.contains('folded'),
            btnText:btn?btn.textContent.replace(/\\s+/g,' ').trim():null};})()`);
  console.log('    ' + JSON.stringify(after));
  check('展开后 expanded=true、folded=false', after.expanded === true && after.folded === false);
  check('按钮变为「收起」', after.btnText === '收起', after.btnText);

  await ev(`(()=>{const p=Array.prototype.slice.call(document.querySelectorAll('#timeline .post'))
      .filter(function(x){return x.querySelector('.post-text').getAttribute('data-text-id')===${JSON.stringify(longest.textId)};})[0];
    p.querySelector('.post-moretext').click(); return 1;})()`);
  await sleep(600);
  const back = await ev(`(()=>{const p=Array.prototype.slice.call(document.querySelectorAll('#timeline .post'))
      .filter(function(x){return x.querySelector('.post-text').getAttribute('data-text-id')===${JSON.stringify(longest.textId)};})[0];
    const body=p.querySelector('.post-text'); const btn=p.querySelector('.post-moretext');
    return {folded:body.classList.contains('folded'), btnText:btn?btn.textContent.replace(/\\s+/g,' ').trim():null};})()`);
  console.log('    ' + JSON.stringify(back));
  check('收起后恢复折叠', back.folded === true);
  check('按钮文案恢复且数字不变', back.btnText === '更多（还有 ' + longest.expectHidden + ' 行）', back.btnText);

  console.log('\n[旋转] 已展开的日记在改宽后保持展开');
  await ev(`(()=>{const p=Array.prototype.slice.call(document.querySelectorAll('#timeline .post'))
      .filter(function(x){return x.querySelector('.post-text').getAttribute('data-text-id')===${JSON.stringify(longest.textId)};})[0];
    p.querySelector('.post-moretext').click(); return 1;})()`);
  await sleep(400);
  await send('Emulation.setDeviceMetricsOverride', { width: 844, height: 390, deviceScaleFactor: 2, mobile: true });
  await sleep(1400);
  const rot = await ev(`(()=>{const p=Array.prototype.slice.call(document.querySelectorAll('#timeline .post'))
      .filter(function(x){return x.querySelector('.post-text').getAttribute('data-text-id')===${JSON.stringify(longest.textId)};})[0];
    const body=p.querySelector('.post-text');
    return {expanded:body.classList.contains('expanded'), folded:body.classList.contains('folded')};})()`);
  console.log('    ' + JSON.stringify(rot));
  check('改宽后用户展开的仍保持展开', rot.expanded === true, JSON.stringify(rot));

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
