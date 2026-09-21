# 企业咨询运营与通知

更新日期：2026-09-05。此文描述仓库已实现的咨询接收、授权处理、审计与 SMTP 通知，不表示这些功能已在生产开启。

## 1. 处理流程

网站联系表单提交后，API 在单一事务中写入加密咨询与 `enterprise_inquiry.created` outbox 事件，返回 `202`。运营人员通过 `/admin/inquiries` 登录既有邮箱账户，查看不含联系方式的分页列表，按 `new → contacted → closed` 处理。需要联系客户时，先填写业务原因；审计事务提交后才显示联系值。状态修改也与审计在同一事务完成，版本冲突要求刷新后重试。

`client/talent` 是产品身份，与管理权限无关。服务器 `ADMIN_USER_IDS` 是唯一的应用管理权限来源；默认空，不自动把首位用户、某个邮箱域或需求方提权，也没有管理员注册/自行提权接口。部署操作者应先核对已验证用户 UUID，再通过受控配置赋权并重启 API。撤权后重启 API；用户既有普通会话继续有效，但不能再调用后台接口。

## 2. 数据库与权限

先以 migration owner 执行 `006_inquiry_operations.sql`。新增字段包括咨询 `version` 与 `notification_status`、outbox 租约和 dead-letter 时间，以及 `inquiry_audit_events` 审计表。安全视图 `enterprise_inquiry_admin_list` 排除联系方式、用户标识和密钥材料。

角色由部署操作者预先创建，必须 `NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOBYPASSRLS`，不得是表/函数 owner，不互相继承；密码放秘密管理系统。更新授权：

```sh
psql "$MIGRATION_DATABASE_URL" --no-psqlrc \
  --set=database_name=duduhire \
  --set=runtime_role=duduhire_runtime \
  --set=maintenance_role=duduhire_maintenance \
  --set=notification_role=duduhire_notifications \
  --file=apps/api/sql/grant-database-roles.sql
```

这些角色名与数据库名是部署示例，替换为已经创建的准确名称。`notification_role` 参数可省略，此时不授予通知权限。授权脚本撤销 PUBLIC 的数据库 CONNECT/TEMP 和函数执行权限，并对指定角色重新应用最小授权。

- runtime：读取安全列表视图；仅经 `admin_update_inquiry_status` 和 `admin_reveal_inquiry_contact` 两个 SECURITY DEFINER 函数进行状态修改与审计后读取密文。不能直接 SELECT 企业联系密文，不能修改/删除审计。
- notification：仅 EXECUTE `claim_inquiry_notification`、`finish_inquiry_notification`；没有业务表、outbox、联系方式、账户或审计表的直接读取权限，不能调用管理函数。
- maintenance：仅执行现有 owner-controlled 保留期清理函数。

数据库函数固定 `search_path=pg_catalog` 并完整限定表名。管理员白名单由 API 执行，数据库 runtime 凭据属于可信服务边界；不要把运行时数据库连接交给浏览器或运营人员。

## 3. 独立通知进程

开发入口 `npm run notifications:work --workspace @duduhire/api`；构建后入口 `npm run notifications:work:compiled --workspace @duduhire/api`，等价于 `node apps/api/dist/notificationWorker.js`。进程无 HTTP 监听端口。

| 环境变量 | 用途 |
| --- | --- |
| `INQUIRY_NOTIFICATION_EMAIL` | 单一通知收件邮箱；空值时明确打印 disabled 并退出，不连接数据库、不领取事件、不发送邮件 |
| `NOTIFICATION_DATABASE_URL` | 专用 notification 角色连接；不回退使用 `DATABASE_URL` |
| `DATABASE_SSL` | 生产必须 true，校验证书；连接 URL 不接受 TLS 覆盖参数 |
| `SMTP_URL`、`EMAIL_FROM` | 明确的 SMTP 发送配置；生产要求认证与 TLS |
| `WEB_ORIGIN` | 后台链接站点 origin；生产必须 HTTPS |
| `NODE_ENV` | 生产设置 production，启用上述严格配置校验 |
| `INQUIRY_NOTIFICATION_POLL_MS` | 空队列轮询间隔，默认 5000，范围 1000–60000 毫秒 |

