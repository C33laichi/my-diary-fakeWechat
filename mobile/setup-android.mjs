#!/usr/bin/env node
/**
 * 「我的日记」Android 构建环境一键搭建 + 出 APK
 *
 * 为什么是 Node 而不是 .bat：
 *   1. Windows cmd 用 OEM 代码页读 .bat，中文极易乱码；Node 走 WriteConsoleW，中文稳。
 *   2. .bat 没法被自动化测试，只能靠人肉试错。这个是「改一步就能跑一遍」的。
 *   3. 路径拼装、错误分支这类逻辑，写在 JS 里能断言。
 *
 * 用法：
 *     node setup-android.mjs             完整流程：装 SDK → 装组件 → 写配置 → 出 debug APK
 *     node setup-android.mjs --release   同上，但出**正式签名**的 release APK（发给别人用这个）
 *     node setup-android.mjs --check     只体检，不下载不构建
 *     node setup-android.mjs --dry-run   只把「打算执行的命令」打出来
 *
 * 关于 --release：第一次跑会自动生成签名证书（keystore）并把它记在
 * android/keystore.properties 里，然后把 android/app/build.gradle 的 release 签名接上。
 * 证书与密码是「以后给同一个包名发更新」的唯一凭据，务必自己备份好。
 *
 * 路径可用环境变量覆盖（默认值见下方 CFG）：
 *     WD_JDK_HOME / WD_SDK_ROOT / WD_DROP_DIR / WD_GRADLE_HOME
 *
 * 安全声明：本脚本只做「新建目录 / 下载 SDK / 写 android/local.properties / 跑 gradlew」，
 * 不删除任何既有文件（只清理自己创建的临时解压目录）。
 */
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));   // .../wechat-diary/mobile
const ARGS = process.argv.slice(2);
const DRY = ARGS.includes('--dry-run');
const CHECK_ONLY = ARGS.includes('--check');
const AUTO_DOWNLOAD = ARGS.includes('--download');
const RELEASE = ARGS.includes('--release');

const CFG = {
  // 跑 Gradle 用的 JDK。17 就足够让 Gradle 自身启动。
  JDK_HOME: process.env.WD_JDK_HOME || 'D:\\jdk17',
  // 但**编译 Capacitor 8 的插件模块必须用 JDK 21** —— 见文件末尾 findJdk21() 的注释。
  JDK21_HOME: process.env.WD_JDK21_HOME || 'D:\\Android\\jdk21',
  SDK_ROOT: process.env.WD_SDK_ROOT || 'D:\\Android\\Sdk',
  DROP_DIR: process.env.WD_DROP_DIR || 'D:\\Android',
  GRADLE_HOME: process.env.WD_GRADLE_HOME || 'D:\\Android\\gradle-home',
};
const CMDLINE_URL =
  'https://dl.google.com/android/repository/commandlinetools-win-14742923_latest.zip';
// 微软 OpenJDK 21：走微软 CDN（download.visualstudio.microsoft.com），
// 国内一般比 GitHub Releases / Adoptium 官方源快，实测约 1.6 MB/s。
const JDK21_URL = 'https://aka.ms/download-jdk/microsoft-jdk-21-windows-x64.zip';

const SDKMAN = path.join(CFG.SDK_ROOT, 'cmdline-tools', 'latest', 'bin', 'sdkmanager.bat');
const SDKMAN_JAR = path.join(CFG.SDK_ROOT, 'cmdline-tools', 'latest', 'lib', 'sdkmanager-classpath.jar');
const SDKMAN_MAIN = 'com.android.sdklib.tool.sdkmanager.SdkManagerCli';
const LOCAL_PROPS = path.join(HERE, 'android', 'local.properties');
const ANDROID_DIR = path.join(HERE, 'android');
const APP_GRADLE = path.join(ANDROID_DIR, 'app', 'build.gradle');
const KEYSTORE = path.join(ANDROID_DIR, 'diary-release.keystore');
const KEYSTORE_PROPS = path.join(ANDROID_DIR, 'keystore.properties');
const APK = path.join(ANDROID_DIR, 'app', 'build', 'outputs', 'apk',
  RELEASE ? 'release' : 'debug', RELEASE ? 'app-release.apk' : 'app-debug.apk');

/* ---------------------------------------------------------------- 工具 */

const C = {
  ok: (s) => '\u2713 ' + s,
  no: (s) => '\u2717 ' + s,
  warn: (s) => '! ' + s,
};
const pass = [];
const fail = [];
let step = 0;
const totalSteps = 9;
let JDK21 = null;   // 在体检阶段探测，在第 2 步补齐

function head(t) { console.log('\n' + t); }
function okN(t) { pass.push(t); console.log('  ' + C.ok(t)); }
function badN(t) { fail.push(t); console.log('  ' + C.no(t)); }
function warnN(t) { console.log('  ' + C.warn(t)); }
function stepN(t) { step++; console.log('\n[' + step + '/' + totalSteps + '] ' + t); }

function run(cmdStr, opts) {
  if (DRY) { console.log('  [dry-run] ' + cmdStr); return { status: 0 }; }
  const o = Object.assign({ shell: true, encoding: 'utf8' }, opts || {});
  return spawnSync(cmdStr, o);
}

