# Showcase+ 1.7.2 / 1020

- Remove the fixed lower and upper input limits for the automatic landscape ratio. Accept finite positive values, round them to two decimal places on Apply, and display two decimal places in both the browser and phone settings. Keep the default at 1.45.
- Add a 1.30 layout-threshold hint: the known Dashboard implementation uses its internal view width/height, which can differ from the full output ratio. This is a reference, not a guarantee for every sender/iOS version.
- Retain supported pixel-size and total-pixel protections. A requested ratio that cannot generate a valid output size produces an explanation instead of being saved silently.
- Verify ratios below 1.30 and above the former 2.00 ceiling, decimal rounding, persistence, invalid values, native control and real Chrome playback.
- The v1.7.1 publication was cancelled before release when the requested ratio behavior changed.

## 1.7.1 / 1019 (superseded; not published)

- Allow the automatic landscape minimum aspect ratio to be set as low as 1.31 in the browser and phone settings. Keep the default at 1.45 and the upper limit at 2.00.
- Update native and browser validation, error messages and the numeric input minimum together. Retain the selected ratio across reloads and restarts.
- Verify acceptance at 1.31 and rejection below it in geometry, native control and real Chrome tests. At a 1600×1250 viewport, 1.31 requests 1600×1220 output; the sending iPhone still determines Dashboard layout.

## 1.7.0 / 1018

- Add custom CarPlay output width/height in both the browser menu and phone Display settings; Apply once to reconnect, rather than reconnecting during typing.
- Remove the 1080-pixel output height cap. Custom sizes use even dimensions, 240–4096 pixels per edge, a maximum of 8294400 pixels, and aspect ratios from 0.4 to 4.
- Add automatic landscape output: fit the browser's measured usable area while maximizing height within an adjustable minimum width/height ratio (default 1.45, range 1.35–2.00). Browser resizing and fullscreen changes recalculate the target.
- Show measured viewport, pixel density and output target in the browser and diagnostics. Persist custom dimensions and the landscape ratio across page/app restarts.
- Retain the existing phone resolution budget and automatic browser width budget (1920) to avoid increasing default decode load. Custom output can request larger widths.
- The browser cannot inspect the sender's Dashboard layout. Landscape output is a configurable geometry constraint, not a guarantee of Apple's internal layout; reduce height/increase the minimum ratio if the sender stacks the cards.
- Keep the current Worker/WebCodecs renderer, touch mapping, Bluetooth audio and managed HTTPS renewal. Target iPhone/Tesla validation is still required.

## 1.6.1 / 1017

- Correct the concurrent activation regression test to accept either request completing first while requiring exactly one device binding, idempotent retries and persistent revocation. Application behavior is unchanged from 1.6.0.

## 1.6.0 / 1016

- Add device-bound activation and automatic trusted-certificate refresh for car.littlepond.eu.org.
- Check for updates on launch/foreground and every six hours while the app runs; keep a validated local certificate through service/network failures.
- Apply certificate updates to new HTTPS connections without restarting the app or closing existing WSS sessions.
- Keep DNS credentials on the dedicated service. Personal packages contain a short-lived activation code; public build artifacts contain no certificate private key or access token.
- Automatic issuance runs separately from app releases and does not require reinstalling after each renewal. Initial activation requires the personal 1.6.0 package.
- The dedicated updater runs on the existing VPS; its daily timer and authenticated identity rotation were verified with real certificates.
- Add validated original-directory certificate deployment hooks for the existing site, including backups and Nginx reload/start after Certbot or successful manual ACME renewal.
- Target iPhone and Tesla validation remain required.

## 1.5.0 / 1015

- Replace the five browser display modes with one Worker/WebCodecs/OffscreenCanvas/WebGL2 path.
- Forward compressed H.264 over same-origin WSS without phone-side image transcoding.
- Require trusted HTTPS and report unsupported browser/codec capabilities explicitly.
- Retain output sizing, touch/hold/cancel, Bluetooth audio, static screens and bounded reconnection.
- Remove JPEG/MJPEG, Broadway, WebRTC and their native dependencies from the browser package.
- Target iPhone and Tesla validation remain required; desktop tests do not establish D-gear behavior.

---

**Showcase+ v1.4.2**，应用／包版本 **1.4.2**，构建 **1014**。适用于 iOS 16.2+ / arm64 / Dopamine rootless。

- 修复发送端“忽略车辆／蓝牙设备”后的一种重连死循环：接收端反复提交旧蓝牙密钥，对端返回 HCI `PIN_OR_KEY_MISSING (0x06)`，随后断开、十秒重试，再次提交同一旧密钥。现在仅对已记住的发送机，在确认同一连接认证失败并断开后，删除该设备的失效密钥，再由正常配对流程重试。每次 Bluetooth 助手启动最多恢复一次；不会清空其他设备的蓝牙记录，也不删除 AirPlay 控制器或热点设置。
- 修复连接进度误报：普通 TCP 探测或 `GET /info` 不再推动“Wi-Fi → 配对”。只有实际收到非空配对／认证 POST 请求后才报告进入该阶段。
- 增加生产代码回归测试，覆盖缺失密钥、重复重试、连接句柄／设备地址不匹配、短报文、其他认证错误，以及 HTTP 探测与真实配对请求的区别。
- 保留 1.4.1 的 iAP2 合包处理、车机／手机比例选择、灵动岛避让、五种网页显示方式、触摸和发送端蓝牙音频。

安装后确认关于与网页诊断为 **1.4.2 / 1014**。先按正常流程连接；如果之前已在发送端忽略车辆，重新配对时请接受发送端出现的蓝牙／CarPlay 提示。无需再次主动删除配对记录。

本版针对抓包确认的旧密钥重试与进度误报。此前“蓝牙认证完成后，发送端不发布 CarPlay 控制服务”的故障、偶发蓝牙恢复守护进程未就绪，以及 Tesla D 档显示仍需继续实机验证；不将模拟测试、构建或成功安装视为这些问题已解决。
