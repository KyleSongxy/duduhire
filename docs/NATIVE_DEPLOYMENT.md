# 阿里云现有单机：DuduHire 原生发行与切换

本指南对应当前 AI Marketplace 工作区的 Node API、静态 Web 和 PostgreSQL。目标是已核实的 `https://kylesong.top`，服务器公网 IP 为 `115.29.178.65`。此前 `kaosong.top` 的拼写不作为部署目标。

**发行包验证不等于上线验收。** 打包程序只在本机生成文件，不上传、不建立 SSH 连接、不改 Nginx、不创建系统用户或开端口、不运行数据库迁移，也不修改生产链接。服务商账号、服务器运行状态、SMTP、数据库 TLS、真实 Qwen 和短信投递仍须在服务器上分别核实。

## 1. 本机发行包

先在当前工作区完成必要构建，构建结束后运行：

```sh
node ops/package-native.mjs --output /tmp/duduhire-native-release
```

可用 `--id duduhire-YYYYMMDDTHHMMSSZ` 指定唯一版本名；同名目录已存在时失败，不覆盖。默认输出是 `/tmp/duduhire-native-release/<release-id>/`，包含归档、外置归档 `.sha256`、`verification.json` 和便于检查的 `payload/`。

白名单包括前后端 `dist`、根目录 `package.json` / `package-lock.json`、两个 workspace 的 `package.json`、全部 001–011 SQL 迁移、`apps/api/sql/grant-database-roles.sql`、本指南、数据库角色说明及离线验证程序。不包含 `.env`、`node_modules`、源码树、开发者个人配置或 macOS 元数据。编译 API 包含本地配置加载器的程序代码，但不包含配置文件；生产模式不会加载个人文件。

`RELEASE.json` 记录版本、文件数量和迁移清单；包内 `SHA256SUMS` 覆盖全部负载文件和 `RELEASE.json`，不自校验。外置 `.sha256` 覆盖整个归档，从而覆盖包内清单。打包器随后重新读取归档，验证归档摘要、每个文件摘要、必需条目、清单完整性、纯常规文件类型、权限和安全相对路径。归档没有软链接、硬链接、设备文件、绝对路径、`..` 或扩展元数据头。

独立复核（需要归档旁同名 `.sha256` 文件）：

```sh
node ops/package-native.mjs --verify /tmp/duduhire-native-release/<release-id>/<release-id>.tar.gz
```

该验证器限定本项目生成的 USTAR 格式，解压内容最大 512 MiB；它不解包到磁盘。摘要用于识别传输损坏和版本差异，不能代替可信传输或数字签名，也不能证明源码/前端资产中绝无人为硬编码秘密。不要同时构建、修改源码或替换 `dist` 后继续沿用旧包。

## 2. 先保留旧站，再准备独立目录

旧站为方序，历史部署使用 Nginx、PostgreSQL 和 systemd。实施前重新确认服务单元、监听端口、Nginx 生效文件、TLS 证书路径、旧数据库和备份恢复方式；不要根据历史名称停止不相关服务。

- 保留旧 `/opt/kylesong`、旧库 `zjad`、其服务定义和原 Nginx 配置，备份归档放在受保护的位置。
- 新站使用 `/opt/duduhire/releases/<release-id>`，以及在验收后切换的 `/opt/duduhire/current`。新版本目录先不接生产流量。
- 新 PostgreSQL 数据库使用独立名称，例如 `duduhire`，不向 `zjad` 执行本项目迁移，也不覆盖旧数据库或复用旧站密钥。
- 先用可信渠道传输归档和已记录的摘要，复核摘要及包内路径，再解压至新建且为空的版本目录。不要用覆盖解压替代发布目录隔离。

在目标 Linux 上确认 Node.js **22.13 或更高**，随后在新的 release 根目录安装该平台的依赖：

```sh
npm ci --omit=dev --workspace @duduhire/api --include-workspace-root
```

不能上传 macOS `node_modules`。Web 已编译，不需要运行 Vite 或安装 Web 开发工具。锁文件保留两个 workspace 的信息是正常行为。必须在目标服务器实际完成安装并确认 `node apps/api/dist/server.js` 能启动，才能认定 Linux 运行依赖已验证；本机打包不证明这一点。

