# 我的日记 · 移动端打包工程（Android / iOS）

把 `../index.html`（唯一源文件）套上 Capacitor 原生外壳，打成手机安装包。

- **Android**：本文件下半部分，`npm run apk:debug` / `apk:release`，在这台 Windows 上就能出包。
- **iOS（.ipa）**：见 **[docs/ios-build.md](docs/ios-build.md)** —— 工程已就绪，
  但 `.ipa` 只能在 macOS 上编译（苹果的签名工具只有 mac 版），文档里写清了借 Mac / 云 Mac /
  云编译三条路和 TestFlight 分发流程。

**不需要改 `index.html` 就能打**——`sync.mjs` 负责把它复制进 `www/`。
`index.html` 永远是唯一源文件，`www/index.html` 是自动生成的，**不要手动编辑它**。

---

## 一、一次性准备

两条路，**选一条**。区别只在「要不要图形 IDE」：

| | **A. 只要命令行工具（推荐）** | B. 完整 Android Studio |
|---|---|---|
| 下载量 | **150 MB** | 1.5 GB 下载，装完约 10 GB |
| 能出 APK | 可以 | 可以 |
| 图形界面 / 模拟器 / 改原生代码 | 没有 | 有 |
| 适合 | 只想把 App 装到自己手机上 | 以后要改原生 Java/Kotlin、看布局 |

你本机已有 `D:\jdk17`（实测 17.0.15）—— 但**这不够，还需要一个 JDK 21**，原因见下。

> ⚠️ **为什么非要 JDK 21（不是 17 也不是 23）**
>
> Capacitor 8 的 Android 插件模块（`@capacitor/app`、`filesystem`、`share`、`status-bar`）
> 在各自 `build.gradle` 里写死了 `sourceCompatibility JavaVersion.VERSION_21`。
> AGP 据此要求一个 **精确匹配 21** 的 Java 工具链，而 **Gradle 的工具链 spec 不支持「21 或更高」** ——
> 所以机器上只有 17 / 23 / 24 都不行，必须有真的 21。缺了会报：
>
> ```
> Cannot find a Java installation ... matching: {languageVersion=21}
> ```
>
> 走 Android Studio 路线不会遇到（IDE 自带的就是 JDK 21），**这个坑只在省 10 GB 的命令行路线上暴露**。
> 而且**启动 Gradle 的 JVM 本身也得是 21** —— 否则会换个错法报 `无效的源发行版：21`。
>
> 脚本（`node setup-android.mjs`）会自动探测机器上已有的 JDK 21，没有就从微软 CDN 下一个
> （约 190 MB），并写好 Gradle 的工具链路径。**所以你不用手动处理。**


---

### A. 只要命令行工具（推荐）

**第 1 步 · 下载**

页面 <https://developer.android.google.cn/studio> 拉到底，在「**仅限命令行工具**」区块里选 Windows：

```
commandlinetools-win-*-latest.zip        150.5 MB
```

直链（可以直接粘到浏览器地址栏）：

<https://dl.google.com/android/repository/commandlinetools-win-14742923_latest.zip>

> 页面顶部那个大按钮是完整 IDE（`.exe`，1.5 GB）。我们只需要 `gradlew` 能跑，
> 命令行工具就够，没必要下 1.5 GB。注意 `/studio/install` 是**说明页**，上面没有下载按钮。

**第 2 步 · 放到指定位置**

