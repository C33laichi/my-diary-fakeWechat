#!/usr/bin/env node
/**
 * 「我的日记」Android 打包前置体检
 *
 * 为什么要有它：本机还没装 Android Studio，跑不了 gradle，于是所有问题都要等到
 * 装完 10GB 环境、敲下 assembleDebug 之后才暴露。而其中一类问题（比如 XML 注释里
 * 出现 `--`）在编辑器里完全看不出，只有 AAPT 会报，排查成本极高。
 * 这个脚本把所有能静态检查的坑提前抓出来，零依赖、秒级返回。
 *
 * 用法：
 *     cd mobile
 *     node tools/preflight.mjs
 *
 * 退出码 0 = 全部通过；1 = 存在阻断性问题（照着提示改）。
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const MOBILE = path.resolve(HERE, '..');
const ROOT = path.resolve(MOBILE, '..');
const ANDROID = path.join(MOBILE, 'android');
const MAIN = path.join(ANDROID, 'app', 'src', 'main');
const RES = path.join(MAIN, 'res');
const SRC = path.join(ROOT, 'index.html');
const WWW = path.join(MOBILE, 'www', 'index.html');

let pass = 0;
const fails = [];
const warns = [];
const ok = (m) => { pass++; console.log('  \u2713 ' + m); };
const bad = (m) => { fails.push(m); console.log('  \u2717 ' + m); };
const warn = (m) => { warns.push(m); console.log('  ! ' + m); };
const group = (t) => console.log('\n' + t);
const rel = (p) => path.relative(MOBILE, p).replace(/\\/g, '/');

/* ------------------------------------------------------------------ *
 * 迷你 XML 良构校验器
 *
 * 不追求完整实现，只覆盖 AAPT 真正会卡住的那几类：注释里的 `--`、
 * 未闭合标签、错配嵌套、裸 `&` 与裸 `<`。够用且零依赖。
 * ------------------------------------------------------------------ */
