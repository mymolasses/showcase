# Showcase+ 1.4.0：当前诊断

新增 `outputMode`、`viewport`、`outputTarget`、`displayFit`。`receiver.displayRequest` 是已保存的输出目标，`displayNegotiated` 是本轮向发送机请求的尺寸，顶层 `resolution` / 接收机 `width,height` 是实际收到的视频尺寸；三者不能混为一谈。`receiver.phoneDisplay` 是手机当前横屏可用区域对应的受限像素尺寸。切换目标会重新连接 CarPlay，旧网页失败记录不代表本轮协商失败。

当前显示方式见 [BROWSER_MODES.md](BROWSER_MODES.md)。`renderer` 是实际后端，`fallbackReason` 说明回退原因；`capabilities` 记录浏览器安全上下文和解码 API，`receiver` 是独立的手机端统计。

`receiver.sourceAVCProfile` 是源视频 Profile（66 Baseline、77 Main、100 High），不依赖是否启动 JPEG。JPEG / MJPEG 共用手机图片解码器：`jpegDecoderBackend` 表示 `videotoolbox` / `ffmpeg` / `inactive`；系统失败后应切到 CPU，`jpegFallbackReason` 保留触发切换的原因。`jpegLastFailure` 跨停用保留故障快照；切到 WebRTC 后它不是当前 WebRTC 错误。

实机已确认 1.3.3 中持续 `-12780`、`jpegDecodedFrames=0`、`jpegEncodedFrames=0` 是系统解码输出失败，不能归因于网页 JPEG 解码。1.3.4 的预期是 CPU 后备的解码／编码／图片序列开始增加。旧系统错误记录仍可保留；应同时看当前后端、当前出图计数与最后出图时间。软件模式只支持 Baseline，High / Main 时会在选项中标记限制；HTTP 下没有 WebCodecs 是另一项能力条件。

`presentedFps` 只统计有效解码后绘制到 Canvas 的输出，不能证明屏幕图像内容变化。MJPEG 无可靠观测时显示 null。`drawnFrames`、`lastDrawAgeMs`、`decodeQueue`、`waitingKey` 用于检查网页输出。WebRTC 的回调次数、原始帧时间与质量计数分别保留，不再把重复回调或播放时钟推进当作新画面。

`receivedFps` 和 `bitrateMbps` 是网页 WS 视频消息的接收量；MJPEG / WebRTC 非 WS 视频路径没有准确值时为 null。手机来流、JPEG 编码／丢弃／错误／队列，以及 WebRTC 连接／发送等数据在 `receiver` 内，与网页输出分开。

默认 JPEG 下若 `receiver.jpegEncodedFrames` 持续增加而网页 `drawnFrames` 不增加，检查图片通道和浏览器解码；若 `jpegErrors` 增加，结合 `jpegLastError` 和源视频日志判断。触摸归属与控制积压仍由 `inputOwner`、`controlBufferedBytes` 和服务端状态说明。复制功能仅在本地生成文字，不上传。

## v1.2.x 历史诊断与故障证据

以下保留原 MSE 版本的复查记录，字段和恢复策略不能直接当作 v1.3.0 的现行实现。

# Showcase+：播放恢复和诊断

v1.2.1 的复查与新增触摸／诊断改动见 [播放与触摸复查](PLAYBACK_REVIEW.md)。

网页右上角“菜单 → 诊断”打开浮层，“复制诊断”生成当前快照；HTTP 不支持 Clipboard API 时自动尝试兼容复制。复制失败可直接选取面板文字。诊断只在本机页面计算和显示，不上传。

