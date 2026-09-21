# 正式部署指南

更新日期：2026-09-12

## 推荐拓扑

```text
CDN / TLS / Reverse Proxy
  ├─ /          → apps/web 静态构建
  └─ /api/*     → apps/api:8787
                         ├─ 托管 PostgreSQL
                         ├─ SMTP 服务（启用邮件时）
                         └─ Qwen API（阿里云百炼）
```

Web 与 API 使用同一浏览器 Origin。这样可以保持 `SameSite=Lax` Cookie、精确 Origin 校验和当前 `/api/v1` 前端配置，不依赖第三方 Cookie。

## 生产环境变量

| 变量 | 要求 |
|---|---|
| `NODE_ENV` | `production` |
| `HOST`、`PORT` | 通常为 `0.0.0.0`、`8787` |
| `DATABASE_URL` | 专用 PostgreSQL 连接串；不得附加查询参数或 fragment，TLS 与超时策略由应用显式控制 |
| `DATABASE_SSL` | 生产必须为 `true`，证书校验失败时拒绝连接 |
| `MIGRATION_DATABASE_URL` | 独立 migration owner 连接；只在发布迁移任务中提供 |
| `MIGRATION_DATABASE_SSL` | 生产必须为 `true` |
| `MAINTENANCE_DATABASE_URL` | 独立 maintenance 连接；只在清理任务中提供 |
| `MAINTENANCE_DATABASE_SSL` | 生产必须为 `true` |
| `WEB_ORIGIN` | 如 `https://duduhire.com`，不能带路径 |
| `AUTH_TOKEN_SECRET` | Secret Manager 中至少 32 字符的随机值 |
| `AUTH_COOKIE_NAME` | `__Host-duduhire_session` |
| `AUTH_COOKIE_SECURE` | `true` |
| `EMAIL_DELIVERY_MODE` | 生产 Compose 默认 `smtp`；原生启动须显式选择 `smtp` 或 `disabled`。缺少 SMTP 配置不会自动切换模式，生产禁止 `console` |
| `SMTP_URL` | `smtp` 模式必填，使用带认证的 `smtp://` 或 `smtps://` URL，生产强制 STARTTLS/TLS；`disabled` 模式的主 API 不需要此值 |
| `EMAIL_FROM` | `smtp` 模式必须显式设置为已验证发送域的 From 地址；`disabled` 模式的主 API 不需要此值 |
| `AI_MODE` | 默认 `qwen`；兼容显式 `openai`；生产拒绝 `local`，不自动降级 |
| `QWEN_API_KEY` / `DASHSCOPE_API_KEY` | 服务端密钥；前者优先，空值时使用后者。必须对应选定地域，不写入镜像、前端或日志 |
| `QWEN_MODEL` | 默认 `qwen3.8-max`；其他 Qwen 型号必须支持 JSON mode 与非思考模式，需另做质量/延迟验收 |
| `QWEN_BASE_URL` | 默认北京 `https://dashscope.aliyuncs.com/compatible-mode/v1`；只接受下述官方地域端点 |
| `OPENAI_API_KEY` / `OPENAI_MODEL` | 仅在显式 `AI_MODE=openai` 时必填，用于已有部署兼容 |
| `OPENAI_BASE_URL` | OpenAI 兼容模式只允许 `https://api.openai.com/v1` |
| `CONTACT_DATA_KEY` | 64 个十六进制字符（32 字节）的独立 AES-256-GCM 密钥 |
| `CONTACT_DATA_KEY_ID` | 与当前联系信息密钥对应的非秘密版本标识；轮换时必须变化 |
| `TRUST_PROXY_CIDRS` | 直连留空；反代后填写逗号分隔的可信代理 IP/CIDR，不接受无限信任 |
| `ADMIN_USER_IDS` | 管理员允许列表（已验证用户 UUID）；空值默认禁止全部管理访问 |
| `NOTIFICATION_DATABASE_URL` | 通知 worker 专用数据库连接，不回退到 API 连接 |
| `INQUIRY_NOTIFICATION_EMAIL` | 运营负责人确认的单一收件邮箱；空值不启用通知 |

保留期不由运行时环境变量控制。`005_preserve_superseded_intakes.sql` 创建 owner-only 的 `data_retention_policy` 单例行，默认为 challenge `7` 天、会话 `30` 天、已归档发现 `30` 天和已发布 outbox `30` 天。只能使用 migration/owner 凭据通过受审查的迁移或发布变更调整；runtime 与 maintenance 都不得读写该表。

