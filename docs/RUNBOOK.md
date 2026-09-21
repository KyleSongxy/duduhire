# 运行手册

更新日期：2026-09-21（按源码核对）

## 日常检查

- `/api/health/live`：进程可响应。
- `/api/health/ready`：数据库查询成功，可接流量。
- ready 同时确认最新 `011_session_active_role.sql` 已以非空校验和记录，浏览器绑定约束、intake 失效列、手机号验证及 challenge、会话身份非空列与密码设置期限、匹配发布与示例表、业务/审计表和管理员列表视图存在；完整 001–011 历史与校验和仍由发布/恢复独立核对。未迁移数据库必须保持不可接流量。
- SMTP 发送成功率、退信率和投诉率。
- challenge 请求量、429 比例和邮件发送失败。
- 会话读取延迟、401 比例与 API 5xx。
- Qwen 请求成功率、超时、结构化输出失败、端到端延迟、token/费用和模型限额；显式 OpenAI 模式监控对应供应商。
- 发现写入的 4xx/409/429/503、每角色完成率和重试幂等命中；不记录用户正文。
- `outbox_events` 的 pending/dead-letter 数量、最老事件年龄和通知 worker 存活；需要指定真实收件邮箱、失败处理机制与负责人。
- PostgreSQL 连接数、慢查询、存储、备份和恢复演练状态。

## 常见故障

### 用户收不到邮件

1. 先检查认证方式接口是否返回 `email.available=false`；`EMAIL_DELIVERY_MODE=disabled` 表示主动停用。启用时再按请求 id 检查 `EMAIL_UNAVAILABLE` 和 SMTP 错误。
2. 检查发送域、抑制名单、退信、SPF/DKIM/DMARC 和垃圾邮件目录。
3. 不从日志复制或转发 Magic Link；重新发起新的 challenge。
4. 恢复后确认发送失败或已消费的链接不可用，新链接只能使用一次。

### 登录后仍回到登录页

1. 检查 `/auth/verify` 是否读取并清除 fragment、API verify POST 是否返回 `200` 和 Set-Cookie。
2. 检查生产 Cookie 是否为 `__Host-`、Secure、Path `/` 且无 Domain。
3. 确认 Web/API 经过同一 HTTPS Origin，代理没有删除 Set-Cookie。
4. 查询 session 是否已过期或撤销，检查 `AUTH_TOKEN_SECRET` 是否在实例间一致。
5. 若返回 `BROWSER_CONTEXT_REQUIRED`，确认用户是否在申请邮件的同一浏览器打开；跨设备或隔离 WebView 需回到原浏览器重新发送。

### 就绪探针失败

1. 检查 `DATABASE_URL`、TLS 和数据库网络策略。
2. 检查连接数是否耗尽、迁移是否完成。
3. 保持实例不接收流量，不把 ready 失败降级为成功。

### 资料保存失败

1. 检查会话是否有效、请求 Origin 是否与 `WEB_ORIGIN` 精确一致。
2. 检查 JSON Schema 字段长度、国家地区代码和资料 `version`。`PROFILE_VERSION_CONFLICT` 表示另一个标签页或设备先完成了保存，应重新读取后让用户确认，不能自动覆盖。
3. 检查数据库约束与连接状态；不要把邮箱或角色加入资料更新接口。

### 发现建议失败

1. 根据响应 request id 检查 `AI_UNAVAILABLE`、请求超时和输出校验失败；日志不得包含用户问题、附件摘录、模型原始错误或 API 密钥。
2. 默认 Qwen 模式检查百炼业务空间状态、模型权限、账户限额和出站网络；确认 `QWEN_BASE_URL` 与密钥地域一致，`QWEN_MODEL` 支持 JSON mode 与非思考模式。显式 `AI_MODE=openai` 的已有部署检查对应 OpenAI 配置。不要把原始供应商响应复制到日志或工单。
3. `409 DISCOVERY_STATE_CONFLICT` 表示 AI 推理期间活跃对话已被其他页面重置或写入；旧 AI 响应已被拒绝落库。重新读取 `/api/v1/me/discovery`，不要手工修改数据库版本或强行追加旧响应；经用户确认后才重试。
4. 确认 API 仍能读取既有发现记录。暂停新的发现写入或展示可重试错误，不要在生产把 `AI_MODE` 改为 `local`，否则相同产品入口会产生未经批准的不同语义。
5. 恢复后以不含真实敏感数据的两个角色测试样例各执行一轮，确认严格 JSON 输出、数据库模型/提示版本和工作台状态正常。

