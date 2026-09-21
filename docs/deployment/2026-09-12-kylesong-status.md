# kylesong.top 替换部署进度

> 后续版本：native-4 已于 2026-09-13 重新部署；现行版本与验收状态以 [native-4 记录](2026-09-13-native4-status.md) 为准。以下为 native-3 历史证据。

更新时间：2026-09-13（Asia/Shanghai）。当前状态：DuduHire 已在正式域名运行，HTML 缓存修复、新服务自启动及新库定时备份已完成；SMTP 真实 TLS/AUTH 验证和启用成功，启用后的 11 项公网 GET 检查全部通过。旧 API/outbox 和旧站备份 timer 已停用。原旧站标签页重载后已显示完整新首页，注册入口和工作方式页面已实测展示；生产 Qwen 单次合成连接及结构化返回检查通过，临时凭据传输文件已清理。15 分钟稳定性检查已通过，31 次采样无失败或服务重启。**短信与邮件实际发送均为 0；真实送达、注册登录、会话与 AI 业务流程仍待用户完成账户验证后验收**。下文保留各阶段历史，以末节最新实证为准。

## 目标核对

- 原请求写作 `kaosong.top`，该拼写的公共 DNS 查询返回 NXDOMAIN。
- 在旧项目的 `PROJECT_DEPLOYMENT_KNOWLEDGE.md` 找到域名 `kylesong.top`；本轮实时 DNS 确认指向 `115.29.178.65`，HTTPS 入口显示方序网站，旧 API `/api/v1/ready` 返回 `ready: true`。
- 本轮已在登录的阿里云域名控制台确认 `kylesong.top` 属于当前账号，状态正常；ECS 控制台确认杭州 `i-bp1dhuuwx8r0zprhvnov`，公网 `115.29.178.65`，2 vCPU / 2 GiB，Alibaba Cloud Linux 3。已使用现有免密通道以 root 进入 Workbench。原生服务拓扑仍通过服务器预检确认。
- 旧路径为 `/var/www/kylesong`、`/opt/kylesong`、`/etc/kylesong/app.env`，旧库为 `zjad`。后续先只读确认，再备份；新站使用独立发布目录和数据库，保留旧数据供恢复。

## 已完成的本地准备（切换前历史）

- 生产 Compose 和环境示例已补齐短信开关、允许号码、PNVS 凭据和发送限额的注入；默认仍关闭短信。
- 205 项本地测试、lint、Web/API 构建通过；运维脚本的合成回滚测试通过。没有 Docker 运行验收。
- 两份 GitHub workflow 的隔离容器 smoke 设置 `AI_MODE=local`，避免无真实 Qwen 凭据的隔离验证无法启动；生产仍要求真实供应商。仅配置解析及合成启动参数验证通过。
- 实时读取旧 `/service-worker.js` 确认其缓存名为 `fangxu-shell-v2`。新 Web 产物包含同 URL 的退役脚本，仅清理该缓存、接管已有客户端并注销旧 worker，不拦截请求或主动刷新页面。生命周期模拟通过且保留无关缓存，Web 已重新构建；旧浏览器更新行为仍待实际验证。
- 新增 `ops/package-native.mjs` 与 `docs/NATIVE_DEPLOYMENT.md`。本次发行包：`/private/tmp/duduhire-native-release/duduhire-20260912-native-3/duduhire-20260912-native-3.tar.gz`，74,767,207 字节，126 个负载文件，9 个迁移；SHA-256：`8a10991fb705b9641ac536484c417fe4a26625edee416546be5d5b10ad50c6bc`。归档摘要、路径、必需文件和逐文件清单通过本地验证；尚未上传或安装 Linux 运行依赖。

## 服务器切换前依赖（历史清单）

1. 内置浏览器和 Workbench 已恢复。继续核验运行服务、端口、磁盘和 TLS；不临时打开原部署已关闭的 SSH 22。
2. 准备新站 PostgreSQL 数据库、独立 owner/runtime/maintenance 角色及可验证 TLS；运行 001–009 迁移与迁移后授权。
3. 检查阿里云邮件服务与已验证发件地址；本机尚未发现有效 SMTP_URL。新版支持显式 EMAIL_DELIVERY_MODE=disabled，无 SMTP 时准确停用邮件功能，生产仍禁止 console 模式。相关 57 项 API 测试、lint、API/Web 构建通过；新增浏览器用例尚未运行。
4. 安全注入 Qwen、PNVS 及随机应用秘密。个人私有配置文件存在不代表生产凭据有效，不得复制到仓库或展示其值。
5. 短信目前仅面向最多 20 个允许号码。真实测试需确定接收号码和有限发送范围，在原浏览器页面由用户私下输入验证码；不把接口响应当成到达证明。
6. 创建并验证本次旧站、配置和数据库备份；新服务就绪后再切换 Nginx 路由及静态目录，保留现有 HTTPS。退役 worker URL 需 JavaScript MIME 与 no-cache。
7. 完成外网资源指纹、健康检查、真实短信/邮件送达、注册、刷新会话、退出和再次登录验证后，才能报告完成。