前端生产默认使用同源 `/api/v1`，一般不需要设置 `VITE_API_BASE_URL`。

## 真实邮箱注册

手机号认证与 SMTP 独立。009 手机号、010 密码认证和 011 会话身份迁移需在对应 API 更新前执行并重新应用数据库授权；部署后仍默认 `PHONE_AUTH_ENABLED=false`。本机 PNVS 密钥已保存不代表线上能发送，正式服务只接受秘密环境注入的 PNVS 凭据，不读取个人配置目录。受限联调的允许号码、发送次数和真实送达验收见 [手机号认证设计](AUTHENTICATION.md#手机号注册受限联调)。不要未经批准开放号码名单或发送付费短信。

`EMAIL_DELIVERY_MODE=console` 只用于本机演练，不会投递邮件；页面会明确显示未发送。要启用真实邮箱注册，需要已有邮件服务允许使用的 SMTP 地址、端口、认证信息与发件地址。不要将密码或授权码粘贴到聊天、前端变量或同步目录。

尚未接入邮件服务时，可明确设置 `EMAIL_DELIVERY_MODE=disabled`。此模式不需要 `SMTP_URL` 或 `EMAIL_FROM`，主 API 不创建 SMTP 传输器；邮件注册、登录和已有邮件链接核验均返回 `503 EMAIL_AUTH_DISABLED`，不会发信、创建邮件 challenge、消费旧链接或建立新会话。已有有效会话仍可正常读取和退出。`/api/v1/auth/methods` 返回 `email: { available: false, delivery: "disabled" }`，页面显示邮箱未启用，并在短信可用时默认选择短信。两种方式都未启用时无法新注册或登录，不能因为 API 启动成功就视为认证可用。

生产 Compose 的默认模式仍是 `smtp`。即使 Compose 允许空的 SMTP 变量展开，API 也会校验所选模式的必填配置；只有显式 `disabled` 才允许不配置邮件服务。HTTPS、数据库 TLS、认证和资料密钥、真实 Qwen/OpenAI 校验均保持不变。启用通知 worker 时仍需单独提供通过校验的 SMTP、发件地址、收件邮箱和独立数据库连接；主 API 的邮件停用开关不控制通知 worker。

通过部署密钥管理工具注入下列变量；本机可在未同步的私有环境文件中配置（父目录权限 `0700`、文件权限 `0600`）：

```dotenv
EMAIL_DELIVERY_MODE=smtp
SMTP_URL=smtps://SMTP_USER:SMTP_AUTH_TOKEN@smtp.example.com:465
EMAIL_FROM=DuduHire <verified-sender@example.com>
```

以上是占位示例，不可直接用于发信。SMTP 用户名和授权码中的特殊字符须进行 URL 编码；端口和 TLS 方式遵循发信服务要求。所有带认证的 SMTP 连接都会强制 TLS/STARTTLS，开发环境也不会明文传输凭据；生产环境还要求认证与已获准使用的发件地址。私有环境文件需由 API 启动命令显式加载，修改后重启 API；仅把文件放在磁盘上不会生效。

启用后，用用户授权的测试邮箱逐项确认：

1. 从网站提交注册，响应为 `delivery=email`；打开实际收件箱确认邮件到达，不以 API 的 `202` 代替送达验收。
2. 在发起注册的同一浏览器打开验证链接，确认进入账户；若邮箱在另一个浏览器打开，将链接复制回原浏览器，而不是移除浏览器绑定保护。
3. 刷新后会话仍有效，退出后失效；再次使用旧链接不能重新登录。
4. 检查重发、过期链接与投递失败；失败不应显示已发送或创建已验证账户。

本地 SMTP 协议测试不外发邮件，只能验证发送代码。真实收件箱、发件域 DNS 与服务商投递信誉仍须单独验收。

以 `disabled` 模式交付时，应验收页面停用提示和邮件接口拒绝行为，并把邮件能力记录为“未启用、未验收投递”。日后切换为 `smtp`、补齐配置并重启后，重新完成上述真实邮箱流程；停用验证不代表邮件已交付。

## Qwen API 接入

生产通过 Secret Manager 或部署系统注入 `QWEN_API_KEY`。不要把密钥粘贴到对话、提交到 Git，或使用任何 `VITE_` 变量存放密钥。`AI_MODE=qwen` 缺少有效配置时 API 会拒绝启动；配置成功也不等于真实模型已完成验收。

### 本机开发与同步目录

工作区位于 Dropbox、iCloud 或其他同步目录时，Git 忽略规则无法阻止云端同步。Qwen 密钥应保存在工作区之外、未同步的用户配置目录：默认文件为用户主目录下的 `.config/duduhire/qwen.env`。由本机编辑器或密钥管理工具填写，文件必须属于当前用户且权限为 `0600`，直接父目录必须属于当前用户且权限为 `0700`；路径中的任何符号链接都会被拒绝。不要在同步目录的 `apps/api/.env`、文档、脚本或日志中写入真实密钥。

该私有文件仅加载 `AI_MODE`、`QWEN_API_KEY`、`DASHSCOPE_API_KEY`、`QWEN_MODEL`、`QWEN_BASE_URL`。配置选定地域的密钥、端点与型号即可；数据库和其他配置仍使用现有环境设置。可以用 `DUDUHIRE_QWEN_ENV_FILE` 指定其他未同步位置的绝对文件路径，安全检查相同。

`npm run dev`、`npm run dev:api` 和 `npm run test:qwen` 会显式开启本地加载。本机运行已编译 API 时使用：

```bash
DUDUHIRE_LOAD_LOCAL_ENV=true npm run start:api
```

普通 `npm run start:api` 不会自动读取个人配置，`NODE_ENV=production` 下即使设置加载开关也不会读取。文件缺失时继续由现有配置校验报告缺少的变量；权限、所有权或路径不符合要求时安全失败，错误不输出私有路径或内容。

进程已提供任一非空 Qwen 密钥时，整个私有文件都会跳过，地域端点和型号应与密钥一起由进程环境提供，以免混用另一套配置。否则仅补充未提供的白名单变量，进程显式设置的非密钥值（包括空值）优先。开发脚本原有 `.env` 加载先执行，因而其中的显式值也具有优先级。

`test:qwen` 仍要求调用者另行设置 `RUN_QWEN_SMOKE=true` 才读取本机文件并进行已授权的真实请求；私有文件不能开启这一授权，也不能修改 `NODE_ENV`、`NODE_OPTIONS` 或数据库配置。

`QWEN_BASE_URL` 必须与 API Key 所属地域一致，可选端点如下：

| 地域 | Base URL |
|---|---|
| 北京 | `https://dashscope.aliyuncs.com/compatible-mode/v1` |
| 新加坡 | `https://dashscope-intl.aliyuncs.com/compatible-mode/v1` |
| 业务空间专属域名 | `https://{WorkspaceId}.{Region}.maas.aliyuncs.com/compatible-mode/v1`，将占位符替换为真实值；Region 支持 `cn-beijing`、`ap-southeast-1`、`us-east-1`、`eu-central-1`、`ap-northeast-1` |

端点来自 [阿里云 Chat API 官方文档](https://help.aliyun.com/zh/model-studio/qwen-api-via-openai-chat-completions)。应用限制 HTTPS、官方主机和固定路径，禁止重定向、URL 凭据、查询参数以及任意代理。调用采用 `POST /chat/completions`、`response_format: {type: "json_object"}` 与 `enable_thinking: false`；收到完整响应后，服务端继续校验业务字段和证据出处。JSON mode 只保证格式，不代表内容已经核实，详见 [阿里云结构化输出文档](https://help.aliyun.com/zh/model-studio/qwen-structured-output)。

请求及响应读取共用 30 秒超时，响应上限 256 KiB；限流、鉴权失败、拒答、截断和无效输出均失败，不静默切换模型或退回演示。不会发送真实用户资料进行隐式启动探测。上线前使用经授权的脱敏测试案例验证两个角色的多轮补充、纠正、草稿、确认、恢复与失败重试，确认所选地域的数据处理政策及账户费用/限额。

## 部署顺序

1. 创建 PostgreSQL owner、runtime、maintenance 角色；启用通知时另建 notifications 角色。设置时间点恢复和独立备份，执行 [数据库角色与最小权限](DATABASE_ROLES.md) 的初始化。
2. 构建一次并推送 Web/API 镜像，以 digest 或不可变发布 tag 固定本次版本；不要在服务器现场重新构建不同产物。
3. 暂停正在运行的通知 worker。在独立发布任务中只注入 `MIGRATION_DATABASE_URL`，执行 `npm run db:migrate:compiled`。迁移器使用 advisory lock、按文件名排序，并拒绝已应用文件的 SHA-256 校验和变化；本次需完成 001–011 全部迁移，当前 readiness 要求 `011_session_active_role.sql` 的非空校验和记录。
4. 以 owner 执行“迁移后表授权”，确认 runtime 只能读写 API 所需表且不能 DDL/业务数据 `DELETE`；maintenance 无业务表和策略表权限，只能 `EXECUTE public.run_data_retention_cleanup()`。授权脚本会撤销 PUBLIC 的数据库 `CONNECT`/`TEMPORARY` 与 `public` schema `CREATE`，并为 runtime/maintenance 显式授予 `CONNECT`。
5. 部署 API；只有 `/api/health/live` 和 `/api/health/ready` 都成功后才接入流量。ready 会检查数据库连接、011 迁移记录、核心表、手机号验证结构、会话身份及密码设置期限列、匹配发布与示例表和管理员列表视图；完整迁移历史与校验和需由发布步骤独立核对。
6. 部署 Web 静态构建并配置 `/api/` 同源反向代理。TLS 入口必须覆盖 `X-Forwarded-For`/`X-Forwarded-Proto`，`TRUST_PROXY_CIDRS` 只列实际代理链。
7. 邮件采用 `smtp` 时，用真实测试邮箱执行注册、同浏览器验证、刷新会话、保存资料和退出，另用不同浏览器确认链接被拒绝。采用 `disabled` 时验证邮件接口和页面确实停用，把邮件投递标为未启用；对已开启的短信方式独立完成获准号码的真实注册与登录验收。
8. 使用同一账户切换两种当前会话身份，分别验证 intake 领取、当前身份入口限制、发现采集/确认、刷新恢复、工作台完成状态与重置。另用授权的合成账户验证默认不发布、预览同意、双向匹配、继续对话后的发布暂停、退出匹配及版本冲突。确认 API/数据库没有把自述或共同标签标为平台验证，未公开对话、附件或联系方式。
9. 确认管理员列表与 worker 专用数据库权限、收件邮箱已配置，使用本次发布的 API 镜像重启通知 worker。提交一笔测试咨询，验证通知不含联系值、管理员读取联系方式必须填写理由、状态更新和审计可追踪。不要把 SMTP 接受或页面提交成功当作运营已跟进。
10. 启用邮件时确认 SMTP SPF/DKIM/DMARC；确认 Qwen 所属业务空间的费用限额/告警、Magic Link fragment 不进入日志、Web 安全响应头完整，并在真正终止 TLS 的入口开启 HSTS。
11. 用 `MAINTENANCE_DATABASE_URL` 每日执行 `npm run data:cleanup:compiled`。任务不接收保留期参数，只执行 owner 定义的无参数函数并从 `data_retention_policy` 读取策略。同时监控长期 pending outbox；清理任务绝不会删除未发布事件。
12. 在 CDN/WAF 配置跨实例速率限制与机器人防护，并开启可用性、5xx、数据库、SMTP、AI 延迟/错误、限流和 outbox 积压告警。

迁移应向前兼容当前 API 版本；数据库破坏性变更必须拆成扩展、回填、切换和清理多个发布阶段。

## 容器验证

仓库提供 Web/API 多阶段 Dockerfile、本地 `compose.yaml` 和使用已发布镜像的 `compose.production.yaml`。正式构建均以仓库根目录为 context：

```bash
docker build -f apps/api/Dockerfile -t duduhire-api .
docker build -f apps/web/Dockerfile -t duduhire-web .
```

两个镜像都包含健康检查。Web 的 `/healthz` 只证明 Nginx/静态层存活；API `/api/health/ready` 才证明数据库结构可接流量。`apps/web/nginx.conf` 把请求体限制为 320 KiB（API JSON 上限为 256 KiB，额外空间留给代理解析开销），代理连接超时为 5 秒、读取超时为 60 秒，并使用 Docker Engine DNS `127.0.0.11` 延迟解析 `api:8787`。非 Docker 平台必须配置不低于这些限制，并把 resolver 与上游改成平台服务发现地址；纯 CDN 可发布 `apps/web/dist`，但平台网关仍必须实现同源 `/api/`。

单机参考部署：

```bash
cp deployment.env.example .env.production
chmod 600 .env.production
# 用 Secret Manager/部署系统替换每个 placeholder，尤其不能保留示例 CONTACT_DATA_KEY。
# 生产配置会主动拒绝明显占位/低多样性认证密钥，以及全同字符或 deadbeef 重复的数据密钥。
docker compose --env-file .env.production -f compose.production.yaml config --quiet
docker compose --env-file .env.production -f compose.production.yaml pull api web migrate maintenance
docker compose --env-file .env.production -f compose.production.yaml --profile release run --rm migrate
# 在此执行 DATABASE_ROLES.md 的迁移后授权，并先验证 runtime 权限。
docker compose --env-file .env.production -f compose.production.yaml up -d api web
docker compose --env-file .env.production -f compose.production.yaml ps
```

生产编排默认只把 Web 绑定到 `127.0.0.1:8080`，应由同机 TLS 代理转发；容器内 API 不发布宿主机端口。若平台需要直接暴露容器端口，可显式修改 `DUDUHIRE_BIND_ADDRESS`，同时必须由平台安全组限制入口。`DUDUHIRE_NETWORK_CIDR` 必须避开现有网络，并包含在 `TRUST_PROXY_CIDRS` 中；如果还有 CDN/LB，还要加入其精确可信网段。

每日维护任务：

```bash
docker compose --env-file .env.production -f compose.production.yaml --profile maintenance run --rm maintenance
```

这份 Compose 是单机参考，不提供多可用区、自动扩缩、托管密钥或滚动发布控制面；正式高可用部署应把同一镜像、环境约束和探针映射到所选编排平台。

容器权限边界：API/迁移/维护/通知使用 Node 非 root 用户；Web 以 `nginx` 用户直接启动，使用自有主配置并把 PID/临时文件置于 `/tmp`。Compose 配置只读根文件系统、受限 tmpfs、`no-new-privileges` 和 `cap_drop: ALL`。应在预发布实际验证 `/healthz`、SPA fallback、视频资源和 `/api/` 代理，不能仅凭静态配置宣布容器验收完成。

## 发布脚本与后台任务

[运维脚本](../ops/README.md) 提供手动构建推送工作流、明确确认的 `deploy.sh` / `rollback.sh`、加密备份和空隔离数据库恢复验收。发布脚本只管理 API/Web，要求已完成迁移/授权并确认旧版本兼容，按 digest 保存版本；健康失败恢复原镜像，无法恢复时停止 API/Web，不执行数据库逆向迁移。

通知 worker 的版本切换必须纳入发布单：**停止旧 worker → 备份/迁移/授权 → 部署并验证 API/Web → 以同一 API 镜像重启已配置的 worker**。使用 systemd 时先停止 `duduhire-notifications.service`，更新秘密环境的镜像引用后再启动。回滚也先停止 worker，确认旧 worker/API 与当前数据库及密钥兼容；脚本成功后更新环境引用为记录的 digest 再重启 worker。没有确认收件邮箱时保持停止，不能以发布操作默认启用真实通知。

仓库只提供 systemd cleanup/health timer 与 notifications service 示例，未安装到任何服务器。健康探针输出可用于告警，尚未配置外部告警接收方；备份脚本不是已启用的自动备份任务。

## CI 门槛

[CI 配置](../.github/workflows/ci.yml) 在 `main`、`master` 推送和 PR 上执行：

1. `npm ci`
2. 前后端 lint
3. API 测试
4. 前后端生产构建
5. 生产依赖高危漏洞门槛
6. 源码迁移与编译产物迁移连续执行
7. 真实 PostgreSQL 仓储认证/资料/发现/联系流程测试
8. 独立测试数据库下的浏览器端到端验收
9. 运维脚本确认与失败回滚测试
10. Web 与 API 容器镜像构建
11. 生产 Compose 静态解析
12. 开发 Compose 运行时启动与 Web/API 健康冒烟

以目标提交的实际执行结果作为发布依据；仓库包含配置不代表已执行通过。正式发布还应在目标平台配置镜像扫描/签名与预发布端到端测试。

## 不支持的部署方式

GitHub Pages 只能提供静态 Web，不能运行 Fastify、PostgreSQL 或 SMTP。除非另外部署 API、配置精确 CORS/Cookie 并使用自定义根域，否则不能用于正式认证环境。

## 回滚

- Web：回滚到上一份静态资产。
- API：回滚到仍兼容当前数据库结构的上一镜像。
- 数据库：优先使用向前修复迁移；禁止在未知影响下直接回滚已写入数据的结构变更。
- 认证故障：可暂时停止验证邮件入口，但保留已登录会话读取；必要时批量撤销会话并轮换 Secret。
- AI 故障：停止新的发现写入并保留既有对话读取；生产不得静默切到本地规则。模型变更应作为独立发布，保留 `provider/model/prompt_version` 以便审计。
- 联系申请故障：先停止表单写入，保留 `enterprise_inquiries` 与未发布 outbox；不要以删除 pending 事件作为恢复手段。

## 备份与恢复

- 托管 PostgreSQL 开启跨可用区备份和时间点恢复；把目标 RPO/RTO 写入发布单，至少每季度恢复到隔离数据库并完成应用级核验。
- 另保留加密的逻辑备份；备份账户只授予读取需要，备份文件进入有生命周期与访问审计的对象存储。
- 恢复演练必须检查已应用迁移记录及校验和、用户/会话/发现表行数、外键一致性和 `/api/health/ready`。恢复环境不得向真实用户发邮件或调用生产 AI 账户。
- 恢复到较早时间点后，可能重新出现当时有效的会话、challenge 或 pending outbox。接流量前应统一撤销会话、作废 challenge，并按事件幂等键核对下游是否已处理，避免重复联系。
- 数据库备份与 `CONTACT_DATA_KEY` 必须分开保存；只有备份没有该密钥无法恢复联系方式，二者放在同一位置则失去加密隔离价值。

逻辑备份示例（连接串由 Secret Manager 注入环境，不粘贴到命令历史；`pg_dump` 客户端版本不得早于服务端主版本）：

```bash
export DUDUHIRE_BACKUP_FILE=/secure/backups/duduhire-YYYYMMDDTHHMMSSZ.dump
pg_dump --dbname="$DUDUHIRE_BACKUP_DATABASE_URL" \
  --format=custom --no-owner --no-privileges --file="$DUDUHIRE_BACKUP_FILE"
pg_restore --list "$DUDUHIRE_BACKUP_FILE" >/dev/null
```

恢复演练只在隔离、空白数据库执行，并禁用生产邮件/AI 出站：

```bash
pg_restore --dbname="$DUDUHIRE_RESTORE_DATABASE_URL" \
  --single-transaction --exit-on-error --no-owner --no-privileges \
  "$DUDUHIRE_BACKUP_FILE"
```

随后用 migration owner 执行当前迁移器（恢复点可能早于最新结构），重新应用最小权限，再以 runtime 连接检查 `/api/health/ready` 和核心聚合。`pg_restore --list` 只验证归档目录可读，不能替代完整恢复演练。

## 密钥轮换

- `AUTH_TOKEN_SECRET` 当前是单活密钥。轮换会立即使全部现有会话、浏览器绑定和未消费 Magic Link 失效；在维护窗口更换所有 API 实例的值，撤销旧会话并要求重新登录。不要让不同实例同时使用不同值。
- SMTP 与 Qwen（或显式选用的 OpenAI）密钥应使用提供方的“先增新、验证、再撤旧”流程；部署新值后验证邮件和一轮发现请求，再撤销旧凭据。任何日志都不得输出密钥或完整模型输入。
- `CONTACT_DATA_KEY` 不能直接覆盖后丢弃旧值。新密文使用 v2 envelope，AAD 会绑定数据域、记录 ID 和 key id；企业申请还在 `encryption_key_id` 列保存该标识，资料联系方式则由当前部署的 `CONTACT_DATA_KEY_ID` 提供解密上下文，没有独立的逐行 key-id 列。API 读取路径仍只加载一组密钥与 key id，因此当前轮换必须使用维护窗口：先停止写入和读取，在同一事务中完成全量重加密，再让所有 API 实例同时切到新 key/key id。需要零停机时必须先实现双 key 读取，不能跳过这一阶段。

仓库提供默认 dry-run 的 `contact-key:rotate:compiled`。它会锁定并验证所有非空 `profiles.contact`（包括 004 迁移前遗留明文），同时兼容解密使用旧固定 AAD 的 v1 envelope，再以绑定记录上下文的 v2 重新加密。它也会扫描全部企业申请：当前 key id 的 v1/v2 记录统一重加密为新 key id 的 v2；已使用新 key id 的 v1 也会原地改写为绑定上下文的 v2，只有已经是新 key/v2 的记录才会仅验证并跳过。遇到任何其他 key id 或无法认证的密文都会整笔回滚；成功提交后所有非空资料联系值与企业联系密文都为 v2。stdout 只输出计数。生产执行顺序：

1. 按 [数据库角色](DATABASE_ROLES.md#联系信息密钥轮换角色) 创建短期轮换角色，仅临时授予脚本所需列的 `SELECT`/`UPDATE`；将连接和两组密钥通过临时 Secret 注入，不写入 `.env.production`。
2. 在外层网关启用维护页并停止 API，保留数据库备份和旧密钥。
3. 不设置确认词先 dry-run；核对扫描数、旧明文数、待重加密数和已经使用新 key 的数量。脚本允许读取低质量的旧 key 以便迁出，但会像生产配置一样拒绝全同字符/`deadbeef` 重复的新 key，以及含 `replace`/`placeholder` 的新 key id。
4. 设置 `CONTACT_KEY_ROTATION_CONFIRM=ROTATE_CONTACT_DATA` 再运行一次，提交事务。
5. 所有 API 实例同时部署新的 `CONTACT_DATA_KEY` 与新的 `CONTACT_DATA_KEY_ID`，验证资料读取/保存和一笔企业申请后再开放流量。
6. 撤销/删除短期数据库角色和临时 Secret；经过既定回滚观察期后才撤销旧 KMS 版本。

使用参考 Compose 时，可把以下变量放入 Secret 管理器或临时 RAM 文件系统中的第二个 env 文件：`ROTATION_DATABASE_URL`、`CURRENT_CONTACT_DATA_KEY`、`CURRENT_CONTACT_DATA_KEY_ID`、`NEXT_CONTACT_DATA_KEY`、`NEXT_CONTACT_DATA_KEY_ID`。生产轮换还要求 `ROTATION_DATABASE_SSL=true`，参考 Compose 已设置该值。随后运行：

```bash
# dry-run：不设置确认词
docker compose --env-file .env.production --env-file .env.rotation \
  -f compose.production.yaml --profile key-rotation run --rm contact-key-rotation

# 核对计数后，在临时环境中增加：CONTACT_KEY_ROTATION_CONFIRM=ROTATE_CONTACT_DATA
docker compose --env-file .env.production --env-file .env.rotation \
  -f compose.production.yaml --profile key-rotation run --rm contact-key-rotation
```

轮换结束立即安全删除临时文件。咨询后台读取会按 `encryption_key_id` 验证当前密钥上下文并写入审计，轮换验收需包含一笔管理员联系信息读取；通知 worker 本身不持有解密密钥。

## 上线批准清单

- [ ] 域名、TLS、HSTS、CDN/WAF 与可信代理链已在预发布环境验证。
- [ ] Web 容器已在目标平台完成非 root/只读根文件系统运行验收。
- [ ] owner/runtime/maintenance 与可选 notifications 角色、001–011 迁移、匹配、手机号、密码认证与会话身份的列级授权、owner-only 保留期策略、自动备份与恢复演练已通过。
- [ ] 邮件采用 `smtp` 时，SMTP 认证与 SPF/DKIM/DMARC 已通过真实邮箱验证；采用显式 `disabled` 时，停用提示及接口拒绝已验证，并将邮件投递记录为未启用，不能标为已通过。
- [ ] Qwen 业务空间已设置模型许可、费用/速率上限、失败告警和数据处理审批；实际端点地域与密钥一致。
- [ ] 认证、资料并发、两个发现角色、企业联系和退出流程均完成浏览器回归。
- [ ] 管理员允许列表、联系方式访问审计、worker 收件邮箱与通知失败处理已由运营负责人验收；通知未配置时保持关闭。
- [ ] 每日保留期清理、outbox 积压告警、5xx/延迟/数据库/邮件/AI 告警已接入值班；已在数据库外部配置专用只读运维连接，没有复用 runtime、maintenance 或 owner。
- [ ] 隐私政策明确披露发现文本、附件摘录、所选 Qwen 处理地域（或显式选用的其他供应商）和联系方式用途/保留期。
- [ ] 明确禁止通过当前附件入口上传身份证件、支付数据和未脱敏机密。
- [ ] 产品、销售与客服明确知道：当前仅有本站主动发布资料的标签/条件匹配；支付、文件托管、站内消息、合同、自由文本/语义人才检索和完整项目流尚未实现。
