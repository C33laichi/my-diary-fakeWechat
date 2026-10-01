/**
 * iOS 出包准备脚本 —— 在 macOS 上跑；Windows 上可以用 --check 做纯体检。
 *
 * 它把「拿到一台 Mac 之后到出 .ipa 之间」的所有琐事一次做完：
 *   1. 体检：Node 版本 / ios 工程是否生成 / 图标是否还是占位图 / Info.plist 合规键
 *   2. 同步网页：node sync.mjs → tools/preflight.mjs → cap sync ios
 *   3. 需要时生成 iOS 工程：cap add ios（Capacitor 8 用 SPM，Mac 上不用装 CocoaPods）
 *   4. 补 Info.plist 的 ITSAppUsesNonExemptEncryption=false（否则每次传 TestFlight 都要手答出口合规）
 *   5. 可选：--team XXXXXXXXXX 把开发团队写进 Xcode 工程（自动签名要用）
 *   6. 可选：--archive 走命令行 archive 出 .ipa（需要付费开发者账号；免费账号请用 Xcode 图形界面）
 *
 * 用法：
 *   node tools/ios-prepare.mjs --check        # 只体检，不改任何文件（Windows 也能跑）
 *   node tools/ios-prepare.mjs                # 同步 + 补丁 + 图标
 *   node tools/ios-prepare.mjs --team ABC123  # 顺带写入开发团队
 *   node tools/ios-prepare.mjs --open         # 完成后用 Xcode 打开
 *   node tools/ios-prepare.mjs --archive      # 完成后命令行出 .ipa
 *   任何命令加 --dry-run 只打印要做什么，不真正执行
 */
import { execFileSync, spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const MOBILE = path.dirname(HERE);
const IOS_DIR = path.join(MOBILE, 'ios');
const APP_DIR = path.join(IOS_DIR, 'App', 'App');
const PBXPROJ = path.join(IOS_DIR, 'App', 'App.xcodeproj', 'project.pbxproj');
const INFO_PLIST = path.join(APP_DIR, 'Info.plist');
const APPICON = path.join(APP_DIR, 'Assets.xcassets', 'AppIcon.appiconset', 'AppIcon-512@2x.png');
// Capacitor 模板里那张占位图（灰色的电容 logo）反而比品牌图标大，所以不能拿文件大小当依据，
// 得真的比对内容 —— 模板就在 node_modules 里，用 tar 现场解出来比哈希最稳。
const TEMPLATE_TARS = ['ios-spm-template.tar.gz', 'ios-pods-template.tar.gz'];
const TEMPLATE_ICON_ENTRY = 'App/App/Assets.xcassets/AppIcon.appiconset/AppIcon-512@2x.png';

const args = process.argv.slice(2);
const flag = (name) => args.includes(name);
const DRY = flag('--dry-run');
const CHECK_ONLY = flag('--check');
const opt = (name) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
};
const TEAM = opt('--team');

let problems = 0;   // 会导致出不了包的
let warns = 0;      // 不拦路，但值得知道

const bad = (msg) => { problems += 1; console.log('  ✗ ' + msg); };
const warn = (msg) => { warns += 1; console.log('  ! ' + msg); };
const ok = (msg) => console.log('  ✓ ' + msg);
const step = (t) => console.log('\n== ' + t + ' ==');

function sha1(buf) {
  return crypto.createHash('sha1').update(buf).digest('hex');
}

/** 从 @capacitor/cli 的模板压缩包里解出占位 AppIcon；拿不到返回 null */
function templateIconBytes() {
  const assetsDir = path.join(MOBILE, 'node_modules', '@capacitor', 'cli', 'assets');
  for (const name of TEMPLATE_TARS) {
    const tarball = path.join(assetsDir, name);
    if (!fs.existsSync(tarball)) continue;
    const r = spawnSync('tar', ['-xzOf', tarball, TEMPLATE_ICON_ENTRY], {
      encoding: 'buffer', maxBuffer: 8 * 1024 * 1024,
    });
    if (r.status === 0 && r.stdout && r.stdout.length) return Buffer.from(r.stdout);
  }
  return null;
}