## 3. 新数据库、TLS 与角色

生产 API 强制 `DATABASE_SSL=true`；迁移强制 `MIGRATION_DATABASE_SSL=true`；维护程序使用 `MAINTENANCE_DATABASE_SSL=true`。`pg` 使用 `rejectUnauthorized: true`。即使 PostgreSQL 在同一服务器，也不能通过 `NODE_ENV=development`、关闭证书校验或 `sslmode=no-verify` 绕过。

应先让 PostgreSQL 提供有效 TLS，连接主机名必须匹配证书 SAN；自有 CA 可通过受保护的 `NODE_EXTRA_CA_CERTS` 文件加入 Node 信任链，该变量须在进程启动前注入。连接串不能附带 `sslmode` 等查询参数；应用仅接受明确的 TLS 环境开关。保留旧站所需数据库访问方式，评估 PostgreSQL TLS 配置修改对旧客户端的影响。若当前服务器无法提供可验证的数据库 TLS，保持旧站服务，先解决该依赖。

由数据库管理员准备新库及分离登录角色：`duduhire_owner`（仅迁移）、`duduhire_runtime`（API）、`duduhire_maintenance`（保留期清理）；通知启用时另建 `duduhire_notifications`。使用各自独立密码，通过受保护的服务环境或秘密管理方式注入，不写入命令参数、终端日志、发布包或 Git。

初始化和授权参考随包 [DATABASE_ROLES.md](DATABASE_ROLES.md)，**本次必须验证 001–011 全部迁移和校验和，最新为 `011_session_active_role.sql`**。readiness 检查 011 的非空校验和记录、当前会话身份与密码设置期限等必要结构，不替代完整迁移历史验收。迁移前撤销 PUBLIC 的数据库 CONNECT / TEMPORARY、schema CREATE；将新数据库和必要时 `public` schema 所有权交给 owner，仅按角色授予连接及 schema 权限。

在已注入生产迁移环境的独立进程中，以 release 根目录作为工作目录运行：

```sh
node apps/api/dist/migrate.js
```

完成迁移后，使用 owner 对同一新库执行 `apps/api/sql/grant-database-roles.sql`，传入 `database_name`、`runtime_role`、`maintenance_role`，只有已创建通知角色才传 `notification_role`。该脚本检查当前库名称，按列授权；不要额外给予 runtime 整库、整表 UPDATE、DDL 或 DELETE 权限。API 进程只拿 runtime 连接，不能拿 owner / maintenance 连接。验收需要 runtime 的 readiness 成功及关键认证写入成功，并验证角色边界。

## 4. 生产环境必须具备的服务

服务环境文件应放在 release 外，例如 `/etc/duduhire/`，权限仅向必要管理员开放，由 systemd 读取；不要复制开发者 `~/.config/duduhire/`、开启 `DUDUHIRE_LOAD_LOCAL_ENV` 或把 `.env` 放进 Web 目录。

| 类别 | 必需配置与边界 |
|---|---|
| API | `NODE_ENV=production`、`HOST=127.0.0.1`、经查重的独立 `PORT`，例如可用时 8787；`WEB_ORIGIN=https://kylesong.top` |
| 数据库 | runtime 的 `DATABASE_URL` 与 `DATABASE_SSL=true`；迁移/维护分开进程、分开秘密 |
| 登录与资料 | 随机 `AUTH_TOKEN_SECRET` 至少 32 字符、`AUTH_COOKIE_NAME=__Host-duduhire_session`、`AUTH_COOKIE_SECURE=true`；独立随机 64 位十六进制 `CONTACT_DATA_KEY` 及非秘密版本标识 `CONTACT_DATA_KEY_ID` |
| 反向代理 | `TRUST_PROXY_CIDRS` 只信任实际 Nginx/LB 地址。单机直连可在确认路径后用 `127.0.0.1/32`；不能信任所有公网来源 |
| 邮件 | 原生生产环境须显式设置 `EMAIL_DELIVERY_MODE=smtp` 或 `disabled`。`smtp` 必须提供有用户名密码的 `SMTP_URL` 与已验证 `EMAIL_FROM`；显式 `disabled` 无需这两个值，邮箱功能不可用；生产禁止 `console`，不会因配置缺失自动停用 |
| Qwen | `AI_MODE=qwen`，有效 `QWEN_API_KEY` 或 `DASHSCOPE_API_KEY`、实际可访问模型和端点。默认模型 `qwen3.8-max`、端点 `https://dashscope.aliyuncs.com/compatible-mode/v1`；服务器出站及真实调用另验收，生产不允许 `AI_MODE=local` |
| 短信 | 默认 `PHONE_AUTH_ENABLED=false`。开启须有 PNVS 凭据、1–20 个明确获准的大陆手机号白名单及限额；当前实现不是开放短信注册 |

