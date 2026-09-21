# 安全基线

更新日期：2026-09-14（源码核对，不代表生产安全验收）

## 已实施

- 256 位随机 Magic Link token 和会话 token。
- token 仅以 HMAC-SHA256 形式落库。
- 一次性、短期限邮箱 challenge；事务锁阻止重放。
- challenge 与发起浏览器的 HttpOnly Cookie 绑定，防止登录 CSRF 和账户会话置换。
- HttpOnly、SameSite Cookie；生产强制 Secure 与 `__Host-`。
- 精确 Web Origin CORS 与状态修改请求 Origin 检查。
- Fastify Helmet 安全响应头、请求体大小限制和速率限制。
- Web Nginx 配置 CSP、禁止嵌入、安全 Referrer/Permissions Policy、nosniff 与同源资源策略；CSP 仅为现有动态样式保留 `style-src 'unsafe-inline'`。
- JSON Schema 请求校验与 PostgreSQL 参数化查询。
- 需求方/人才发现类型由服务端会话角色确定，仓储再次校验。
- 个人资料写入使用乐观并发版本，防止旧页面静默覆盖新数据；发现和企业申请使用客户端 UUID 幂等键。
- 首页 intake 只在数据库保存正文，URL 仅携带短期 UUID；领取还要求原浏览器绑定和需求方角色。
- 登录邮箱使用严格单一 addr-spec 规范化；数据库内原子限流，角色受数据库 CHECK 约束。
- API 数据库连接设置连接、语句、查询、锁和空闲事务上限；迁移与维护使用独立的较长工作负载上限。
- Magic Link token 使用 URL fragment 传给 Web，再通过受 Origin 保护的 POST 验证，不进入静态站点或代理访问日志。
- SMTP 连接、问候和空闲等待均有明确上限，不做自动重排；API 只有在 SMTP 明确接受邮件后才返回 202。
- API 最多同时保留 25 个待完成的邮件请求，防止 SMTP 故障形成无界应用队列；邮件不是脱离请求的内存任务。
- 应用日志关闭原始请求 URL 记录，并对 Cookie、Authorization 与 Set-Cookie 字段脱敏。
- 生产配置缺少 HTTPS、数据库 TLS、Secure Cookie 或足够长度密钥时拒绝启动；启用邮件时还须认证 SMTP 和有效单一 From，显式 `EMAIL_DELIVERY_MODE=disabled` 可停用邮件认证。
- 生产拒绝本地演练，默认 Qwen，保留显式 OpenAI 兼容模式；强制官方 API 基址、模型 ID、API key、64 字符十六进制联系数据密钥和独立 key id；明显占位、低多样性或重复模式密钥会被拒绝。
- Qwen 使用 JSON mode 与服务端业务结构/引用校验，30 秒请求与读取超时、256 KiB 响应上限、禁止重定向；OpenAI 兼容请求另设置 `store:false`。无效输出失败关闭，不降级到本地回复。用户和附件是不可信输入，不能设置确认/验证状态；只有明确用户命令且版本一致才能确认。引用校验不等于事实核验。
- 个人资料中的可选联系方式与企业联系值都使用 AES-256-GCM 信封加密后落库；新写入统一使用 v2，其认证附加数据绑定数据域、记录 ID 与 key id，密文不能在记录或数据域间置换。旧 v1 只作迁移兼容读取。企业记录另存不可逆 HMAC 和 `encryption_key_id`，outbox 不含联系值。
- 迁移在全局 advisory lock 下顺序执行，并记录 SQL SHA-256；已应用迁移文件被修改时拒绝继续。
- 健康探针分为进程存活和数据库就绪。
- 咨询管理默认拒绝，按已验证用户 UUID 配置管理员；联系方式读取必须写入理由和审计记录。通知 worker 使用独立数据库角色，仅执行租约函数，不持有认证、联系方式解密或 AI 密钥。
- Web 以 `nginx` 用户直接启动，运行目录位于 `/tmp`；生产 Web/API/维护/通知进程配置只读根文件系统、`no-new-privileges` 与清空 Linux capabilities。
- runtime 不具有业务表 `DELETE` 或 outbox 读取权限；maintenance 不具有任何业务表或 `data_retention_policy` 表权限，只能执行 owner 定义的无参数 `run_data_retention_cleanup()`。

## 部署必须完成

