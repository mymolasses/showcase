# Browser5 / v1.0.5

针对特斯拉“只显示首帧，重连再更新一帧”的反馈，修复两条可能的冻结路径：

- CarPlay 未要求 RespectTimestamps 时，桥接改用本机到达时间。重复、回退、零值或大跳变时间戳不再丢弃有效帧，生成连续相对时间轴。保留不支持 B 帧的限制。
- 网页 MSE 声明无限直播时长。收到新视频但播放位置停住时，定位到新缓冲内恢复；不再仅在积压超过 650ms 时追帧。关闭变速追赶，避免反复耗尽缓冲。静态屏幕无新数据时保持画面，不循环重连。

移除服务端配对码验证、网页输入框和手机配对码 UI。访问入口后自动连接，仍校验本机 Host 和同源 WebSocket Origin；单观看／控制端限制保留。连接热点的客户端可直接打开和控制 CarPlay。

画面占满网页可用区域，菜单为默认收起的浮层。默认“填满”模式拉伸到可用区域，不裁掉 CarPlay 按钮；菜单可切“等比”保持原始比例。两种模式的触控坐标均匹配显示。此设置不能移除车机浏览器自身的地址栏、系统栏或源视频中编码进去的黑边。

## 验证

Windows 上已通过：

```sh
node tests/test_browser_player.cjs
node tests/test_browser_stall.cjs
node tests/test_browser_live.cjs
```

最后一项需要 Playwright 与 Chrome，可用 NODE_PATH 和 CHROME 指定安装位置；只创建隔离浏览器及本机合成视频服务。覆盖真实 Chrome 连续解码、重复和回退 PTS、静态停流后恢复、免密码自动进入、填满与等比切换、手动重连。模拟单帧停滞测试覆盖小于 650ms 的新缓冲恢复和静态屏幕不反复 seek。

macOS 原生集成测试已更新为免密码，并增加重复／零时间戳回归用例。GitHub Actions 的 Release 流程在 macOS 上运行这些测试、iOS 编译签名和 deb 内容校验，全部成功后才公开 Release。真实故障根因尚需实车复核，桌面通过不代表特斯拉已验证。

## 安装和实车复核

安装 v1.0.5 Release 的 rootless deb。先停止 CarPlay、关闭网络探测、覆盖安装，再重新开启探测和 CarPlay。车机重新加载入口后应直接进入画面，右上角“菜单”可重连或切换显示比例。

先用动态导航画面连续观察，再测试静态画面停留后操作、点击拖动、刷新和重连。手机保持 Showcase 前台；关闭其他电脑或手机上的观看页。

排查时可查看 `/status` 的 `receivedFrames`、`timestampFallbacks`、`frameAgeMs` 和 `mediaQueueBytes`：持续收到帧但画面停住时，需进一步检查车机解码与 MSE；若源帧数不增长，则检查接收机前台及 CarPlay 来流。