把 zip 放进 `D:\Android\`（目录不存在就新建一个）。文件名保持原样，脚本自己去认。

**第 3 步 · 跑一键脚本**

```bash
cd D:/WorkBuddy/WorkPlace/wechat-diary/mobile
node setup-android.mjs
```

或者**双击 `build-apk.bat`**（同一条命令的包装，方便以后重复用）。

脚本依次做完：

| 步骤 | 做什么 |
|---|---|
| 1 | 体检：JDK / 路径是否纯 ASCII / `tar.exe` `curl.exe` 在不在 / 有没有 JDK 21 |
| 2 | **确保 JDK 21**：先探测机器上已有的，没有就从微软 CDN 下一个（约 190 MB），并写好 Gradle 工具链路径 |
| 3 | 解压 zip，装到 `<SDK>\cmdline-tools\latest`（**目录名必须是 `latest`**，否则 sdkmanager 报 “Could not determine SDK root”） |
| 4 | 接受 SDK 许可（灌 80 个 `y`，覆盖所有条目） |
| 5 | 装 `platform-tools` + `platforms;android-36` + `build-tools;36.0.0`（失败退回 35.0.1） |
| 6 | 写 `android/local.properties`（已有则先备份 `.bak`） |
| 7 | `node sync.mjs` + `npx cap sync android` |
| 8 | `java -jar gradle/wrapper/gradle-wrapper.jar assembleDebug --no-daemon` |
| 9 | 报告 APK 路径与体积 |

> 第 8 步为什么不用 `gradlew.bat`：直接调 wrapper jar 可以**完全绕开 `cmd.exe`**。
> `gradlew.bat` 的本质就是这一行命令（见该文件最后一行），但多引入一个 cmd 就多了
> 「OEM 代码页读批处理」「环境里 cmd 被禁」两类不必要的风险。

**可以重复执行**，已完成的步骤会自动跳过。

常用参数：

```bash
node setup-android.mjs --check      # 只体检，不下载不构建
node setup-android.mjs --dry-run    # 只打印打算执行的命令
node setup-android.mjs --download   # 让脚本自己下 zip（走你的网络，可能慢）
```

路径可以用环境变量覆盖：`WD_JDK_HOME` / `WD_JDK21_HOME` / `WD_SDK_ROOT` / `WD_DROP_DIR` / `WD_GRADLE_HOME`。

**产物**：`android/app/build/outputs/apk/debug/app-debug.apk`

> **为什么要把 `GRADLE_USER_HOME` 指到 `D:\Android\gradle-home`**：你的 Windows 家目录是
> `C:\Users\陈畅`（含中文），而 Gradle 对非 ASCII 的家目录历史上有过不少兼容问题。
> 指到纯 ASCII 目录一劳永逸。
>
> **脚本的安全边界**：只做「新建目录 / 下载 SDK / 写 `local.properties` / 跑 `gradlew`」，
> 不删除任何既有文件（只清理它自己创建的临时解压目录）。

---

### B. 完整 Android Studio

想以后改原生 Java/Kotlin、看布局、跑模拟器才需要它。

下载页同上（**不是** `/studio/install`），当前稳定版是 **Quail（2026.1.x）**：

| 平台 | 该选的文件 | 大小 |
|---|---|---|
| **Windows（64 位）** | `android-studio-*-windows.exe` | 1.5 GB |
| ~~Windows（64 位）~~ | `*.zip` 免安装包 | 不用它，要手动配环境 |
| Mac / Linux / ChromeOS | `.dmg` / `.tar.gz` / `.deb` | 不是你的系统 |

安装向导里：

- 装到**非中文、非空格路径**（例如 `D:\Android\Android Studio`），默认 C 盘路径会吃掉约 10 GB
- 选 **Custom**，**取消勾选 Android Virtual Device** —— 只用 `gradlew` 出包的话模拟器纯属浪费，
  还平白要求 4 GB 显存
- 其余（Android SDK / Platform-Tools）保持勾选

装完打开 → **More Actions → SDK Manager**：

- **SDK Platforms** 页：勾 `Android 16 (API 36)`（Capacitor 8 要 compileSdk 36）
- **SDK Tools** 页：勾 `Android SDK Build-Tools` + `Android SDK Command-line Tools`

之后用 IDE 打开一次 `mobile/android`，它会自动生成 `local.properties`
（在生成之前命令行跑 `gradlew` 会报 `SDK location not found`，这是正常的）。
日常出包仍然用 `npm run apk:debug` 就够了，不必开 IDE。

---

## 二、每次改完网页代码

> **第一步永远是装依赖**（从 Git 克隆下来、或 `package.json` 有过改动时）：
>
> ```bash
> cd D:/WorkBuddy/WorkPlace/wechat-diary/mobile
> npm install
> ```
>
> 只改了 `../index.html` 的话，之后重复下面的 `npm run sync` 就够了。
> 依赖里有用到原生插件的（比如相机 `@capacitor/camera`），**必须**跑一次
> `npm install` + `npm run sync`，否则插件不会进原生工程，功能会静默退回网页实现。

```bash
cd D:/WorkBuddy/WorkPlace/wechat-diary/mobile
npm run sync          # = node sync.mjs && node tools/preflight.mjs && cap sync
```

`sync.mjs` 会把 `../index.html` 复制到 `www/index.html`，并**检查有没有外部资源引用**
（单文件应用一旦引了外链文件，打进 APK 必然缺资源，所以这里直接报错拦住）。

`tools/preflight.mjs` 是**打包前置体检**，30 项静态检查，秒级返回，不通过就直接中断
（`apk:debug` / `apk:release` 里也串了它，跑构建必先过体检）。详见第六节。

## 三、出安装包

### 自用（debug 包）

```bash
npm run apk:debug        # = node tools/preflight.mjs && node setup-android.mjs
# 产物：mobile/android/app/build/outputs/apk/debug/app-debug.apk
```

debug 包可以直接装，只是签名是 Android 自动生成的调试证书。自己用完全够。

### 发给别人（release 包，正式签名）

```bash
npm run apk:release      # = node tools/preflight.mjs && node setup-android.mjs --release
# 产物：mobile/android/app/build/outputs/apk/release/app-release.apk
```

**第一次跑会自动把签名配好**，不需要手动 `keytool`：

1. 生成证书 `mobile/android/diary-release.keystore`
2. 密码写进 `mobile/android/keystore.properties`，并在屏幕上打印一次
3. 把签名配置接进 `android/app/build.gradle`（原文件备份为 `.bak`，写法是"properties 不存在就跳过"，
   所以没证书的人跑 debug 构建不受影响）
4. 构建完用 `apksigner.jar` 复验签名是否有效

> 🔴 `diary-release.keystore` + `keystore.properties` 请备份到别处。
> **以后给同一包名发更新必须用同一份证书**，丢了只能卸载重装（会清掉日记）。
>
> ⚠️ 手机上已装 debug 版时，装 release 版会报"应用未安装"（签名不同），要先卸载 —— 卸载会清掉日记，
> 所以先在应用里「我的 → 导出备份」。

> 想知道"打包"这件事从头到尾每个环节在做什么、出错怎么查，看 `../打包成手机安装包_教程.md`。

### 装到手机

```bash
adb install -r mobile/android/app/build/outputs/apk/debug/app-debug.apk
```

或者把 apk 拷进手机点击安装（需先允许"安装未知来源应用"）。

---

## 四、装成 App 后做了哪些适配

`index.html` 里有一层 `Native`（第 0.5 节），**用浏览器打开时 `isNative` 恒为 false，
所有原生分支都不生效**，网页版行为与打包前完全一致。装成 App 后自动激活：

| 能力 | 浏览器 | App 内 | 用到的插件 |
|---|---|---|---|
| 系统返回键 | 浏览器自己的后退 | 分层消费：弹层 → 大图 → 二级页 → 才退出 | `@capacitor/app` |
| 导出备份 | `<a download>` | 写入缓存目录 + 调起系统分享面板 | `@capacitor/filesystem` + `@capacitor/share` |
| 状态栏 | 无 | 跟随深浅主题切换图标明暗 | `@capacitor/status-bar` |
| 「拍摄」 | `<input capture>` | 原生相机，且照片**同时写入系统相册** | `@capacitor/camera` |

**为什么「拍摄」要用原生相机**：`<input type="file" capture>` 即使拍成功了，照片也只活在
WebView 的临时文件里，**不会进手机的系统相册**（用户看到的症状就是"App 里拍了照，但相册里没有"）。
原生 `takePhoto({ saveToGallery: true })` 才会真正写进系统相册并让媒体库索引到。

**为什么相机需要那两条权限**：`saveToGallery` 是唯一需要存储权限的地方，
`AndroidManifest.xml` 里按系统版本限定申请（`READ` ≤ API 32、`WRITE` ≤ API 29），
Android 13+ 走 MediaStore 不需要声明。iOS 侧则在 `Info.plist` 里声明了
`NSCameraUsageDescription` / `NSPhotoLibraryUsageDescription` / `NSPhotoLibraryAddUsageDescription`
—— iOS 上缺这几项会**直接崩**（不是弹窗被拒）。

**「拍摄」是独立 Activity，所以还要接 `appRestoredResult`**：相机在前台时本 App 可能被系统回收，
不接这个监听，用户拍完回来照片会凭空消失。已在 `index.html` 的 `bindNativeCameraRestore` 里处理。

**为什么导出备份要改**：`<a download>` + `blob:` URL 在 Android WebView 里**完全不生效**，
原来点"导出备份"在手机上会静默没反应。

---

## 五、品牌资源（已替换掉 Capacitor 默认 logo）

Capacitor 模板自带的是 Capacitor 自己的图标和启动图，不清掉的话装上就是别人的 logo。已处理：

- `res/mipmap-*/ic_launcher.png` / `ic_launcher_round.png` → 墨蓝底 + 白色日记本
  重新生成：`python tools/make_icons.py`（需要 Pillow）
- `res/drawable/ic_launcher_foreground.xml` → 自适应图标前景（矢量，API 26+ 用这个，不糊）
- `res/values/ic_launcher_background.xml` → 底色 `#2E4A63`
- `res/drawable/splash.xml` → 启动画面：整屏品牌墨蓝 + 居中白色标志
- 已删除模板自带的 `splash.png`（11 张）和 `ic_launcher_foreground.png`（5 张）