### intake 无法领取

1. 确认 UUID 未过期，并且领取发生在创建 intake 的同一浏览器；绑定 Cookie 丢失或跨设备时应让用户重新从首页发起。
2. 检查用户角色：需求方只能进入问题发现，专业人才只能进入能力发现。
3. 不要从数据库或日志复制用户问题来绕过浏览器绑定；过期 intake 会由每日清理删除。

### 匹配资料无法发布或结果为空

1. `MATCHING_VERSION_CONFLICT` 表示来源未确认、来源版本变化或其他页面先修改了发布状态。重新读取 `/api/v1/me/matching`，让用户核对当前草稿和公开预览；不能自动使用新版本补写同意或强行发布。
2. `MATCHING_NOT_PUBLISHED` 表示本人没有当前有效发布。退出匹配、重置或任何新对话版本都可能使旧发布不再有效；`status=published` 且 `active=false` 是正常的保守暂停，不是可以手改数据库绕过的状态。
3. `INVALID_MATCHING_LISTING` 时检查公开标题/摘要长度、是否混入联系方式/链接/敏感标记、1–8 项受控工作标签、必须标签子集、当前会话身份和现场城市。不在日志中输出完整公开摘要或原始输入来排障。
4. 真实空结果并不一定是故障。只比较有效的对端主动发布，要求至少一个共同标签，并过滤项目必须技能及明确不兼容的条件。`catalogLimited=true` 时仅完成最多 500 条候选的本批比较，不能宣称全平台没有合适对象。
5. 撤回后用新的正常结果请求核实不再返回该记录；已经在其他浏览器显示、截屏或保存的内容无法追溯撤销。不要为了恢复匹配而复制未发布档案、加入演示人物或解除角色/确认约束。
6. 恢复后用隔离合成的需求方和人才验证明确发布、双向查看、来源更新暂停与退出。此流程不发送站内消息、不交换联系方式、不发起真实合作或付款。

### 企业联系已提交但无人处理

1. 只查询申请 id、`status`、`source`、`created_at` 和 pending outbox 计数，不在普通日志或工单中输出 `contact_ciphertext`。
2. 检查 notifications 服务是否运行、独立连接是否授权、收件邮箱是否配置，以及 SMTP 投递状态。空收件邮箱会关闭 worker；通知发送成功不表示人员已经阅读或跟进。
3. 按 `aggregate_id` 检查 `attempt_count`、`last_error`、租约与 dead-letter 状态。worker 最多尝试 8 次；不要删除 pending 事件清空告警，也不要在无审查情况下重置重试次数。邮件采用至少一次投递，超时重试可能产生重复通知。
4. 管理员从 `/admin/inquiries` 处理咨询；读取联系方式要填写用途并写入审计，不能绕过后台直接导出密文/明文。完整流程见 [企业咨询运营](OPERATIONS.md)。

### 迁移或启动失败

1. `Applied migration checksum mismatch` 表示已应用 SQL 被修改。停止发布，恢复迁移文件原内容，并用新的顺序编号编写修复迁移；禁止直接改 `schema_migrations.checksum`。
2. 确认 migration owner、runtime 和 maintenance 连接没有混用，并检查 `*_DATABASE_SSL=true` 与证书链。授权脚本应撤销 PUBLIC 的数据库 `CONNECT`/`TEMPORARY` 和 `public` schema `CREATE`，再向 runtime/maintenance 显式授予 `CONNECT`。
3. 迁移成功但 ready 失败时，先执行迁移后授权，再用 runtime 角色检查 007 记录、匹配发布表与核心表/视图可见性。
4. 不要为了让探针变绿而放宽到数据库 owner 或把 ready 降级成单纯 `SELECT 1`。

## 维护任务

- 每日调度 `npm run data:cleanup:compiled`；旧的 `auth:cleanup:compiled` 是兼容别名。
- maintenance 连接只能执行无参数 `public.run_data_retention_cleanup()`，不能读取业务表或 `data_retention_policy`。默认策略由 005 迁移写入 owner-only 单例行：删除过期超过 7 天的 `email_challenges`、过期/撤销超过 30 天的 `sessions`、已经过期的 `intake_drafts`、归档超过 30 天的发现会话（级联删除 turns/artifact），以及发布超过 30 天的 outbox 事件。
- 调整保留期时，只能使用 migration/owner 凭据通过受审查的迁移或发布变更修改 `data_retention_policy`；不得向 maintenance 传入天数或授予其策略表权限。每个值受 1–365 天约束。未发布 outbox 不会被清理；活跃发现会话和企业联系申请当前也没有自动删除策略。
- 清理成功向 stdout 输出一行不含个人数据的 JSON 计数。任务失败或计数异常时告警，不要无限自动重试数据库删除。
- 每季度轮换 SMTP 凭据并演练 `AUTH_TOKEN_SECRET` 轮换方案。
- 定期恢复数据库备份到隔离环境，验证恢复时间和数据完整性。
- 每次依赖升级运行 `npm run check`、迁移验证和核心浏览器回归。

