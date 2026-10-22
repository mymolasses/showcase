# Browser4：无端口 CarPlay 入口、域名和可选 HTTPS

适用接收机：iPhone 14 Pro Max / iOS 16.2 / Dopamine rootless。
仍然需要另一台 iPhone 发送 CarPlay，接收机保持 Showcase 前台，无安卓中转。
用户已验证旧版本电脑热点访问；本版自动测试不代替手机及 Model Y 焕新版实测。

## 安装与快速测试

1. 在 Showcase 完整停止 CarPlay，并关闭 **Tesla Network Probe / 车机网络探测**，再退出 App。
2. 用 Filza 安装 `Showcase-Browser4-iOS16.2-Dopamine-rootless.deb`，覆盖旧版。
3. 接收机开启个人热点，让电脑或特斯拉连接。打开 Showcase → Settings → Display。
4. 开启 **Tesla Network Probe**，刷新状态。需看到 `local_ready`，且显示 `HTTP 80：可用`。
5. 确认 **Browser Output** 已开启，启动 CarPlay，确认接收机有原生画面。
6. 浏览器完整输入 **http://carplay.99-99-99-99.sslip.io/**，直接进入 CarPlay 配对页；也可输入 **http://99.99.99.99/**。输入 Display 页的四位数字配对码。
7. 在特斯拉测试前关闭电脑页面，避免占用唯一的画面和触控连接。先停车测试画面、点击、拖动、长按松开、刷新及重连。

Browser4 在标准 HTTP 80 上同时提供网页、视频 WS 和触摸 WS；网页不会跳去 8080。
旧 8080 入口仍可用。80 被其他服务占用时，状态会提示；备用入口是
`http://99.99.99.99:8081/`，该入口也直接进入 CarPlay。
只开网络探测、不启动 CarPlay 时能打开配对页和诊断页，但不能播放视频。

地址仅用于连接接收机热点且兼容地址就绪的设备；离开热点后不要使用。
99.99.99.99 并非本项目拥有的公网服务器；本机别名或路由失效时不能保证请求仍在局域网。
免费 DNS 服务由第三方提供，车机能否解析需实测；IP 正常但域名失败时可先用 IP。

## HTTP 和特殊端口的依据

- TeslaMirror 官方 Android FAQ 仍列出 `https://TeslaMirror.net:9999` 备用入口，说明不能仅因带端口就判定特斯拉不支持。但不能据此保证目标固件接受 8080。
- WheelPlay 的实验方案仍有 HTTP 兼容入口，并明确要求目标车机验证。因此没有足够证据把用户的故障断定为“特斯拉只允许 HTTPS”。
- 本版优先去掉显式端口，同时准备标准 HTTPS 443；这是兼容性改进，不是目标固件已验证的结论。