- 使用独立生产数据库账户和最小权限；开启 TLS、自动备份与时间点恢复。
- 数据库 URL 不携带查询参数或 fragment，避免覆盖 TLS、超时、`application_name` 或注入额外 GUC；应用还显式覆盖 `PGOPTIONS`，TLS 统一由 `DATABASE_SSL=true` 强制证书校验。
- 把 `AUTH_TOKEN_SECRET` 放入平台 Secret Manager，至少 32 个随机字符，不写入仓库或镜像。
- 把 `CONTACT_DATA_KEY` 与数据库备份分开托管，给每次版本设置新的 `CONTACT_DATA_KEY_ID`；按部署手册演练默认 dry-run 的停机重加密流程。
- 启用邮件时为 SMTP 域配置 SPF、DKIM、DMARC，监控退信、投诉和发送信誉。
- 为 Qwen 所属业务空间（或显式兼容供应商）设置模型许可、预算/速率限制、数据处理审批和错误/延迟告警；隐私政策必须披露发现文本及附件摘录的第三方处理。地域需与密钥一致，不能认为默认北京地址适用于所有账户。
- 入口层启用 HTTPS、HSTS、请求大小限制、DDoS 防护与结构化审计日志。
- HSTS 必须由实际终止 TLS 的 CDN、负载均衡器或 Nginx 层设置，不能在本地 HTTP 示例中伪造。
- 在 CDN/WAF 对验证邮件入口执行跨实例 IP 限流与机器人防护，避免邮箱配额耗尽和邮件滥用；应用内 IP 限流不是全局配额。
- 设置数据库连接数上限、CPU/内存限制、滚动发布和可用性告警。
- 在预发布实际验证 Web 非 root/只读容器的临时目录、静态资源与 API 代理；Dockerfile/Compose 配置不等于运行验收通过。
- 每日以独立 maintenance 凭据运行 `npm run data:cleanup:compiled`，按 owner 控制的 `data_retention_policy` 删除超期认证数据、过期 intake、已归档发现会话和已发布 outbox；策略只能通过 migration/owner 凭据变更，不得删除 pending outbox 来消除告警。
- 对异常发送量、验证失败、5xx、就绪失败、SMTP、AI 失败/费用和 outbox 积压设置告警。

## 仍未覆盖

- 邮箱变更、无法访问原联系方式时的人工账户恢复、账户删除和独立的全设备退出入口；密码重置已有撤销全部会话的行为。
- 组织级 RBAC、管理员后台、KYC 与身份文件。
- 原始附件二进制上传、对象存储、病毒扫描、下载授权与材料验证。当前只处理有限文字摘录和元数据。
- 全面的 AI 安全评测、提示注入红队、内容分级、人工复核后台和自动化模型回归门槛；现有系统提示与结构校验只是基础防线。
- 活跃发现记录、企业申请、账户级数据导出/删除的完整保留期和数据主体请求工作流。
- 第三方 CRM 集成、通用 outbox 消费与完整运营权限分级；当前管理员名单是部署级允许列表。
- 支付、财务合规、争议与审计。

在以上能力完成前，不应在发现流程收集未脱敏机密、身份证件或支付数据。

## 响应原则

发现可能泄露 token 或密钥时：

1. 立即轮换相关 Secret。
2. 撤销受影响会话并使未消费 challenge 失效。
3. 保存不含秘密值的时间线、请求 id 和影响范围。
4. 检查邮件、代理、应用和数据库日志是否包含 token。
5. 修复后补充回归测试与事故复盘。

## 手机号与登录资格边界

PNVS 验证码使用独立手机号身份、浏览器绑定、验证码尝试次数、重发冷却、每号码/每 IP 和全局滚动额度。默认关闭，公开大陆号码模式须显式设置 `PHONE_AUTH_ALLOW_ALL_NUMBERS=true`；公开模式不取消限流、凭据或 Origin 检查。配置及异常处理见 [认证](AUTHENTICATION.md)。

登录资格接口会返回 `registered` 布尔值，未知账户的 challenge 请求也会返回 `ACCOUNT_NOT_REGISTERED`。这是显式账户存在性反馈，不应将其描述为防账户枚举；Origin 和限流只能约束滥用。它不返回用户资料，也不建立会话。

会话身份保存在 `sessions.active_role`，用户可主动切换需求方/专业人才；`users.role` 仅保留注册初始身份。发现与匹配数据按用户和类型隔离，基本资料共用。`X-DuduHire-Role` 是旧页面冲突检测而非授权来源，发现、匹配与工作台不一致时拒绝为 `409 ACTIVE_ROLE_CHANGED`；管理员仍依赖用户 UUID 白名单。

密码使用随机盐 scrypt（N=131072、r=8、p=1）并限制哈希并发，不保存明文；登录有 IP 与数据库持久化账户窗口双重限流。首次/重置要求当前会话的近期邮件验证资格，保存后撤销全部会话并使旧邮件链接失效。普通登录状态不等于重置授权，详见 AUTHENTICATION。
