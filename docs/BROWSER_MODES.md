# Showcase+ 1.3.0 / 1007：浏览器显示方式

本版移除旧的 fMP4 / MSE 播放器，保留 CarPlay 接收、手机与网页触摸交接、免密码访问、热点兼容入口和手机蓝牙音频。H.264 编码本身仍用于部分新显示方式。

打开网页后默认使用 **JPEG Canvas**。展开“菜单”，在“显示方式”选择其他后端。选择保存在当前浏览器、当前入口下；换域名或 HTTP/HTTPS 后可能需要重新选择。切换会释放当前手势、结束旧显示连接，再建立新连接，只允许一个观看／控制页面。请驻车后切换与导出诊断。

| 选项 | 实际链路 | 条件与局限 |
|---|---|---|
| JPEG Canvas（默认） | 手机 VideoToolbox 解码、JPEG 编码，WS 传图片，网页解码绘制 | 不使用 video / MSE；最多 15 fps、宽度最多 1280，JPEG 质量 0.58；增加手机编码与热点流量 |
| MJPEG Image | 同一手机 JPEG 编码器，HTTP multipart 图片流 | 对照 OpenCarStream 的图片显示方式；浏览器无法准确提供实际绘制帧率，因此对应统计为 null |
| WebCodecs Canvas | 转发 H.264，浏览器 VideoDecoder 输出到 Canvas | 需要浏览器提供 VideoDecoder，通常要求可信 HTTPS；localhost 的桌面测试不能代表车机 HTTP 支持 |
| Software Canvas | 转发 H.264，Worker 中 Broadway/WASM 软件解码，绘制到 Canvas | 实验性，只支持兼容 Baseline 输入；不支持 CABAC、加权 P 帧等特性；性能不足或流不兼容会回退 JPEG |
| WebRTC Canvas | libdatachannel 发送 H.264 RTP，浏览器接收后由离屏 video 解码并绘制 | 实验性，仅局域网 host ICE，无外部 STUN/TURN；需要 UDP / DTLS 和浏览器支持；仍依赖 video 解码，不能承诺规避车机视频策略 |

不支持的浏览器 API 在选项中说明原因。新后端首次出帧超时、解码失败或持续收帧却没有有效输出时，明确记录原因并回退 JPEG；不会悄悄换回已删除的 MSE。JPEG 连续失败有恢复预算，避免无限重连。静态画面没有新来流时保留已有图片。

## 触摸与音频

触摸使用同一条控制 WS 和 CarPlay HID 链路，按源视频尺寸映射坐标；JPEG 的缩小不会改变点击位置。手机和网页按实际按下交接，空闲网页不占用手机输入。移动合并、快速滑动终点、长按保活、取消、失焦、尺寸变化、前后台和断线清理均保留。

网页不播放声音、不开麦克风。音频仍由发送 iPhone 走车载蓝牙，未引入 OpenCarStream 的 MP3 音频流或新的音频同步缓冲。

## 队列与诊断

手机图片解码输入最多 12 包 / 8 MiB；拥塞后等待 IDR，不阻塞 CarPlay 接收线程。JPEG 编码限帧但仍解码必要的参考链。发送端保留正在写入的完整分帧边界，并只保留最新待发图片。浏览器最多一个图片解码任务和一张待解码图片。WebCodecs 最多保留一个待绘制 VideoFrame，过时帧及时 close；软件解码最多 4 个待处理包，拥塞后重新请求 IDR。

`presentedFps` 来自有效解码／绘制，不能把浏览器回调频率当作新画面。WebRTC 同时核对非丢弃帧计数或帧时间戳，修复旧版重复回调仍清零卡帧计时的问题。MJPEG 无可靠计数时显示 null。`receiver` 内是手机来流、JPEG 编码、WebRTC 发送等统计，不能直接等同于浏览器输出或端到端延迟。

## 安装与验证边界

停止 CarPlay，关闭网络探测，退出 Showcase，保持 Dopamine 越狱激活，用 Filza 覆盖安装新版 rootless deb。确认 **Showcase+ 1.3.0 / 1007**，重新开启 Browser Output、网络探测和 CarPlay。接收机保持前台，关闭其他观看页面，刷新原来的网页入口。

自动测试覆盖协议、输入、重复回调、资源回收、真实 Chrome 多后端、原生 JPEG / WebRTC、HTTP / TLS 网关以及 iOS arm64 编译、签名与包来源验证。软件模拟和桌面测试不等于该型号车机已验证；本版不读取档位、不修改车辆系统，也不保证 D 档画面可用。此前已确认 P 档恢复、D 档冻结的观察记录保留在 PLAYBACK_REVIEW 和历史诊断中。请在停车后检查和导出数据。
