# Showcase+ 1.5.0 / 1015：单一浏览器输出

仅保留：H.264 → 同源 WSS → Worker → WebCodecs → OffscreenCanvas / WebGL2。
网页不再提供 JPEG、MJPEG、软件解码、WebRTC 或旧模式选择器，也不会回退到它们。
手机端直接转发压缩 H.264，不为浏览器解码、缩放或重编码图片。音频继续由发送 iPhone 通过汽车蓝牙播放。

## 必要条件

- 车机需要浏览器信任的 HTTPS 证书与同源 WSS。
- 接收机设置中配置自有域名、匹配的可信 P12 证书，再重启网络探测。现有证书导入和热点路由保留；HTTP 入口仅适合网络诊断。
- 浏览器需要 Worker 中的 VideoDecoder、OffscreenCanvas、WebGL2 和支持源 AVC Profile 的解码器。
- 不满足条件时明确显示失败原因；不尝试低帧率后备。localhost 的 HTTP 例外只用于本机开发，不能代表车机的局域网 HTTP 可用。

## 保留功能

输出比例可自动适配浏览器，也可选择手机比例或固定分辨率。修改源尺寸会重新连接 CarPlay。
完整/铺满保持等比映射；单指触摸、长按、拖动、失焦取消和手机/网页输入交接保留。
静态画面不算卡顿；断线保留最后一帧，连接恢复后等待 IDR。前后台切换重建 Worker 和 WebSocket。

## 延迟和诊断

网络接收、解析、解码和 WebGL 绘制全部在 Worker，主线程仅处理界面和触摸。
解码使用 optimizeForLatency。允许短时网络突发；待解码输入达到 24 个，或至少四个尚未被解码器接收的请求持续积压超过 250ms 时，重置参考链并等待 IDR；不随意丢弃参考帧后继续解码。
服务端队列最多八个待发包，仍完整发送已开始写出的 WS 帧，避免截断协议。
WebGL 保留绘图缓冲以支持静态导航和断线截图。实现保留本项目的 AVCC 配置及消息封装，没有复制第三方播放器代码。

诊断中的 inputFrames、drawnFrames、decodeQueue、droppedFrames、recoveries、lastDrawAgeMs 区分传输、解码和绘制。
帧率仅由实际 WebGL 绘制增加，定时器和 WebSocket connected 状态不计为成功出图。

## 验证范围

真实 Chrome 覆盖 Baseline/Main/High H.264、可信 HTTPS/WSS、真实像素及上下方向、触摸、静态画面、断线重连和分辨率切换。
独立回归覆盖解码积压恢复、旧代回调清理及能力失败提示。浏览器验证不能代替 iPhone 原生编译、热点及目标车机实测。
这次改造未新增 VPN，也没有证明各款车机在 D 挡下的表现；该效果仍需目标硬件验收。