worker 不需要 `AUTH_TOKEN_SECRET`、`CONTACT_DATA_KEY`、`ADMIN_USER_IDS` 或 Qwen/OpenAI 密钥。部署编排与发布流程见 [部署文档](DEPLOYMENT.md)。不要在未确认收件邮箱与 SMTP 配置时开启生产通知 profile。

邮件正文只包含咨询 UUID、固定来源标签和 `/admin/inquiries` 链接；不包含电话、微信、联系密文、用户邮箱、需求正文或 Magic Link。来源映射为固定标签，未知来源不原样进入邮件。日志仅包含事件 ID 与固定处理状态/错误码，不保存原始 SMTP 错误或收件地址。

## 4. 投递语义与重试

worker 每次单条领取 `enterprise_inquiry.created`，使用 `FOR UPDATE SKIP LOCKED` 避免不同进程竞争同一条记录。领取后拥有 120 秒租约与独立随机 token，领取时原子增加尝试次数。只有当前 token 能确认成功/失败；崩溃后租约到期可重新领取，旧 token 无法确认新租约。

失败后按 30 秒起的指数退避重试，退避上限 1 小时；最多 8 次尝试，之后写入 `dead_lettered_at` 并将咨询通知状态设为 `failed`。第 8 次处理中崩溃，租约到期后也会进入 dead-letter。通知状态单独保存在咨询记录中，已发布 outbox 按保留期清理后仍显示 `sent`。

SMTP 是 **at-least-once**：服务商已接受邮件，但数据库确认前进程崩溃，后续重试可能重复发送。邮件使用稳定 Message-ID 帮助识别，但不能承诺服务商去重或 exactly-once。`sent` 只表示 SMTP 接受，不代表送达收件箱或运营已联系客户。dead-letter 也可能包含这种结果不确定的最后尝试。

本进程只消费企业咨询事件；发现流程等其他 outbox 事件不由它消费。不提供自动 CRM 同步、自动联系客户或无限重试。

## 5. 审计与故障处理

审计表保留操作者、咨询 ID、操作类型、前后状态或查看原因及时间，不含联系方式。当前没有自动删除咨询或其审计记录的任务；已有保留期任务不会删除它们。上线负责人应按实际保留政策安排受控导出/删除流程，普通运营账户不能自行改写历史。

以下不含联系信息的诊断查询可在发布或故障维护窗口由部署 owner 临时执行；日常监控应使用另行配置的专用 observer，不复用 migration owner 凭据值班：

```sql
SELECT notification_status, COUNT(*) FROM public.enterprise_inquiries GROUP BY notification_status;
SELECT id, aggregate_id, attempt_count, available_at, lease_expires_at, dead_lettered_at, last_error
FROM public.outbox_events WHERE event_type = 'enterprise_inquiry.created'
  AND published_at IS NULL ORDER BY created_at;
SELECT inquiry_id, actor_user_id, action, created_at FROM public.inquiry_audit_events
ORDER BY created_at DESC LIMIT 100;
```

`failed` 事件不自动重新入队。检查 SMTP 配置与服务商投递记录，确认是否已投递，再由授权数据库操作者对准确事件 ID 安排一次有记录的重投；不能批量清空 dead-letter。查看联系值失败时检查当前 key ID 及 v2 envelope，使用现有离线轮换工具处理旧记录，不在应用中绕过审计或认证检查。

## 6. 回归验证

单元测试覆盖默认无管理员权限、401/403、分页、无 PII 列表、业务原因校验、Origin、状态冲突、审计后显示、通知默认禁用、消息内容脱敏和发送/确认顺序。PostgreSQL 集成覆盖专用角色最小授权、并发状态修改、真实审计提交、活跃租约排他、过期接管、旧 token 拒绝、退避、8 次 dead-letter、最后尝试崩溃和 SKIP LOCKED。

运行数据库回归必须使用独立且没有待处理通知的 `*_test` 数据库；测试拒绝消费其他任务已有的待处理通知。回归通知使用内存 sender，不发送真实邮件。
