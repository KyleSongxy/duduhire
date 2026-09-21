# DuduHire 技术架构

更新日期：2026-09-14（按当前源码核对；不代表外部服务验收）
状态：核心 MVP 已后端化；交易、文件与完整项目协作仍不在当前实现范围

## 1. 总体结构

DuduHire 使用 npm workspaces 管理两个独立应用：

```text
Browser
  └─ HTTPS / same origin
       ├─ /          → apps/web（React/Vite 静态站点）
       └─ /api/*     → apps/api（Fastify）
                            ├─ PostgreSQL（系统事实来源）
                            ├─ SMTP（启用邮箱时的 Magic Link）
                            ├─ 阿里云 PNVS（显式启用的手机号认证）
                            └─ Qwen Chat API（默认发现建议；显式 OpenAI 兼容可选）
```

生产环境采用同源反向代理。浏览器只持有 HttpOnly Cookie，不持有认证 token；API 与 PostgreSQL 是账户、邮箱/手机号验证、当前会话身份、个人资料、发现记录、匹配发布、工作台状态和企业联系申请的事实来源。企业联系事务同时写入 outbox，独立通知 worker 领取租约后发送不含联系方式的运营通知。

## 2. Web 工作区

`apps/web` 使用 React 19、TypeScript、Vite、原生 CSS 与 Phosphor Icons。

| 文件 | 职责 |
|---|---|
| `apps/web/src/main.tsx` | 应用入口和错误边界 |
| `apps/web/src/App.tsx` | 全局导航、会话启动、路由分发和受保护页面门禁 |
| `apps/web/src/api.ts` | 同源 API 客户端与统一错误格式 |
| `apps/web/src/auth.ts` | 服务端会话加载、认证方式探测、Magic Link/短信请求与核验、退出和安全回跳 |
| `apps/web/src/profileStore.ts` | 带版本号的个人资料 API 与页面内状态 |
| `apps/web/src/discoveryStore.ts` | intake、发现对话与结构化草稿 API |
| `apps/web/src/matchingStore.ts` / `MatchingPanel.tsx` | 原发现页面中的条件预填、私密示例预览、显式发布同意、真实匹配结果与撤回 |
| `apps/web/src/workspaceStore.ts` | 工作台服务端汇总状态 API |
| `apps/web/src/contactStore.ts` | 企业联系申请 API |
| `apps/web/src/SecondaryPages.tsx` | 发现流程、认证页、工作台和其他二级页面 |
| `apps/web/src/styles.css` | 全站设计令牌、布局、响应式、主题和动效 |
| `apps/web/public/` | 自托管字体、图片、海报、视频与爬虫配置 |

访客保留两端入口，登录后导航只显示当前身份的发现入口。`X-DuduHire-Role` 用于发现/匹配/工作台的旧页面冲突检测，不匹配时返回 `409 ACTIVE_ROLE_CHANGED`；前端亦丢弃身份改变后迟到的 `/me/*` 响应。首次进入认证页或受保护页面时，应用先调用 `/auth/session`，确认无会话后才执行登录跳转。两类用户的发现入口按服务端会话角色重定向，最终授权由 API/仓储执行。

## 3. API 工作区

`apps/api` 使用 Node.js 22、Fastify、PostgreSQL、Nodemailer 与 Fastify 官方安全插件。

| 文件 | 职责 |
|---|---|
| `src/app.ts` | 插件、路由、校验、Cookie、Origin 检查与错误响应 |
| `src/config.ts` | 环境变量解析和生产环境 fail-closed 校验 |
| `src/domain.ts` | 邮箱、回跳地址、资料、发现与联系申请领域类型 |
| `src/security.ts` | 随机 token、HMAC 哈希与期限计算 |
| `src/postgresRepository.ts` | 参数化查询、事务、幂等写入、角色授权和持久化 |
| `src/email.ts` | SMTP 与仅开发可用的 console 邮件适配器；邮件显式停用时不发信 |
| `src/passwordAuth.ts` / `src/passwordAuthRoutes.ts` | scrypt 密码校验、登录限流、近期邮件资格下的首次/重置密码与会话撤销 |
| `src/phoneAuthConfig.ts` / `src/phoneAuthRoutes.ts` / `src/phoneAuthRepository.ts` / `src/pnvsProvider.ts` | 手机号配置、号码策略、验证码发送/核验、持久化限额与 PNVS 适配 |
| `src/discoveryAdvisor.ts` / `src/qwenClient.ts` | Qwen 默认适配器、显式离线演练与 OpenAI 兼容；供应商安全传输 |
| `src/discoveryFlow.ts` | 两端分步采集、字段来源与结构校验、草稿、明确确认和修改状态 |
| `src/matching.ts` / `src/matchingRoutes.ts` | 确认来源、受控工作标签、公开字段校验、发布/撤回接口和双向条件比较 |
| `src/naturalMatchingConditions.ts` / `src/domainKnowledge.ts` | 从有来源的事实预填合作条件、受控领域方法提示 |
| `src/matchingExamples.ts` / `src/seedMatchingExamples.ts` | 独立虚构示例目录与显式导入；不写入真实发布表 |
| `src/privacy.ts` | 资料与企业联系方式的 AES-256-GCM v2 信封加解密，以及 v1 兼容读取 |
| `src/migrate.ts` | 带 advisory lock 的顺序迁移执行器 |
| `src/cleanup.ts` | 以 maintenance 连接调用 owner 控制的无参数保留期清理函数 |
| `src/adminRoutes.ts` | 默认拒绝的管理员接口、咨询跟进与联系方式访问审计 |
| `src/notificationWorker.ts` | 独立数据库角色和 SMTP 凭据下的通知处理进程 |
| `migrations/` | PostgreSQL 结构事实来源 |