### 清单文件的两处改动

- `android:allowBackup="false"` —— 默认是 `true`，会让系统把 App 数据（也就是你的日记）
  同步到云端备份。日记类应用不该这样，已关掉。
- `android:windowSoftInputMode="adjustResize"` —— 写日记弹出键盘时把界面顶上去，
  否则输入框会被键盘挡住。

### 横屏适配

系统没有锁竖屏（`AndroidManifest.xml` 的 `configChanges` 里含 `orientation`，
iOS 的 `Info.plist` 也声明了 LandscapeLeft/Right），所以旋转会进来，适配写在 **`index.html` 的
`@media (orientation:landscape) and (max-height:520px)`** 那一段：

- 横屏的问题不在宽度而在**高度**：竖屏专用的固定高度（封面 250px、导航 46px、
  底部标签栏 50px）会把只剩约 390px 的高度吃掉大半，正文被挤成一条缝。
  所以这段的核心是把竖向占用整体压下来（封面改 `46vh` 上限 230px、导航 38px、
  标签栏隐藏文字、正文可视高度从 ~150px 提到 310px / 占 79%）。
- `max-height:520px` 用来把平板和桌面排除在外 —— 它们横屏高度足够，套上压缩规则反而小气。
- 因为是 `configChanges` 而不是重建 Activity，页面**不会重载**，所以 `index.html` 里
  另外监听了 `resize` / `screen.orientation` / `orientationchange`，延后 260ms
  重算查看器的缩放平移（否则旋转后放大的图片会被卡在屏幕外）。
