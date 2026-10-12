/**
 * 打包菜单：选 Debug / Release → 同步网页副本 → 查版本号 → 调 Gradle → 归档并校验。
 *
 * 三条"为什么"：
 *  1) 逻辑写在 .mjs 而不是 .bat —— .bat 读不了非 ASCII（中文提示会乱码），也没法被自动化测试。
 *     build-apk-menu.bat 只是纯 ASCII 薄壳，负责双击 + 传参。
 *  2) 不让 setup-android.mjs 代劳出包 —— 它探测 JDK 的逻辑在本机认不出 JDK 21
 *     （会探到 D:\jdk17，然后转去下载解压而失败）。这里自己找 JAVA_HOME，找不到就明确报错。
 *  3) **打包前拦一次"版本号没升"** —— 每次更新都该把 versionCode +1、versionName 进一位（2.3 → 2.4）。
 *     否则两次不同的改动会打出同名同版本的两个包，手机上覆盖安装后根本分不清装的是哪版。
 *
 * 用法：
 *   node tools/build-apk-menu.mjs                    # 交互式选择
 *   node tools/build-apk-menu.mjs debug              # 直接打 debug
 *   node tools/build-apk-menu.mjs release            # 直接打 release
 *   node tools/build-apk-menu.mjs release --force    # 明知版本没升也要打（跳过拦截）
 */
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const MOBILE = path.resolve(HERE, '..');            // mobile/
const REPO = path.resolve(MOBILE, '..');            // wechat-diary/
const ANDROID = path.join(MOBILE, 'android');
const BUILD_GRADLE = path.join(ANDROID, 'app', 'build.gradle');
const SRC_HTML = path.join(REPO, 'index.html');
const APK_OUT = path.join(ANDROID, 'app', 'build', 'outputs', 'apk');
const PEEK = path.join(REPO, '_verify', 'apk_peek.mjs');
const IS_WIN = process.platform === 'win32';

const FLAGS = process.argv.slice(2);
const FORCE = FLAGS.includes('--force');

/** Java 候选目录：环境变量优先，其次本机常见安装位置 */
const JAVA_CANDIDATES = [
  process.env.JAVA_HOME,
  'D:/Android/jdk21',
  'C:/Program Files/Java/jdk-21',
  'C:/Program Files/Android/Android Studio/jbr',
].filter(Boolean);

/** 交互式问一个问题；非终端（管道 / 双击批处理无 stdin）时当作"直接回车" */
function ask(q) {
  if (!process.stdin.isTTY) return Promise.resolve('');
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((res) => rl.question(q, (a) => { rl.close(); res(a.trim()); }));
}

/* ---------- 版本号 ---------- */

/** 唯一真相源：android/app/build.gradle 的 versionCode / versionName */
function readVersion() {
  const g = fs.readFileSync(BUILD_GRADLE, 'utf8');
  return {
    name: (g.match(/versionName\s+"([^"]+)"/) || [])[1] || '?',
    code: (g.match(/versionCode\s+(\d+)/) || [])[1] || '?',
  };
}

/** 给出下一个版本号建议：2.3 -> 2.4 */
function bumpHint(name) {
  const m = String(name).match(/^(\d+)\.(\d+)$/);
  return m ? `${m[1]}.${Number(m[2]) + 1}` : `${name} (versionName 进一位)`;
}

/** 仓库根下已经打出来的包，形如 my-diary-v2.3-debug.apk */
function existingPackages() {
  return fs.readdirSync(REPO)
    .filter((f) => /^my-diary-v.+-.+\.apk$/i.test(f))
    .map((f) => {
      const m = f.match(/^my-diary-v(.+?)-(debug|release)\.apk$/i);
      return { file: f, ver: m ? m[1] : '?' };
    });
}

/* ---------- 环境探测 ---------- */

