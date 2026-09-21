# PostgreSQL 角色与最小权限

更新日期：2026-09-12

正式环境使用分离的数据库角色：

- `duduhire_owner`：只供发布迁移任务使用，拥有 DDL 和表所有权。
- `duduhire_runtime`：只供 API 使用，不拥有表，不执行 DDL 或业务数据 DELETE。
- `duduhire_maintenance`：只供定时清理任务使用，无业务表权限，仅能执行 owner 定义的无参数保留期函数。
- `duduhire_notifications`：启用通知时使用，只能执行领取/结束通知租约函数，不能直接读取业务表或联系方式。

API 使用 `DATABASE_URL`；迁移使用 `MIGRATION_DATABASE_URL`；清理使用 `MAINTENANCE_DATABASE_URL`。迁移/清理只允许在本地开发回退到运行时连接。通知必须显式配置 `NOTIFICATION_DATABASE_URL`，不回退；生产 worker 使用 `DATABASE_SSL=true`，迁移/维护则使用对应的 `*_DATABASE_SSL=true`。

请把下列数据库名与角色名替换为实际值。PostgreSQL 14 或既有数据库中，`public` schema 可能仍由 bootstrap/托管管理员拥有：管理员应先把目标数据库及必要时该 schema 的所有权交给 `duduhire_owner`，或代为执行 `REVOKE`/`GRANT` 的 schema 权限部分；表授权仍由表 owner 执行。

## 迁移前初始化

先以 bootstrap/托管管理员连接目标 `duduhire` 数据库，执行数据库与 schema 权限初始化。此时业务表还不存在，不要提前执行表授权。

```sql
REVOKE CONNECT ON DATABASE duduhire FROM PUBLIC;
REVOKE TEMPORARY ON DATABASE duduhire FROM PUBLIC;
REVOKE CREATE ON SCHEMA public FROM PUBLIC;

GRANT CONNECT ON DATABASE duduhire TO duduhire_owner, duduhire_runtime, duduhire_maintenance;
GRANT USAGE, CREATE ON SCHEMA public TO duduhire_owner;
GRANT USAGE ON SCHEMA public TO duduhire_runtime, duduhire_maintenance;
```

然后只用 `duduhire_owner` 运行迁移。迁移完成后，业务表和 `schema_migrations` 应由该角色拥有。

## 迁移后表授权

迁移完成后，以 `duduhire_owner` 连接同一数据库运行仓库中的可执行授权脚本，角色名通过 `psql` 变量传入：

```bash
psql "$MIGRATION_DATABASE_URL" \
  --set=database_name=duduhire \
  --set=runtime_role=duduhire_runtime \
  --set=maintenance_role=duduhire_maintenance \
  --set=notification_role=duduhire_notifications \
  --file=apps/api/sql/grant-database-roles.sql
```

脚本会在一个事务中重申完整边界：撤销 PUBLIC 在目标数据库的 `CONNECT`/`TEMPORARY`、撤销 PUBLIC 在 `public` schema 的 `CREATE`，再向 runtime 与 maintenance 显式授予 `CONNECT` 和 schema `USAGE`。脚本会校验 `database_name` 与当前连接的数据库完全一致，避免对错库授权。

授权以 [grant-database-roles.sql](../apps/api/sql/grant-database-roles.sql) 为唯一可执行来源，不要额外补充整表 `UPDATE`：

| 对象 | runtime 权限 |
|---|---|
| 账户、challenge、会话、资料、intake、发现线程与草稿 | `SELECT`、`INSERT`；`UPDATE` 仅限脚本列出的状态或可编辑列 |
| `discovery_turns` | `SELECT`、`INSERT` |
| `matching_listings` | `SELECT`、`INSERT`；只允许更新来源快照、展示字段、同意时间、状态与版本，不允许修改所有者或类型 |
| `enterprise_inquiries` | `INSERT`；仅可读取 id、联系类型、来源、状态、同意时间与创建时间 |
| `outbox_events` | 仅 `INSERT` |
| `schema_migrations` | 仅 `SELECT` |
| `enterprise_inquiry_admin_list` | 只读非敏感列表视图 |
| 管理员状态修改/联系读取函数 | `EXECUTE`，函数强制写入审计；API 另行校验管理员身份 |
| `data_retention_policy`、清理函数 | 无权限 |

maintenance 只获得 `public.run_data_retention_cleanup()` 的执行权限。

`notification_role` 为可选参数：仅在角色已创建且将启用 worker 时传入。脚本撤销该角色所有直接表/序列权限，只授予 `claim_inquiry_notification(uuid)` 与 `finish_inquiry_notification(uuid, uuid, boolean)` 执行权限。不要复用 runtime、owner 或 maintenance 连接运行 worker。

这里有意不对 owner 的所有未来表设置宽泛默认授权。每次新增表或 API 操作类型时，都要在同一次发布中显式更新迁移后的最小授权；新增授权必须在 API 新版本接收流量前完成。

runtime 不能修改用户角色、登录邮箱、登录手机号、记录归属或原始问题；只能更新验证时间、challenge 消费标记、会话撤销标记、当前会话身份与密码设置期限、个人资料、intake 领取/失效标记、发现状态与授权脚本列出的匹配发布字段。009 迁移后须重新应用授权：新增 phone_challenges 的 SELECT/INSERT 与验证码哈希、sent/失效/消费、尝试次数和核验租约的列级 UPDATE，以及 users.phone_verified_at 更新；不允许修改手机号或清空发送配额记录。匹配撤回使用状态更新，不需要业务数据 `DELETE`。企业申请的读取权限排除密文、哈希和 key id。新 intake 用 `invalidated_at` 关闭同浏览器上一份未领取草稿，不需要业务数据 `DELETE`。

