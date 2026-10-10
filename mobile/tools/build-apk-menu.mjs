/**
 * 打包菜单：交互式选择 Debug / Release，然后交给 setup-android.mjs 干活。
 *
 * 为什么单独写这个文件、而不把逻辑塞进 .bat：
 *   .bat 读不了非 ASCII（中文提示会乱码），也没法被自动化测试。
 *   所以真正的逻辑一律留在这里（Node），build-apk.bat 只是一层纯 ASCII 的薄壳，
 *   负责双击启动 + 传参。
 *
 * 用法：
 *   node tools/build-apk-menu.mjs            # 交互式选择
 *   node tools/build-apk-menu.mjs debug      # 直接打 debug
 *   node tools/build-apk-menu.mjs release    # 直接打 release
 */
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const MOBILE = path.resolve(HERE, '..');            // mobile/
const REPO = path.resolve(MOBILE, '..');            // wechat-diary/
const SETUP = path.join(MOBILE, 'setup-android.mjs');
const SRC_HTML = path.join(REPO, 'index.html');
const APK_DIR = path.join(MOBILE, 'android', 'app', 'build', 'outputs', 'apk');

/** 交互式问一个问题，返回用户输入的原始行 */
function ask(q) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((res) => rl.question(q, (a) => { rl.close(); res(a.trim()); }));
}

/** 把源 index.html 同步到各平台副本（和 sync.mjs 同源逻辑，但只做核心那一份） */
function syncCopies() {
  const targets = [
    path.join(MOBILE, 'www', 'index.html'),
    path.join(MOBILE, 'android', 'app', 'src', 'main', 'assets', 'public', 'index.html'),
    path.join(MOBILE, 'ios', 'App', 'App', 'public', 'index.html'),
  ].filter((p) => fs.existsSync(path.dirname(p)));

  const src = fs.readFileSync(SRC_HTML);
  let same = 0;
  for (const t of targets) {
    const cur = fs.existsSync(t) ? fs.readFileSync(t) : null;
    if (cur && cur.equals(src)) { same++; continue; }
    fs.writeFileSync(t, src);
    console.log('  synced -> ' + path.relative(REPO, t));
  }
  console.log(`  副本已是最新：${same}/${targets.length}`);
}

/** 校验：源文件与三处副本必须逐字节一致，否则提示先同步 */
function verifyCopies() {
  const targets = [
    path.join(MOBILE, 'www', 'index.html'),
    path.join(MOBILE, 'android', 'app', 'src', 'main', 'assets', 'public', 'index.html'),
    path.join(MOBILE, 'ios', 'App', 'App', 'public', 'index.html'),
  ].filter((p) => fs.existsSync(p));
  const src = fs.readFileSync(SRC_HTML);
  return targets.every((t) => fs.readFileSync(t).equals(src));
}

/** 找最新生成的 APK（按修改时间倒序取第一个） */
function newestApk(kind) {
  const dir = path.join(APK_DIR, kind);
  if (!fs.existsSync(dir)) return null;
  const files = fs.readdirSync(dir)
    .filter((f) => f.endsWith('.apk'))
    .map((f) => ({ f, p: path.join(dir, f), t: fs.statSync(path.join(dir, f)).mtimeMs }))
    .sort((a, b) => b.t - a.t);
  return files[0] || null;
}

async function main() {
  let mode = (process.argv[2] || '').toLowerCase();
  if (mode !== 'debug' && mode !== 'release') {
    console.log('');
    console.log('  选择要打包的类型：');
    console.log('    1) Debug   —— 自己手机测试用（安装快，体积略大）');
    console.log('    2) Release —— 发给别人用（正式签名，体积小）');
    console.log('');
    const a = await ask('  输入 1 或 2（直接回车 = Debug）：');
    mode = a === '2' ? 'release' : 'debug';
  }

  const isRel = mode === 'release';
  console.log('');
  console.log('='.repeat(52));
  console.log(`  打包 ${isRel ? 'Release' : 'Debug'} APK`);
  console.log('='.repeat(52));
  console.log('');

  // ① 同步副本：改完 index.html 忘了同步是这里最常见的事故
  console.log('[1/4] 同步网页副本');
  syncCopies();
  if (!verifyCopies()) {
    console.error('\n  ✗ 副本同步后仍与源文件不一致，已中止。');
    process.exit(1);
  }
  console.log('  ✓ 三处副本与源文件逐字节一致\n');

  // ② 交给 setup-android.mjs：它内部会做 preflight + 版本校验 + 签名 + gradle
  console.log('[2/4] 校验环境与签名（setup-android.mjs 内部完成）');
  console.log('[3/4] 调用 Gradle 打包…（首次可能较久，请稍候）\n');
  const args = [SETUP];
  if (isRel) args.push('--release');
  const r = spawnSync(process.execPath, args, {
    cwd: MOBILE,
    stdio: 'inherit',
    env: process.env,
  });
  if (r.status !== 0) {
    console.error(`\n  ✗ 打包失败（退出码 ${r.status}）。上面的日志里有原因。`);
    process.exit(r.status || 1);
  }

  // ③ 报告产物
  console.log('\n[4/4] 产物');
  const apk = newestApk(isRel ? 'release' : 'debug');
  if (apk) {
    const size = (fs.statSync(apk.p).size / 1024 / 1024).toFixed(1);
    console.log(`  ✓ ${path.relative(REPO, apk.p)}`);
    console.log(`    大小 ${size} MB · 生成于 ${new Date(apk.t).toLocaleString('zh-CN')}`);
  } else {
    console.log('  （没找到 APK 文件，请检查上面 Gradle 的输出）');
  }
  console.log('');
  console.log('  装到手机：把这个 .apk 传到手机点安装即可。');
  console.log('');
}

main().catch((e) => { console.error('\n  ✗ ' + (e && e.message ? e.message : e)); process.exit(1); });