生产 Compose 和部署环境示例的默认邮件模式仍是 `smtp`，原生服务不会自动读取这些默认值，应在其受保护环境中明确填写模式。尚未接入邮件服务时，可以明确填写 `EMAIL_DELIVERY_MODE=disabled`，主 API 不需要 SMTP 配置并且不创建邮件传输器。`/api/v1/auth/methods` 应返回 `email: { available: false, delivery: "disabled" }`；邮件注册、登录和旧链接核验均返回 `503 EMAIL_AUTH_DISABLED`，不会发信、创建邮件 challenge、消费旧链接或建立新会话。已有有效会话可以继续读取和退出。页面的邮件入口显示未启用；登录默认仍使用邮箱密码，已有密码账户不依赖邮件发送完成登录。短信入口按 PNVS 配置决定是否可用；邮件与短信都停用时不能新注册或重新验证联系方式，也不能获得首次/重置密码所需的新邮件资格。此模式须交付为“邮箱未启用、投递未验收”，不能写成邮箱已可用。

邮箱注册仍先通过 Magic Link 验证所有权；登录默认使用邮箱密码，也保留邮件链接登录。首次设置或重置密码须在当前浏览器完成邮件验证，并在 15 分钟资格期内保存；成功后撤销全部会话并使旧邮件链接失效。既有密码登录不因停用邮件而禁用，但新的密码设置资格依赖邮件验证。需确认发信域名/发件人、SMTP 认证和 TLS、服务商要求的 SPF/DKIM/DMARC 等 DNS 配置；SMTP 接收不等于用户收件。凭据不能在聊天、前端、Git 或包内流转。测试须由用户在发起注册的**同一浏览器**打开真实邮箱链接，验证账户建立、会话、登出与再次登录；记录结果时不保留令牌链接。从 `disabled` 改为 `smtp` 后须补齐必填配置、重启并完成这些真实验收；不得静默改为 `console`。

主 API 的邮件模式不控制通知 worker。若启用企业咨询邮件通知，worker 仍需独立数据库连接、确认的收件邮箱、有效 `SMTP_URL` 和 `EMAIL_FROM`，并独立通过生产 TLS 等校验；未配置时保持停止。无论主 API 是否停用邮箱，HTTPS、数据库 TLS、Qwen 和生产密钥要求都不变。

短信使用阿里云号码认证 PNVS 的 `SendSmsVerifyCode` / `CheckSmsVerifyCode`，不能把普通短信服务已开通视为 PNVS 已配置。测试前核实专用 RAM 权限、服务开通、有效凭据和获准号码；仅按本次批准的数量发送，设定较小的每日/每小时限额与可选 `PHONE_AUTH_SEND_UNTIL` UTC 截止时间。验证码由用户在原浏览器页面私下输入，不能写进聊天或日志；超时不自动重发。真实通过必须包括收件、验证码核验、会话和登录，不仅是接口返回 200。默认 `PHONE_AUTH_ENABLED=false`；启用且 `PHONE_AUTH_ALLOW_ALL_NUMBERS=false` 时只接受 `PHONE_AUTH_ALLOWED_NUMBERS` 白名单。显式设置 `PHONE_AUTH_ALLOW_ALL_NUMBERS=true` 才允许全部格式有效的大陆手机号，仍受号码/IP/全局额度约束；持续开放时不设置测试截止时间。按实际部署策略说明受限或公开模式，代码默认值不代表线上配置，也不代替真实送达验收。