`005_preserve_superseded_intakes.sql` 另外创建 owner-only 的 `data_retention_policy` 单例表，默认策略是 challenge `7` 天、过期/撤销会话 `30` 天、已归档发现线程 `30` 天和已发布 outbox `30` 天。runtime 与 maintenance 都不得读写该表；策略只能使用 migration/owner 凭据在受审查的迁移或发布变更中修改。maintenance 没有任何业务表的 `SELECT`/`DELETE`，只能执行 `SECURITY DEFINER` 的 `public.run_data_retention_cleanup()`；函数自行读取 owner 策略并使用固定筛选条件，因此 maintenance 无法缩短保留期、读取问题/邮箱/联系方式，或删除活跃发现记录与 pending outbox。外键级联由数据库约束执行。

`007_bilateral_matching.sql` 新增 `matching_listings`。必须重新执行授权脚本后才让新 API 接流量，不能只执行建表迁移。发布记录通过外键关联来源发现线程；归档线程在既有保留期到期清理时，相关匹配记录级联删除，不需给 maintenance 新增表读取或删除权限。仅撤回但未归档的记录没有独立自动清理期限。运行时可读该表以比较有效发布，浏览器对外可见范围另由 `publicListing()` 字段白名单及有效性查询控制。

部署验证应使用 owner 连接运行迁移和授权，使用 runtime 连接运行 `/api/health/ready` 及认证/资料/发现/联系流程，再使用 maintenance 连接运行清理命令，确认：

- 已完成 001–011 全部迁移并逐项核对校验和；当前最新迁移为 `011_session_active_role.sql`（010 为密码认证，011 为会话身份）。readiness 检查 011 的非空校验和记录，以及浏览器绑定约束、intake 失效列、手机号验证列和 challenge 表、会话身份非空列及密码设置期限列、咨询审计表、管理员列表视图、匹配发布与示例表等结构；ready 成功不能代替完整迁移历史核对，尤其必须独立确认 010/011 已应用。
- runtime 可通过正常 API 发布/撤回本人匹配快照，但不能修改匹配记录的 `owner_user_id`、`kind` 或执行 DELETE；对外结果不含所有者、来源线程、对话、附件和联系方式。
- runtime 不能执行 `CREATE`、`DROP`、`DELETE`、创建临时表，也不能读取/更新 `outbox_events` 或访问 `data_retention_policy`。
- maintenance 不能直接读取或修改任何业务表/策略表、创建临时表或执行 DDL，只能调用无参数保留期函数。
- migration owner 凭据不会注入 API 或日常清理容器。

## 只读运维角色

仓库不创建也不授权 observer。如要执行 [运行手册](RUNBOOK.md#值班查询) 中的聚合查询，数据库管理员必须在仓库外创建专用只读运维连接，只授予所需视图或非敏感列，并记录访问审计。不得为了值班查询复用应用数据库凭据；该外部角色未配置前，不应把这些查询列为可用的生产监控项。

## 联系信息密钥轮换角色

`CONTACT_DATA_KEY` 轮换需要短时读取并更新 `profiles.contact` 和 `enterprise_inquiries`，不要把这项权限永久加给 runtime 或 maintenance。由数据库管理员创建一次性登录角色并在维护窗口执行：

```sql
GRANT CONNECT ON DATABASE duduhire TO duduhire_key_rotator;
GRANT USAGE ON SCHEMA public TO duduhire_key_rotator;
GRANT SELECT (user_id, contact) ON TABLE profiles TO duduhire_key_rotator;
GRANT UPDATE (contact) ON TABLE profiles TO duduhire_key_rotator;
GRANT SELECT (id, contact_ciphertext, encryption_key_id)
  ON TABLE enterprise_inquiries TO duduhire_key_rotator;
GRANT UPDATE (contact_ciphertext, encryption_key_id, updated_at)
  ON TABLE enterprise_inquiries TO duduhire_key_rotator;
```

把该角色的连接串仅作为 `ROTATION_DATABASE_URL` 注入默认 dry-run 的 `contact-key:rotate:compiled`。轮换、应用验证和回滚观察期完成后立即执行：

```sql
REVOKE ALL PRIVILEGES ON TABLE profiles, enterprise_inquiries FROM duduhire_key_rotator;
REVOKE USAGE ON SCHEMA public FROM duduhire_key_rotator;
REVOKE CONNECT ON DATABASE duduhire FROM duduhire_key_rotator;
```

最后由具备 `CREATEROLE` 权限的管理员删除或禁用该登录角色。不要让重加密脚本使用 migration owner；脚本不需要 DDL。完整停机顺序见 [部署指南](DEPLOYMENT.md#密钥轮换)。

010/011 迁移后，runtime 另需 `user_passwords`、`password_login_limits` 的 SELECT/INSERT，以及密码哈希/更新时间、限流窗口/次数的列级 UPDATE；会话 UPDATE 限 `revoked_at, active_role, password_setup_expires_at`。不得授予整表 UPDATE 或通过改 users.role 实现会话切换。权限以当前 grant-database-roles.sql 为准，发行前使用 runtime 角色验证实际认证写入。
