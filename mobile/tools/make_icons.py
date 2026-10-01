"""
生成「我的日记」的启动图标与启动图 —— 一套图形，两个平台。

图形与 App 内部品牌标完全一致（日记本轮廓），只是换成适合图标的配色：
底色墨蓝 #2E4A63，线条纯白。

原始设计画布是 24x24 的 SVG viewBox：
    <rect x=4.5 y=3.5 width=15 height=17 rx=2.6 />
    <path d="M8.6 3.5v17" />
    <path d="M12.2 9.2h4 M12.2 13.2h4" />
这里按 scale 换算到目标像素，再 4 倍超采样后缩回来做抗锯齿。

产出：
  Android → android/app/src/main/res/mipmap-{mdpi..xxxhdpi}/ic_launcher(.round).png
  iOS     → ios/App/App/Assets.xcassets/AppIcon.appiconset/AppIcon-512@2x.png
            ios/App/App/Assets.xcassets/Splash.imageset/splash-2732x2732*.png

iOS 侧有两条硬规矩，别照 Android 的写法直接抄：
  1. AppIcon 必须是**全出血正方形且不透明**。系统自己套圆角（squircle），
     自己切一遍会被切两遍；带 alpha 通道的图标 App Store 直接拒审。
  2. 启动图在 LaunchScreen.storyboard 里是 aspectFill 铺满屏幕的，
     所以做成正方形、图案居中 —— 竖屏拉伸时左右被裁掉，图案仍在正中。

用法（需要 Pillow）：
    python tools/make_icons.py              # 两个平台，目录存在哪个就写哪个
    python tools/make_icons.py --android    # 只写 Android
    python tools/make_icons.py --ios        # 只写 iOS
"""
import os
import sys

try:
    from PIL import Image, ImageDraw
except ImportError:
    sys.exit(
        '需要 Pillow。本机默认的 python 没装，用装了 Pillow 的解释器跑，例如：\n'
        '  C:\\Users\\<你>\\.workbuddy\\binaries\\python\\envs\\default\\Scripts\\python.exe '
        'tools/make_icons.py'
    )

HERE = os.path.dirname(os.path.abspath(__file__))
MOBILE = os.path.dirname(HERE)
ANDROID_RES = os.path.join(MOBILE, 'android', 'app', 'src', 'main', 'res')
IOS_ASSETS = os.path.join(MOBILE, 'ios', 'App', 'App', 'Assets.xcassets')

BRAND_INK = (0x2E, 0x4A, 0x63, 255)
GLYPH = (0xFF, 0xFF, 0xFF, 255)

# 设计画布单位
DESIGN = 24.0
RECT = (4.5, 3.5, 19.5, 20.5)
RECT_R = 2.6
SPINE_X = 8.6
BAR_Y = (9.2, 13.2)
BAR_X = (12.2, 16.2)
STROKE = 1.9

# 各密度下 ic_launcher 的边长
DENSITIES = {
    'mdpi': 48,
    'hdpi': 72,
    'xhdpi': 96,
    'xxhdpi': 144,
    'xxxhdpi': 192,
}

SS = 4  # 超采样倍数
# 设计画布占图标边长的比例，留出一点呼吸空间
CANVAS_RATIO = 0.84
# 启动图上图案小得多，不然整屏都是线条
SPLASH_RATIO = 0.22

IOS_ICON_SIZE = 1024     # iOS AppIcon 只认这一张 1024，其余尺寸由 Xcode 生成
IOS_SPLASH_SIZE = 2732   # 与 Capacitor 模板自带的三张启动图同尺寸
# 顺序照抄模板 Contents.json：1x → -2、2x → -1、3x → 无后缀
IOS_SPLASH_FILES = ('splash-2732x2732-2.png', 'splash-2732x2732-1.png', 'splash-2732x2732.png')


def draw_glyph(img, scale, offset):
    """在 img 上按 scale/offset 画线条部分（描边按 4 倍超采样放大）。"""
    d = ImageDraw.Draw(img)
    w = max(1, round(STROKE * scale))

    def X(u):
        return offset + u * scale

    def Y(v):
        return offset + v * scale

    # 书脊
    d.line([(X(SPINE_X), Y(RECT[1])), (X(SPINE_X), Y(RECT[3]))], fill=GLYPH, width=w)
    # 两条横线（补圆头）
    for y in BAR_Y:
        d.line([(X(BAR_X[0]), Y(y)), (X(BAR_X[1]), Y(y))], fill=GLYPH, width=w)
        r = w / 2.0
        for x in BAR_X:
            d.ellipse([X(x) - r, Y(y) - r, X(x) + r, Y(y) + r], fill=GLYPH)