来源：
[TeslaMirror FAQ](https://teslamirror.com/faq-android)、
[WheelPlay Tesla HTTP](https://github.com/fython/wheelplay/blob/main/docs/TESLA_HTTP.md)。

## 同类产品为什么不要求用户买域名

通常是项目方维护统一域名与证书，用户直接访问产品给出的入口。
Tesla Android 的文档明确使用 `device.teslaandroid.com`，设备通过本地 iptables 把该入口地址的流量转到设备 Web 服务，服务端反向代理提供 HTTPS，前端视频／触摸使用 WSS。
这说明域名可以只是局域网入口的名称，视频不必绕公网服务器。
来源：[官方网络与 SSL 说明](https://github.com/tesla-android/tesla-android.github.io/blob/main/release-notes.md)、[前端接口](https://github.com/tesla-android/frontend/blob/main/README.md)。

TslaMirror iOS 官方给用户统一的 `https://TslaMirror.com`，要求开启本地 Proxy，明确视频留在个人热点内；它没有公开足以核实证书签发、私钥分发细节的实现，不能把猜测当作已确认机制。
来源：[官方 iOS FAQ](https://teslamirror.com/faq-ios)。

本项目若面向所有用户做到“装好即用 HTTPS”，也需要有人长期维护域名、证书签发／续期和每台设备的私钥管理。只在包内附带一个公共域名，无法完成这些工作。
当前为个人原型，支持用户自己的可控子域名与独立证书；免费子域名即可，不要求购买顶级域名。

## 免费 HTTP 域名与 HTTPS 的区别

默认域名 `carplay.99-99-99-99.sslip.io` 由 sslip.io 动态解析到 `99.99.99.99`，
不需要注册。它只解决 DNS，没有附带本项目可用的 HTTPS 证书或私钥。
**本包默认 HTTPS 关闭，不能把 http 改成 https 就直接使用。**

可通过免费 DuckDNS 子域名获得自己可控的 DNS，再用 DNS-01 签发证书。
无需买域名、服务器或安卓手机，但需要你登录 DuckDNS 并选一个可用子域名。
这一步尚未完成，当前没有已经签发的公网可信 HTTPS 地址。

配置流程：

1. 在 [DuckDNS](https://www.duckdns.org/) 登录并创建自己的子域名，例如 `你选择的名字.duckdns.org`。
2. 把该域名的 IPv4 A 记录设置为 `99.99.99.99`。不要开自动更新公网 IP 的任务；不要配置不指向接收机的 AAAA 记录。
3. 在电脑用支持 DuckDNS 的 ACME 客户端通过 **DNS-01** 签发该域名的公开可信证书。DNS-01 验证域名控制权，不需要热点手机对公网开放端口。可参考 [acme.sh DuckDNS 文档](https://github.com/acmesh-official/acme.sh/wiki/dnsapi#27-use-duckdnsorg-api)。
4. 把签发得到的私钥、叶证书和中间证书链导出为带密码的 P12 / PFX。iOS 16.2 导入推荐兼容传统 PKCS#12 加密的格式；如果电脑的 OpenSSL 3 默认导出无法导入，使用其 `pkcs12 -export -legacy` 选项。不要分享私钥或 P12 密码。
5. 在 Showcase → Display → **Web Domain / 设置网页域名** 填写这个完整域名，不含协议、端口和路径。
6. 点 **Import HTTPS Certificate / 导入 HTTPS 证书**，从文件 App 选择 P12 / PFX，输入密码。
7. 关闭再打开车机网络探测。只有证书通过域名、时间和 iPhone 系统信任检查、443 端口可监听，才显示 HTTPS 已就绪。
8. 测试 `http://你的域名/` 和 `https://你的域名/`。HTTPS 页面的视频与触摸使用同源 **WSS**；没有 HTTP 视频混合内容。车机还需信任该证书链，iPhone 校验成功并不保证车机成功。
9. 证书到期前需在电脑续期、重新导出并导入；此原型不自动续期。无需把 DNS API token 放进 Showcase。

应用没有内置共享私钥、自签名证书或绕过证书校验的开关。
证书和密码以 0600 私有文件保存在接收机 `/var/mobile/Library/Showcase/` 下，不写入探测响应或日志。
DNS-01 机制见 [Let's Encrypt](https://letsencrypt.org/docs/challenge-types/#dns-01-challenge)，
免费 DNS 行为见 [sslip.io / nip.io](https://nip.io/)，
DuckDNS 的 A / TXT API 见 [官方说明](https://www.duckdns.org/spec.jsp)。

## 诊断与回滚

独立探测页移到 **http://99.99.99.99/probe**，备用为
`http://99.99.99.99:8081/probe`；域名入口也支持 `/probe`。
探测页连续收到 HTTP / JSON 响应才能证明该客户端往返可达。
`local_ready` 只证明手机本机别名和内核路由配置通过检查。

失败时保存：哪个完整网址可用、地址栏是否被改为 HTTPS、具体报错、电脑与车机差异，
以及 Display → **Copy Network Status** 的状态。该状态不含配对码或证书密码。
日志为 `/var/mobile/Library/Showcase/logs/network-probe.log`。
不要公开 `browser-server.p12`、`browser-web.json`、`browser-token` 或真实导航画面。

- `HTTPS 未配置`：正常的默认状态，不影响 HTTP。
- `证书未通过…检查`：核对域名、完整中间链、有效期及系统时间。
- IP 能打开、域名打不开：检查车机 DNS；不要据此更改已工作的热点路由。
- HTTPS 显示证书错误：记录车机文字，不能以绕过错误代替可信证书。
- 页面打开、无视频：检查 Browser Output、CarPlay 会话、四位码和前台状态。

先关闭探测，再停止 CarPlay，即撤下本版的标准端口入口和临时兼容别名。
卸载和正常退出也会清理；同时强杀主 helper 与清理子进程时可能需重启手机。
可覆盖安装 Browser3 回退；恢复官方包的步骤见 [安装指南](INSTALL_DOPAMINE.md)。

## 自动验证范围

- Mac 隔离 Chrome：标准入口 → 生产桥接 → 1080p MSE、单指回传、配对拒绝、重复配置、静态恢复、断线保留画面、重试和前后台复位。
- HTTPS/WSS：临时测试 CA（不写入系统钥匙串），域名校验、错误密码及错域名拒绝、4 MiB 媒体完整性、控制回传、公开 Origin 校验、只允许固定 loopback 上游、证书失败仍保留 HTTP。
- 独立探测、模拟地址／路由状态机与清理；桌面测试禁止真实别名修改。
- iOS arm64 / 16.2 编译签名、rootless 包路径和内容校验。

尚待目标 iPhone 的低端口权限、热点路由、证书导入 UI，以及中国大陆车机 DNS、HTTP/HTTPS、MSE 和触控的硬件验收。