- 横屏时 `#app` 放开 600px 上限铺满整宽，但内容加 720px 居中上限
  （否则 844 宽的手机上磁贴会被拉成三块巨大方块）。

---

## 六、验证

### 打包前置体检（不用装 Android Studio）

```bash
npm run preflight     # 30 项，秒级，退出码 0 = 可打包
```

覆盖：`www/` 与源文件是否字节一致 · 有没有外链资源 · Native 层六个挂钩是否还在 ·
非原生环境是否被短路 · 12 个 XML 是否良构 · 图标尺寸是否对 · 模板 logo 是否清干净 ·
`allowBackup` / `adjustResize` · SDK 版本 · 包名三处一致 · 五个插件接线。

**为什么单独搞这一层**：本机装 Android Studio 之前跑不了 gradle，所有问题都要等装完
10GB 环境才暴露。其中 XML 注释里出现 `--` 这类错误**编辑器完全看不出、只有 AAPT 报**，
到时候排查成本极高。体检把它提前到几秒钟内。

顺带一提：体检器自己做过反向测试——注入「注释含 `--`」「标签嵌套错」「`www` 失同步」
三种故障，确认全部被捕获且退出码为 1。一个从不报错的校验器等于没有。

### 浏览器端回归

```bash
cd ../_verify
node serve.cjs            # 另开一个终端，e2e_diary.mjs 需要它提供 7788 端口
node e2e_diary.mjs        # 344 项：网页版全量回归
node native_shell.mjs     #  36 项：注入假原生桥，验证返回键 / 原生导出 / 状态栏
node file_boot.mjs        #  25 项：file:// 双击 + 存储降级
node verify_close_pin.mjs    # 89 项：密码锁的关闭 / 修改流程
node verify_zoom_rotate.mjs  # 36 项：照片缩放 / 横屏适配 / 拍照回退
node verify_camera.mjs       # 20 项：拍照入草稿（注入假原生桥，跑真机才走的分支）
node verify_swipe.mjs        # 18 项：多图查看器的连续翻页（真实触摸事件）
node verify_fold.mjs         # 14 项：「更多 / 收起」的折叠判定
```

