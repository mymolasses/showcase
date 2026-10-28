> 历史说明：当前版本仅支持可信 HTTPS/WSS 下的 Worker/WebCodecs/WebGL2。请优先按 [当前说明](BROWSER_MODES.md) 配置；下文旧播放器与 HTTP 播放描述不再适用。

# iPhone 14 Pro Max / iOS 16.2 / Dopamine rootless 安装测试

本指南对应 `1.0~beta5-2+browser4` 浏览器原型，2026-10-22 构建。
安装包是 `iphoneos-arm64.deb`，使用 `/var/jb` 布局；它不是 IPA。
这是针对该系统和越狱布局构建的测试包，尚未在真实 iPhone／特斯拉上验收。

## Browser4 升级与实车网络探测

本版在标准 HTTP 80 直接提供 CarPlay 网页、视频和触摸，不再跳转 8080。
完整测试步骤见 [Browser4 测试指南](TEST_TESLA_BROWSER4.md)。
开启车机网络探测并显示 `local_ready`、`port80` 后，打开
`http://carplay.99-99-99-99.sslip.io/` 或 `http://99.99.99.99/`。
独立探测页改为 `/probe`。只开探测能打开页面，但播放仍需 Browser Output 和 CarPlay 会话。
默认免费域名只提供 HTTP；HTTPS 443 / WSS 需要配置可控域名和匹配可信 P12 证书，默认未启用。

## 保留的 Browser2 视频优化

1. 在 Showcase 三指轻点调出控制，点 × 停止 CarPlay，再安装 Browser4 deb 覆盖旧包。
2. 打开 Settings → Display，确认 Browser Output 开启；网页默认 1080p，可选择 900p／720p。
3. 记下新四位配对码；旧版长配对码失效，前导零需要保留。
4. 返回首页，重新 Start CarPlay。关闭旧网页，再打开热点地址，输入四位码。
5. 网页顶部会显示实际视频分辨率。若热点速度不足，降低档位后停止并重新启动 CarPlay。

Browser2 修复重复 AVC 配置重建播放器、静态画面恢复被误判为时间轴错误等路径，
增加缓冲恢复、保留最后一帧、渐进重连、明确的配对错误提示和服务日志。
新增回归覆盖四位配对、错误次数限制、重复配置、静态恢复、连接中断恢复、
单指操作与后台释放；自动化使用 Mac 上的真实 Chrome 和合成视频，不代表车机硬件验收。

## 包内内容与验证范围

- 从当前分支交叉编译修改后的 Showcase UI 和 CarPlay 网络服务。
- 三个新程序（UI、CarPlay 服务、ShowcaseNet）均使用 `SHOWCASE_ROOTLESS=1`、arm64、iOS 16.2 deployment target。
- 保留同版本官方 rootless 包的 CarDisplaySim、BTdaemon、libBTstack；安装脚本新增 ShowcaseNet 签名，卸载／升级时停止探测进程。
- 下载的官方运行库包校验 SHA-256；构建记录列出三个未改运行库的摘要。
- 新程序在 Mac 上带所需 entitlement 进行 ad-hoc 签名；安装时 postinst 使用手机的 ldid 重新签名。
- 包内文件按 root:wheel 打包，UI、两个原有 helper 和 ShowcaseNet 为 4755，BTdaemon／dylib 为 0755。
- 独立版本号、`MinimumOSVersion=16.2`，并保留原包 ID `com.rostane.showcase`。

保留原包 ID 是为了作为原版 Showcase 的升级安装，避免两个包争用蓝牙 daemon、文件和 socket。
原有设置通常保留。这个包不新增 A16 蓝牙驱动；其硬件接管仍依赖上游实现，需要先验证原生 CarPlay 接收。

## 安装（Filza）

1. 确认手机已经进入 **Dopamine 已越狱** 状态；如果重启过，先在 Dopamine 中重新越狱。
2. 退出／停止正在运行的 Showcase 会话。
3. 在 Sileo 确认已安装 rootless 版本的 **ldid** 与 **UIKit Tools（uikittools）**。如果此前已安装官方 Showcase，通常已有这两个依赖。
4. 把 `com.rostane.showcase_1.0~beta5-2+browser4_iphoneos-arm64.deb` 传到手机，例如通过 AirDrop 或 Filza 的文件传输功能。
5. 用越狱环境里的 **Filza** 打开 `.deb`，选择安装，等待结束。不要把这个包交给巨魔当 IPA 安装。
6. 若提示缺少依赖，先回到 Sileo 安装对应依赖，再重新安装本包，不要忽略错误。
7. 回到桌面，打开 **Showcase Browser**。若安装成功但图标未出现，在终端执行 `sudo uicache -p /var/jb/Applications/Showcase.app`。

