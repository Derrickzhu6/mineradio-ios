#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
Mineradio iOS 自组装脚本
--------------------------------------------------------------------------
在 CI（或本地）中把散落在各公开仓库里的素材组装成一个完整可编译的 iOS 工程：

  1. 取 Mineradio-Android 的 H5 界面        -> public/
  2. 取 xxyyht 的 Capacitor iOS 工程骨架     -> ios/   （含图标/启动图等二进制资源）
  3. 注入本仓库的补丁：
       - public/js/mr-standalone.js    （独立版桥接层：无后端实现全部 /api/*）
       - public/js/vendor/qrcode.js    （二维码生成，CI 从 unpkg 下载）
       - index.html                    （挂载桥接层；去掉 googleapis 外链字体）
       - capacitor-bridge.js           （独立版下整体跳过）
       - 音频/封面代理调用点             （改为直连 CDN）
       - MineradioPlugin.swift/.m      （原生 HTTP 通道 + Cookie）
       - Info.plist                    （横屏 + 允许 http 资源）
       - project.pbxproj               （包名/版本号）

用法:
  python3 apply.py --out . [--src-h5 DIR] [--src-ios DIR] [--qrcode FILE]
如果不给 --src-h5/--src-ios，会自动从 GitHub codeload 下载。
"""
import argparse
import io
import os
import re
import shutil
import subprocess
import sys
import zipfile

H5_ZIP = "https://codeload.github.com/Timingyyds/Mineradio-Android/zip/refs/heads/main"
IOS_ZIP = "https://codeload.github.com/xxyyht-design/Mineradio-v2-iOS-Standalone/zip/refs/heads/main"
QRCODE_URL = "https://unpkg.com/qrcode-generator@1.4.4/qrcode.js"

SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
PATCH_DIR = os.path.join(SCRIPT_DIR, "patch")

FAILS = []


def log(msg):
    print("[apply] " + str(msg), flush=True)


def die(msg):
    print("[apply][FATAL] " + str(msg), flush=True)
    sys.exit(1)


def must(cond, msg):
    if not cond:
        FAILS.append(msg)
        log("!! 校验失败: " + msg)


def download(url, dest):
    log("下载 " + url)
    for attempt in range(3):
        try:
            subprocess.run(["curl", "-sL", "--fail", "--retry", "2", "-o", dest, url], check=True)
            if os.path.getsize(dest) > 1000:
                return dest
        except Exception as e:
            log("第 %d 次失败: %s" % (attempt + 1, e))
    die("下载失败: " + url)


def unzip(zip_path, out_dir):
    with zipfile.ZipFile(zip_path) as z:
        z.extractall(out_dir)
    entries = [e for e in os.listdir(out_dir) if os.path.isdir(os.path.join(out_dir, e))]
    if not entries:
        die("解压目录为空: " + zip_path)
    return os.path.join(out_dir, sorted(entries)[0])


def read(path):
    with io.open(path, "r", encoding="utf-8") as f:
        return f.read()


def write(path, text):
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with io.open(path, "w", encoding="utf-8", newline="") as f:
        f.write(text)


def replace_all(path, pairs, label):
    text = read(path)
    for old, new in pairs:
        if old not in text:
            must(False, "%s: 未找到锚点 -> %s" % (label, old[:70]))
            continue
        text = text.replace(old, new)
    write(path, text)
    log("已打补丁: " + label)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--out", required=True, help="输出目录（仓库根）")
    ap.add_argument("--src-h5", help="本地 H5 素材目录（Mineradio-Android/app/src/main）")
    ap.add_argument("--src-ios", help="本地 iOS 骨架目录（含 ios/ 的仓库根）")
    ap.add_argument("--qrcode", help="本地 qrcode.js 路径")
    args = ap.parse_args()

    out = os.path.abspath(args.out)
    tmp = os.path.join(out, ".build-src")
    os.makedirs(tmp, exist_ok=True)

    # ---------- 1. 素材 ----------
    if args.src_h5:
        h5_src = os.path.join(os.path.abspath(args.src_h5), "mineradio_src")
        if not os.path.isdir(h5_src):
            die("找不到 H5 源目录: " + h5_src)
    else:
        zp = download(H5_ZIP, os.path.join(tmp, "h5.zip"))
        root = unzip(zp, os.path.join(tmp, "h5"))
        h5_src = os.path.join(root, "app", "src", "main", "mineradio_src")

    if args.src_ios:
        ios_src = os.path.join(os.path.abspath(args.src_ios), "ios")
        if not os.path.isdir(ios_src):
            die("找不到 iOS 骨架目录: " + ios_src)
    else:
        zp = download(IOS_ZIP, os.path.join(tmp, "ios.zip"))
        root = unzip(zp, os.path.join(tmp, "iosrepo"))
        ios_src = os.path.join(root, "ios")

    # ---------- 2. 拷贝 ----------
    public = os.path.join(out, "public")
    if os.path.isdir(public):
        shutil.rmtree(public)
    shutil.copytree(h5_src, public)
    log("public/ <- H5 界面 (%d 个文件)" % sum(len(f) for _, _, f in os.walk(public)))

    ios_dst = os.path.join(out, "ios")
    if os.path.isdir(ios_dst):
        shutil.rmtree(ios_dst)
    shutil.copytree(ios_src, ios_dst)
    log("ios/ <- Capacitor 工程骨架")

    # ---------- 3. 注入桥接层 ----------
    shutil.copy(os.path.join(PATCH_DIR, "mr-standalone.js"),
                os.path.join(public, "js", "mr-standalone.js"))
    log("注入 js/mr-standalone.js")

    qrcode_dst = os.path.join(public, "js", "vendor", "qrcode.js")
    os.makedirs(os.path.dirname(qrcode_dst), exist_ok=True)
    if args.qrcode and os.path.exists(args.qrcode):
        shutil.copy(args.qrcode, qrcode_dst)
    else:
        download(QRCODE_URL, qrcode_dst)
    must(os.path.getsize(qrcode_dst) > 10000, "qrcode.js 体积异常")

    # ---------- 4. H5 补丁 ----------
    idx = os.path.join(public, "index.html")
    text = read(idx)
    # 4.1 去掉 Google Fonts 外链（国内网络会阻塞渲染），改用系统字体
    text = re.sub(r'\s*<link\s+href="https://fonts\.googleapis\.com[^>]*>', '', text)
    must('fonts.googleapis.com' not in text, "index.html 仍残留 googleapis 外链")
    # 4.2 挂载桥接层（必须在 capacitor-bridge.js 之前）
    anchor = '<script src="js/capacitor-bridge.js"></script>'
    must(anchor in text, "index.html 未找到 capacitor-bridge 锚点")
    text = text.replace(
        anchor,
        '<script src="js/vendor/qrcode.js"></script>\n'
        '  <script src="js/mr-standalone.js"></script>\n  ' + anchor)
    write(idx, text)
    log("已打补丁: index.html（去外链字体 + 挂载桥接层）")

    # 4.3 capacitor-bridge.js：独立版整体跳过
    replace_all(
        os.path.join(public, "js", "capacitor-bridge.js"),
        [("(function () {\n  'use strict';\n",
          "(function () {\n  'use strict';\n\n"
          "  // iOS 独立版：由 mr-standalone.js 接管全部 /api/*（无 Node 后端），本文件整体跳过\n"
          "  if (window.__MR_STANDALONE__) {\n"
          "    console.log('[Mineradio] Capacitor bridge SKIPPED: standalone mode');\n"
          "    return;\n  }\n")],
        "capacitor-bridge.js")

    # 4.4 音频/封面代理 -> 直连 CDN
    audio_files = []
    for base, _, files in os.walk(os.path.join(public, "js")):
        for fn in files:
            if fn.endswith(".js"):
                p = os.path.join(base, fn)
                if "'/api/audio?url=' + encodeURIComponent(" in read(p):
                    audio_files.append(p)
    must(len(audio_files) >= 4, "音频代理调用点数量异常: %d" % len(audio_files))
    for p in audio_files:
        t = read(p)
        t2 = re.sub(r"'/api/audio\?url=' \+ encodeURIComponent\(([^)]*)\)",
                    r"window.MRAudioProxy(\1)", t)
        must(t2 != t, "音频代理替换未生效: " + p)
        write(p, t2)
        log("已打补丁(音频直连): " + os.path.relpath(p, public))

    replace_all(
        os.path.join(public, "js", "modules", "05-playback", "01-cover-custom-map.js"),
        [("  if (!isProxyableCoverUrl(url)) return '';\n  return '/api/cover?url='",
          "  if (!isProxyableCoverUrl(url)) return '';\n"
          "  // iOS 独立版：无本地代理，封面直连 CDN\n"
          "  if (window.__MR_STANDALONE__) return url;\n"
          "  return '/api/cover?url='")],
        "封面直连")

    # ---------- 5. iOS 工程补丁 ----------
    app_dir = os.path.join(ios_dst, "App", "App")
    for fn in ("MineradioPlugin.swift", "MineradioPlugin.m"):
        shutil.copy(os.path.join(PATCH_DIR, "ios", fn), os.path.join(app_dir, fn))
    log("替换 MineradioPlugin.swift/.m（原生 HTTP 通道）")

    # Info.plist：横屏 + 允许任意 http 资源
    plist = os.path.join(app_dir, "Info.plist")
    t = read(plist)
    old_orient = ("\t<key>UISupportedInterfaceOrientations</key>\n\t<array>\n"
                  "\t\t<string>UIInterfaceOrientationPortrait</string>\n"
                  "\t\t<string>UIInterfaceOrientationLandscapeLeft</string>\n"
                  "\t\t<string>UIInterfaceOrientationLandscapeRight</string>\n\t</array>")
    new_orient = ("\t<key>UISupportedInterfaceOrientations</key>\n\t<array>\n"
                  "\t\t<string>UIInterfaceOrientationLandscapeLeft</string>\n"
                  "\t\t<string>UIInterfaceOrientationLandscapeRight</string>\n\t</array>\n"
                  "\t<key>NSAppTransportSecurity</key>\n\t<dict>\n"
                  "\t\t<key>NSAllowsArbitraryLoads</key>\n\t\t<true/>\n"
                  "\t\t<key>NSAllowsArbitraryLoadsInWebContent</key>\n\t\t<true/>\n\t</dict>")
    must(old_orient in t, "Info.plist 未找到方向配置锚点")
    write(plist, t.replace(old_orient, new_orient))
    log("已打补丁: Info.plist（横屏 + ATS）")

    # pbxproj：包名/版本 + 把插件文件加入编译（模板里这两个文件没被工程引用）
    pbx = os.path.join(ios_dst, "App", "App.xcodeproj", "project.pbxproj")
    t = read(pbx)
    t = t.replace("PRODUCT_BUNDLE_IDENTIFIER = com.mineradio.v2;",
                  "PRODUCT_BUNDLE_IDENTIFIER = com.mineradio.ios;")
    t = t.replace("MARKETING_VERSION = 1.0;", "MARKETING_VERSION = 2.1.0;")

    swift_bf = "AA00000000000000000000B1"
    objc_bf = "AA00000000000000000000B2"
    swift_fr = "AA00000000000000000000F1"
    objc_fr = "AA00000000000000000000F2"

    build_file_anchor = ("\t\t504EC3081FED79650016851F /* AppDelegate.swift in Sources */ = "
                         "{isa = PBXBuildFile; fileRef = 504EC3071FED79650016851F /* AppDelegate.swift */; };")
    file_ref_anchor = ("\t\t504EC3071FED79650016851F /* AppDelegate.swift */ = "
                       "{isa = PBXFileReference; lastKnownFileType = sourcecode.swift; path = AppDelegate.swift; sourceTree = \"<group>\"; };")
    group_anchor = "\t\t\t\t504EC3071FED79650016851F /* AppDelegate.swift */,"
    sources_anchor = "\t\t\t\t504EC3081FED79650016851F /* AppDelegate.swift in Sources */,"

    must(build_file_anchor in t, "pbxproj 未找到 PBXBuildFile 锚点")
    must(file_ref_anchor in t, "pbxproj 未找到 PBXFileReference 锚点")
    must(group_anchor in t, "pbxproj 未找到 group 锚点")
    must(sources_anchor in t, "pbxproj 未找到 Sources 锚点")

    t = t.replace(build_file_anchor, build_file_anchor + "\n"
                  "\t\t%s /* MineradioPlugin.swift in Sources */ = {isa = PBXBuildFile; fileRef = %s /* MineradioPlugin.swift */; };\n"
                  "\t\t%s /* MineradioPlugin.m in Sources */ = {isa = PBXBuildFile; fileRef = %s /* MineradioPlugin.m */; };" % (swift_bf, swift_fr, objc_bf, objc_fr))
    t = t.replace(file_ref_anchor, file_ref_anchor + "\n"
                  "\t\t%s /* MineradioPlugin.swift */ = {isa = PBXFileReference; lastKnownFileType = sourcecode.swift; path = MineradioPlugin.swift; sourceTree = \"<group>\"; };\n"
                  "\t\t%s /* MineradioPlugin.m */ = {isa = PBXFileReference; lastKnownFileType = sourcecode.c.objc; path = MineradioPlugin.m; sourceTree = \"<group>\"; };" % (swift_fr, objc_fr))
    t = t.replace(group_anchor, group_anchor + "\n"
                  "\t\t\t\t%s /* MineradioPlugin.swift */,\n"
                  "\t\t\t\t%s /* MineradioPlugin.m */," % (swift_fr, objc_fr))
    t = t.replace(sources_anchor, sources_anchor + "\n"
                  "\t\t\t\t%s /* MineradioPlugin.swift in Sources */,\n"
                  "\t\t\t\t%s /* MineradioPlugin.m in Sources */," % (swift_bf, objc_bf))

    must("MineradioPlugin.swift in Sources" in t, "pbxproj 插件未被加入编译清单")
    write(pbx, t)
    log("已打补丁: project.pbxproj（com.mineradio.ios / 2.1.0 / 插件入编译清单）")

    # ---------- 6. 收尾 ----------
    shutil.rmtree(tmp, ignore_errors=True)

    # 最终自检
    checks = [
        (os.path.join(public, "js", "mr-standalone.js"), "桥接层"),
        (os.path.join(public, "js", "vendor", "qrcode.js"), "二维码库"),
        (os.path.join(app_dir, "MineradioPlugin.swift"), "原生插件"),
        (os.path.join(ios_dst, "App", "App.xcodeproj", "project.pbxproj"), "Xcode 工程"),
        (os.path.join(ios_dst, "App", "App", "Assets.xcassets", "AppIcon.appiconset", "icon-1024.jpg"), "App 图标"),
    ]
    for path, name in checks:
        must(os.path.exists(path), "缺失: " + name + " -> " + path)
        log("OK  %s  %.1f KB" % (name, os.path.getsize(path) / 1024.0))

    if FAILS:
        log("==== 有 %d 项校验失败 ====" % len(FAILS))
        for f in FAILS:
            log("  - " + f)
        sys.exit(1)
    log("==== 组装完成 ====")


if __name__ == "__main__":
    main()