## 切换前进展与授权（历史）

- 用户已授权用新站覆盖旧站；最新明确要求使用已登录的内置浏览器，本轮按此继续，无需再次确认部署授权。
- 内置浏览器单次页面操作延迟较高，延长单次工具执行窗口后已读取账号、域名、ECS，并连接现有 Workbench 免密终端。
- 已执行只读预检，服务器临时报告 `/tmp/duduhire-preflight-20260912.txt`。确认 Node 22.23.2、npm 10.9.8、PostgreSQL 13.23、Nginx 1.24.0；磁盘剩 30 GiB、可用内存约 1.4 GiB，新端口 8788 空闲，旧 API/outbox active，无 `/opt/duduhire`。PostgreSQL peer 可用且旧库 `zjad` 存在；原预检多语句 `psql -c` 只返回最后结果导致假阴性，已修复本地脚本，补查确认 ssl=off，监听仅 127.0.0.1:5432，配置与数据目录位于 `/var/lib/pgsql/data`；无 duduhire 库和角色。Python 3.6.8、OpenSSL 1.1.1k。已读取真实 Nginx 配置并在本地生成保留 TLS 的候选（摘要 `adfd82b832299e853cbdbda95ab48d60177424867997198144fddd66b375e0a4`），尚未应用。
- 文件管理器上传会话过期后已刷新 Workbench 并以现有免密连接重连。上传对话框仅支持单文件，已改为逐个上传；发行包已提交上传，等待服务器端确认。尚未改 DNS、切换旧站或发送短信/邮件。下一步核验上传摘要、备份、配置独立新库及 TLS、安装、启动和切换。

## 本轮已审查的服务器操作包（切换前历史）

- `/private/tmp/duduhire-ops-20260912-1.tar.gz`：29,807 字节，SHA-256 `7dc0e81bd43c1d4088b9fe922ad360bcd7991dc2be7004da22b3f777c3beb59f`。仅公开运维脚本、systemd 模板和发行包摘要，不含服务凭据。
- `deploy-staging.sh` 先验证发行包，依次执行旧站文件/数据库备份、PostgreSQL 可验证 TLS、独立新库与角色、Linux 依赖、001–009 迁移与权限检查、8788 服务启动；最后只生成 Nginx 候选，不公开切换。
- 已修复受限 umask 导致新建公开 CA/发布父目录不可读的问题，并检查 npm 安装后服务身份的依赖读取权限。
- 真实 Nginx 候选仅改 root、主域同源 `/api/`、api 子域上游、主域 microphone=(self)、www 规范域跳转；TLS、CSP 和旧 service-worker 精确路由保留。13 项本地切换测试通过。
- 新库独立本地备份脚本及每日 timer 已准备，8 项离线测试通过；尚未安装或启用。

## 服务器实际执行结果：21:48（Asia/Shanghai）

运维脚本通过同一 Workbench 终端传入并校验，目录 `/root/duduhire-transfer-20260912`，进程启动 PID 91946，日志 `staging.log`。发行包在服务器验证通过。旧站备份完成：`/root/duduhire-backups/20260912T134804Z-4fe2ad`，manifest SHA-256 `b03276142bd1c5fa75e4556ad88bfadbd078c2d85791ac2f8ca533cd1daae9d2`；文件归档完整读取及数据库归档列表检查通过，未恢复演练。

TLS 启用检查失败，脚本恢复了原 `postgresql.auto.conf` 并确认 SSL 仍 off，未重启数据库。新库/角色/env、发布目录、迁移和服务尚未创建；旧 API active，新 API inactive，Nginx 未切换。生成的 CA 和服务端 TLS 文件保留，先只读诊断，不重跑首次初始化。SELinux 已确认 Disabled。