- `receivedFps`：网页每秒收到的视频消息数；它和帧提交回调都不是逐帧图像内容变化校验。
- `presentedFps`：有效帧推进的估计。优先使用浏览器 `totalVideoFrames - droppedVideoFrames` 的增量；不支持该计数时，使用回调中严格递增的 `mediaTime`。缺少两种信号时显示 null。计数不能保证屏幕图像内容已改变。
- `frameCallbackFps`、`frameCallbackCount`：原始回调频率与次数；浏览器在图像冻结时仍可能回调，不能直接当作出画面帧率或重置卡帧计时。
- `repeatedFrameCallbacks`：时间戳相同或回退的回调次数；`presentedMediaTime`、`browserPresentedFrames` 保留浏览器原始元数据用于比对。
- `totalVideoFrames`、`droppedFrames`、`nonDroppedFrames`：浏览器的总帧数、丢弃帧数及两者之差。总帧数包括解码前丢弃的帧，原来的 `decodedFrames` 命名不准确，已改为 `totalVideoFrames`。
- `lastPresentedAgeMs`：最近一次有效帧推进的年龄；`lastFrameCallbackAgeMs`：最近回调的年龄。持续回调但前者增加，有助于识别虚假的播放活跃信号。
- `bufferedAheadMs`：当前播放点到缓冲尾部的时间差，不是整个链路的端到端延迟。
- `historySeconds`、`queuedBytes`、`serverQueueBytes`：已保留的历史视频、网页待追加字节和服务端待发送字节。
- `recoveryCount`、`reconnectCount`、`lastReason`：恢复尝试、重连次数和最近原因。
- `sourceFrameAgeMs`：接收机最近一帧的年龄。静态 CarPlay 屏幕可以没有新帧，不应仅凭此值判定故障。

收帧持续但出画面不前进时，播放器最多先追帧两次，再重建 MSE 并请求关键帧；30 秒内连续失败受预算限制，防止无限重建。旧浏览器无法计数时使用播放时间作为恢复判断的后备信号，并忽略自身 seek 带来的短暂位移。

重复回调或 `presentedFrames` 自增不再单独清零恢复预算。若回调时间戳不可用，但非丢弃帧计数正常增长，仍接受独立的计数信号，避免健康播放被误判。相关回归测试覆盖固定零时间戳、回退时间戳、全部新帧被丢弃、正常计数与重复回调并存，及静态屏幕保留。

2026-10-23 的车机截图显示 v1.2.2 / 1006 在画面冻结时仍收帧约 20 fps、3.19 Mbps，缓冲约 92 ms，页面可见，`videoPaused=false`、`videoReadyState=4`，没有旧 canvas 遮挡；另一张快照显示媒体时间 0、回调计数 358，而总帧计数为 124、丢弃 113。原实现会把每次回调都当作进展，模拟固定时间戳回调已复现恢复计数一直为零的问题。截图是瞬时证据，不能确定浏览器在解码、合成或显示哪一层限制输出；P/D 档切换可逆的现象仍强烈提示车辆的视频策略。此修改修正统计和通用卡帧判断，不读取档位、不绕过车辆限制，也不代表实车 D 档播放已修复。实测数据应在停车后导出与分析。

随后用户确认车型为焕新版 Model Y，并提供 P 档正常截图：收帧约 22 fps、回调约 23 fps，`videoCurrentTime=19.986942` 与 `presentedMediaTime=20` 吻合；总帧 443、丢弃 308，差值 135。D 档截图对应视频时间约 5.65 秒而帧时间为 0，差值仅为 11。两种状态均报告页面可见、未暂停、无视频错误。这个对比支持按档位切换时媒体输出行为发生变化，但不能证明浏览器内部具体拦截点。累计丢帧数还可能包含此前 D 档阶段，不能把它直接解释为 P 档当前的丢帧率。用户口述车机为最新版，尚无具体软件版本号。

历史缓冲清理优先于下一次 append，不再等待发送队列完全空闲。关键帧稀疏时主动请求 IDR，只在足够旧的关键帧边界清理；历史超过 30 秒仍无法清理则重建播放器。

网络别名临时失败后采用 1、2、4、8、16、30 秒的有上限退避，成功后清零连续失败。清理失败和外部地址冲突仍保留明确错误，避免删除其他程序管理的地址。兼容地址仍挂在原来的 loopback /32，不改变 DHCP、热点主地址或默认路由。

路由和客户端回程检查都由独立工作线程处理，HTTP/WS 转发循环只读取缓存。`/probe.json` 的 `returnRoutePending` 表示回程结果尚未产生；`routeCheckAgeMs` 和 `routeCheckDurationMs` 可判断是否检查缓慢。首次开启可能需要几秒得到完整网络状态。

自动验证包括模拟 30 分钟稀疏关键帧播放、有限卡帧恢复、忽略关键帧请求时的历史上限、连续失败退避和成功清零、真实 Chrome 诊断数据及 HTTP 复制、注入 1.5 秒后台检查延迟时的 HTTP/WS/HTTPS 转发。虚拟时间测试不是手机或特斯拉长时间实测。
