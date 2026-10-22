# Browser output prototype / 浏览器输出原型

This fork adds a foreground-only local browser display and single-touch input
to Showcase. No Android device, screen recording or media relay server is used.
The upstream CarPlay receiver, authentication and Bluetooth setup are retained.

## 设备与首版范围

```text
发送 CarPlay 的 iPhone → 越狱 iPhone/iPad 上的 Showcase → 特斯拉浏览器
                               ↑                         │
                               └──── 单指触摸回传 ───────┘
```

两部 iOS 设备仍然需要。接收机与发送机是不同的设备。用户计划用
iPhone 14 Pro Max / iOS 16.2 做接收机；用户已反馈原生 CarPlay 接收正常；Browser3 的手机／车机稳定性仍待升级后验收。
先确认原版 Showcase 的蓝牙接管和 CarPlay 接收已经工作。巨魔可安装应用，
不代表已具备上游 deb、BTstack 和系统服务所要求的越狱运行环境。

- 接收机保持 Showcase 前台；启用浏览器模式的会话会禁用自动锁屏。
- 默认 1920 × 1080，30 fps；Display 可选 1600 × 900 或 1280 × 720。浏览器档位覆盖下方原生显示设置。
- H.264 压缩视频直接经 WebSocket 发送，在浏览器中转封装为 fMP4 并使用 MSE。
- 单指点击、拖动、长按、松开。暂不支持双指、键盘和浏览器麦克风。
- 声音留在发送 iPhone；请在发送机选择车载蓝牙。音乐、导航语音、通话、Siri
  的实际路由需分别验证，不能由网页有画面推断全部可用。
- 不支持锁屏／后台常驻；进入后台会停止网页视频并释放按压。
- Browser3 增加实验性本地兼容地址／内核路由检查；不包含 VPN、HTTPS、WebCodecs、MJPEG 或车辆行驶限制的适配。

## Browser3 车机网络探测

rootless 包新增 Settings → Display → Tesla Network Probe / 车机网络探测，
不依赖 CarPlay 会话，尝试在实际热点桥建立 `99.99.99.99/32` 与对应内核本地路由。
配置成功后测试 `http://99.99.99.99/` 或 `http://99.99.99.99:8081/`，
通过后才测试已有播放页 `http://99.99.99.99:8080/`。
普通热点入口保留，不改 DHCP、默认路由或防火墙；地址和热点回程仍需 iOS／车机实测。
详见 [Browser3 实车网络测试与回滚](TEST_TESLA_BROWSER3.md)。

## 使用

1. 按上游方法构建并安装此分支的修改版 Showcase。原版安装包没有这些修改。
2. 在接收机打开 Settings → Display，启用 **Browser Output / 浏览器输出（原型）**。
3. 停止并重新连接 CarPlay，让浏览器模式、分辨率、30 fps 和发送机音频设置生效。
4. 让发送 iPhone 和特斯拉连接接收机的个人热点。
5. 在接收机 Settings → Display 查看当前热点地址和 4 位数字配对码。
6. 车机浏览器打开显示的 `http://实际热点IPv4:8080`，输入配对码并连接。
7. 手机保持在 Showcase 前台。首次配置和排障请停车完成。

监听地址为接收机的 IPv4 接口。页面只接受本机 IPv4 Host 和同源 WebSocket；
当前不接受 `.local` 名称或 IPv6 URL。如果热点地址还未出现，先启动 CarPlay，
然后重新打开设置页。普通入口不要照抄其他手机的 IP。兼容地址仅在车机网络探测实际显示 local_ready 时展示。

浏览器模式在下次 CarPlay 连接时生效。关闭开关后同样重连，以恢复原版显示／音频配置。
停止 CarPlay 后本地 HTTP 服务随网络 helper 退出。配对码存放在接收机私有文件
`/var/mobile/Library/Showcase/browser-token`，权限 0600；不会通过启动参数或普通日志输出。

Browser2 会把旧版 32 位配对码迁移为随机四位数字（可含前导零），原码失效。
累计 5 次错误配对后，认证接口暂时锁定到当前 30 秒窗口结束。
网页显示实际流分辨率、连接中断状态和重试倒计时；配对错误停止自动重试。
重连期间保留最后一帧；重复的 AVC 配置不会重置播放器，静态画面停顿不会当成时间轴错误。

一次只允许一个观看连接和一个控制连接。网页关闭、隐藏、断网、流切换和
触摸租约超时会释放按压；浏览器控制连接存在时，本地手机 CarPlay 触摸被忽略。
只有持有配对码的同源页面可订阅媒体／状态和发送控制。HTTP 在热点内仍是明文，
配对码不能代替传输加密。

## 代码入口