API 请求体由 JSON Schema 校验，响应错误使用稳定的 `{ error: { code, message, requestId? } }` 结构。所有 `/api/v1` 状态修改请求必须来自精确配置的 Web Origin。生产启动会 fail closed：数据库 TLS、HTTPS Origin、Secure `__Host-` Cookie、真实 Qwen（或显式 OpenAI 兼容）配置和联系信息加密密钥缺一不可。邮箱启用时必须配置认证 SMTP，也可显式设置 `EMAIL_DELIVERY_MODE=disabled` 停用邮件入口；通知 worker 的 SMTP 另行校验。

## 4. 数据模型

| 表 | 作用 | 关键约束 |
|---|---|---|
| `users` | 已验证账户 | 规范化邮箱/手机号各自唯一，至少有一个已验证身份；手机号账户邮箱可为 null；`role` 保留注册初始身份（client/talent），账户可使用两种身份 |
| `email_challenges` | 一次性验证链接 | token 只存 HMAC；有期限、消费时间和回跳地址 |
| `user_passwords` / `password_login_limits` | 密码认证数据 | 010 迁移建立密码哈希和按身份哈希的登录尝试窗口；明文密码不落库 |
| `phone_challenges` | 一次性短信验证码 | 验证码只存 HMAC；浏览器绑定、发送/消费状态、核验租约和持久化限额 |
| `sessions` | 可撤销且可切换身份的会话 | 随机 token 只存 HMAC；过期或撤销后不可使用；`active_role` 保存当前身份；密码设置资格另有短期限 |
| `profiles` | 两端个人资料 | 以 user id 唯一关联；联系方式以 AES-GCM envelope 保存，资料带乐观并发版本 |
| `intake_drafts` | 首页到登录后发现页的短期问题草稿 | 浏览器绑定、期限、失效标记与单次领取状态 |
| `discovery_threads` | 每个账户/类型的发现会话 | 每用户/类型一个活跃会话；两种类型分别保存，由当前会话身份选择 |
| `discovery_turns` | 用户问题和服务端建议 | `request_id` 幂等、顺序、来源摘录、模型与提示版本；无固定轮数上限 |
| `discovery_artifacts` | 问题简报或能力身份卡草稿 | 与发现类型一致；版本化 JSON 草稿 |
| `matching_listings` | 用户明确同意的匹配展示快照 | 每账户/类型唯一；来源线程与草稿版本、同意时间、发布/撤回状态和乐观版本；对外只序列化展示白名单 |
| `matching_examples` | 独立虚构需求与人才示例 | 固定 example- 标识；与真实用户和发布隔离，runtime 只读 |
| `enterprise_inquiries` | 企业联系申请 | 联系值加密，另存不可逆哈希和密钥标识 |
| `outbox_events` | 与业务事务原子写入的待分发事件 | 租约、退避重试、死信与发布时间；目前只处理企业咨询通知 |
| `inquiry_audit_events` | 管理员状态修改与联系信息读取审计 | 记录操作者、操作理由与时间，不保存联系明文 |
| `enterprise_inquiry_admin_list` | 咨询管理列表视图 | 排除联系密文、哈希与关联用户 ID |
| `data_retention_policy` | owner 控制的单例保留期策略 | 仅 migration/owner 可读写；runtime 和 maintenance 都无表权限 |
| `schema_migrations` | 已应用迁移 | 文件名与 SHA-256 校验和；advisory lock 串行执行 |

`users.role` 只在首次验证注册时确定，作为新会话初始身份；`sessions.active_role` 可经 `/auth/role` 更新，session 的 user.role 来自此列，user.roles 包含两种身份。个人资料按用户共用，身份切换不复制资料；资料接口不修改注册初始身份、登录邮箱或手机号。资料写入使用乐观并发版本，旧页面覆盖新修改时返回冲突而不是静默丢失。

## 5. 发现与联系数据流