function validateXml(text) {
  const errors = [];

  // 1) 注释：剥掉的同时检查 `--`
  let stripped = '';
  let last = 0;
  const commentRe = /<!--([\s\S]*?)-->/g;
  let m;
  while ((m = commentRe.exec(text)) !== null) {
    if (m[1].includes('--')) errors.push('注释体里出现 `--`（XML 规范禁止，AAPT 直接报错）');
    stripped += text.slice(last, m.index);
    last = m.index + m[0].length;
  }
  stripped += text.slice(last);
  if (stripped.includes('<!--')) errors.push('注释没有闭合，缺少 `-->`');

  // 2) 剥掉声明 / 处理指令 / CDATA / DOCTYPE
  stripped = stripped
    .replace(/<\?[\s\S]*?\?>/g, '')
    .replace(/<!\[CDATA\[[\s\S]*?\]\]>/g, '')
    .replace(/<!DOCTYPE[^>]*>/gi, '');

  // 3) 裸 `&`（必须是合法实体或数字引用）
  const bareAmp = stripped.match(/&(?!(?:[A-Za-z][A-Za-z0-9]*|#[0-9]+|#x[0-9A-Fa-f]+);)/);
  if (bareAmp) errors.push('出现未转义的 `&`（应写成 &amp;）');

  // 4) 标签栈
  const stack = [];
  const tagRe = /<(\/?)([A-Za-z_][\w.\-:]*)((?:\s[^<>]*?)?)(\/?)\s*>/g;
  let consumed = 0;
  let t;
  while ((t = tagRe.exec(stripped)) !== null) {
    const between = stripped.slice(consumed, t.index);
    consumed = tagRe.lastIndex;
    if (between.includes('<')) errors.push('出现未转义的 `<`（应写成 &lt;）');
    if (t[4] === '/') continue;               // 自闭合
    const name = t[2];
    if (t[1] === '/') {
      if (!stack.length) errors.push('多余的闭合标签 </' + name + '>');
      else {
        const top = stack.pop();
        if (top !== name) errors.push('嵌套不匹配：<' + top + '> 被 </' + name + '> 闭合');
      }
    } else {
      stack.push(name);
    }
  }
  if (stripped.slice(consumed).includes('<')) errors.push('文件尾部有未解析的 `<`');
  if (stack.length) errors.push('标签未闭合：<' + stack.join('> <') + '>');

  return errors;
}

function walkXml(dir, out = []) {
  if (!fs.existsSync(dir)) return out;
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walkXml(p, out);
    else if (e.name.endsWith('.xml')) out.push(p);
  }
  return out;
}

/** 读 PNG 头部拿到真实像素尺寸（IHDR 固定在第 16~23 字节） */
function pngSize(file) {
  const buf = fs.readFileSync(file);
  if (buf.length < 24 || buf.readUInt32BE(0) !== 0x89504e47) return null;
  return { w: buf.readUInt32BE(16), h: buf.readUInt32BE(20) };
}

const read = (p) => (fs.existsSync(p) ? fs.readFileSync(p, 'utf8') : '');

console.log('=== 「我的日记」打包前置体检 ===');
console.log('工程：' + MOBILE.replace(/\\/g, '/'));

/* ================================================================== *
 * [A] 源文件 → www 同步
 * ================================================================== */
group('[A] 源文件 → www 同步');
const srcBuf = fs.existsSync(SRC) ? fs.readFileSync(SRC) : null;
const wwwBuf = fs.existsSync(WWW) ? fs.readFileSync(WWW) : null;
if (!srcBuf) bad('找不到源文件 ' + SRC.replace(/\\/g, '/'));
else if (!wwwBuf) bad('www/index.html 不存在 —— 先跑 `npm run sync`');
else if (!srcBuf.equals(wwwBuf)) {
  bad('www/index.html 与源文件内容不一致 —— 改完 index.html 必须重跑 `npm run sync`');
} else {
  ok('www/index.html 与 ../index.html 字节级一致（' + (srcBuf.length / 1024).toFixed(1) + ' KB）');
}

/* ================================================================== *
 * [B] 单文件完整性与原生层挂钩
 * ================================================================== */
group('[B] 单文件完整性与原生层挂钩');
const html = srcBuf ? srcBuf.toString('utf8') : '';

if (!html) {
  bad('拿不到 index.html 内容，跳过本节');
} else {
  // 外链守卫：与 sync.mjs 用同一套规则，这里再独立确认一遍
  const offenders = [];
  const attrRe = /(?:src|href)\s*=\s*["']([^"']+)["']/gi;
  let m;
  while ((m = attrRe.exec(html)) !== null) {
    const url = m[1].trim();
    if (!url) continue;
    if (/^(javascript:|#|data:|blob:)/i.test(url)) continue;
    offenders.push(url);
  }
  const imRe = /@import\s+[^;]+;/gi;
  while ((m = imRe.exec(html)) !== null) offenders.push(m[0].trim());

  if (offenders.length) {
    bad('有 ' + offenders.length + ' 处外部资源引用，打进 APK 必缺资源：'
      + [...new Set(offenders)].slice(0, 4).join(' / '));
  } else {
    ok('无外部资源引用，可安全内嵌进 APK');
  }

  // 原生层不能被回退掉，否则装成 App 后返回键直接退出、导出备份静默失效
  const hooks = [
    ['Native 运行时门控', /var Native\s*=\s*\(function\s*\(\)/],
    ['系统返回键分层消费', /function handleBackKey\s*\(/],
    ['返回键监听注册', /function bindNativeBackButton\s*\(/],
    ['状态栏主题同步', /function syncNativeStatusBar\s*\(/],
    ['原生导出备份', /function saveBackupFile\s*\(/],
    ['调试出口 window.__diary__', /window\.__diary__\s*=/],
  ];
  for (const [name, re] of hooks) {
    if (re.test(html)) ok('原生层在位：' + name);
    else bad('原生层缺失：' + name + ' —— index.html 可能被回退了');
  }

  // 网页版保护：非原生环境下必须短路，否则双击打开会报错
  if (/if\s*\(!Native\.isNative\)\s*return/.test(html)) ok('非原生环境全部短路（双击打开行为不变）');
  else warn('没找到 `if (!Native.isNative) return` 短路写法，请确认原生分支在浏览器里不会执行');

  // 用到的原生插件是否真的被调用
  const plugins = ['App', 'Camera', 'Filesystem', 'Share', 'StatusBar'];
  const missing = plugins.filter((p) => !html.includes("plugin('" + p + "')"));
  if (missing.length) bad('index.html 里没有调用这些插件：' + missing.join(' / '));
  else ok(plugins.length + ' 个原生插件在 index.html 里都有调用点');
}

/* ================================================================== *
 * [C] XML 资源合法性（含注释禁 `--`）
 * ================================================================== */
group('[C] XML 资源合法性');
const xmlFiles = [
  path.join(MAIN, 'AndroidManifest.xml'),
  ...walkXml(RES),
].filter((p) => fs.existsSync(p));

if (!xmlFiles.length) {
  bad('没找到任何 XML 资源 —— android/ 目录不完整？');
} else {
  let badCount = 0;
  for (const f of xmlFiles) {
    const errs = validateXml(read(f));
    if (errs.length) {
      badCount++;
      bad(rel(f) + ' → ' + errs.join('；'));
    }
  }
  if (!badCount) ok(xmlFiles.length + ' 个 XML 全部良构（含注释无 `--`）');
}

/* ================================================================== *
 * [D] 图标与启动图
 * ================================================================== */
group('[D] 图标与品牌资源');
const DENS = {
  'mipmap-mdpi': 48,
  'mipmap-hdpi': 72,
  'mipmap-xhdpi': 96,
  'mipmap-xxhdpi': 144,
  'mipmap-xxxhdpi': 192,
};
let iconBad = 0;
for (const [dir, size] of Object.entries(DENS)) {
  for (const name of ['ic_launcher.png', 'ic_launcher_round.png']) {
    const f = path.join(RES, dir, name);
    if (!fs.existsSync(f)) { bad(dir + '/' + name + ' 缺失'); iconBad++; continue; }
    const s = pngSize(f);
    if (!s) { bad(dir + '/' + name + ' 不是合法 PNG'); iconBad++; continue; }
    if (s.w !== size || s.h !== size) {
      bad(dir + '/' + name + ' 尺寸应为 ' + size + '×' + size + '，实际 ' + s.w + '×' + s.h);
      iconBad++;
    }
  }
}
if (!iconBad) ok('5 档密度 × 2 种图标，尺寸全部正确（48/72/96/144/192）');

// 自适应图标（API 26+ 走这条，矢量不糊）
const anydpi = path.join(RES, 'mipmap-anydpi-v26');
for (const name of ['ic_launcher.xml', 'ic_launcher_round.xml']) {
  const f = path.join(anydpi, name);
  if (!fs.existsSync(f)) { bad('缺自适应图标 ' + name); continue; }
  const t = read(f);
  if (t.includes('@drawable/ic_launcher_foreground')) ok('自适应图标 ' + name + ' 指向品牌前景');
  else bad(name + ' 没有指向 @drawable/ic_launcher_foreground（可能仍是模板 logo）');
}
if (fs.existsSync(path.join(RES, 'values', 'ic_launcher_background.xml'))) {
  const bg = read(path.join(RES, 'values', 'ic_launcher_background.xml'));
  if (bg.includes('#2E4A63')) ok('自适应图标底色 = 品牌墨蓝 #2E4A63');
  else warn('自适应图标底色不是 #2E4A63，请确认是否有意为之');
} else {
  bad('缺 values/ic_launcher_background.xml');
}

// 模板残留：这些东西不清掉，装上就是 Capacitor 的 logo
const residue = [];
const scanResidue = (dir) => {
  if (!fs.existsSync(dir)) return;
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) scanResidue(p);
    else if (/^(splash|ic_launcher_foreground)\.png$/i.test(e.name)) residue.push(rel(p));
  }
};
scanResidue(RES);
if (residue.length) bad('仍有 Capacitor 模板图未清理：' + residue.join(' / '));
else ok('模板自带 splash.png / ic_launcher_foreground.png 已清理干净');

if (fs.existsSync(path.join(RES, 'drawable', 'splash.xml'))) ok('启动画面 drawable/splash.xml 在位');
else warn('没有 drawable/splash.xml，会退回 Capacitor 默认启动画面');

/* ================================================================== *
 * [E] 清单 / 版本 / 文案
 * ================================================================== */
group('[E] 清单与版本配置');
const APP_ID = 'com.chenchang.diary';
const APP_NAME = '我的日记';

const manifest = read(path.join(MAIN, 'AndroidManifest.xml'));
if (manifest) {
  if (/android:allowBackup\s*=\s*"false"/.test(manifest)) ok('allowBackup=false（日记不会被同步上云）');
  else bad('allowBackup 未关闭 —— 默认 true 会把 App 数据同步到云端备份');
  if (/android:windowSoftInputMode\s*=\s*"adjustResize"/.test(manifest)) ok('windowSoftInputMode=adjustResize（键盘不挡输入框）');
  else bad('windowSoftInputMode 未设为 adjustResize，写日记时键盘会挡住输入框');
} else {
  bad('读不到 AndroidManifest.xml');
}

const vars = read(path.join(ANDROID, 'variables.gradle'));
if (vars) {
  const want = { minSdkVersion: 24, compileSdkVersion: 36, targetSdkVersion: 36 };
  let vBad = 0;
  for (const [k, v] of Object.entries(want)) {
    const m = vars.match(new RegExp(k + '\\s*=\\s*(\\d+)'));
    if (!m) { bad('variables.gradle 里缺少 ' + k); vBad++; }
    else if (Number(m[1]) !== v) { bad(k + ' 应为 ' + v + '，实际 ' + m[1]); vBad++; }
  }
  if (!vBad) ok('SDK 版本匹配 Capacitor 8 要求（min 24 / compile 36 / target 36）');
} else {
  bad('读不到 android/variables.gradle');
}

const appGradle = read(path.join(ANDROID, 'app', 'build.gradle'));
if (appGradle) {
  if (appGradle.includes('namespace = "' + APP_ID + '"') && appGradle.includes('applicationId "' + APP_ID + '"')) {
    ok('包名一致：' + APP_ID);
  } else {
    bad('app/build.gradle 里的 namespace / applicationId 不是 ' + APP_ID);
  }
}

const cfg = read(path.join(MOBILE, 'capacitor.config.json'));
if (cfg) {
  try {
    const c = JSON.parse(cfg);
    if (c.appId === APP_ID) ok('capacitor.config.json appId 与原生工程一致');
    else bad('capacitor.config.json appId = ' + c.appId + '，与原生工程 ' + APP_ID + ' 不一致');
    if (c.appName === APP_NAME) ok('应用名 = ' + APP_NAME);
    else warn('capacitor.config.json appName = ' + c.appName);
    if (c.webDir === undefined || c.webDir === 'www') ok('webDir = www');
    else bad('webDir = ' + c.webDir + '，与 sync.mjs 输出目录不符');
  } catch (e) {
    bad('capacitor.config.json 不是合法 JSON：' + e.message);
  }
} else {
  bad('找不到 capacitor.config.json');
}

const strings = read(path.join(RES, 'values', 'strings.xml'));
if (strings) {
  if (strings.includes('>' + APP_NAME + '</string>')) ok('strings.xml 桌面图标名 = ' + APP_NAME);
  else bad('strings.xml 里的 app_name 不是 ' + APP_NAME);
}

/* ================================================================== *
 * [F] 插件接线
 * ================================================================== */
group('[F] 原生插件接线');
const PLUGINS = [
  ['@capacitor/app', 'backButton 监听'],
  ['@capacitor/camera', '拍照并存入系统相册'],
  ['@capacitor/filesystem', '写备份文件'],
  ['@capacitor/share', '系统分享面板'],
  ['@capacitor/status-bar', '状态栏主题'],
];

const pluginsJson = read(path.join(MAIN, 'assets', 'capacitor.plugins.json'));
let registered = [];
if (pluginsJson) {
  try { registered = JSON.parse(pluginsJson).map((x) => x.pkg); } catch (e) { /* 下面统一报 */ }
  if (!registered.length) bad('capacitor.plugins.json 解析不出任何插件 —— 重新跑 `npx cap sync`');
} else {
  bad('缺 app/src/main/assets/capacitor.plugins.json —— 先跑 `npx cap sync android`');
}

const pkgJson = read(path.join(MOBILE, 'package.json'));
let deps = {};
try { deps = { ...JSON.parse(pkgJson).dependencies }; } catch (e) { /* ignore */ }

for (const [pkg, why] of PLUGINS) {
  const inJson = registered.includes(pkg);
  const inDeps = Object.prototype.hasOwnProperty.call(deps, pkg);
  const onDisk = fs.existsSync(path.join(MOBILE, 'node_modules', pkg));
  if (inJson && inDeps && onDisk) ok(pkg + '（' + why + '）已接线');
  else {
    const miss = [];
    if (!inJson) miss.push('capacitor.plugins.json');
    if (!inDeps) miss.push('package.json dependencies');
    if (!onDisk) miss.push('node_modules');
    bad(pkg + ' 未接线，缺：' + miss.join(' / '));
  }
}

if (fs.existsSync(path.join(MOBILE, 'node_modules', '@capacitor', 'cli'))) ok('@capacitor/cli 已安装');
else bad('@capacitor/cli 未安装（npm run 里的 cap 命令会失败）');

/* ================================================================== *
 * [G] iOS 工程（ipa 侧）
 * ================================================================== */
group('[G] iOS 工程');
const IOS = path.join(MOBILE, 'ios');
const IOS_APP = path.join(IOS, 'App', 'App');
const IOS_PBX = path.join(IOS, 'App', 'App.xcodeproj', 'project.pbxproj');
// Capacitor 模板自带的那张占位 AppIcon 就这么大（灰电容 logo），别用「文件小=占位」的直觉猜
const TEMPLATE_APPICON_BYTES = 110522;

if (!fs.existsSync(IOS_PBX)) {
  warn('iOS 工程还没生成 —— 不影响打安卓包；要出 ipa 先跑 `npx cap add ios`（见 docs/ios-build.md）');
} else {
  const pbx = read(IOS_PBX);
  const iosBundle = (pbx.match(/PRODUCT_BUNDLE_IDENTIFIER = ([^;]+);/) || [])[1];
  const iosTarget = Number((pbx.match(/IPHONEOS_DEPLOYMENT_TARGET = ([^;]+);/) || [])[1]);
  if (iosBundle === APP_ID) ok('iOS Bundle ID 与安卓一致：' + iosBundle);
  else bad('iOS Bundle ID（' + iosBundle + '）≠ 安卓（' + APP_ID + '）—— 不一致会上架成两个 App');
  if (iosTarget >= 15) ok('iOS 最低部署目标：' + iosTarget + '（Capacitor 8 要求 15+）');
  else bad('iOS 部署目标低于 15：' + iosTarget);

  const iosPlist = read(path.join(IOS_APP, 'Info.plist'));
  if (/ITSAppUsesNonExemptEncryption/.test(iosPlist)) ok('Info.plist 已带出口合规声明');
  else bad('Info.plist 缺 ITSAppUsesNonExemptEncryption —— 每次传 TestFlight 都要手答一次出口合规');
  if (read(path.join(IOS_APP, 'Info.plist')).includes('我的日记')) ok('iOS 应用名：我的日记');
  else bad('iOS Info.plist 的 CFBundleDisplayName 不是「我的日记」');

  const appIcon = path.join(IOS_APP, 'Assets.xcassets', 'AppIcon.appiconset', 'AppIcon-512@2x.png');
  if (!fs.existsSync(appIcon)) {
    bad('缺 iOS AppIcon：' + path.relative(MOBILE, appIcon) + '（跑 `npm run icons`）');
  } else {
    const dim = pngSize(appIcon);
    const bytes = fs.statSync(appIcon).size;
    if (dim && dim.w === 1024 && dim.h === 1024 && bytes !== TEMPLATE_APPICON_BYTES) {
      ok('iOS AppIcon 为品牌图（1024×1024，' + (bytes / 1024).toFixed(1) + ' KB）');
    } else {
      bad('iOS AppIcon 异常：' + JSON.stringify(dim) + ' / ' + bytes +
        ' B —— 必须是 1024×1024 且不是模板占位图，跑 `npm run icons`');
    }
  }

  const SPLASHES = ['splash-2732x2732-2.png', 'splash-2732x2732-1.png', 'splash-2732x2732.png'];
  const splashDir = path.join(IOS_APP, 'Assets.xcassets', 'Splash.imageset');
  const splashBad = SPLASHES.filter((n) => {
    const p = path.join(splashDir, n);
    const d = fs.existsSync(p) ? pngSize(p) : null;
    return !d || d.w !== 2732 || d.h !== 2732;
  });
  if (!splashBad.length) ok('iOS 启动图 3 张齐全（2732×2732）');
  else bad('iOS 启动图缺失或尺寸不对：' + splashBad.join(', ') + '（跑 `npm run icons`）');

  const iosCfg = (() => { try { return JSON.parse(cfg).ios || {}; } catch (e) { return {}; } })();
  if (iosCfg.contentInset === 'never') ok('capacitor.config.json：ios.contentInset=never（安全区由网页自己管）');
  else bad('capacitor.config.json 的 ios 段缺 "contentInset": "never" —— 缺了 iPhone 顶部可能双倍留白');

  if (/@capacitor\/ios/.test(pkgJson)) ok('@capacitor/ios 已写入 package.json');
  else bad('package.json 缺 @capacitor/ios 依赖');

  // 网页产物是否已同步进 iOS 工程（该目录被 gitignore，只有 cap sync 会写）
  const iosPublic = path.join(IOS_APP, 'public', 'index.html');
  if (!srcBuf) { /* 前面 [A] 已经报过了 */ }
  else if (!fs.existsSync(iosPublic)) warn('ios/App/App/public/index.html 还没生成 —— 跑 `npx cap sync ios`');
  else if (!fs.readFileSync(iosPublic).equals(srcBuf)) warn('ios/App/App/public/index.html 落后于源文件 —— 跑 `npx cap sync ios`');
  else ok('iOS 工程里的网页与 index.html 字节级一致');
}

/* iOS 侧特有的源码兼容点（放这里而不是 [B]，跟 iOS 工程绑在一起看更直观） */
if (fs.existsSync(IOS_PBX)) {
  if (/-webkit-backdrop-filter/.test(html)) ok('毛玻璃带 -webkit- 前缀（iOS 的 WKWebView 只认带前缀的）');
  else bad('index.html 里有不带前缀的 backdrop-filter —— iPhone 上毛玻璃会直接失效');
  if (/touch-action:\s*none/.test(html)) ok('长按手势元素已设 touch-action:none（防 WebKit 抢手势）');
  else warn('index.html 里没有 touch-action —— iOS 上长按时间线相机可能被滚动打断');
  if (/viewport-fit=cover/.test(html)) ok('viewport 已开 viewport-fit=cover（刘海屏安全区生效的前提）');
  else bad('index.html 缺 viewport-fit=cover —— iPhone 刘海屏会顶到内容');
}

/* ================================================================== *
 * 汇总
 * ================================================================== */
console.log('\n' + '='.repeat(48));
console.log('通过 ' + pass + ' 项 / 失败 ' + fails.length + ' 项'
  + (warns.length ? ' / 提醒 ' + warns.length + ' 项' : ''));
console.log('='.repeat(48));

if (warns.length) {
  console.log('\n提醒（不阻断构建，但值得看一眼）：');
  warns.forEach((w, i) => console.log('  ' + (i + 1) + '. ' + w));
}

if (fails.length) {
  console.log('\n阻断性问题（必须先修）：');
  fails.forEach((f, i) => console.log('  ' + (i + 1) + '. ' + f));
  console.log('\n提示：改完 index.html 后先 `npm run sync`，再重跑本脚本。');
  process.exit(1);
}

console.log('\n全部通过。接下来：');
console.log('  · 还没装构建环境  → node setup-android.mjs     （150 MB 路线，见 README 第一节 A）');
console.log('  · 环境已就绪      → npm run apk:debug');
process.exit(0);
