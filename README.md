# Mineradio iOS 独立版（构建仓库）

把 **Mineradio** 搬进 iOS：**全部在 iPhone 本地运行，不需要电脑、不需要服务器。**

本仓库只存放**补丁与构建脚本**（约 30KB 文本）；网页界面、iOS 工程骨架等素材由
`apply.py` 在构建时从各公开仓库自动下载并组装（因此仓库里没有二进制文件）。

## 组成

```
apply.py                        自组装脚本：下素材 → 打补丁 → 自检
patch/mr-standalone.js          独立版桥接层：在应用内实现全部 /api/*（搜索/播放/歌词/登录）
patch/ios/MineradioPlugin.swift 原生 HTTP 通道（URLSession，绕过 CORS）+ 持久 Cookie 会话
patch/ios/MineradioPlugin.m     插件注册
.github/workflows/build-ios.yml 云端 macOS 构建 → 未签名 IPA → 发布到 Releases
```

## 原理

| 环节 | 做法 |
|---|---|
| 界面 | 复用 Mineradio-Android 的横屏 H5（`public/`） |
| 壳 | Capacitor 8 + WKWebView，横屏、后台播放 |
| API | `mr-standalone.js` 拦截 `/api/*`，改用网易云公开接口（无需加密签名） |
| 无 CORS | 请求经原生 `httpRequest`（URLSession）发出，不受浏览器同源策略限制 |
| 登录 | 二维码登录（终端生成二维码 + 轮询）或 Cookie 粘贴；Cookie 存原生会话 |

## 构建

push 到 `main` 或手动触发 `Build Mineradio iOS IPA`，产物 IPA 自动发布到 Releases。

## 安装（未签名 IPA）

- **TrollStore**（iOS 14.0–16.6.1 / 17.0）：直接安装，永久有效
- **SideStore / AltStore / Sideloadly**（更高版本 / 无 TrollStore）：电脑端完成一次配对或侧载；
  SideStore 之后可在手机上自动续签，不再依赖电脑

## 已知差异（相对安卓版）

- 仅接入网易云音源（QQ/酷狗/汽水/Spotify 显示为不可用）
- 歌词为逐行 LRC（安卓版的逐字歌词依赖服务端加密接口）
- 本地曲库扫描不可用（WebView 无文件系统权限）

## 版权

界面与逻辑来自 [Timingyyds/Mineradio-Android](https://github.com/Timingyyds/Mineradio-Android)（GPL-3.0）
及其上游 [XxHuberrr/Mineradio](https://github.com/XxHuberrr/Mineradio)、
[chthollyphile/folia-major](https://github.com/chthollyphile/folia-major)；
iOS 工程骨架参考 [xxyyht-design/Mineradio-v2-iOS-Standalone](https://github.com/xxyyht-design/Mineradio-v2-iOS-Standalone)。
本项目以 **GPL-3.0** 发布。仅供个人学习自用，请遵守各音乐平台用户协议。