function run(cmd, cmdArgs, opts = {}) {
  if (DRY) { console.log('  [dry-run] ' + cmd + ' ' + cmdArgs.join(' ')); return; }
  console.log('  $ ' + cmd + ' ' + cmdArgs.join(' '));
  execFileSync(cmd, cmdArgs, { cwd: MOBILE, stdio: 'inherit', ...opts });
}

/* ------------------------------------------------------------------ */
/* 体检                                                                */
/* ------------------------------------------------------------------ */

function checkPlatform() {
  step('运行环境');
  if (process.platform === 'darwin') {
    ok('macOS（' + os.release() + '）');
    const xcode = spawnSync('xcodebuild', ['-version'], { encoding: 'utf8' });
    if (xcode.status === 0) {
      ok(xcode.stdout.trim().split('\n').join(' / '));
      // Capacitor 8 要求 Xcode 26+，装不上 26 的老 Mac 跑不了
      const ver = Number((xcode.stdout.match(/Xcode (\d+)/) || [])[1]);
      if (ver && ver < 26) warn('Capacitor 8 要求 Xcode 26.0+，当前 ' + ver + ' 可能编不过 iOS 15 目标');
    } else {
      bad('找不到 xcodebuild —— 请从 App Store 装 Xcode，并跑一次 sudo xcode-select -s /Applications/Xcode.app');
    }
  } else if (CHECK_ONLY) {
    // Windows 上跑 --check 本来就只能体检到这一步，这不算「错」，记成提醒，
    // 否则 npm run ios:check 在 Windows 上永远以失败告终，没人会再看它的输出。
    warn('当前是 ' + process.platform + '，只能做体检；真正的出包要在一台 macOS 上跑。');
  } else {
    bad('当前是 ' + process.platform + '。.ipa 只能在 macOS 上编译（xcodebuild / 签名工具只有 mac 版）。');
    console.log('     → Windows 上本脚本只支持 --check；真正的出包要在一台 macOS 上跑。');
  }
  const major = Number(process.versions.node.split('.')[0]);
  if (major >= 22) ok('Node ' + process.versions.node);
  else bad('Node 需要 >= 22，当前 ' + process.versions.node);
}

function checkProject() {
  step('iOS 工程（' + path.relative(MOBILE, IOS_DIR) + '/）');
  if (!fs.existsSync(PBXPROJ)) {
    bad('还没生成 iOS 工程。在 macOS 上跑：npx cap add ios');
    return;
  }
  ok('工程已生成（' + path.relative(MOBILE, PBXPROJ) + '）');

  const pbx = fs.readFileSync(PBXPROJ, 'utf8');
  const bundleId = (pbx.match(/PRODUCT_BUNDLE_IDENTIFIER = ([^;]+);/) || [])[1];
  const target = (pbx.match(/IPHONEOS_DEPLOYMENT_TARGET = ([^;]+);/) || [])[1];
  const team = (pbx.match(/DEVELOPMENT_TEAM = ([^;]+);/) || [])[1];
  bundleId ? ok('Bundle ID：' + bundleId) : bad('pbxproj 里没有 PRODUCT_BUNDLE_IDENTIFIER');
  target ? ok('最低 iOS：' + target) : bad('pbxproj 里没有 IPHONEOS_DEPLOYMENT_TARGET');
  if (team) ok('开发团队：' + team);
  else if (TEAM) console.log('  · 本次会用 --team ' + TEAM + ' 写入开发团队');
  else warn('还没设开发团队（DEVELOPMENT_TEAM）。真机/上架前要设：node tools/ios-prepare.mjs --team 你的TeamID');

  // 图标：跟模板占位图逐字节比对，比拿文件大小猜靠谱得多
  if (fs.existsSync(APPICON)) {
    const cur = fs.readFileSync(APPICON);
    const tpl = templateIconBytes();
    if (tpl && sha1(cur) === sha1(tpl)) warn('AppIcon 还是 Capacitor 占位图，跑一次 npm run icons');
    else ok('AppIcon 已是品牌图标（' + (cur.length / 1024).toFixed(1) + ' KB' + (tpl ? '，与占位图不同' : '') + '）');
  } else bad('缺 AppIcon：' + path.relative(MOBILE, APPICON));

  // Info.plist：出口合规
  const plist = fs.readFileSync(INFO_PLIST, 'utf8');
  if (/ITSAppUsesNonExemptEncryption/.test(plist)) ok('Info.plist 已带出口合规声明');
  else warn('Info.plist 缺 ITSAppUsesNonExemptEncryption，每次传 TestFlight 都会被问一次（本脚本可自动补）');

  // capacitor 配置
  const cfg = JSON.parse(fs.readFileSync(path.join(MOBILE, 'capacitor.config.json'), 'utf8'));
  if (cfg.ios && cfg.ios.contentInset === 'never') ok('capacitor.config.json：ios.contentInset=never（安全区由网页自己管）');
  else warn('建议 capacitor.config.json 的 ios 段加 "contentInset": "never"');
}

