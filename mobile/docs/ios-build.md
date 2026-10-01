# 「我的日记」iOS 出包操作清单

> 一句话现状：**工程这边已经全部就绪**（iOS 平台、图标、启动图、合规键、出包脚本都做好了），
> 只差「一台能跑 Xcode 26 的 macOS」和「一个 Apple 开发者账号」。
> 这两样都不在这台 Windows 机器上，苹果的签名/打包工具只发布 macOS 版，这是硬性规定。

---

## 0. 先做三个决定

### 决定 A：有没有 Mac 可用？
| 情况 | 路线 |
|---|---|
| 有自己的 Mac / 能借到 | 直接看 §2，最省事 |
| 完全没有 | 三选一：**云 Mac 租一小时**（最省心）、**GitHub Actions 云编译**（免费额度够用但要配 secrets）、**Codemagic**（iOS 友好，免费 500 分钟/月） |

> ⚠️ **Mac 不能太老**：Capacitor 8 要求 **iOS 15+ 且 Xcode 26.0+**，而 Xcode 26 只能装在较新的 macOS 上。
> 借 Mac 前先确认能装 Xcode 26（本仓库的体检脚本会帮你查：`npm run ios:check`）。

### 决定 B：装给谁用？
| 目标 | 需要什么 | 花费 |
|---|---|---|
| 只装自己手机 | 免费 Apple ID + Xcode 直连真机 | 0 元，**签名 7 天到期，到期重连电脑装一次** |
| 发给别人用 | **Apple Developer Program** | **$99/年（约 ¥688）**，签名 1 年有效 |
| 发给别人用（零成本土办法） | 每个人自己装 AltStore/SideStore + 自己的 Apple ID 重签 | 0 元，但每人都要折腾，7 天一签，不推荐给非技术朋友 |

> **想「发给别人」又不想花钱，唯一体面的办法是做成网页（PWA）** —— 这个 app 是单文件 HTML、
> 数据全在本地、不依赖网络，发个链接对方用 Safari「添加到主屏幕」就能用。
> 代价是数据存在 Safari 的存储里，不如独立 App 稳。要走这条路单独说一声，我来改。

### 决定 C：Bundle ID
工程里现在是 `com.chenchang.diary`。App Store Connect 里 Bundle ID 全网唯一，
如果注册时提示被占用，改 `mobile/ios/App/App.xcodeproj/project.pbxproj` 里的
`PRODUCT_BUNDLE_IDENTIFIER`（两处都要改），再 `node tools/ios-prepare.mjs` 同步一次。

---

## 1. 上手前先体检（这台 Windows 上就能跑）

```bash
cd mobile
npm run ios:check
```

它会告诉你：Node 版本、iOS 工程是否生成、图标是不是还是占位图、合规键在不在、
设没设开发团队。**在 Windows 上跑，除了「不是 macOS」这条是预期内的，其它都应该是 ✓。**

---

## 2. 在 Mac 上出包（推荐路径）

把整个 `wechat-diary/mobile/` 目录拷到 Mac 上（U 盘 / 网盘 / git 都行，**记得连 `node_modules` 一起，
或者到 Mac 上重新 `npm install`**），然后：

```bash
cd mobile
npm install                 # 如果没拷 node_modules
npm run ios:prepare -- --team 你的TeamID
npm run ios:open            # 会用 Xcode 打开 ios/App/App.xcworkspace
```