def draw_frame(img, scale, offset):
    """日记本外框：圆角矩形描边。"""
    d = ImageDraw.Draw(img)
    w = max(1, round(STROKE * scale))
    r = RECT_R * scale
    box = [offset + RECT[0] * scale, offset + RECT[1] * scale,
           offset + RECT[2] * scale, offset + RECT[3] * scale]
    d.rounded_rectangle(box, radius=r, outline=GLYPH, width=w)


def render(size, shape, canvas_ratio, ss=SS):
    """shape: 'rounded' 圆角方形底色 / 'circle' 圆形底色 / 'square' 全出血方形

    ss 是超采样倍数。默认 4 倍只适合小图（48~1024）；启动图 2732 若也按 4 倍，
    中间画布会到 10928² —— 光这一张 RGBA 就要 478MB，没必要。所以调用方自己降倍数。
    """
    big = size * ss
    scale = big * canvas_ratio / DESIGN
    offset = (big - DESIGN * scale) / 2.0

    img = Image.new('RGBA', (big, big), (0, 0, 0, 0))
    bg = ImageDraw.Draw(img)
    edge = big - 1
    if shape == 'circle':
        bg.ellipse([0, 0, edge, edge], fill=BRAND_INK)
    elif shape == 'rounded':
        bg.rounded_rectangle([0, 0, edge, edge], radius=round(big * 0.22), fill=BRAND_INK)
    else:
        bg.rectangle([0, 0, edge, edge], fill=BRAND_INK)

    draw_frame(img, scale, offset)
    draw_glyph(img, scale, offset)
    return img.resize((size, size), Image.LANCZOS)


def save(img, path, label=None):
    os.makedirs(os.path.dirname(path), exist_ok=True)
    img.save(path)
    print('  写入 {}  ({}×{}, {})'.format(
        label or os.path.relpath(path, MOBILE), img.size[0], img.size[1],
        'RGB 无透明' if img.mode == 'RGB' else img.mode))


def do_android():
    if not os.path.isdir(ANDROID_RES):
        print('[跳过 Android] 找不到 ' + ANDROID_RES)
        return 0
    print('Android 图标 →')
    n = 0
    for name, size in DENSITIES.items():
        save(render(size, 'rounded', CANVAS_RATIO),
             os.path.join(ANDROID_RES, 'mipmap-' + name, 'ic_launcher.png'),
             'mipmap-{}/ic_launcher.png'.format(name))
        save(render(size, 'circle', CANVAS_RATIO),
             os.path.join(ANDROID_RES, 'mipmap-' + name, 'ic_launcher_round.png'),
             'mipmap-{}/ic_launcher_round.png'.format(name))
        n += 2
    return n


def do_ios():
    if not os.path.isdir(IOS_ASSETS):
        print('[跳过 iOS] 找不到 ' + IOS_ASSETS + '（先跑 npx cap add ios）')
        return 0
    print('iOS 资源 →')
    # 全出血正方形 + 转 RGB：去掉 alpha 通道，App Store 才收
    save(render(IOS_ICON_SIZE, 'square', CANVAS_RATIO).convert('RGB'),
         os.path.join(IOS_ASSETS, 'AppIcon.appiconset', 'AppIcon-512@2x.png'),
         'AppIcon.appiconset/AppIcon-512@2x.png')

    # 启动图单独降到 2 倍超采样：2 倍在这个尺寸上已经看不出锯齿，4 倍要 478MB 中间画布
    splash = render(IOS_SPLASH_SIZE, 'square', SPLASH_RATIO, ss=2).convert('RGB')
    for fn in IOS_SPLASH_FILES:
        save(splash, os.path.join(IOS_ASSETS, 'Splash.imageset', fn),
             'Splash.imageset/' + fn)
    return 1 + len(IOS_SPLASH_FILES)


def main():
    args = sys.argv[1:]
    want_android = ('--android' in args) or not any(a in args for a in ('--android', '--ios'))
    want_ios = ('--ios' in args) or not any(a in args for a in ('--android', '--ios'))

    total = 0
    if want_android:
        total += do_android()
    if want_ios:
        total += do_ios()
    print('完成，共写入 {} 个文件。'.format(total))


if __name__ == '__main__':
    main()