/* ------------------------------------------------------------------ */
/* 动作                                                                */
/* ------------------------------------------------------------------ */

function syncWeb() {
  step('同步网页到 iOS 工程');
  run(process.execPath, ['sync.mjs']);
  run(process.execPath, ['tools/preflight.mjs']);
  if (!fs.existsSync(PBXPROJ)) run('npx', ['cap', 'add', 'ios']);
  run('npx', ['cap', 'sync', 'ios']);
}

function ensureEncryptionKey() {
  step('Info.plist 出口合规');
  let plist = fs.readFileSync(INFO_PLIST, 'utf8');
  if (/ITSAppUsesNonExemptEncryption/.test(plist)) { ok('已存在，跳过'); return; }
  // 锚在 LSRequiresIPhoneOS 前面，沿用它那一行的缩进
  const anchor = plist.match(/^([ \t]*)<key>LSRequiresIPhoneOS<\/key>/m);
  if (!anchor) { warn('找不到插入锚点，请手动加 ITSAppUsesNonExemptEncryption=false'); return; }
  const ind = anchor[1];
  const add = ind + '<key>ITSAppUsesNonExemptEncryption</key>\n' + ind + '<false/>\n';
  plist = plist.replace(anchor[0], add + anchor[0]);
  if (!DRY) fs.writeFileSync(INFO_PLIST, plist);
  ok('已写入 ITSAppUsesNonExemptEncryption=false');
}

function writeTeam() {
  if (!TEAM) return;
  step('写入开发团队 ' + TEAM);
  if (!fs.existsSync(PBXPROJ)) { bad('iOS 工程还没生成'); return; }
  let pbx = fs.readFileSync(PBXPROJ, 'utf8');
  if (/DEVELOPMENT_TEAM = /.test(pbx)) {
    pbx = pbx.replace(/DEVELOPMENT_TEAM = [^;]+;/g, 'DEVELOPMENT_TEAM = ' + TEAM + ';');
  } else {
    // 模板里只有 CODE_SIGN_STYLE = Automatic; 这一处是每个配置块都有的，借它定位
    const n = (pbx.match(/CODE_SIGN_STYLE = Automatic;/g) || []).length;
    if (!n) { bad('pbxproj 里找不到 CODE_SIGN_STYLE = Automatic;'); return; }
    pbx = pbx.replaceAll('CODE_SIGN_STYLE = Automatic;', 'CODE_SIGN_STYLE = Automatic;\n\t\t\t\tDEVELOPMENT_TEAM = ' + TEAM + ';');
  }
  if (!DRY) fs.writeFileSync(PBXPROJ, pbx);
  ok('DEVELOPMENT_TEAM = ' + TEAM + '（' + (pbx.match(/DEVELOPMENT_TEAM = /g) || []).length + ' 处）');
}

/** CI 上没有图形界面可以登录，xcodebuild 的自动签名要靠 App Store Connect API 密钥。
 *  三个环境变量都齐了才带上（本地 Mac 用 Xcode 登录过的话不需要，缺了就不带）。 */