## 5. Nginx、systemd 与旧 service worker

先为新 API 准备独立 systemd 单元，工作目录指向具体 release，执行 `node apps/api/dist/server.js`，读取专用生产环境，使用经确认的非 root 服务身份。服务单元、资源限制与文件读取权限需按现有服务器确认，本指南不会自动创建账号、监听公网 API 或安装服务。

Nginx 最终根目录指向新 Web `dist`；`/api/` 保留完整路径代理到本机新端口，设置 Host、受控的 `X-Forwarded-For` 和 `X-Forwarded-Proto`。维持 SPA 路由回退、静态资源正常 MIME、TLS 证书续期与请求大小限制。仓库 `apps/web/nginx.conf` 是 Docker 内部配置，含 Docker DNS 和 `api:8787`，不能原样用于现有主机 Nginx。

旧站当前 `/service-worker.js` 使用 `CACHE_NAME='fangxu-shell-v2'`，缓存 `/`、manifest、icon，导航 network-first，其余 cache-first。**只删除旧 worker 文件无法清除老用户已注册的 worker。** 新发行包提供同 URL 的退役脚本 `apps/web/dist/service-worker.js`，只清理已观察的 `fangxu-shell-v2` 缓存，再执行 clients claim 和 unregister，无 fetch handler，不主动跳转用户页面。

Nginx 需要让 `/service-worker.js` 命中该真实 JS 文件，返回 JavaScript MIME 及 `Cache-Control: no-cache`；不可落入 SPA HTML 回退、不可改名、不可使用长期 immutable 缓存。首次切换保留该文件，待旧客户端实际完成升级后再评估后续保留期限。旧浏览器更新验证必须检查 worker 更新/激活、旧缓存清除且无关缓存保留、解除注册后刷新进入新站；本地 VM 生命周期检查不算已安装旧 worker 浏览器的真实验收。

## 6. 切换、验收与回滚

切换前完成新服务启动、直接连接本机 API 的 `/api/health/live` / `/api/health/ready`、001–011 迁移和角色验证、已选择模式的生产环境依赖、Nginx 配置检查及旧站可恢复备份。新 API 若因已启用的 SMTP、TLS、Qwen 或权限缺失不能正常工作，继续保留旧站，记录具体阻塞；邮箱明确设为 `disabled` 后不再要求主 API 的 SMTP 依赖，但必须验收停用提示和接口拒绝。

切换时记录原链接/根目录和上游，使用原子方式更新新站 `current`，验证 Nginx 配置后 reload；需要 API 单元重启时明确使用新 release 和新库。禁止直接清空 `/opt/kylesong` 或删除 `zjad`。若生产请求出现回归，将 Nginx 根目录/上游恢复到保存的旧配置并 reload，恢复旧站经确认的单元；DuduHire 新数据库保留以便排查，不做破坏性降级迁移。

外网验收至少覆盖真实 DNS、HTTPS/证书、首页与内页刷新、API readiness、桌面/手机布局、页面关键交互、影片播放、旧 worker 浏览器迁移，以及已启用认证方式的真实注册登录。邮箱采用 `smtp` 时必须验证真实邮件；采用 `disabled` 时验证邮箱发送和旧链接均拒绝、页面提示准确，并明确记录邮件未启用。真实短信仍需独立收件与会话验收，不能由邮箱停用检查代替。真实 Qwen 需完成一条有输入有输出的梳理流程。保存版本摘要、检查时间、结果和未完成项；不要保存凭据、OTP、Magic Link 或个人信息。

完成记录分别填写：发行包验证、Linux 依赖安装、数据库及角色、服务启动、域名切换、浏览器渲染、邮箱模式及投递和登录、PNVS 投递和登录、真实 AI 调用、回滚准备。邮箱显式停用时填写“disabled：停用行为已验证，邮件投递与登录未启用”，其他未验收项标记待完成；不能用本地测试数量、静态构建或 HTTP 200 代替整体上线成功。
