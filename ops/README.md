# 发布与运维脚本

这些文件不会自动连接生产环境。正式启用前由部署负责人配置绝对路径、服务账号、数据库权限、域名和告警接收渠道。脚本不读取浏览器账户，也不把 `.env` 当作 shell 执行。

原生发布流程见 [原生部署](../docs/NATIVE_DEPLOYMENT.md)。`native/archive/native-3/` 保留 native-3 的固定资源指纹验证脚本和当时浏览器清单，只供历史追溯，不能用于判断当前版本是否正常。后续版本的实际检查结果以对应的 `docs/deployment/` 记录为准；旧部署记录里的原脚本路径对应这个归档目录。

## 前提

- 部署主机：Bash、Docker Engine、Docker Compose v2（支持 `--wait`）、jq、curl。
- `production.env` 使用 `0600` 权限，由 Secret Manager 生成；不要在共享终端运行 `compose config` 输出完整配置。
- 镜像必须是 `registry/repository@sha256:<64位哈希>` 或 `registry/repository:sha-<40位Git提交>`。部署成功后保存实际 digest；不接受 `latest`、版本号或缩写 SHA。
- 代码和 Compose 位于固定发布目录，示例使用 `/opt/duduhire`。脚本的发布记录仅含镜像引用，位于专用的 `/var/lib/duduhire/releases`，不备份秘密值。
- 不在 `set -x` 模式运行；不要把数据库密码放入命令参数或 Git。

## 构建与部署

在 GitHub 的 **Build release images** 手动工作流中输入 `BUILD_AND_PUSH`，对当前提交构建并推送两个 GHCR 镜像，生成 SBOM/provenance 和包含 digest 的 `release-images` artifact；不会登录服务器或部署站点。GitHub 仓库和 Packages 权限需先配置。

1. 下载当前提交的镜像引用，写入秘密管理中的 `DUDUHIRE_API_IMAGE` / `DUDUHIRE_WEB_IMAGE`。
2. 创建并验收备份，运行当前迁移与 [数据库授权](../docs/DATABASE_ROLES.md)。确认旧 API 对迁移后的数据库仍兼容。
3. 使用以下命令发布。`--database-ready` 确认迁移/授权已完成；`--rollback-compatible` 确认旧镜像可访问当前数据库；`--backup-reference` 是已验收备份的记录号。它们是操作方确认，不代表脚本已验证业务兼容性。

```bash
bash ops/deploy.sh \
  --env-file /etc/duduhire/production.env \
  --state-dir /var/lib/duduhire/releases \
  --backup-reference release-backup-20260905 \
  --database-ready --rollback-compatible --confirm DEPLOY
```

脚本先验证并拉取镜像，再启动 API/Web，最多等待 120 秒健康检查。拉取失败不改运行服务；健康失败会尝试恢复记录中的原镜像，仍失败或首次发布无历史时停止 API/Web。数据库和数据卷不会回滚或删除。只有成功发布才更新 `current.release` / `previous.release`。同一状态目录有互斥锁；中断后的锁须先核查进程再人工处理。

手动回滚同样必须确认数据库向后兼容：

```bash
bash ops/rollback.sh \
  --env-file /etc/duduhire/production.env \
  --state-dir /var/lib/duduhire/releases \
  --database-compatible --confirm ROLLBACK
```

部署脚本只管理 API/Web。通知 worker 使用相同版本 API 镜像但单独运行；其迁移兼容性、停止旧 worker 和启动新 worker 由发布步骤明确处理。环境秘密不会随镜像回滚；密钥变更必须遵循 [密钥轮换流程](../docs/DEPLOYMENT.md#密钥轮换)。

## 后台任务与探针

```bash
bash ops/maintenance.sh --env-file /etc/duduhire/production.env --confirm CLEANUP
bash ops/notifications.sh --env-file /etc/duduhire/production.env --confirm NOTIFY
bash ops/healthcheck.sh --origin https://duduhire.example.com
```

- cleanup 只调用独立 maintenance 凭据下的保留期函数。
- notifications 要求独立数据库角色和显式收件邮箱；不传认证、解密或 Qwen/其他 AI 供应商密钥。仅在运营负责人确认后启用，通知投递语义及后台权限见 [企业咨询运营](../docs/OPERATIONS.md)。
- healthcheck 检查 Web、API 存活和数据库就绪，输出固定 JSON 行并在任一失败时退出 `1`；不输出响应正文。它不证明 SMTP 投递、AI 质量或通知 worker 已正常处理。

`systemd/` 提供每日 cleanup timer、持续运行的 notifications service 和每分钟 health timer。先复制到目标主机并按实际路径修改，再由部署负责人启用；仓库不会自动安装服务。示例健康服务使用 `nobody:nogroup`，发行版若没有该组需替换。`/etc/duduhire/health.env` 只放 `DUDUHIRE_HEALTH_ORIGIN=https://实际域名`，不要放秘密。具有 Docker socket 权限的任务相当于具备主机管理权限，不要把生产 env 授权给普通用户。

收集 systemd 失败状态和健康脚本非零退出码到实际监控平台；示例未配置任何邮件/webhook 告警目标，timer 存在不代表已有人值班。

## 加密备份与隔离恢复

主机需提供与服务器主版本兼容的 `pg_dump`/`pg_restore`/`psql` 和 `age`。连接使用 libpq service 名称；连接地址、`sslmode=verify-full`、CA 和密码放在受保护的 `PGSERVICEFILE` / `PGPASSFILE` 中，不在命令行暴露 URL。备份目录必须预先建立并限制权限。

```bash
bash ops/backup.sh \
  --service duduhire-backup \
  --output /secure/backups/duduhire-20260905.dump.age \
  --recipient age1实际公钥 \
  --confirm BACKUP
```

`pg_dump` 直接通过管道加密，没有明文备份临时文件；已有输出文件不会覆盖。失败的部分密文保留为 `.failed`，便于调查。脚本不会删除历史备份，也不代替备份生命周期和异地存储策略。成功只说明备份生成，不能视作恢复已验收。

恢复只能使用预先创建的**空**隔离库，数据库名称须以 `_restore_test` 或 `_validation` 结尾。禁用到生产 SMTP/AI 的出站访问，并使用专门的隔离连接；脚本不会启动应用，也不会清空已有数据库。

```bash
bash ops/restore-check.sh \
  --service duduhire-isolated-restore \
  --backup /secure/backups/duduhire-20260905.dump.age \
  --identity /secure/keys/backup-age.key \
  --confirm RESTORE_ISOLATED
```

恢复在单个事务中进行，验证核心表、已验证约束及本提交所有迁移校验和。旧版本备份可能需要另行执行向前迁移；脚本会如实失败，不跳过版本差异。恢复的数据留在隔离库供应用级验收；该脚本不授予应用角色、不验证邮件/AI、不宣布生产恢复完成。关闭演练后按批准的数据保留流程处理隔离库。

## 本地验证

```bash
bash ops/test-operations.sh
```

测试仅使用假的 Docker 命令验证操作确认、拉取失败不变更服务、成功保存版本、健康失败恢复原版本；不接触真实 Docker 或生产服务。容器、systemd 与完整备份恢复仍须在目标平台验收。