> 全部 8 个套件合计 **582 项断言**，不需要真机。

> `e2e_diary.mjs` 需要先另开一个终端跑 `node serve.cjs`（它自己不起服务器）。

`verify_camera.mjs` 盯的是两个**已经踩过的坑**：
1. **`addImages()` 曾经任何分支都不返回 Promise**（正常路径也是隐式 `undefined`），
   于是调用方写 `addImages(...).then(...)` 会**必崩**，报
   「Cannot read properties of undefined (reading 'then')」。
   现在它统一返回 Promise，测试会逐个出口验证这一点。
2. **拍照入口曾经无条件调 `openComposer(null)`**，而它每次都会清空草稿 ——
   表现为「在发布页里拍第二张，第一张被抹掉」。测试用连拍两张来守这条。

`verify_swipe.mjs` 专门盯另一个**已经踩过的坑**：`.viewer-track` 上**不能加 `overflow:hidden`**。
加上之后，轨道被 `translateX` 移出约 50% 时，整棵子树会同时失去命中测试和绘制 ——
表现为「多图只能翻一次，之后怎么滑都没反应」。这个测试用真实触摸事件连续左右翻页，
并逐次断言「计数递增 + 视口中心命中的是 IMG + 画面不是纯色」，能直接拦住这类回归。

`verify_fold.mjs` 盯「更多 / 收起」的判定。原来的实现用 `\n` 的个数当行数（逻辑行），
而 CSS 的 `-webkit-line-clamp` 数的是**视觉行** —— 一段长文字没有换行符，逻辑行是 1，
手机上却能折成十几行。两个后果：

1. 「还有 N 行」的数字严重偏小（写 1 行，实际藏了 10 行）；
2. 更糟：逻辑行 ≤ 6 而视觉行 > 6 时**不生成「更多」按钮**，CSS 却把正文裁到第 6 行 ——
   内容被吞掉且无法展开。

现在改成量真实视觉行数，且**折叠前后不能用同一个 API**（这点很反直觉）：
未折叠用 `Range.getClientRects()`（块级元素自身的 `getClientRects()` 只返回一个盒子，
会让行数恒为 1）；已折叠用 `元素高度 / 行高`（此时 Range **不遵守** line-clamp，
仍会返回全部行的矩形）。测试用克隆元素量出真实全文行数，再和按钮上的数字逐个比对。

> `verify_swipe.mjs` 需要一个放着真实 JPEG 的目录来做数据准备，默认 `D:/dshWorkPlace/backup-images`，
> 可用环境变量 `WD_IMGDIR` 覆盖。

