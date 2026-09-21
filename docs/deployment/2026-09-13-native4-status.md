# native-4 重新部署记录

> 后续版本：手机公开访问已切换 native-5，现行状态见 [native-5 记录](2026-09-13-native5-sms-public.md)。下文为历史证据。

当前阶段：native-4 已公开切换，17 项公网校验、受影响 UI 与 15 分钟稳定观察通过；本轮真实认证复验受限额和账户类型输入阻塞。

- 用户授权：将最新修改重新部署到现有阿里云 ECS / kylesong.top 并验证功能，继续使用内置浏览器。
- 目标：杭州 `i-bp1dhuuwx8r0zprhvnov`，`115.29.178.65`；本轮 Workbench 实际读到 `/opt/duduhire/releases/duduhire-20260912-native-3`、API PID 93848、现有 Nginx SHA `e653e6204518558300d3f6f0557d6b27c155fa01f4e100b9d247d3a6e9d9df8f`，磁盘剩余 30 GiB。
- 新版变化：注册资格查询、未注册邮箱/手机号登录拒绝并引导注册、相应 Web 更新；默认 Qwen 模型改为 `qwen3.8-max`。全部 001–009 迁移及依赖清单/lockfile 与 native-3 相同。
- 本地 `npm run check` 通过：15 项 Web 测试、197 项 API 测试，lint 与两端构建通过。此结果不是生产数据库或真实投递验收。
- 完整发行包：`/private/tmp/duduhire-native-release/duduhire-20260913-native-4/duduhire-20260913-native-4.tar.gz`，74,768,782 字节，SHA `623ef0b0d076af112f35c76675cc8e06056f0d637733f24eb43612368b1c8e72`。安全路径、常规文件、必需项及逐文件清单校验通过。
- 增量传输包：`/private/tmp/duduhire-native-4-delta.tar.gz`，228,170 字节，SHA `1d28f767d7e698bc6efed5655b0afe9d91b4eca29467347e374ba2d5cd37f63c`。包含 15 个变化/清单文件；113 个未变文件从已逐一校验的 native-3 复用。重建后的完整 SHA256SUMS 摘要必须为 `456842436a9e2a41ecd0fa1f2b8ade7bc3ea6887d79b4679eb927ec78f70c198`。
- 发布脚本：`ops/native/upgrade-existing.py`，Python 3.6 语法及离线激活、失败/中断恢复、候选内容及权限检查通过。服务器目标状态目录 `/root/duduhire-upgrade-native4`；stage 备份配置及数据库、重建发布目录、复用同机且依赖清单相同的 Linux 依赖，并在 8789 预发布检查；activate 重新核对候选后替换服务配置与 current，失败恢复旧配置/服务/链接。不会重新初始化数据库或改 Nginx 内容。
- 新模型先执行一次 64 token、12 秒上限且无重试的连接检查；不把模型配置值或合成 JSON 返回当作已登录业务流程验收。
- 自动认证回归仅对保留域名的合成邮箱检查未注册登录拒绝；对授权手机号只查资格，不自动 POST 短信 challenge，避免注册并发造成意外发信。真实注册沿用此前接收者与发送次数授权，账户类型仍待用户选择。
- Workbench 文件管理会话曾过期，已通过原有 root 免密权限重连并重新读取文件列表；该问题不表示服务器业务服务异常。

## 服务器已执行结果

- 上传文件服务器 SHA 与本地 `1d28f767…37f63c` 一致。
- stage PID 95358；备份 `/var/lib/duduhire-backup/duduhire-20260912T185539018Z-b91b52ab0c5a.dump`，67,250 字节，归档列表通过，未执行恢复演练。
- 全量重建、原文件与新清单校验通过；实际 QwenClient 检查：`qwen3.8-max / requests=1 / structure_valid=true / error=null`。
- 8789 预发布健康与认证负向检查通过：未注册邮箱登录被拒绝，手机号资格查询正常；发送短信/邮件均为 0。
- activate PID 95416，日志返回 `NATIVE4_ACTIVATED`；主域和 API 子域健康正常，17 项公网 GET 与完整新资源指纹校验全部通过（含 5 条 HTML 路由、4 个 JS/CSS、退役 worker、6 条 API 能力/健康、www 跳转）。
- 证据：服务器 `/root/duduhire-upgrade-native4/stage.log`、`activate.log`、本地 `/private/tmp/verify-native4.py`。

未完成：本轮真实认证及已登录 AI 业务流程。部署、受影响页面、模型连接、公网与稳定性检查已完成，知识记录已同步。

## 真实浏览器认证检查

- 未注册的保留域名邮箱：页面显示“尚未注册”，登录按钮禁用；“去注册”实际跳转成功，保留 returnTo 工作台路径，正确展示两种账户类型。
- 本轮授权手机号资格查询表明该号码已有账户，登录页允许发送。执行一次已授权的短信登录申请，返回应用层 429 对应提示“短信发送频率或额度已达限制”；未得到有效 challenge，未重试、未扩大额度。不得把历史记录中的“发送 0”当作当前数据库总数。
- 授权邮箱在当前生产库仍未注册，登录页正确阻止登录；账户类型待选择，因此本轮没有发送邮件或创建邮箱账户。真实送达、验证码登录、会话和已登录 AI 流程仍未完成。

- 响应式页面实测：登录页 390×844 和 1280×800，document scrollWidth 分别等于 390/1280，未发生横向溢出；手机主按钮宽 320，截图确认表单、未注册提示及按钮可见。测试后已恢复浏览器原尺寸。未保存含个人联系方式的截图文件。

## 最终服务器证据

- 900 秒、31 次采样全部通过，failed_samples=0、changed_service_samples=0；journal 0–4 级计数均为 0，未截断。证据 `/root/duduhire-upgrade-native4/stability.jsonl`，采样进程 PID 95492。
- 当前目录为 `/opt/duduhire/releases/duduhire-20260913-native-4`，API PID 95447、Nginx PID 17573，均 active/enabled、NRestarts=0。新备份 timer active/enabled；旧 API/outbox/旧备份 timer inactive/disabled。Nginx SHA 与切换前一致。
- 只读预算诊断：过去 24 小时 reserved=2、sent=2、consumed=2；下一全局日额度释放点 `2026-09-13T18:01:00.785Z`（北京时间 9 月 14 日 02:01），晚于当前短信授权窗口（9 月 13 日 22:16:30）。本轮申请在发送前被拒绝。历史 consumed 记录不等于本轮已完成登录与会话验收；不得擅自扩大额度或延长窗口。
- 首次 peer 方式读取预算失败，改用现有运行账号、严格 TLS 与 READ ONLY 事务完成聚合查询，未打印身份、验证码、连接串或令牌。

- 最终日志复核：采样开始以来 166 条结构化 API 日志，warn/error/fatal/non_json 均为 0；浏览器 warn/error 列表为空。观察窗口为北京时间 2026-09-13 03:01:48–03:16:48。初次日志查询的 ISO 时间参数被本机 journalctl 拒绝，改用 Unix 秒后只读计数成功；不表示应用异常。