Filza 开发者说明：[DEB 安装与文件传输](https://www.tigisoftware.com/default/?page_id=177)。

## 可选：手机终端安装

先用 Filza 把包复制到 `/var/mobile/Downloads/`。在 NewTerm 或 SSH 的 rootless shell 中运行：

```sh
cd /var/mobile/Downloads
sudo dpkg -i './com.rostane.showcase_1.0~beta5-2+browser4_iphoneos-arm64.deb'
```

输入你在 Dopamine 设置的密码。如果报告缺少依赖，可在 Sileo 安装依赖，或在确认 apt 提示后用 `sudo apt-get -f install` 修复，再重新安装本包。

检查实际安装的版本：

```sh
dpkg-query -W -f='${Package} ${Version} ${Architecture}\n' com.rostane.showcase
```

应包含 `1.0~beta5-2+browser4` 和 `iphoneos-arm64`。

## 测试顺序

### 1. 先测原生接收

先不启用 Browser Output，按原版 Showcase 的设置连接另一部 iPhone。
接收机首次准备认证时需能联网；接收画面应出现在 14 Pro Max 上。
先确认点击和导航可用，再进入浏览器测试。如果这里就无法完成蓝牙／Wi-Fi 连接，问题尚未到网页部分。

### 2. 启用浏览器输出

打开 Showcase 的 Settings → Display，启用 **Browser Output / 浏览器输出（原型）**。
选择网页分辨率，默认 1920×1080 / 30 fps，热点较慢时可用 900p 或 720p。
点 × 完整停止会话后重新 Start CarPlay，使所选浏览器分辨率、30 fps 和发送机音频配置生效。
重新打开 Display 设置查看当前热点 IPv4 地址和 4 位数字配对码。

保持接收机 Showcase 前台运行。程序会禁用自动锁屏，但手动锁屏／切到其他 App 会暂停网页画面。

### 3. 先用电脑浏览器测试

把电脑连接到 14 Pro Max 的热点，浏览器打开设置中显示的 `http://carplay.99-99-99-99.sslip.io/`（开启探测并显示 local_ready、port80 后），输入配对码。
确认有连续画面，能点击 App、拖动地图、长按并松开。刷新和断开重连也应恢复。

这一步可以先排除手机服务或输入通道问题。普通热点地址以手机显示为准；启用车机网络探测并显示 local_ready 后可测试兼容地址。

### 4. 再到特斯拉测试

停车后，让特斯拉连接同一个接收机热点，并在车机浏览器打开同一地址。
关闭电脑上的测试页，避免占用唯一的观看／控制连接，再在车机输入配对码。
依次检查：

1. 连续画面与比例；黑边区域不应触发点击。
2. 点击、拖动、长按和松手；首版不支持双指缩放。
3. 刷新页面和重连后，画面恢复、旧手势不残留。
4. 接收机切后台再回到 Showcase，网页能恢复；切后台期间不能控制。
5. 在发送 iPhone 上选择特斯拉蓝牙音频，分别检查音乐和导航提示。

通话和 Siri 麦克风路由需另测。测试时记录车型、车机固件、发送机 iOS 和 Dopamine 版本。
本包增加标准端口入口、免费 HTTP 域名及可配置 HTTPS；MJPEG 回退和车辆状态限制适配尚未实现。Wi-Fi 连上不等于目标车机的 MSE 视频必然可用。

## 遇到问题

| 表现 | 先检查 |
|---|---|
| 安装失败／依赖未配置 | Dopamine 是否处于越狱状态；包是否为 iphoneos-arm64；ldid、uikittools 是否已装 |
| “not running as root” | 包是否经 rootless 包管理流程安装；postinst 是否成功；不要手动拷贝 app 后用巨魔启动 |
| 蓝牙不支持／卡在 Wi-Fi | 先在关闭浏览器输出时复现，查看上游 BTstack／CarPlay 日志 |
| 电脑也打不开网页 | 开关是否已启用并重连 CarPlay；热点、地址、端口是否与设置一致；Showcase 是否前台 |
| 电脑可用，车机不行 | 记录车机地址访问、MSE／解码和 WebSocket 表现，区分网络不可达与播放器报错 |
| 配对失败／连接反复断开 | 配对码、是否仍有其他浏览器页面占用连接 |
| 黑屏但网页正常 | 接收机是否切后台／锁屏；手机原生 CarPlay 是否仍有画面；网页是否报告格式不支持 |

日志位于：

```text
/var/mobile/Library/Showcase/logs/app.log
/var/mobile/Library/Showcase/logs/carplay_services.log
/var/mobile/Library/Showcase/logs/carplay_bt.log
/var/mobile/Library/Showcase/logs/btdaemon.log
```

分享日志前去除设备名、热点密码、配对码和其他身份信息。不要上传 `browser-token` 文件。
需要查看时可在手机终端使用 `sudo tail -n 80 /var/mobile/Library/Showcase/logs/app.log`。

## 卸载或恢复官方版本

先在 Showcase 中停止会话，再用 Sileo 卸载 `Showcase Browser Prototype (Rootless)`。
或手动安装官方同版本 rootless `.deb` 覆盖回退；版本较低时包管理器可能显示降级提示。
官方包来自 [Showcase v1.0-beta5-2 Releases](https://github.com/amineross/showcase/releases/tag/v1.0-beta5-2)，
选择文件名以 `_iphoneos-arm64.deb` 结尾的包。不要选 `iphoneos-arm` 或 Taurine 包。

## 在 Mac 重建

需要完整 Xcode 的 iPhoneOS SDK、Python 3 和系统 codesign，无需 SSH 手机：

```sh
python3 tools/build_browser_rootless.py \
  --upstream-deb /path/to/com.rostane.showcase_1.0.beta5-2_iphoneos-arm64.deb
```

脚本只接受固定摘要的官方依赖包：

```text
f91ab0bf7ddf94d9eb1eacc56db37e8943ea8f1dce60c4976f793d679707a1d6
```

输出在 `build/browser-rootless/`：deb、SHA256SUMS、build-provenance.json。
构建后会重新读取 deb，校验所有文件内容、root 所有者、权限、MD5 和未改动蓝牙组件。
这些检查验证构建产物，不能代替手机与车机实测。