- `--team` 的 TeamID 在 [developer.apple.com/account](https://developer.apple.com/account) → Membership details 里，
  是一串 10 位大写字母数字。
- 之后 Xcode 里：左上角选你的 iPhone（或任意 iOS 设备）→ **Product → Archive** →
  Archive 完成后弹窗里 **Distribute App**。
  - **TestFlight / App Store** → `app-store-connect`，一路 Next，传完等苹果处理几分钟。
  - **只装自己手机（免费账号）** → 选 `Run` 直接跑到真机（免费账号没有发布证书，走不了命令行 archive）。

### 命令行出包（熟手 / CI 用）
```bash
node tools/ios-prepare.mjs --team 你的TeamID --archive
# 出来的 ipa 在 ios/App/output/*.ipa
```
> 命令行 archive **只有付费开发者账号能用**（要发布证书）。免费账号请用上面的 Xcode 图形界面。

---

## 3. TestFlight 发给朋友（需要 $99/年 账号）

1. [App Store Connect](https://appstoreconnect.apple.com) → 我的 App → **+ 新建 App**，
   Bundle ID 选 `com.chenchang.diary`。
2. Xcode Distribute App 到 App Store Connect 后，进 **TestFlight** 标签页。
3. 第一次的 build 要过 **Beta App Review**（比正式审核松得多，一般 1-2 天）。
4. **内部测试**：加 100 个以内，用你自己的账号，基本秒过。
   **外部测试**：最多 1 万人，需要一次 Beta 审核 + 一段「测试要点」描述。
5. 朋友收到邮件邀请 → 装 TestFlight App → 里头下载你的 App。
   **每个 build 90 天过期**，过期传个新 build 就行（改个版本号重新 Archive）。

### 上 App Store 公开下载的额外提醒
- **Guideline 4.2（Minimum Functionality）是最大的风险点**：苹果不喜欢「把网页包一层壳」的 App。
  我们这个有原生文件分享、本地存储、状态栏跟随，属于有原生能力的，过审概率不低，
  但被拒了别意外 —— 申诉时强调「本地离线、隐私优先、无任何网络请求」。
- 需要：**App 图标（已生成好）**、**iPhone 截图（6.9" 和 6.5" 各一套，至少 2 张/套）**、
  **隐私政策 URL**（可以说「本应用不收集任何数据、不联网」，我可以帮你写一个挂到免费静态托管上）、
  **App 隐私说明**（全部选「不收集」）、年龄分级。
- 工程现在 `TARGETED_DEVICE_FAMILY = "1,2"`（iPhone + iPad 都算）。只想做 iPhone 的话，
  把 pbxproj 里两处改成 `1`，可以少传一整套 iPad 截图。

---

## 4. 没有 Mac：GitHub Actions 云编译

仓库推到 GitHub 后，`.github/workflows/ios.yml` 会在 `macos-26` 云主机上跑同一段出包逻辑，
**不需要你本地有任何苹果设备**。注意额度：

> GitHub 私有仓库的 Actions 免费额度按 **macOS = 10 倍** 计费，2000 分钟/月 ≈ 200 分钟真实构建时间。
> 一次 iOS 构建约 5-10 分钟，**一个月能出 20-40 个包，够用**。公开仓库不限时长（但源码就公开了，
> 这个 App 源码公开无所谓，自己权衡）。

需要在仓库 Settings → Secrets and variables → Actions 里配 4 个 secret：

| Secret | 是什么 | 从哪拿 |
|---|---|---|
| `APPLE_TEAM_ID` | 10 位团队 ID | developer.apple.com/account → Membership |
| `APP_STORE_CONNECT_KEY_ID` | 密钥 ID（10 位） | App Store Connect → 用户和访问 → 集成 → App Store Connect API |
| `APP_STORE_CONNECT_ISSUER_ID` | 签发方 ID（UUID） | 同上页面顶部 |
| `APP_STORE_CONNECT_P8` | `.p8` 私钥**文件内容** | 同上页面「生成 API 密钥」，下载 `.p8` 用文本编辑器打开全选复制 |

配好后 Actions 页面手动触发 **iOS 出包**，跑完在 Artifacts 里拿 `.ipa`。
**这条工作流我没法在这台 Windows 上实测**，首次跑大概率要按报错调一两次 —— 把报错贴给我，我来改。

---

## 5. 上真机后需要人工确认的点（Windows 上验不了）

代码层面我已经把能查的都查了，但这几条必须真机/模拟器看一眼：

1. **长按时间线相机 → 写纯文字**：加了 `touch-action:none` 保证指针事件不被 WebKit 的滚动接管，
   理论上没问题，但要确认 iOS 不会另外弹文字选择气泡。
2. **`crypto.subtle` 是否可用**：iOS 上 WebView 的来源是 `capacitor://localhost`，按规范 host 是
   localhost 就算安全上下文，应该是可用的；就算不可用，代码里有 FNV 兜底，锁屏密码功能不会崩。
3. **导出备份**：iOS 上应该弹系统分享面板（存到「文件」/ 发微信）。确认写入的内容是明文 JSON
   而不是 base64 —— 这是这次安卓侧刚修过的坑，iOS 走的同一份代码，理论上一并修好了。
4. **毛玻璃**：封面右上角那颗「添加」小药丸的模糊效果（这次补了 `-webkit-backdrop-filter`）。
5. **状态栏**：深色模式下图标应该变浅色。iOS 的 `setBackgroundColor` 是空操作，只有 `setStyle` 生效，
   属正常。
6. **刘海屏**：顶部导航和底部留白是否正确避开了安全区（`viewport-fit=cover` + `env(safe-area-inset-*)`
   都已写对，主要是看视觉效果）。

---

## 6. 已知坑 & 说明

- **`server.iosScheme` 千万别设成 `https`** —— Capacitor 官方明确禁止（WKWebView 已处理 http/https）。
  保持默认的 `capacitor://localhost` 即可。
- **iOS AppIcon 不能带透明通道**，所以 `tools/make_icons.py` 给 iOS 生成时是**全出血正方形 + 强转 RGB**，
  跟 Android 那套（带圆角/圆形透明底）走的不是同一个分支。别照 Android 的写法改 iOS 的。
- **启动图是 aspectFill 铺满**，所以做的是正方形、图案居中；竖屏裁左右，图案仍在中间。
- `Info.plist` 里 `UIRequiredDeviceCapabilities` 仍是模板给的 `armv7`（Capacitor 官方模板一直如此，
  上架正常）。如果 App Store Connect 报设备兼容性异常，把它改成 `arm64` 即可，不用找我。
- `ios/App/App/public/`（网页产物的拷贝）和 `ios/App/App/capacitor.config.json` 在 `.gitignore` 里，
  每次 `npm run ios:prepare` 会重新生成，**别手工改它们**。

---

## 7. 命令速查

| 命令 | 干什么 | 在哪跑 |
|---|---|---|
| `npm run ios:check` | 体检，不改文件 | 任何平台 |
| `npm run ios:prepare` | 同步网页 + 补合规键 + 刷新图标 | macOS |
| `npm run ios:prepare -- --team XXX` | 顺带写入开发团队 | macOS |
| `npm run ios:open` | 用 Xcode 打开工程 | macOS |
| `npm run ios:archive` | 命令行出 `.ipa`（需付费账号） | macOS |
| `npm run icons` | 重新生成 Android + iOS 图标/启动图 | 任何平台（要 Pillow） |
| `npm run apk:debug` / `apk:release` | 出安卓包 | Windows |

`ios:prepare` / `icons` 都是幂等的，反复跑没事。所有命令加 `--dry-run` 可以只看不动手。
