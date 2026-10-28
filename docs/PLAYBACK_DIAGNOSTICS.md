# Showcase+ 1.5.0 播放诊断

当前 renderer 固定为 webcodecs-worker。旧 renderer 本地存储不再读取；没有 JPEG 回退。

- secureContext 必须为 true；普通 HTTP 只显示 HTTPS 要求。
- Worker 首先检查 VideoDecoder，再检查源 AVC Profile 是否支持和 WebGL2 是否可用。
- inputFrames / bytes 是 Worker 收到的有效 AVC 输入。
- drawnFrames / presentedFps 仅计真实解码后 WebGL 绘制；没有媒体时钟或 video 回调计数。
- decodeQueue 达到四时重置解码器，等待 IDR；recoveries、droppedFrames 记录恢复，不允许坏参考链继续解码。
- lastDrawAgeMs 和 lastInputAgeMs 可区分源静止、解码未输出及网络断开。
- receiver 内是原生转发端统计，不能视为浏览器输出或端到端延迟。

旧版 -12780 属于已移除的手机端 JPEG 解码链，不适用于本版。测试与目标硬件验收范围见 BROWSER_MODES.md。