1. 首页问题由公开 intake 接口保存，浏览器 Cookie 的 HMAC 绑定值与正文分开；跳转 URL 只包含 UUID。
2. 用户完成邮箱或手机号验证后，在同一浏览器领取未过期 intake。领取操作把草稿绑定到当前 user id，其他浏览器不能领取。
3. API 从服务端会话角色确定唯一发现类型：`client → problem`，`talent → capability`。同一账户可切换当前身份访问另一类型，不能指定其他账户；发现和匹配按 owner 与 kind 隔离。
4. 每轮输入经长度和附件摘要限制后发送到流程引擎。默认 Qwen 官方兼容 Chat API，JSON mode、关闭思考输出、服务端校验结构和引用；保留显式 OpenAI 兼容模式，生产拒绝 `local`。模型失败不降级为规则回复。引擎保留逐字段状态与来源，每次只追问当前缺失信息；明确的确认/查看/跳过命令由服务端处理，不让模型决定完成状态。
5. API 在上游推理前快照活跃 thread ID 和版本；PostgreSQL 事务只在状态未变时写入回答、分析上下文、附件元数据、模型/提示版本和最新结构化草稿。推理期间发生重置或其他写入时返回 `409 DISCOVERY_STATE_CONFLICT` 并丢弃旧响应；同一 `requestId` 已成功落库后的重试返回当前业务状态。
6. 工作台仅在当前草稿 `flow.status=confirmed` 且有确认时间时标记发现完成；生成草稿不算完成。前端发送所见 thread ID/version，确认和重置都经过版本校验。修改后回到待确认状态。收付款状态固定为“未配置”，因为支付服务尚未接入。
7. 企业联系申请在 API 中校验并使用 v2 envelope 加密，数据库事务同时保存申请和 `enterprise_inquiry.created` outbox 事件。v2 AAD 绑定数据域、记录 ID 和 key id，阻止记录间密文置换。联系值不进入 outbox payload；下游处理者仍需使用受审计的解密流程。个人资料中的可选联系方式也使用同一数据密钥的 v2 envelope 落库，API 只向资料所有者解密返回。旧明文与 v1 envelope 由保存路径或离线轮换工具兼容读取；轮换成功提交后所有非空联系密文统一为 v2。

附件边界：浏览器只提交文件名、MIME、大小和有限文本摘录。API 不接收或保存原始二进制，也不执行病毒扫描；这些数据只能作为待确认线索。后续轮次重新读取已持久化的摘录，来源 ID 以 requestId 稳定标识，模型上下文有界；旧 AI 回答不会作为事实来源。具体字段与状态见 [AI 交互流程](AI_FLOWS.md)。

### 匹配发布与读取

1. 当前确认草稿只用于生成可编辑的展示建议，不自动发布。建议来自已确认的 `provided` 字段，包含有来源的标签和明确自然语言条件。用户从 34 项受控工作标签中选择 1–8 项并核对合作条件，单独明确同意后提交。
2. 发布事务校验账户角色、当前活跃来源的确认状态、源线程 CAS 与发布记录 CAS，保存白名单展示字段和来源版本。编辑、撤回都不能绕过版本检查。
3. 有效性由当前查询动态判断：发布状态、来源活跃、必要字段已确认、线程/草稿版本一致。发送新对话版本即保守暂停旧发布，不能把新内容自动替换成已同意内容。
4. 查询候选只返回本站有效对端记录，排除自己。数据库按共同标签预筛选最多 500 条；规则引擎应用必需标签、明确办公/合作方式和现场城市约束，以及市场、语言、同币种同周期预算、每周投入和开始日期的明确冲突，按标签重合、已知一致条件和稳定 ID 排序，最多返回 20 条，并明确 `catalogLimited` 与本批 `total` 的含义。
5. `publicListing()` 显式列举字段，不序列化所有者 ID、线程信息、邮箱、联系方式、原始对话或引用。公开字段另做常见敏感模式检查，但不保证匿名化；预览及用户核对仍是必要条件。所有匹配响应 `no-store`。
6. 匹配无额外模型调用、外部人才库、自动联系或雇佣决策。理由只是共同工作标签与已知条件；自由文本、身份属性不参与排序，未知预算/时间/证据留待人工确认。

确认草稿后也可私密比较独立 `matching_examples` 表中的示例，无需公开同意，不创建发布、不提供联系人。开发 seed 为 22 条虚构资料（11 条需求、11 条人才），部署数据库可使用不同导入批次；按 ID 最多读取 100 条对侧资料，遵守同样硬条件；真实结果不从示例表补位。示例表由 `008_matching_knowledge_and_examples.sql` 建立，需显式导入才有数据。

