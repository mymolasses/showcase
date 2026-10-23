**Showcase+ v1.3.1**，应用／包版本 **1.3.1**，构建 **1008**。适用于 iOS 16.2+ / arm64 / Dopamine rootless。

- 修复 1.3.0 安装失败：补齐许可证等新增文件的全部父目录条目，避免 dpkg 创建 LICENSE.Broadway.dpkg-new 时因目录不存在而中断。发布前新增真实 Linux dpkg 全新安装／升级解包检查，保留数据归档原样，测试时不执行 iOS 脚本。
- 新增“菜单 → 显示方式”：JPEG Canvas（默认）、MJPEG Image、WebCodecs Canvas、Software Canvas（Broadway Baseline）、WebRTC Canvas（实验）。移除旧 fMP4 / MSE 播放模式，保留 H.264 编码作为部分新后端的输入。
- 手机后台 VideoToolbox 解码并编码 JPEG，最多 15 fps、宽度最多 1280；前后端队列有上限，优先更新最新图片。不支持的 API、软件解码不兼容、UDP 或解码失败会说明原因并回退 JPEG。
- 修复把重复浏览器回调误认为新画面的诊断与卡帧判断。Canvas 模式按有效解码／绘制计数；无法准确观测的 MJPEG 帧率显示 null。补充后端、回退原因、浏览器能力和手机编码／发送统计。
- 保留免密码访问、填满／等比、手机与网页的触摸交接、移动合并、快速滑动终点、长按和取消保护、网络自动退避、后台路由检查，以及 v1.2.2 的蓝牙就绪启动修复。音频继续由发送手机走车载蓝牙，网页不引入音频或麦克风通路。

安装：1.3.0 解包失败的用户可直接用本版覆盖安装，无需卸载旧版。驻车后停止 CarPlay、关闭网络探测并退出 Showcase，用 Filza 覆盖安装 deb。确认 **1.3.1 / 1008**，重新开启 Browser Output、网络探测和 CarPlay，接收机保持前台，刷新原来的网页入口。默认先测试 JPEG，再在菜单切换；关闭其他观看页。

WebCodecs 通常需要可信 HTTPS；旧的普通 HTTP 入口不保证能提供该 API。Broadway 软件模式仅支持兼容 Baseline 流，手机输出其他 Profile 时会回退 JPEG。WebRTC 仅用局域网 host ICE，仍可能受车机视频解码／显示策略影响。JPEG 增加手机编码和热点流量。具体条件、诊断和来源许可见 **BROWSER_MODES.md** 与 **THIRD_PARTY_BROWSER.md**。

Release 流程验证原生服务、真实 Chrome 多后端、1080p JPEG、WebRTC、HTTP / HTTPS 网关、触摸与断线恢复，执行 iOS arm64 编译、签名和 deb 内容／来源校验。提供 SHA256SUMS 和 build-provenance.json。自动验证不等于实车兼容性验收；本版不读取档位或修改车辆系统，不承诺 D 档画面已恢复。可用 v1.2.2 / v1.2.0 的已发布 deb 回退。
