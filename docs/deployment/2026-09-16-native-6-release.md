# 2026-09-16 native-6 部署验收

状态：**native-6 已部署，公网与浏览器检查、15 分钟稳定性观察通过。真实送达及真实账号登录未重测。**

用户授权重新部署最新功能。初次检查遇到阿里云登录过期，未修改线上；用户恢复内置浏览器登录后继续，同一 Workbench 实例完成部署。

## 冻结产物

- 版本：`duduhire-20260916-native-6`
- 完整包：`/private/tmp/duduhire-native-release/duduhire-20260916-native-6/duduhire-20260916-native-6.tar.gz`
- 大小：52,465,476 bytes；SHA-256：`429d6b7dd0686e0e86ff885ae86f3c4359dc03f827704534bb5d5d8b29bb7c89`
- 124 个负载文件，11 项迁移；归档路径、常规文件类型、必需文件、完整 SHA256 清单均通过打包器验证。
- `SHA256SUMS` 摘要：`8d864431ffa44a1eed5053b3231cebbc95cc5d483e4c7cce9e2f69736bfeba3f`
- 差分包：同目录 `duduhire-native-6-delta.tar.gz`，249,924 bytes，SHA-256 `f56d023f305cc3d72d09d5abb14bbf42af23f6b7094a91e3ea38e08e80c275bc`，24 个变更文件。
- 差分基线：本地冻结 `duduhire-20260913-native-5/payload`。恢复服务器连接后必须机械核对基线清单，不能仅凭版本目录名复用。
- 新前端：`assets/index-BVwoRyev.js`、`assets/index-phQ-r79K.css`。

## 变更及迁移边界

- 包含密码认证、当前会话身份切换及本地最新界面更新。
- 新增 `010_password_authentication.sql`：密码哈希表、密码登录限流表和会话密码设置期限。
- 新增 `011_session_active_role.sql`：会话当前身份，回填既有会话并增加合法值约束；触发器兼容旧 API 未提供该字段的 INSERT，保留原账号身份。
- 最新权限脚本增加密码表和会话字段的受限授权，必须在迁移后执行并以 runtime 身份验收。不得为功能方便赋予运行账号所有者权限。
- 锁文件、API/Web package.json 与 native-5 一致；根 package.json 仅 scripts 增加仓库检查。运行依赖没有变化，可在机械确认后复制既有 Linux 依赖到独立新发布目录。
- 已清理的过时视频不在新清单中，完整包缩小；旧发布目录保留用于回滚，不清理生产历史数据或版本。

## 本地验证

- `npm run check`：仓库检查、lint、Web 18/18、API 204/204、前后端构建通过。Vite 提示主 JS 超过 500 kB，构建成功。
- 新建临时 PostgreSQL 集群（仅监听 127.0.0.1:55486），应用 001–011 迁移。
- PostgreSQL 集成 6/6 通过；短信数据库及模拟 PNVS 路由集成 20/20 通过；最终运行无跳过、无失败。测试后临时集群已停止。
- 首次短信测试缺少专用路由数据库变量而跳过 1 项；补全变量后重新使用全新临时集群，最终全部通过。
- 日志：`/private/tmp/duduhire-20260916-check.log`、`/private/tmp/duduhire-20260916-integration-final.log`。
- 测试没有连接生产数据库，没有发送真实短信或邮件。

## 保留边界与回滚

- 大陆手机公开注册/登录、全站滚动 24 小时 30 条短信额度、无测试截止时间及单手机/IP频率保护均保留。
- 没有重跑 mock 导入、修改真实账号密码或发送真实短信/邮件。旧发布目录和私有原配置保存于服务器。
- 直接回滚版本是 native-5。按本次 `/root/duduhire-upgrade-native6` 中的 `unit.before`、`runtime.before.env` 和 `current.before` 恢复应用后，必须重新检查健康和权限，并观察 15 分钟。
- 010/011 是增量兼容迁移，应用回滚保留新增结构，不恢复旧 dump 覆盖此后的用户数据。
- 旧版 `upgrade-public-phone.py` 不支持这两项新迁移，不可用于此版本重复部署。