`007_bilateral_matching.sql` 新增真实发布表及索引，发布前需执行配套最小权限脚本。runtime 只能更新指定的发布字段和版本，不能修改所有者或类型；撤回是状态更新，不执行 DELETE。源发现线程按既有归档保留期删除时，关联匹配记录级联清理；活跃来源的撤回记录没有单独自动删除策略。

## 6. 认证数据流

邮箱链接通过 URL fragment 交给 Web，再以同源 POST 提交验证；API 同时校验一次性 token 和发起浏览器的 HttpOnly Cookie。账户创建、邮箱验证和会话创建在事务中完成，浏览器缓存不能建立账户或授权身份。手机号经 PNVS 发送和核验验证码，服务端先检查绑定、有效期、HMAC 与核验租约；数据库事务完成消费及账户/会话创建，不生成邮箱或合并账户。两种方式对未注册账户的登录请求均在申请阶段拒绝，不静默注册。手机号默认关闭，可配置号码白名单或显式公开号码访问；代码支持与真实供应商送达验收分开。令牌、限流、Cookie 与错误行为见 [账户认证设计](AUTHENTICATION.md)。

## 7. 路由与访问控制

公开 Web 路由：`/`、`/how-it-works`、`/pricing`、`/enterprise`、`/login`、`/signup`。`/auth/verify` 是邮件内部回调，部署时必须启用 SPA fallback。

受保护 Web 路由：`/account/password`、`/talent`、`/projects`、`/workspace`、`/workspace?tab=profile`。管理员另有 `/admin/inquiries`，必须属于配置中的已验证账号名单。前端门禁只改善导航体验，服务端独立验证会话与授权。

API 路由分为：

- `/api/health/*`：存活与数据库就绪探针。
- `/api/v1/auth/*`：认证方式探测、登录资格预检查、会话身份切换、邮箱/手机 challenge 与验证、密码登录与设置、会话读取和退出。
- `/api/v1/discovery/intakes`：公开短期 intake 创建，绑定发起浏览器。
- `/api/v1/me/profile`：当前用户资料读取和带版本写入。
- `/api/v1/me/discovery/*`：intake 领取、发现读取/追加/重置，必须拥有有效会话及正确角色。
- `/api/v1/me/matching/*`：本人发布状态、条件预填、私密示例预览、CAS 发布/撤回和有效对端匹配，必须登录；公开范围只限明确同意的展示快照。
- `/api/v1/me/workspace`：当前账户工作台汇总。
- `/api/v1/enterprise/inquiries`：经过限流、校验与加密的联系申请。

逐项请求、响应、状态码和幂等约定见 [API 契约](API.md)。

## 8. 浏览器存储边界

只有主题偏好持久保存在 `localStorage:duduhire-theme`，不影响授权或业务状态。认证、角色和个人资料不使用 `localStorage`；旧本地账户清理规则见 [邮箱认证设计](AUTHENTICATION.md#旧数据)。

认证、角色、资料、发现、工作台与联系申请的持久化事实均来自服务端。未提交编辑短期存于 sessionStorage，只用于当前浏览器会话内恢复，不影响服务端确认或权限。个人信息编辑按账户、登录会话与当前身份隔离，只缓存相对服务端基线改动的字段；恢复时合并到最新服务端个人资料，未修改字段沿用最新值。匹配预览保存文字及来源线程/发布版本，恢复时不恢复公开同意，旧版本仍阻止发布。发现文字按原 mode/入口隔离恢复，尚未提交的附件需重新添加，附件正文不进入缓存。存储不可用时仍可在当前页面编辑和保存，但不承诺刷新或切换后的恢复。附件文本摘录会进入发现记录，因此上线前要在隐私政策中披露处理目的和保留期；身份证件、支付信息或未脱敏机密仍不得通过当前附件入口收集。

## 9. 构建、测试与运行

构建与运行命令见 [README](../README.md#常用命令)。API 测试覆盖邮箱与手机号认证、号码策略与发送窗口、一次性链接注册、注册初始身份保留、会话读取/撤销、资料乐观并发、intake 浏览器绑定、发现角色授权与幂等写入、推理期间重置的状态冲突、联系密文上下文绑定、未知邮箱登录和 Origin 拒绝。CI 配置使用真实 PostgreSQL 执行迁移两次并构建/探测两个镜像；是否通过以对应提交的 CI 结果为准。

前端构建位于 `apps/web/dist/`，API 构建位于 `apps/api/dist/`。前端 `postbuild` 继续生成静态托管需要的 `404.html`；生产 Nginx 使用 `try_files` 回退到 `index.html`。

## 10. 实现边界

功能范围统一维护于 [产品事实与范围](PRODUCT.md)。本架构实现账户、发现、用户主动发布后的标签/条件匹配和企业线索持久化，不构成完整交易市场。自由文本/语义人才检索、站内联系、支付、文件托管和项目协作仍需独立实现，不能从营销页面或工作台卡片推断已经具备。