已通过服务器证书确认 TLS 失败根因：OpenSSL 1.1.1k 将系统默认 `v3_ca` 与命令行 `-addext basicConstraints` 叠加，CA 出现两份 Basic Constraints，导致证书链验证报 error 20；CA 公共副本一致，服务端证书与私钥匹配。本地 `bootstrap.py` 已改用独立 CA/CSR 配置与明确扩展段，在安装公共 CA、修改 PostgreSQL 配置前先验证 CA 自签名及服务端 DNS/IP；Python 3.6 语法和本机 OpenSSL 3.6.3 实际签发验证通过，失败门禁通过合成检查。此修改仅供后续初始化，未替换服务器冻结版本；本次服务器使用保留原备份和私钥的 `repair-tls.py` 修复，修复与恢复部署结果须以服务器后续回报为准。

## 2026-09-12 23:10 恢复进度（历史，Asia/Shanghai）

- TLS 修复已在服务器执行，真实证书校验握手通过，PostgreSQL `ssl=on`。PG13 libpq 对本机 IP SAN 的匹配限制通过将三个新库 URL 的 host 精确改为 `localhost` 解决，密码与供应商配置保留；三个角色的 verify-full 认证和拒绝明文检查均通过，`database-env-complete.json` 已写入本次备份。
- 发行包已提取到 `/opt/duduhire/releases/duduhire-20260912-native-3` 并核对清单。原依赖步骤失败：官方 npm registry 连接超时，npm 随后报告 `Exit handler never called!`；未进入迁移、服务启动或公网切换。
- `registry.npmmirror.com` 已通过服务器同一服务账号的真实 tgz 下载及原 lockfile SHA-512 校验。重试仅调整下载 registry，保留 lockfile、完整性校验、原失败目录和缓存；后台 PID 92819，日志 `/root/duduhire-transfer-20260912/npm-retry-1.log`。结果尚待读取。
- 用户已明确授权 DirectMail 新增计费服务，服务已开通；发信域名 `mail.kylesong.top`（杭州，565617）已创建，仍待 DNS 验证。原三个网站 A 记录未改，发件地址和 SMTP 尚未配置。
- 短信测试和邮箱测试沿用用户提供的接收人及次数授权，当前均未发送。

## 正式域名首次切换结果（后续状态见末节）

- 依赖恢复完整通过，日志结束为 `STAGING_READY`，新服务在 8788 就绪；001–009 迁移、摘要与角色权限验收通过，`/opt/duduhire/current` 指向 native-3。
- `cutover.py apply` 返回 `applied`；Nginx 配置检查、reload 和本机就绪检查通过。配置原件保留于 `/root/duduhire-transfer-20260912/cutover-plan/original.conf`。
- `SSL_CERT_FILE=/etc/ssl/cert.pem bash ops/native/verify-production.sh` 通过全部 11 次公网 GET：主域 HTML、新版 JS/CSS 精确 SHA-256、退役 worker 与 no-cache、www 308，以及主域和 API 子域的 live/ready/auth methods。此次验收时 email disabled、phone available true。该标志不能证明短信配额或送达。
- 首次本机 Python 检查因未配置系统 CA 报证书链缺失；curl 使用系统信任验证成功，显式使用系统 CA 后 Python 全部通过，未关闭证书校验。

## 2026-09-13 缓存、服务收尾与 SMTP 启用（后续状态见末节）

- HTML 缓存修复于 UTC `2026-09-12 16:15:57` 返回 `RELOADED`。现行 Nginx SHA-256 为 `e653e6204518558300d3f6f0557d6b27c155fa01f4e100b9d247d3a6e9d9df8f`；修复前备份为 `/root/duduhire-backups/html-cache-20260912T161557Z-6shcicmv`。三个 HTML 的 epoch `If-Modified-Since` 检查均由 304 变为 200，响应带 no-cache、无 ETag，六个安全响应头保留。此项 HTTP 验证不替代浏览器根页重载验收。
- 新 API 为 active/enabled，新库 `duduhire-backup.timer` 为 active/enabled。首份备份 `/var/lib/duduhire-backup/duduhire-20260912T153141526Z-76666e735825.dump` 的 `pg_restore --list` 校验通过，未执行恢复演练。旧 API/outbox 均为 inactive/disabled，旧站备份 timer 已成功 `disable --now`；旧文件和数据库保留。
- `mail.kylesong.top` 的 DKIM、SPF、DMARC、MX 四条新增 DNS 记录在控制台返回 success 4，公网查询匹配；原三个网站 A 记录不变。DirectMail 域名验证通过，触发邮件发件地址 `no-reply@mail.kylesong.top` 状态正常。
- SMTP 凭据通过隐藏 TTY 输入安全导入；`enable-smtp.py` 的真实 TLS/SMTP AUTH 验证通过。原环境备份位于 `/root/duduhire-smtp-enablement/20260912T162012Z-ebc7dd`；运行配置仅修改 `EMAIL_DELIVERY_MODE`、`SMTP_URL`、`EMAIL_FROM` 三项并重启 API，随后 live/ready 通过、`email_available=true`，`SMTP_ENABLE_PROCESS_EXIT=0`。公网验收增加 `--email-mode smtp` 后，11 项 GET 再次全部通过；SMTP 接受认证不代表邮件已送达。
- 截至本阶段，15 分钟生产稳定性采样已启动但结果尚未完成；浏览器根页重载、真实 AI 调用、注册登录及会话当时均尚未验收，后续进展见下节。
- 短信和邮件真实发送均为 0。用户尚未选择注册账户类型；短信注册、登录测试各最多 1 次、总计最多 2 次，邮箱测试总计最多 1 封。沿用已有次数授权，验证码由用户直接在网站私下填写；本记录不保存接收者手机号、邮箱或验证码。