## 生产执行证据

- 预检：current 为 native-5，API PID 98469、Nginx PID 17573，均 active/enabled、NRestarts=0；磁盘剩余 29 GiB。
- 上传文件 `/root/duduhire-native-6-delta.tar.gz`，249,924 bytes，服务器 SHA-256 与本地一致。
- 执行目录 `/root/duduhire-upgrade-native6`；部署驱动源为 `ops/native/upgrade-password-role.py`，包含独立候选、完整清单校验、私有配置备份、增量迁移、受限授权、预览服务和自动应用回滚。
- 第一次长命令粘贴未进入终端执行，随后只读确认执行目录不存在、上传文件完整；再次可视核对粘贴后执行成功。没有重复迁移或重复切换。
- 数据库备份 `/var/lib/duduhire-backup/duduhire-20260915T171309788Z-6bacc176ad28.dump`，85,561 bytes；备份工具确认 `pg_restore --list` 成功。未进行生产恢复操作。
- 010、011 迁移及新版权限脚本成功，11 项数据库迁移 checksum 与冻结包完整一致。
- 迁移前后 users=6、matching_examples=120、matching_listings=4、sessions=12；无数据丢失。
- 候选 8789 与切换后 8788 均通过 health/ready、未注册邮箱登录拒绝、手机登录资格查询、无效密码 401、未登录密码设置 401、未登录身份切换 401。
- current 和 API systemd 已切换到 `/opt/duduhire/releases/duduhire-20260916-native-6`。Nginx 配置摘要不变。
- 稳定性观察进程 PID 112109，日志 `/root/duduhire-upgrade-native6/stability.jsonl`。
- 切换确认前提前运行的一次公网指纹检查仍读到旧版，因此旧入口/新资源检查失败；它不是新版本验收。切换完成后重新检查，21/21 全部通过，见 `/private/tmp/duduhire-native6-public-final.jsonl`。
- 浏览器登录页显示密码、邮件链接、手机短信三种入口；未注册邮箱预检提示并禁用登录按钮已验证。尚未使用真实账号密码或发送邮件/短信。

## 最终验收

- 2026-09-16 北京时间 01:16:48–01:31:48（UTC 2026-09-15 17:16:48–17:31:48），900 秒、31 次采样全部通过：failed_samples=0、changed_service_samples=0。
- 最终 API PID 112089，Nginx PID 17573；服务 active/enabled、NRestarts=0；备份 timer active/enabled。
- 观察以来 171 条 Pino 结构化日志，warn/error/fatal/non_json 均为 0；journal 0–4 级均为 0。
- 最终只读聚合：users=6、matching_listings=4、matching_examples(problem=20, capability=100)、migrations=11、invalid_session_roles=0；候选完整 SHA256 清单复核成功，Nginx 配置无变化。
- 此次 dump SHA-256：`85ec70596bdead3873afeed80c81b6b10009d02cad888e00103a8e516ebd9d46`。
- 最终服务器证据：`/root/duduhire-upgrade-native6/final-status.json`、`stability.jsonl`、`stage.log`、`activate.log`。
- 浏览器：密码/邮件/短信入口可见；未注册邮箱提示且禁止登录；需求方/能力方初始身份可选；验证后设置密码选项可切换；1280px 页面无横向溢出；未登录访问 `/account/password` 跳转登录并保留 returnTo。浏览器 warning/error 列表为空，最终已打开线上首页。
- 终验读取曾出现 CDP 键盘事件超时；随后只读 DOM 确认命令已经完成（当时第 29 个样本），未重复任何迁移/切换操作。窗口结束后重新运行只读核验取得 complete=true。
- 本地测试的真实 PostgreSQL、模拟 PNVS 和合成账号证据不等同于线上真实邮箱/短信送达。此次没有使用真实账号进行密码设置、密码登录或登录后身份切换；相关完整流程由隔离集成测试覆盖。