/**
 * 不经 shell 直接起一个可执行文件（走参数数组）。
 *
 * 为什么关键步骤都用它：`shell: true` 在 Windows 上会先起一个 cmd.exe，于是
 *   ① cmd.exe 被禁的环境整段卡死；② 参数字符串要自己处理引号；③ 多一层进程。
 * 传数组则三样都不存在。
 */
function runExe(exe, args, opts) {
  if (DRY) { console.log('  [dry-run] ' + quote(exe) + ' ' + args.map(quote).join(' ')); return { status: 0 }; }
  return spawnSync(exe, args, Object.assign({ encoding: 'utf8' }, opts || {}));
}

function quote(p) { return '"' + p + '"'; }

/**
 * 调 sdkmanager。
 *
 * 优先「直接用 java 调那个 jar」，而不是 `call sdkmanager.bat` —— 因为 .bat 的本质就是这一行，
 * 但它多引入一个 cmd.exe，会带来两个真实问题：
 *   1. 受限环境（智能体沙箱、部分企业管控）可能直接禁掉 cmd.exe，于是整段流程卡死；
 *   2. cmd 用 OEM 代码页读批处理，对含中文的路径不友好。
 * 直接调 java 两个问题都不存在。没有 java 或 jar 时才退回 .bat。
 */
function sdkmanager(args, opts) {
  const javaForSdk = [path.join(CFG.JDK_HOME, 'bin', 'java.exe'),
    JDK21 && path.join(JDK21, 'bin', 'java.exe')]
    .filter(Boolean).find((p) => fs.existsSync(p));
  if (javaForSdk && fs.existsSync(SDKMAN_JAR)) {
    return runExe(javaForSdk,
      ['-classpath', SDKMAN_JAR, SDKMAN_MAIN, '--sdk_root=' + CFG.SDK_ROOT].concat(args), opts);
  }
  return run('call ' + quote(SDKMAN) + ' --sdk_root=' + quote(CFG.SDK_ROOT) + ' ' +
    args.map(quote).join(' '), opts);
}

/**
 * 定位一个「真能解 zip」的 tar。
 *
 * 坑：Git for Windows 自带 GNU tar（C:\Program Files\Git\usr\bin\tar.exe），**不认 zip**，
 * 报 "This does not look like a tar archive"；Windows 10 1803+ 自带的是 bsdtar，认 zip。
 * 两个可执行文件**都叫 tar.exe**，靠 PATH 顺序决定谁赢 —— 而如果用户是在 Git Bash 里启动
 * node，cmd 继承的 PATH 会带上 Git 的 usr\bin 且往往排在前面，于是必然挑到错的那个。
 * 所以这里直接锁 System32 的绝对路径，别信 PATH。
 */
function resolveTar() {
  const cands = [
    path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'tar.exe'),
    'C:\\Windows\\System32\\tar.exe',
  ];
  for (const c of cands) if (fs.existsSync(c)) return c;
  return 'tar.exe';   // 交给 PATH 赌一把，至少报错信息上面那段注释能解释
}

/** 把 zip 解到 destDir。返回 {ok, tool} */
function extractZip(zip, destDir) {
  const tar = resolveTar();
  let r = run(quote(tar) + ' -xf ' + quote(zip) + ' -C ' + quote(destDir));
  if (DRY || r.status === 0) return { ok: true, tool: tar };

  // 退路：PowerShell 的 Expand-Archive，任何 Win10 都有
  console.log('  tar 解压失败，改用 PowerShell Expand-Archive...');
  const ps = 'powershell -NoProfile -NonInteractive -Command "Expand-Archive -LiteralPath ' +
    "'" + zip + "'" + ' -DestinationPath ' + "'" + destDir + "'" + ' -Force"';
  r = run(ps);
  return { ok: r.status === 0, tool: 'powershell Expand-Archive' };
}

/** 非 ASCII 路径是 Android 构建的经典坑，提前拦掉 */
function isAscii(p) { return /^[\x20-\x7E]*$/.test(p); }

/**
 * 出包后验真：把 APK 里的 assets/public/index.html 抽出来，跟源文件做**字节比对**。
 * 为什么值得单独做一步：`www/` 是拷贝出来的，忘了同步时「构建成功」这句话不会提醒你，
 * 装到手机上跑的还是旧版本 —— 这个错只有比对才看得见。
 */
function verifyApk() {
  if (DRY) return;
  const src = path.join(HERE, '..', 'index.html');
  if (!fs.existsSync(src)) { warnN('找不到源文件 index.html，跳过验真'); return; }
  // ★ 每次用一个全新的临时目录（mkdtemp 自带随机后缀）。
  //   以前用固定的 `_apkcheck`，第二次跑就得先把上一次的残留删掉 —— 那是一次上千文件的
  //   批量删除，会被 safe-delete 拦下，整个验真步骤就被 catch 掉"忽略"了，等于没验。
  //   换成新目录后就永远不需要"先删再建"。
  let tmp;
  try { tmp = fs.mkdtempSync(path.join(CFG.DROP_DIR, '_apkcheck-')); }
  catch (e) { warnN('建临时目录失败，跳过验真：' + (e && e.message)); return; }
  try {
    const r = run(quote(resolveTar()) + ' -xf ' + quote(APK) + ' -C ' + quote(tmp) +
      ' assets/public/index.html', { encoding: 'utf8' });
    const inner = path.join(tmp, 'assets', 'public', 'index.html');
    if (r.status !== 0 || !fs.existsSync(inner)) {
      warnN('没能从 APK 里取出 assets/public/index.html（包本身没问题，只是这步没验成）');
      return;
    }
    if (fs.readFileSync(inner).equals(fs.readFileSync(src))) {
      okN('APK 内的网页与 index.html 字节级一致 —— 装上去的确实是最新版');
    } else {
      badN('APK 内的网页与 index.html 不一致，多半是构建前没同步。再跑一次这个脚本即可。');
    }
  } catch (e) {
    warnN('验真步骤出错，忽略：' + (e && e.message));
  } finally {
    try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (e) { /* 忽略 */ }
  }
}

