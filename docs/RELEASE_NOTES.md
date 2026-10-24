**Showcase+ v1.3.3**，应用／包版本 **1.3.3**，构建 **1010**。适用于 iOS 16.2+ / arm64 / Dopamine rootless。

- 调整 JPEG / MJPEG 共用的手机解码链路：不再强制 VideoToolbox 输出 BGRA，由解码器选择原生像素格式，再通过软件 Core Image 转换、裁切和 JPEG 编码。增加样本关键帧标记。
- JPEG 解码出错后清掉失效参考链，从关键帧重建解码器；连续失败最多重建三次，间隔至少两秒，新配置或成功解码后恢复预算。诊断新增 AVC Profile、原生像素格式、错误状态和恢复次数。`-12780` 的设备端根因尚未确认，需在用户的 iPhone 14 Pro Max / iOS 16.2 上验证。
- 修复前后台切换后发送手机没有重发 VideoConfig 时网页一直等待的问题，恢复同一会话的缓存配置并请求关键帧，旧触摸代次继续失效。真正断开屏幕会话仍清理配置。
- 加固强制退出后重开的恢复流程：串行执行旧服务恢复与认证启动；认证 socket、launchctl、ioreg 的等待有上限；被中断的认证请求不会无限占用服务。屏幕属性在主线程读取，Wi-Fi 总线探测单独异步执行，补充启动阶段日志。这些改动覆盖代码中确认的等待风险，不代表已经复现或确认用户 App 无法打开的根因；必要时仍需 app.log / iOS 崩溃记录。
- 扩展验证：真实原生 JPEG 的 Baseline 1920×1080、Main / High 1600×900 图片、裁切、方向和静态帧刷新；注入解码输出失败后的恢复、持续失败预算和新会话恢复；不重发 VideoConfig 的前台恢复；挂起子进程和半截认证请求超时。保留真实 Chrome 五后端、HTTP / HTTPS、触摸、iOS arm64 签名和真实 Linux dpkg 升级解包检查。

安装后确认手机关于和网页诊断均为 **1.3.3 / 1010**。先检查手机 App 划掉重开，再测 JPEG / MJPEG 和前后台恢复。如果仍无法打开，请提供 `/var/mobile/Library/Showcase/logs/app.log` 末尾与相应 iOS 崩溃记录；如果图片仍为零，请复制包含新增 `jpeg*` 字段的完整网页诊断。

WebCodecs 通常需要可信 HTTPS；旧的普通 HTTP 入口不保证能提供该 API。Broadway 软件模式仅支持兼容 Baseline 流，手机输出其他 Profile 时会回退 JPEG。WebRTC 仅用局域网 host ICE，仍可能受车机视频解码／显示策略影响。JPEG 增加手机编码和热点流量。具体条件、诊断和来源许可见 **BROWSER_MODES.md** 与 **THIRD_PARTY_BROWSER.md**。

Release 流程执行上述自动验证、iOS arm64 编译、签名和 deb 内容／来源校验。提供 SHA256SUMS 和 build-provenance.json。自动验证不等于手机或实车兼容性验收，不承诺 D 档画面已恢复。