/** 读 JDK 根目录 release 文件里的 JAVA_VERSION，拿到主版本号（读不到返回 null） */
function javaMajor(dir) {
  try {
    const m = fs.readFileSync(path.join(dir, 'release'), 'utf8').match(/JAVA_VERSION="(\d+)/);
    return m ? Number(m[1]) : null;
  } catch {
    return null;
  }
}

/**
 * 选 JDK。**这里必须按版本挑，不能无条件信 JAVA_HOME** ——
 * 本机环境变量 `JAVA_HOME` 指向的是 `D:\jdk17`，而本工程 Gradle 里设了
 * source/target 21，用 17 编译会直接报「无效的源发行版：21」。
 * （setup-android.mjs 当初就是在这里栽的：探到 jdk17 就跑偏。）
 */
function probeJavaHome(minMajor) {
  const found = [];
  for (const dir of JAVA_CANDIDATES) {
    if (found.some((f) => f.dir === dir)) continue;                 // 去重
    if (!fs.existsSync(path.join(dir, 'bin', IS_WIN ? 'java.exe' : 'java'))) continue;
    found.push({ dir, major: javaMajor(dir) });
  }
  if (!found.length) return null;
  const ok = found.filter((f) => f.major !== null && f.major >= minMajor);
  if (ok.length) return ok[0];                                      // 按候选顺序取第一个够格的
  return found.sort((a, b) => (b.major || 0) - (a.major || 0))[0];  // 都不够格：给最大的，由调用方报错
}

function probeGradleHome() {
  const cands = [
    process.env.GRADLE_USER_HOME,
    'D:/Android/gradle-home',
    path.join(process.env.USERPROFILE || process.env.HOME || '', '.gradle'),
  ].filter(Boolean);
  for (const d of cands) if (fs.existsSync(d)) return d;
  return null;
}

/* ---------- 副本同步（和 sync.mjs 同源逻辑） ---------- */

const COPY_TARGETS = () => [
  path.join(MOBILE, 'www', 'index.html'),
  path.join(ANDROID, 'app', 'src', 'main', 'assets', 'public', 'index.html'),
  path.join(MOBILE, 'ios', 'App', 'App', 'public', 'index.html'),
].filter((p) => fs.existsSync(path.dirname(p)));

function syncCopies() {
  const src = fs.readFileSync(SRC_HTML);
  const targets = COPY_TARGETS();
  let same = 0;
  for (const t of targets) {
    const cur = fs.existsSync(t) ? fs.readFileSync(t) : null;
    if (cur && cur.equals(src)) { same++; continue; }
    fs.writeFileSync(t, src);
    console.log('  synced -> ' + path.relative(REPO, t));
  }
  console.log(`  副本已是最新：${same}/${targets.length}`);
  return targets.every((t) => fs.readFileSync(t).equals(src));
}

/* ---------- Gradle ---------- */

function runGradle(variant, jdk, gradleHome) {
  const env = { ...process.env, JAVA_HOME: jdk.dir };
  if (gradleHome) env.GRADLE_USER_HOME = gradleHome;
  console.log(`  执行：gradlew assemble${variant}\n`);

  const r = spawnSync(IS_WIN ? 'gradlew.bat' : './gradlew', [`assemble${variant}`], {
    cwd: ANDROID,
    stdio: 'inherit',
    env,
    shell: IS_WIN,
  });
  return r.status === null ? 1 : r.status;
}

/* ---------- 归档 + 校验 ---------- */

function archiveAndVerify(kind, expectVer) {
  const dir = path.join(APK_OUT, kind);
  const metaPath = path.join(dir, 'output-metadata.json');
  if (!fs.existsSync(metaPath)) {
    console.error(`  ✗ 没找到 ${path.relative(REPO, metaPath)}，Gradle 可能没成功出包。`);
    return 1;
  }
  const meta = JSON.parse(fs.readFileSync(metaPath, 'utf8'));
  const el = (meta.elements || [])[0] || {};
  const builtFrom = path.join(dir, el.outputFile || `app-${kind}.apk`);

  console.log('  Gradle 自报：versionCode ' + el.versionCode + ' · versionName ' + el.versionName);
  if (String(el.versionName) !== String(expectVer)) {
    console.log(`  ⚠ 与 build.gradle 里读到的 ${expectVer} 不一致，请检查。`);
  }

  const dest = path.join(REPO, `my-diary-v${el.versionName}-${kind}.apk`);
  fs.copyFileSync(builtFrom, dest);
  const size = (fs.statSync(dest).size / 1024 / 1024).toFixed(1);
  console.log(`  ✓ 已归档 ${path.relative(REPO, dest)}  (${size} MB)`);
  console.log('');

  // 校验包内 index.html 与源文件逐字节一致（手写 zip 解析，沙箱里 unzip 会 EBUSY）
  console.log('  校验包内 index.html …');
  const r = spawnSync(process.execPath, [PEEK, dest], { cwd: REPO, stdio: 'inherit' });
  return r.status === null ? 1 : r.status;
}

/* ---------- 主流程 ---------- */

async function main() {
  const args = FLAGS.filter((a) => a !== '--force');
  let mode = (args[0] || '').toLowerCase();
  if (mode !== 'debug' && mode !== 'release') {
    console.log('');
    console.log('  选择要打包的类型：');
    console.log('    1) Debug   —— 自己手机测试用（安装快，体积略大）');
    console.log('    2) Release —— 发给别人用（正式签名，体积小）');
    console.log('');
    mode = (await ask('  输入 1 或 2（直接回车 = Debug）：')) === '2' ? 'release' : 'debug';
  }
  const kind = mode;                                  // debug | release
  const variant = kind === 'release' ? 'Release' : 'Debug';

  console.log('');
  console.log('='.repeat(52));
  console.log(`  打包 ${variant} APK`);
  console.log('='.repeat(52));
  console.log('');

  // ① 版本号检查：这是这个脚本存在的首要理由
  console.log('[1/5] 版本号检查');
  const { name: ver, code } = readVersion();
  console.log(`  build.gradle：versionName "${ver}" · versionCode ${code}`);
  const dup = existingPackages().filter((p) => p.ver === ver);
  if (dup.length) {
    console.log('');
    console.log(`  ⚠ 仓库里已经有 v${ver} 的包了：${dup.map((d) => d.file).join('、')}`);
    console.log('    如果这次是一轮新的改动，请先升版本号：');
    console.log(`      mobile/android/app/build.gradle   versionCode ${code} -> ${Number(code) + 1} · versionName "${ver}" -> "${bumpHint(ver)}"`);
    console.log('      mobile/ios/App/App.xcodeproj/project.pbxproj   CURRENT_PROJECT_VERSION / MARKETING_VERSION 同步改');
    console.log('');
    if (!FORCE) {
      const a = await ask('  输入 y 仍然继续打包，直接回车则中止：');
      if (a.toLowerCase() !== 'y') {
        console.log('\n  已中止。先把版本号升上去再打包吧。\n');
        process.exit(0);
      }
      console.log('');
    } else {
      console.log('  （--force 已指定，继续）\n');
    }
  } else {
    const others = [...new Set(existingPackages().map((p) => p.ver))].sort();
    console.log(`  ✓ 还没有 v${ver} 的包` + (others.length ? `（历史：${others.map((v) => 'v' + v).join('、')}）` : ''));
    console.log('');
  }

  // ② 同步副本：改完 index.html 忘了同步是这里最常见的事故
  console.log('[2/5] 同步网页副本');
  if (!syncCopies()) {
    console.error('\n  ✗ 副本同步后仍与源文件不一致，已中止。');
    process.exit(1);
  }
  console.log('  ✓ 三处副本与源文件逐字节一致\n');

  // ③ 环境：必须先定 JDK，选错版本会以「无效的源发行版：21」这种难懂的报错收场
  console.log('[3/5] 定位 JDK / Gradle 缓存');
  const jdk = probeJavaHome(21);
  if (!jdk) {
    console.error('  ✗ 没找到任何 JDK。请安装 JDK 21，或设置 JAVA_HOME 后重试。');
    console.error('    探测过的位置：' + JAVA_CANDIDATES.join(' | '));
    process.exit(1);
  }
  if (jdk.major !== null && jdk.major < 21) {
    console.error(`  ✗ 找到的 JDK 是 ${jdk.major}（${jdk.dir}），但本工程需要 JDK 21+（Gradle 里设了 source/target 21）。`);
    console.error('    请把 JDK 21 装到 D:/Android/jdk21，或把 JAVA_HOME 指向 JDK 21。');
    process.exit(1);
  }
  const gradleHome = probeGradleHome();
  console.log(`  JDK ${jdk.major === null ? '?' : jdk.major}          -> ${jdk.dir}`);
  console.log(`  Gradle 缓存      -> ${gradleHome || '(默认 ~/.gradle)'}`);
  console.log('');

  // ④ 打包
  console.log('\n[4/5] 调用 Gradle 打包…（首次可能较久，请稍候）\n');
  const st = runGradle(variant, jdk, gradleHome);
  if (st !== 0) {
    console.error(`\n  ✗ 打包失败（退出码 ${st}）。上面的日志里有原因。`);
    process.exit(st || 1);
  }

  // ⑤ 归档 + 校验
  console.log('\n[5/5] 归档产物并校验');
  const rc = archiveAndVerify(kind, ver);
  if (rc !== 0) process.exit(rc);

  console.log('');
  console.log('  装到手机：把这个 .apk 传到手机点安装即可。');
  console.log('');
}

main().catch((e) => { console.error('\n  ✗ ' + (e && e.message ? e.message : e)); process.exit(1); });