[运维脚本](../ops/README.md) 提供 systemd timer/service 示例、健康探针、确认式发布和备份恢复验收。示例尚未自动安装，告警接收方与备份调度也未配置；由值班负责人在目标主机启用并确认失败通知可达。通知 worker 发布时先停止，迁移/授权与 API/Web 验收后再以同版本镜像重启；回滚也必须验证其数据库/密钥兼容性。

## 值班查询

以下查询只返回聚合或非敏感元数据，但仓库当前不创建也不授权 observer。上线时必须由数据库管理员在仓库外配置专用只读运维连接，只授予所需视图或非敏感列并开启审计。不得使用 runtime、maintenance 或 owner 凭据执行日常查询；专用连接尚未配置时，下列查询不是可用的生产运维能力。

```sql
SELECT COUNT(*) AS pending,
       MIN(created_at) AS oldest_created_at
  FROM outbox_events
 WHERE published_at IS NULL;

SELECT status, COUNT(*)
  FROM enterprise_inquiries
 GROUP BY status
 ORDER BY status;

SELECT provider, model, prompt_version, COUNT(*)
  FROM discovery_turns
 WHERE created_at >= NOW() - INTERVAL '24 hours'
 GROUP BY provider, model, prompt_version;
```

禁止在共享终端、告警标签或工单中执行/粘贴 `SELECT *`、用户问题、分析上下文、附件摘录、邮箱或加密联系方式。

## 备份恢复与密钥事故

- 备份/恢复、应用数据库角色、外部只读运维连接边界和密钥轮换顺序见 [正式部署指南](DEPLOYMENT.md) 与 [数据库角色](DATABASE_ROLES.md)。每季度演练必须记录实际 RPO/RTO。
- 怀疑 `AUTH_TOKEN_SECRET` 泄露时，统一轮换所有 API 实例并接受全部会话/Magic Link 失效；禁止在滚动窗口同时保留两个不同值。
- 怀疑 `CONTACT_DATA_KEY` 泄露时，先限制 `profiles` 与 `enterprise_inquiries` 访问并保留证据。该密钥不能仅通过改环境变量安全轮换；按部署指南在维护窗口使用默认 dry-run 的 `contact-key:rotate:compiled`，重加密资料联系方式和企业申请、验证计数并同步切换全部 API 后，再撤销旧密钥。
- 怀疑 Qwen/其他 AI 供应商或 SMTP 凭据泄露时，在提供方创建新凭据、部署验证后撤销旧值，同时检查用量、发送和访问审计。
- 从备份恢复后，在开放流量前作废可能复活的 challenge/会话，并核对 pending outbox 是否已经在外部系统处理，避免重复通知。

## 手机验证码不可用

先检查 `/api/v1/auth/methods`、大陆号码格式、`PHONE_AUTH_ENABLED` 及公开模式或白名单。窗口到期对应 `SMS_TEST_WINDOW_CLOSED`，未知账户登录对应 `ACCOUNT_NOT_REGISTERED`，不应靠重复发送解决。429 时检查冷却、每号码、每 IP 及全局滚动额度，不清空发送记录绕过限制。provider 超时使本次 challenge 失效；真实送达须由收件人确认。

## 文档与生成缓存

维护入口见 [文档索引](README.md)。部署记录只表示记录日期的状态；不能以历史验收代替当前检查。清理范围和恢复方法见 [清理记录](maintenance/2026-09-14-cleanup.md)。

### 当前身份改变

遇到 `409 ACTIVE_ROLE_CHANGED`，先刷新会话核对当前身份，不自动重试旧身份的发现、匹配或工作台操作。检查请求头 `X-DuduHire-Role` 是否与会话一致；它不能代替切换接口。核对已执行 011 迁移及 runtime 对 `sessions.active_role` 的列级更新权限；不得修改 `users.role` 来代替会话切换，也不复制共用个人资料。