`verify_zoom_rotate.mjs` 覆盖后来加的三项：图片查看器的滚轮·双击·双指缩放与放大后拖动平移、
竖屏转横屏后的布局与查看器重算、以及「拍摄」在网页版的回退路径。它用
`Emulation.setDeviceMetricsOverride` 在同一个页面里切换 390x844 ↔ 844x390，
断言的是**真实测量值**（导航栏高度、正文可视高度占比、放大倍数），不是截图比对。
截图输出到 `_verify/shots/v*.png`。

> 注意：这些脚本都要启动本机 Chrome（`C:/Program Files/Google/Chrome/Application/chrome.exe`）。
> 如果 Chrome 起不来并报 `crashpad` / `platform_channel.cc: 拒绝访问`，说明当前环境
> 不允许创建命名管道（Chrome 的多进程 IPC 需要它），请在不受限的终端里跑。

`native_shell.mjs` 在页面加载前注入一个假的 `window.Capacitor`，于是**手机里才跑得到的
三条原生分支在桌面 Chrome 上就能断言**——不用真机、不用模拟器、不用先跑通 gradle。
假对象走的是真实的插件调用协议（`window.Capacitor.Plugins.<名>.<方法>()`，由原生侧
`JSExport` 生成），所以它确实在验证产品代码，不是自欺欺人。

---

## 七、常见问题

**打包前先自查** → `npm run preflight`。30 项静态检查，几秒钟，能挡掉绝大部分白屏和
构建失败。构建命令里已经串了它，所以正常走 `npm run apk:debug` 不会漏。

**白屏** → 九成是 `www/` 没同步或资源缺失。先 `npm run sync`，再确认 `sync.mjs` 的资源检查通过。

**gradlew 报 `SDK location not found`** → 缺 `local.properties`。跑一次 `node setup-android.mjs`
就会写好（走命令行路线）；用 Android Studio 的话打开一次 `mobile/android` 也会自动生成。

**`setup-android.mjs` 说找不到 zip** → 把 `commandlinetools-win-*.zip` 放到 `D:\Android\`，
或者加 `--download` 让脚本自己下。

**sdkmanager 报 `Could not determine SDK root`** → `cmdline-tools` 下的目录名不是 `latest`。
脚本已经处理这一步，手动装的话注意必须是 `<SDK>\cmdline-tools\latest\bin\sdkmanager.bat`。

**gradle 报 licence not accepted** → 手动跑一次：
`D:\Android\Sdk\cmdline-tools\latest\bin\sdkmanager.bat --licenses`，一路输 `y`。

**`Cannot find a Java installation ... matching: {languageVersion=21}`** → 机器上没有 JDK 21
（Capacitor 8 的插件模块写死了 `VERSION_21`，且 Gradle 工具链不支持"21 或更高"，所以 17/23/24 都不行）。
跑一次 `node setup-android.mjs`，第 2 步会自动下载并配上。

**`错误: 无效的源发行版：21`** → 工具链找对了，但**启动 Gradle 的 JVM** 不是 21。
`setup-android.mjs` 固定用 JDK 21 启动，所以用脚本跑不会遇到这个错误；
自己敲 gradle 命令时要显式用 `D:\Android\jdk21\bin\java.exe`。

**装到手机后返回键直接退出 App** → 说明 `@capacitor/app` 没生效。检查 `npx cap sync` 后
`android/app/src/main/assets/capacitor.plugins.json` 里有没有 `@capacitor/app`。

**改完 `index.html` 手机上没变化** → `www/` 是拷贝，必须重跑 `npm run sync` 并重新构建 APK。
（`setup-android.mjs` 内部已经包含这一步，跑它就够。）

**装新包报"应用未安装"** → 签名冲突：手机上已装过**不同签名**的同包名应用。
debug ↔ release 互相覆盖不了。先卸载旧的 —— **卸载会清掉日记，先「导出备份」**。

**iOS** → 同一个工程 `npx cap add ios` 即可，但**必须在 Mac 上用 Xcode 26 编译**，
Windows 出不了 ipa。