| 文件 | 用途 |
|---|---|
| `source/browser_bridge.m` | 非阻塞 HTTP/WS 服务、配对、流分代、有界队列、触摸状态与超时 |
| `source/browser_settings.h` | 模式开关、私有配对码、热点地址枚举 |
| `source/carplay_services.m` | 配置／解密帧分发、HID 输入回调、会话与前台状态 |
| `source/Showcase.m` | Display 设置、720p30 档位、前台自动锁屏策略 |
| `web/index.html`, `web/player.js` | 本地网页、MSE/fMP4、等比坐标换算、重连 |
| `tools/embed_browser.py` | 把网页嵌入 `source/browser_assets.h`，无需运行时网页目录 |

HTTP 提供 `/`、`/player.js` 与持配对码的 `/status`。媒体 `/media` 和控制
`/control` 使用独立 WebSocket，配对码通过 `Sec-WebSocket-Protocol` 发送。
控制端只提供 CarPlay 触摸、心跳与限频关键帧请求，不提供 shell 或文件访问。

媒体二进制协议（多字节整数均为 big endian）：

| 类型 | 内容 |
|---|---|
| `1` | u32 generation, u16 width, u16 height, AVCC decoder configuration |
| `2` | u32 generation, u8 keyframe, u64 relative PTS in microseconds, AVC access unit |
| `3` | u32 generation；清除旧播放器并等待新的配置 |

H.264 access unit 使用 4 字节 NAL 长度前缀，不是 Annex B，也不包含原生 IPC 的
56 字节内部元数据。服务端把发送端 32.32 时间戳转换为相对微秒。
MSE 首版只支持无 B 帧的低延迟视频；页面检测到 B slice 会明确报错。
连接和积压恢复必须从配置及 IDR 开始；视频消费者不会阻塞 CarPlay 收流线程。

## 构建

沿用上游的 on-device SDK/clang、BTstack、ldid、SSH 及打包依赖，见主 README。
rootful、rootless 和 Taurine 路径均纳入新增源文件；网页已经嵌入并提交。
修改网页后先运行：

```sh
python3 tools/embed_browser.py
```

例如，为 rootless 接收机使用现有的构建脚本（根据实际 SSH 配置设置参数）：

```sh
cd packaging
./scripts/build-rootless-deb.sh
```

此脚本使用越狱设备及上游列出的本地依赖，不是纯 Xcode 一键安装脚本。
另提供无需 SSH 手机的 Mac 交叉编译打包脚本 `tools/build_browser_rootless.py`。
已为 iOS 16.2 / Dopamine rootless 构建测试 deb；安装步骤、包来源和重建方式见
[iPhone 14 Pro Max 安装测试指南](INSTALL_DOPAMINE.md)。手机安装与硬件验收仍待完成。

## 验证

核心播放器无需 npm 安装即可测试：

```sh
node tests/test_browser_player.cjs
python3 tests/test_browser_bridge.py
```

第二条需要 macOS 的 Foundation、clang 与本机回环端口权限。测试真实服务端，
使用合成媒体和固定测试配对码，覆盖握手、Host/Origin、单控制端、视频包／时间戳、
单指状态、静态画面触控、后台复位、旧 generation、断线和触摸租约释放。

可选的真实浏览器端到端测试需要 Playwright 和 Google Chrome：

```sh
node tests/test_browser_e2e.cjs
```

使用独立临时 Chrome profile，通过 WebCodecs 生成合成 H.264，再走生产 WS/MSE
显示画面并验证点击／拖动／松开、黑边拒绝、重连和前后台复位。可用 `CHROME`
指定 Chrome 可执行路径，用标准 `NODE_PATH` 指定已有 Playwright 安装位置。
测试不读取用户浏览器资料，不连接 iPhone，也不把视频上传到外部服务。

2026-10-22 验证范围（Browser3 新增网络回归见实车测试指南）：

- 修改后的 UI、桥接与服务通过 iOS arm64 语法检查，并编译链接出未签名可执行文件。
- 核心播放器、macOS 服务端集成、真实 Chrome MSE／触摸端到端测试通过。
- 上游显示配置、连接、蓝牙恢复与本地化检查通过。
- 未做真实 iPhone → Showcase → 特斯拉的硬件验收；不能据此承诺目标车机兼容。

## 硬件验收与已知边界

先确认目标车机可访问热点宿主地址、支持对应 AVC profile 的 MSE 和 WebSocket。
网络连接成功不代表所有车辆状态下都可播放。Browser3 的兼容地址是实验入口，
仍可能被目标固件的地址／HTTP 策略拒绝；HTTPS 和 MSE 不兼容问题尚未解决。

现场顺序：网页连通 → 停车连续画面 → 单指和长按 → 刷新／重连 → 发送机蓝牙音频。
记录车型、固件、CarPlay 发送机系统、接收机越狱方式与连接状态。
若看到“播放失败”，先用桌面浏览器访问同一入口，对比是否为车机解码问题。
配对码、真实导航内容和设备身份不应放进公开问题日志。