function authArgs() {
  const { APPLE_KEY_ID, APPLE_ISSUER_ID, APPLE_P8_PATH } = process.env;
  if (!(APPLE_KEY_ID && APPLE_ISSUER_ID && APPLE_P8_PATH)) return [];
  if (!fs.existsSync(APPLE_P8_PATH)) { warn('APPLE_P8_PATH 指向的文件不存在：' + APPLE_P8_PATH); return []; }
  ok('带 App Store Connect API 密钥签名（' + APPLE_KEY_ID + '）');
  return ['-authenticationKeyPath', APPLE_P8_PATH,
    '-authenticationKeyID', APPLE_KEY_ID,
    '-authenticationKeyIssuerID', APPLE_ISSUER_ID];
}

function archive() {
  step('命令行出 .ipa');
  if (process.platform !== 'darwin') { bad('archive 只能在 macOS 上跑'); return; }
  const outDir = path.join(IOS_DIR, 'App', 'output');
  const exportOptions = path.join(IOS_DIR, 'App', 'ExportOptions.plist');
  // 免费账号没有发布证书，命令行 archive 只支持付费开发者账号
  const method = opt('--method') || 'app-store-connect';   // app-store-connect / ad-hoc / development
  const plistSrc = [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">',
    '<plist version="1.0">',
    '<dict>',
    '  <key>method</key>',
    '  <string>' + method + '</string>',
    '  <key>signingStyle</key>',
    '  <string>automatic</string>',
    '  <key>uploadSymbols</key>',
    '  <true/>',
    TEAM ? '  <key>teamID</key>\n  <string>' + TEAM + '</string>' : '  <!-- teamID 未指定，Xcode 会用工程里的 DEVELOPMENT_TEAM -->',
    '</dict>',
    '</plist>',
  ].join('\n') + '\n';
  if (!DRY) fs.mkdirSync(path.dirname(exportOptions), { recursive: true });
  if (!DRY) fs.writeFileSync(exportOptions, plistSrc);
  console.log('  写入 ' + path.relative(MOBILE, exportOptions) + '（method=' + method + '）');
  const auth = authArgs();
  run('xcodebuild', ['-workspace', 'ios/App/App.xcworkspace', '-scheme', 'App', '-configuration', 'Release',
    '-destination', 'generic/platform=iOS', '-archivePath', 'ios/App/output/App.xcarchive', 'archive',
    '-allowProvisioningUpdates', ...auth]);
  run('xcodebuild', ['-exportArchive', '-archivePath', 'ios/App/output/App.xcarchive',
    '-exportPath', 'ios/App/output', '-exportOptionsPlist', 'ios/App/ExportOptions.plist',
    '-allowProvisioningUpdates', ...auth]);
  if (!DRY) {
    const ipa = fs.readdirSync(outDir).find((f) => f.endsWith('.ipa'));
    if (ipa) ok('出包完成：' + path.relative(MOBILE, path.join(outDir, ipa)));
    else warn('output 里没找到 .ipa，看上面 xcodebuild 的报错');
  }
}

function openXcode() {
  step('用 Xcode 打开');
  run('npx', ['cap', 'open', 'ios']);
}

/* ------------------------------------------------------------------ */

console.log('「我的日记」iOS 出包准备' + (DRY ? '（dry-run）' : ''));
checkPlatform();
checkProject();

if (CHECK_ONLY) {
  console.log('\n--check 模式：只体检，未做任何修改。');
} else {
  if (problems && process.platform !== 'darwin') {
    console.log('\n存在阻断问题（见上），在 ' + process.platform + ' 上无法继续出包步骤。');
    process.exit(1);
  }
  syncWeb();
  ensureEncryptionKey();
  writeTeam();
  if (flag('--archive')) archive();
  if (flag('--open')) openXcode();
}

console.log('\n---- 结果：' + (problems ? problems + ' 个阻断问题' : '无阻断问题') +
  (warns ? '，' + warns + ' 个提醒' : '') + ' ----');
if (problems) process.exit(1);
