**Showcase+ v1.3.4**，应用／包版本 **1.3.4**，构建 **1011**。适用于 iOS 16.2+ / arm64 / Dopamine rootless。

- 针对实机 JPEG / MJPEG 持续 `JPEG decoder output: -12780`、解码与图片计数均为零的问题，增加独立 FFmpeg CPU H.264 解码后备。系统解码失败后从关键帧切到 CPU，支持当前 High Profile 输入；后备解码与色彩转换不依赖 VideoToolbox / Core Image。仍通过 ImageIO 编码 JPEG，最多 15 fps、宽度最多 1280。
- 系统解码首张 IDR 失败时，立即重放同一张关键帧给 CPU；即使发送端随后静止，也能提交最后一张 JPEG。参考链、输入与图片队列仍有上限，持续失败仍受恢复预算约束。
- 网页选项按真实源 `sourceAVCProfile` 标注 Broadway Baseline 限制，High / Main 输入时禁用不兼容的软件选项；保存的旧选项也有明确回退原因。普通 HTTP 下 WebCodecs 仍需安全上下文，WebRTC 路径保留。
- 手机图片解码失败会直接显示原因，不再只显示等待画面。新增 `jpegDecoderBackend`（`videotoolbox` / `ffmpeg`）、`jpegFallbackReason` 和持久的 `jpegLastFailure`。切换 WebRTC 后旧 JPEG 失败记录不代表 WebRTC 当前失败。
- 固定 FFmpeg n8.1.3 的精确源码提交，仅构建 CPU H.264、图像转换和必要基础库，关闭硬件加速、网络和命令行程序；许可证随 deb 安装，原始源码与构建参数作为同一 Release 的附件提供。手机“关于”新增授权与源码入口。
- 新增强制所有系统解码返回 `-12780` 的真实 High Profile JPEG / MJPEG 像素、裁切、方向、触摸和恢复测试；覆盖只发一张 IDR 后静止的 CPU 后备出图。保留原有 HTTP / HTTPS、多后端、前后台、iOS 编译签名和真实 dpkg 升级解包验证。

安装后确认手机关于和网页诊断均为 **1.3.4 / 1011**。先测 JPEG，再测 MJPEG；若系统解码仍报错，预期 `jpegDecoderBackend` 变为 `ffmpeg`，`jpegDecodedFrames`、`jpegEncodedFrames`、`jpegSequence` 开始增长。仍无图时请复制完整诊断。保留 1.3.3 的启动恢复与前后台配置修复。

CPU 后备会增加手机负载和耗电，实际帧率取决于接收机；JPEG 也会增加热点流量。WebRTC 仅用局域网 host ICE，仍可能受车机视频策略影响。音频继续由发送手机走车载蓝牙，网页不加入音频或麦克风。显示条件和来源许可见 **BROWSER_MODES.md** 与 **THIRD_PARTY_BROWSER.md**。

Release 流程执行上述自动验证、iOS arm64 编译、签名和 deb 内容／来源校验。提供 SHA256SUMS 和 build-provenance.json。自动验证不等于手机或实车兼容性验收，不承诺 D 档画面已恢复。