## 2026-09-13 浏览器、Qwen 单次检查与凭据清理

- 在原旧站标签页进入根路径后执行实际 reload；DOM 和 1280×720 截图均显示完整 DuduHire 首页，`dev.logs` 返回 `[]`。点击“免费注册”后，真实页面显示邮件链接方式可选且已选中，手机短信方式也可选；页面仍提示角色不可更改。本次未填写注册信息、未发送邮件或短信，用户账户类型仍待选择。
- 工作方式页面的真实 DOM 和截图检查通过。4K、44 秒视频在采样时为 `currentTime=34.525328`、`paused=false`、`muted=true`、`error=null`，已缓冲区间为 `0..37.528` 秒。这证明采样时视频正在播放，尚不能认定完整播放或全程无卡顿通过。
- root 使用已安装的 production `qwenClient` 模块执行一次合成供应商检查，限制 `max_tokens=64`、12 秒超时且无重试；真实结果为 `provider=qwen`、`model=qwen-plus`、`requests=1`、`structure_valid=true`、`error=null`、`processExit=0`。脚本为 `/root/duduhire-transfer-20260912/qwen-once-probe.mjs`，日志为 `/root/duduhire-transfer-20260912/qwen-once-1.log`。检查未创建用户、未写数据库，仅证明该进程使用生产配置的供应商连通及合成结构返回有效，不证明服务账号或已登录用户的 AI 业务流程。
- 服务器上的 `/root/provider-secrets.json`、`/root/duduhire-smtp.json` 已核对与运行配置一致后删除；本地 `/private/tmp/duduhire-private-transfer-20260912` 内对应两份文件也已删除。生产运行配置及受保护的备份保留，秘密值未输出。
- 本阶段尚在等待稳定性最终结果，现已完成，见下节。短信与邮件实际发送仍均为 0；真实注册、送达、登录、刷新会话、退出和再次登录，以及完整 AI 业务流程仍待验收。


## 2026-09-13 最新复核：15 分钟稳定性通过，真实账户验收待用户输入

- 服务器于北京时间 `00:39:35` 读取最终结果。采样覆盖 `00:21:50–00:36:50`，完整 900 秒、31 次采样，本地和公网健康及认证能力检查全部通过，失败数 0。API PID `93848`、Nginx PID `17573` 全程不变，二者 `NRestarts=0`，`STABILITY_PROCESS_EXIT=0`。证据为 `/root/duduhire-transfer-20260912/stability-1.log`。
- 采样期间 API journal 的 0–4 级计数均为 0，无截断。另在服务器内部统计 SMTP 启用以来的 176 条 API 日志：结构化 warning/error 均为 0，非 JSON 记录 4 条；没有输出日志正文，也未进行逐条正文审计。
- 真实登录页已检查，邮件链接与手机短信均可选择；这些入口展示和 SMTP AUTH 不等于实际收信或登录成功。短信配置仍限 1 个已授权测试号码，每日、每号码每小时、每 IP 每小时上限均为 2，发送窗口截止北京时间 `2026-09-13 22:16:30`（UTC `2026-09-13T14:16:30Z`）。公开 phone available 标志不表达该截止时间和剩余次数；不要自动延长窗口或把它当作全量公开短信注册。
- 尚待用户选择两个测试账户的类型（需求方或专业人才，注册后暂不可更改），然后才发送已授权的有限验证消息。任务累计 SMS 仍为 0、邮件仍为 0；短信注册和再次登录各最多 1 次、合计最多 2 次，邮件合计最多 1 封。验证码及邮件登录链接由用户私下在原网站浏览器完成，不发送到聊天。
- 用户完成验证后仍需核对注册、刷新会话、退出和再次登录，以及服务账号下已登录用户的真实 AI 业务流程。网站发布、基础健康与配置验收已通过，整个认证验收尚未完成。