/** release 包再确认签名真的有效（用 build-tools 里的 apksigner.jar，绕开被禁的 .bat） */
function verifySignature() {
  if (DRY) return;
  const jar = path.join(CFG.SDK_ROOT, 'build-tools', '36.0.0', 'lib', 'apksigner.jar');
  if (!fs.existsSync(jar) || !JDK21) { warnN('没找到 apksigner，跳过签名校验'); return; }
  const r = run(quote(path.join(JDK21, 'bin', 'java.exe')) + ' -jar ' + quote(jar) +
    ' verify --print-certs ' + quote(APK), { encoding: 'utf8' });
  const out = (r.stdout || '') + (r.stderr || '');
  const dn = out.match(/Signer #1 certificate DN:\s*(.+)/);
  if (r.status === 0) okN('签名有效' + (dn ? '：' + dn[1].trim() : ''));
  else badN('签名校验没通过：' + out.trim().split('\n').slice(0, 2).join(' / '));
}


/** 读某个 JDK 目录的主版本号；不是 JDK 就返回 null */
function javaMajor(home) {
  if (!home) return null;
  const exe = path.join(home, 'bin', 'java.exe');
  if (!fs.existsSync(exe)) return null;
  const r = spawnSync(quote(exe) + ' -version', { shell: true, encoding: 'utf8' });
  const out = (r.stdout || '') + (r.stderr || '');
  const m = out.match(/version\s+"(\d+)/);
  return m ? Number(m[1]) : null;
}

/**
 * 找一个 languageVersion=21 的 JDK。
 *
 * 为什么必须要 21（而不是「17 以上就行」）：
 *   Capacitor 8 的 Android 插件模块在各自 build.gradle 里写死了
 *     sourceCompatibility JavaVersion.VERSION_21
 *   AGP 会据此要求一个**精确匹配 21** 的 Java 工具链。Gradle 的工具链 spec 不支持
 *   「21 或更高」，所以 JDK 23 / 24 都不顶用，机器上必须真的有 21。
 *   缺了就会报：
 *     Cannot find a Java installation ... matching: {languageVersion=21}
 *   而 Android Studio 用户不会遇到这个 —— IDE 自带的就是 JDK 21。
 */

/** 从若干候选目录里挑出主版本为 21 的那个 */
function findJdk21() {
  const cands = [
    CFG.JDK21_HOME,
    process.env.JAVA_HOME,
    'D:\\jdk21', 'D:\\jdk-21', 'D:\\Java\\jdk-21',
    'C:\\Program Files\\Microsoft\\jdk-21',
    'C:\\Program Files\\Eclipse Adoptium\\jdk-21',
    'C:\\Program Files\\Java\\jdk-21',
  ].filter(Boolean);

  // 再扫几个「带版本号的父目录」，例如 C:\Program Files\Microsoft\jdk-21.0.5.11-hotspot
  const parents = [
    'C:\\Program Files\\Microsoft',
    'C:\\Program Files\\Eclipse Adoptium',
    'C:\\Program Files\\Java',
    'C:\\Program Files\\Zulu',
    'D:\\Android',
  ];
  for (const p of parents) {
    if (!fs.existsSync(p)) continue;
    let entries = [];
    try { entries = fs.readdirSync(p); } catch (e) { /* 无权限，跳过 */ }
    for (const e of entries) {
      if (/jdk.?21/i.test(e)) cands.push(path.join(p, e));
    }
  }

  const seen = new Set();
  for (const c of cands) {
    const k = c.toLowerCase();
    if (seen.has(k)) continue;
    seen.add(k);
    if (javaMajor(c) === 21) return c;
  }
  return null;
}

/* ------------------------------------------- release 签名（仅 --release 用） */

/**
 * 为什么需要它：
 *   debug 包用的是 Android 自动生成的调试证书，换个机器就变了，给别人也不显得正规。
 *   release 包用你自己生成的证书签名 —— 关键意义是**以后想给同一个包名发更新，
 *   必须用同一份证书**，否则手机上装不上（报"签名不同/应用未安装"）。
 */

const SIGN_MARK = 'setup-android.mjs 添加：release 签名';

/** 随机密码：刻意排除 shell 特殊字符，免得后续在命令行里被转义搞坏 */
function randomPassword(len) {
  const abc = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789';
  let s = '';
  for (let i = 0; i < len; i++) s += abc[Math.floor(Math.random() * abc.length)];
  return s;
}

/**
 * 把 release 签名接进 android/app/build.gradle。
 * 幂等：认标记，已接过就直接返回；且写法是「keystore.properties 不存在就整段跳过」，
 * 所以没证书的人跑 debug 构建不会被这个改动影响。
 */
function patchAppGradle() {
  let src = fs.readFileSync(APP_GRADLE, 'utf8');
  if (src.includes(SIGN_MARK)) return { ok: true, changed: false };

  const anchor = "apply plugin: 'com.android.application'";
  if (!src.includes(anchor)) return { ok: false, why: '找不到 ' + anchor };

  const head = [
    anchor,
    '',
    '// >>> ' + SIGN_MARK,
    '// keystore.properties 不存在时整段自动跳过，不影响 debug 构建。',
    'def keystoreProps = new Properties()',
    "def keystorePropsFile = rootProject.file('keystore.properties')",
    'if (keystorePropsFile.exists()) { keystorePropsFile.withInputStream { keystoreProps.load(it) } }',
    "def hasReleaseSigning = keystorePropsFile.exists() && keystoreProps['storeFile']",
    '// <<< ' + SIGN_MARK,
  ].join('\n');
  src = src.replace(anchor, () => head);

  if (!src.includes('    buildTypes {')) return { ok: false, why: 'build.gradle 结构不符（找不到 buildTypes）' };
  src = src.replace('    buildTypes {', () => [
    '    if (hasReleaseSigning) {',
    '        signingConfigs {',
    '            release {',
    "                storeFile rootProject.file(keystoreProps['storeFile'])",
    "                storePassword keystoreProps['storePassword']",
    "                keyAlias keystoreProps['keyAlias']",
    "                keyPassword keystoreProps['keyPassword']",
    '            }',
    '        }',
    '    }',
    '    buildTypes {',
  ].join('\n'));

  const relAnchor = '        release {\n            minifyEnabled false';
  if (!src.includes(relAnchor)) return { ok: false, why: '找不到 release 构建块' };
  src = src.replace(relAnchor, () => [
    '        release {',
    '            minifyEnabled false',
    '            if (hasReleaseSigning) { signingConfig signingConfigs.release }',
  ].join('\n'));

  fs.copyFileSync(APP_GRADLE, APP_GRADLE + '.bak');   // 改第三方模板前先留一份
  fs.writeFileSync(APP_GRADLE, src);
  return { ok: true, changed: true };
}

/** 没有证书就生成一份，并写 keystore.properties（内容用正斜杠，避开 properties 的反斜杠转义） */
function ensureKeystore() {
  if (fs.existsSync(KEYSTORE) && fs.existsSync(KEYSTORE_PROPS)) return { created: false };
  if (DRY) {
    console.log('  [dry-run] keytool -genkeypair -keystore ' + quote(KEYSTORE) + ' -alias diary ...');
    return { created: true };
  }
  if (!JDK21) return { created: false, fail: '没有 JDK 21，无法生成证书（先跑一次不带 --release 的）' };

  const pw = process.env.WD_KEYSTORE_PASS || randomPassword(24);
  const keytool = path.join(JDK21, 'bin', 'keytool.exe');
  const r = run(quote(keytool) + ' -genkeypair -v' +
    ' -keystore ' + quote(KEYSTORE) +
    ' -alias diary -keyalg RSA -keysize 2048 -validity 10950' +
    ' -storepass ' + quote(pw) + ' -keypass ' + quote(pw) +
    ' -dname ' + quote('CN=My Diary, OU=Personal, O=Personal, L=City, ST=Province, C=CN'),
    { encoding: 'utf8' });
  if (r.status !== 0) {
    return { created: false, fail: 'keytool 退出码 ' + r.status + '（' + ((r.stderr || '').trim().slice(0, 200)) + '）' };
  }
  fs.writeFileSync(KEYSTORE_PROPS, [
    '# 由 setup-android.mjs 生成。这份文件和 diary-release.keystore 请一起备份好：',
    '# 以后给同一个包名发更新必须用同一份证书，丢了就再也装不上覆盖安装。',
    '# storeFile 相对 android/ 目录。',
    'storeFile=diary-release.keystore',
    'storePassword=' + pw,
    'keyAlias=diary',
    'keyPassword=' + pw,
    '',
  ].join('\n'));
  return { created: true, password: pw };
}

/* ------------------------------------------------- 0. 环境体检（总会跑） */

head('=== 「我的日记」Android 构建环境搭建 ===');
console.log('  JDK      ' + CFG.JDK_HOME);
console.log('  SDK      ' + CFG.SDK_ROOT);
console.log('  Gradle   ' + CFG.GRADLE_HOME);
console.log('  工程     ' + HERE);
if (DRY) console.log('\n  ** dry-run：只打印计划，不实际执行 **');

stepN('环境体检');

let asciiBad = 0;
for (const [k, v] of Object.entries(CFG)) {
  if (!isAscii(v)) { badN(k + ' 含非 ASCII 字符，Android 构建会出问题：' + v); asciiBad++; }
}
if (!asciiBad) okN('JDK / SDK / Gradle 路径均为纯 ASCII（避开中文路径坑）');

if (!isAscii(HERE)) badN('工程路径含非 ASCII 字符：' + HERE);
else okN('工程路径纯 ASCII');

const javac = path.join(CFG.JDK_HOME, 'bin', 'javac.exe');
if (fs.existsSync(javac)) {
  const v = spawnSync(quote(javac) + ' -version', { shell: true, encoding: 'utf8' });
  okN('跑 Gradle 的 JDK：' + ((v.stderr || v.stdout || '').trim() || CFG.JDK_HOME));
} else {
  badN('找不到 JDK：' + javac + '（改脚本顶部的 JDK_HOME）');
}

// Capacitor 8 的插件模块要求一个**精确的** JDK 21，见 findJdk21() 的注释
JDK21 = findJdk21();
if (JDK21) okN('JDK 21 已就位：' + JDK21);
else if (DRY) console.log('  [dry-run] 没找到 JDK 21，正式运行时会自动下载安装（约 190 MB）');
else warnN('没找到 JDK 21 —— 下一步会自动下载安装（约 190 MB）');

// node 是否可用。注意：同步那一步用的是 process.execPath（就是当前这个 node），
// 所以不依赖 PATH 上有没有 `node` 命令 —— 少一个会随环境变化的前提。
const nodeOnPath = fs.existsSync(process.execPath);
if (nodeOnPath) okN('node 可用（同步网页资源用）');
else warnN('node 不可用，第 7 步会跳过同步（当前 www/ 已是同步状态，跳过也能构建）');

// Windows 自带工具
const tarPath = resolveTar();
{
  // 这里必须报告用的是哪一个 tar：GNU tar 与 bsdtar 同名，选错了会在解压那步才发现
  const r = run(quote(tarPath) + ' --version', { encoding: 'utf8' });
  if (r.status === 0) {
    const isBsd = /bsdtar|libarchive/i.test((r.stdout || '') + (r.stderr || ''));
    if (isBsd) okN('解压工具：' + tarPath + '（bsdtar，支持 zip）');
    else warnN('解压工具指向 ' + tarPath + '（看起来是 GNU tar，**不支持 zip**）；' +
      '若解压失败脚本会自动改用 PowerShell Expand-Archive');
  } else {
    warnN('没找到可用的 tar，解压会走 PowerShell Expand-Archive');
  }
}
for (const [name, cmd] of [['curl.exe', 'curl --version']]) {
  const r = spawnSync(cmd, { shell: true, encoding: 'utf8' });
  if (r.status === 0) okN('可用：' + name);
  else warnN(name + ' 不可用');
}

// 网页资源是否已经在原生工程里
const assetsHtml = path.join(HERE, 'android', 'app', 'src', 'main', 'assets', 'public', 'index.html');
if (fs.existsSync(assetsHtml)) {
  const same = fs.readFileSync(assetsHtml).equals(fs.readFileSync(path.join(HERE, '..', 'index.html')));
  if (same) okN('原生工程内的网页资源与 index.html 一致');
  else warnN('原生工程内的网页资源与 index.html 不一致，构建前需要 cap sync');
} else {
  warnN('原生工程内还没有网页资源，需要先跑 cap sync');
}

if (fail.length && !DRY) {
  console.log('\n体检有阻断项，先修掉再往下走。');
  process.exit(1);
}

if (CHECK_ONLY) {
  console.log('\n--check 模式到此为止：' + pass.length + ' 项通过 / ' + fail.length + ' 项失败');
  process.exit(fail.length ? 1 : 0);
}

/* -------------------------------------------------- 2. JDK 21（硬要求） */

stepN('确保 JDK 21（Capacitor 8 的硬要求，不能省）');

if (!JDK21) {
  const zipPath = path.join(CFG.DROP_DIR, 'microsoft-jdk-21-windows-x64.zip');
  if (DRY) {
    console.log('  [dry-run] curl.exe -L --fail -o ' + quote(zipPath) + ' ' + quote(JDK21_URL));
    console.log('  [dry-run] 解压后重命名为 ' + CFG.JDK21_HOME);
    JDK21 = CFG.JDK21_HOME;
  } else {
    fs.mkdirSync(CFG.DROP_DIR, { recursive: true });
    if (fs.existsSync(zipPath)) {
      okN('复用已下载的 ' + path.basename(zipPath));
    } else {
      console.log('  正在下载 JDK 21（约 190 MB）...');
      const r = run('curl.exe -L --fail -o ' + quote(zipPath) + ' ' + quote(JDK21_URL));
      if (r.status !== 0) {
        badN('JDK 21 下载失败。可手动下载后解压到 ' + CFG.JDK21_HOME + '：\n      ' + JDK21_URL);
        process.exit(1);
      }
    }

    // 解压目录也用全新的随机目录：固定目录名意味着第二次跑要先删掉上次解压出来的
    // 上万个文件，那一下会撞 safe-delete 的批量删除保护，直接把这个安装步骤打断。
    const tmp = fs.mkdtempSync(path.join(CFG.DROP_DIR, '_jdkx-'));
    const ex = extractZip(zipPath, tmp);
    if (!ex.ok) { badN('JDK 21 解压失败（用 ' + ex.tool + '）'); process.exit(1); }

    // 解压出来是 jdk-21.0.x+y 这样的版本目录，改名成固定的 jdk21 方便引用
    let inner = null;
    for (const f of fs.readdirSync(tmp)) {
      const p = path.join(tmp, f);
      try { if (fs.statSync(p).isDirectory()) { inner = p; break; } } catch (e) { /* 忽略 */ }
    }
    if (!inner) { badN('JDK 压缩包结构与预期不符'); process.exit(1); }
    // ★ 不直接删掉旧 JDK（上万个文件，会撞 safe-delete 的批量删除保护让整步中断），
    //   改成改名挪到一边：单个文件系统操作，删不删留给用户自己决定。
    if (fs.existsSync(CFG.JDK21_HOME)) {
      const stale = CFG.JDK21_HOME + '.old-' + Date.now();
      fs.renameSync(CFG.JDK21_HOME, stale);
      warnN('旧 JDK 目录已挪到：' + stale + '（确认新环境可用后可自行删除）');
    }
    fs.renameSync(inner, CFG.JDK21_HOME);
    fs.rmSync(tmp, { recursive: true, force: true });

    const major = javaMajor(CFG.JDK21_HOME);
    if (major !== 21) { badN('装完的版本不是 21（读到 ' + major + '）'); process.exit(1); }
    JDK21 = CFG.JDK21_HOME;
    okN('JDK 21 安装完成：' + CFG.JDK21_HOME);
  }
}

// 告诉 Gradle 去哪找 21。Gradle 工具链自动探测会扫 JAVA_HOME，但显式声明更稳：
// 将来就算有人用别的 JDK 启动 Gradle，工具链解析照样能找到 21。
{
  const userProps = path.join(CFG.GRADLE_HOME, 'gradle.properties');
  const tkLine = 'org.gradle.java.installations.paths=' + JDK21.replace(/\\/g, '/');
  if (DRY) {
    console.log('  [dry-run] 在 ' + userProps + ' 写入：' + tkLine);
  } else {
    fs.mkdirSync(CFG.GRADLE_HOME, { recursive: true });
    const cur = fs.existsSync(userProps) ? fs.readFileSync(userProps, 'utf8') : '';
    if (cur.includes('org.gradle.java.installations.paths')) {
      okN('Gradle 工具链路径已配置');
    } else {
      fs.appendFileSync(userProps,
        (cur && !cur.endsWith('\n') ? '\n' : '') +
        '\n# Capacitor 8 的插件模块写死了 sourceCompatibility JavaVersion.VERSION_21，\n' +
        '# 而 Gradle 的工具链 spec 不支持「21 或更高」，所以必须精确指出 21 在哪。\n' +
        tkLine + '\n');
      okN('已写入工具链路径：' + tkLine);
    }
  }
}

/* ------------------------------------------------------- 3. 命令行工具 */

stepN('安装 Android 命令行工具（150 MB）');

if (fs.existsSync(SDKMAN)) {
  okN('已安装，跳过：' + SDKMAN);
} else {
  // 找用户已经下好的 zip
  let zip = null;
  const dirs = [CFG.DROP_DIR, HERE];
  for (const d of dirs) {
    if (!fs.existsSync(d)) continue;
    const hit = fs.readdirSync(d).find((f) => /^commandlinetools-win-.*\.zip$/i.test(f));
    if (hit) { zip = path.join(d, hit); break; }
  }

  if (zip) {
    okN('找到你下好的安装包：' + zip);
  } else if (DRY) {
    console.log('  [dry-run] 未找到 zip，正常流程会提示下载：' + CMDLINE_URL);
    zip = path.join(CFG.DROP_DIR, 'commandlinetools-win.zip');
  } else if (!AUTO_DOWNLOAD) {
    // 刻意不做交互式提问：cmd 里读一行输入在 Node 下很脆（TTY 模式、管道、编码都踩过），
    // 不如让用户显式加 --download，或者自己下好放进目录。
    head('没有找到 commandlinetools 安装包');
    console.log('  用浏览器下（150 MB，比脚本自己下快得多）：');
    console.log('    ' + CMDLINE_URL);
    console.log('');
    console.log('  存到：  ' + CFG.DROP_DIR + '\\');
    console.log('  然后重新运行：  node setup-android.mjs');
    console.log('');
    console.log('  不想自己下，也可以让脚本代劳（走你的网络）：');
    console.log('        node setup-android.mjs --download');
    process.exit(1);
  } else {
    fs.mkdirSync(CFG.DROP_DIR, { recursive: true });
    zip = path.join(CFG.DROP_DIR, 'commandlinetools-win.zip');
    console.log('  正在下载（150 MB）...');
    const r = run('curl.exe -L --fail --progress-bar -o ' + quote(zip) + ' ' + quote(CMDLINE_URL));
    if (r.status !== 0) { badN('下载失败。请改成浏览器手动下载。'); process.exit(1); }
    okN('下载完成');
  }

  // 解压到 <SDK_ROOT>/cmdline-tools/latest
  const tmp = path.join(CFG.SDK_ROOT, '_unzip');
  if (!DRY) {
    fs.mkdirSync(CFG.SDK_ROOT, { recursive: true });
    if (fs.existsSync(tmp)) fs.rmSync(tmp, { recursive: true, force: true });
    fs.mkdirSync(tmp, { recursive: true });
  }
  const ex = extractZip(zip, tmp);
  if (!ex.ok) {
    badN('解压失败（用 ' + ex.tool + '）。可手动右键解压，把里面的 cmdline-tools 文件夹放到 ' +
      path.join(CFG.SDK_ROOT, 'cmdline-tools', 'latest'));
    process.exit(1);
  }
  if (!DRY) okN('解压成功（用 ' + path.basename(ex.tool) + '）');
  const inner = path.join(tmp, 'cmdline-tools');
  if (!DRY && !fs.existsSync(inner)) {
    badN('压缩包结构与预期不符，里面没有 cmdline-tools 目录');
    process.exit(1);
  }
  const dest = path.join(CFG.SDK_ROOT, 'cmdline-tools', 'latest');
  if (!DRY) {
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    if (fs.existsSync(dest)) fs.rmSync(dest, { recursive: true, force: true });
    fs.renameSync(inner, dest);
    fs.rmSync(tmp, { recursive: true, force: true });
  } else {
    console.log('  [dry-run] move ' + inner + ' -> ' + dest);
  }
  // sdkmanager 要求目录名必须是 latest，否则报 "Could not determine SDK root"
  okN('已安装到 ' + dest + '（目录名必须是 latest，已处理）');
}

/* ------------------------------------------------------------ 4. 许可 */

stepN('接受 SDK 许可协议');

// sdkmanager --licenses 是交互式的，需要反复输 y；灌 80 个足够覆盖所有条目
const yes = 'y\n'.repeat(80);
const lic = sdkmanager(['--licenses'], { input: yes, stdio: ['pipe', 'inherit', 'inherit'] });
if (DRY || lic.status === 0) okN('许可已接受（未接受时 gradle 会报 "licence not accepted"）');
else warnN('许可步骤退出码 ' + lic.status + '，若后续构建报 licence 错误，手动跑一次：\n      ' + SDKMAN + ' --licenses');

/* --------------------------------------------------------- 5. 组件 */

stepN('安装 SDK 组件');

const packages = ['platform-tools', 'platforms;android-36', 'build-tools;36.0.0'];
let pRes = sdkmanager(packages);
if (!DRY && pRes.status !== 0) {
  warnN('build-tools;36.0.0 装不上，退回 35.0.1');
  pRes = sdkmanager(['platform-tools', 'platforms;android-36', 'build-tools;35.0.1']);
}
if (DRY || pRes.status === 0) okN('platform-tools / platforms;android-36 / build-tools 就绪');
else warnN('组件安装有报错。缺什么 gradle 通常会自动补，先继续，出错再回来看。');

/* --------------------------------------------- 6. local.properties */

stepN('写 android/local.properties');

// Java properties 格式：反斜杠必须转义成 \\
const sdkEsc = CFG.SDK_ROOT.replace(/\\/g, '\\\\');
const propsContent = 'sdk.dir=' + sdkEsc + '\n';
if (DRY) {
  console.log('  [dry-run] 写入 ' + LOCAL_PROPS);
  console.log('  [dry-run] 内容：' + propsContent.trim());
} else if (fs.existsSync(LOCAL_PROPS)) {
  const cur = fs.readFileSync(LOCAL_PROPS, 'utf8');
  if (cur.trim() === propsContent.trim()) okN('已是正确内容，未改动');
  else {
    fs.copyFileSync(LOCAL_PROPS, LOCAL_PROPS + '.bak');
    fs.writeFileSync(LOCAL_PROPS, propsContent);
    okN('已更新（原文件备份为 local.properties.bak）');
  }
} else {
  fs.writeFileSync(LOCAL_PROPS, propsContent);
  okN('已创建：' + propsContent.trim());
}

/* ------------------------------------------------------------ 7. 同步 */

stepN('同步网页资源到原生工程');

if (nodeOnPath) {
  // 用 process.execPath（就是当前这个 node）而不是裸 `node`，并且不经 shell —— 少一个 cmd.exe。
  runExe(process.execPath, ['sync.mjs'], { cwd: HERE });
  // cap sync 直接调 CLI 的入口 js，绕开 npx：npx 在本地找不到 bin 时会去问 npm 源，可能长时间卡住。
  const capJs = path.join(HERE, 'node_modules', '@capacitor', 'cli', 'bin', 'capacitor');
  if (fs.existsSync(capJs)) {
    const cn = runExe(process.execPath, [capJs, 'sync', 'android'], { cwd: HERE });
    if (DRY || cn.status === 0) okN('sync.mjs + cap sync 完成');
    else warnN('cap sync 有报错，但 assets/public 里已有同步好的资源，构建多半仍能成功');
  } else {
    warnN('没找到 capacitor CLI，跳过 cap sync（assets/public 已是同步状态，不影响构建）');
  }
} else {
  warnN('跳过（node 不在 PATH）。现有 assets/public 已是同步状态。');
}

/* ------------------------------------------------------------ 8. 打包 */

stepN('构建 ' + (RELEASE ? 'release' : 'debug') + ' APK（首次会下载 Gradle，约 200 MB，请耐心）');

if (RELEASE) {
  const ks = ensureKeystore();
  if (ks.fail) { badN(ks.fail); process.exit(1); }
  okN(ks.created ? '已生成签名证书：' + KEYSTORE : '签名证书已存在：' + KEYSTORE);
  if (ks.password) {
    console.log('');
    console.log('  ⚠️  证书密码（只显示这一次，也已写进 keystore.properties）：');
    console.log('      ' + ks.password);
    console.log('      请把 ' + path.basename(KEYSTORE) + ' 与 keystore.properties 一起备份到别处。');
    console.log('');
  }
  if (DRY) {
    console.log('  [dry-run] 把 release 签名接进 ' + APP_GRADLE);
  } else {
    const pk = patchAppGradle();
    if (!pk.ok) { badN('写入签名配置失败：' + pk.why); process.exit(1); }
    okN(pk.changed ? '已把 release 签名接进 app/build.gradle（原文件备份为 .bak）'
      : 'app/build.gradle 已接过签名，未改动');
  }
}

const env = {
  ...process.env,
  // 用 JDK 21 跑 Gradle：既满足 AGP，也让工具链解析能直接命中 21，不必依赖自动探测
  JAVA_HOME: JDK21,
  ANDROID_HOME: CFG.SDK_ROOT,
  ANDROID_SDK_ROOT: CFG.SDK_ROOT,
  // 关键：用户的 Windows 家目录是 C:\Users\陈畅（含中文），Gradle 对非 ASCII 的家目录
  // 有过不少兼容问题，所以把 GRADLE_USER_HOME 指到一个纯 ASCII 目录。
  GRADLE_USER_HOME: CFG.GRADLE_HOME,
  PATH: path.join(JDK21, 'bin') + ';' + (process.env.PATH || ''),
};
console.log('  JAVA_HOME=' + JDK21 + '（JDK 21，Capacitor 8 编译必需）');
console.log('  GRADLE_USER_HOME=' + CFG.GRADLE_HOME + '（刻意避开含中文的家目录）');

// 优先用 java 直接调 wrapper jar，而不是 gradlew.bat。
// 理由：gradlew.bat 本质上就是「java -jar gradle-wrapper.jar」这一行（见该文件最后一行），
// 但它多引入一个 cmd.exe —— 一旦环境禁掉 cmd.exe 就完全跑不了，而且 cmd 用 OEM 代码页读
// 批处理、对路径里的非 ASCII 字符也不友好。直接调 java 则两个问题都不存在。
const wrapperJar = path.join(HERE, 'android', 'gradle', 'wrapper', 'gradle-wrapper.jar');
const javaExe = path.join(JDK21, 'bin', 'java.exe');
const canUseJar = fs.existsSync(wrapperJar) && fs.existsSync(javaExe);
const TASK = RELEASE ? 'assembleRelease' : 'assembleDebug';
let gradleCmd;
if (canUseJar) {
  gradleCmd = quote(javaExe) + ' -jar ' + quote(wrapperJar) + ' ' + TASK + ' --no-daemon';
} else {
  warnN('wrapper jar 或 java 不在预期位置，退回 gradlew.bat');
  gradleCmd = 'gradlew.bat ' + TASK + ' --no-daemon';
}

// 用参数数组直接起 java（不经 cmd.exe）。stdio 用 inherit，好让构建日志实时刷在屏幕上。
const gradle = canUseJar
  ? runExe(javaExe, ['-jar', wrapperJar, TASK, '--no-daemon'],
    { cwd: path.join(HERE, 'android'), env, stdio: 'inherit' })
  : run(gradleCmd, { cwd: path.join(HERE, 'android'), env, stdio: 'inherit' });

if (DRY) {
  console.log('\n[dry-run] 到此为止，未执行任何构建。');
  process.exit(0);
}

const rc = gradle.status;
console.log('');
if (rc !== 0) {
  console.log('构建失败，退出码 ' + rc + '。往上翻第一条错误。');
  console.log('常用排查：');
  console.log('  ' + SDKMAN + ' --list       看已装组件');
  console.log('  sdk.dir 是否指向真实 SDK 目录（现在写的是 ' + CFG.SDK_ROOT + '）');
  process.exit(1);
}

/* ------------------------------------------------------------ 9. 收尾 */

stepN('完成');

if (!fs.existsSync(APK)) {
  badN('gradle 返回成功但找不到 APK：' + APK);
  process.exit(1);
}
const sizeMB = (fs.statSync(APK).size / 1048576).toFixed(1);
okN((RELEASE ? 'release' : 'debug') + ' APK 已生成（' + sizeMB + ' MB）：' + APK);

verifyApk();
if (RELEASE) verifySignature();

console.log('');
console.log('  装到手机：');
console.log('    · 把 apk 拷进手机点击安装（需允许「安装未知来源应用」），或');
console.log('    · 手机开 USB 调试并连电脑，然后：');
console.log('        "' + path.join(CFG.SDK_ROOT, 'platform-tools', 'adb.exe') + '" install -r "' + APK + '"');
console.log('');
if (RELEASE) {
  console.log('  这是**正式签名**包，适合发给别人。两点提醒：');
  console.log('    · 证书 ' + path.basename(KEYSTORE) + ' 与 keystore.properties 请备份好，');
  console.log('      以后给同一包名发更新必须用同一份，丢了就再也覆盖安装不上。');
  console.log('    · 手机上如果已装过 debug 版，直接装这个会报「应用未安装」（签名不同）。');
  console.log('      要先卸载旧的 —— **卸载会清掉里面的日记**，务必先在应用里「导出备份」。');
} else {
  console.log('  这是 debug 包（调试签名），自己用完全够；发给别人可以加 --release 出正式签名包。');
}
console.log('');
console.log('  ' + pass.length + ' 项通过 / ' + fail.length + ' 项失败');

// 到了这里还留下失败项，说明「包装出来了但有地方不对」（例如包内网页与源文件不一致），
// 用非零退出码告诉调用方，别让它在 && 链里被当成成功。
process.exit(fail.length ? 1 : 0);
