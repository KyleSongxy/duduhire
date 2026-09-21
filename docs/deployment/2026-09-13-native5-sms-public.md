# native-5 手机注册登录公开访问

当前：已公开切换并通过部署验收，17 项公网检查及 15 分钟稳定观察通过。

## 授权与配置

用户明确选择：向所有中国大陆手机号开放注册/登录，取消测试窗口，全站滚动 24 小时最多 30 条短信。保留每号码/每 IP 每小时各 2 条、60 秒重发冷却、验证码有效期/失败次数限制、来源与浏览器绑定检查。既有发送记录不清零，发送失败仍占滚动预算。

新增明确开关 `PHONE_AUTH_ALLOW_ALL_NUMBERS=true`，配置 `PHONE_AUTH_DAILY_LIMIT=30`，移除 `PHONE_AUTH_SEND_UNTIL`。默认代码仍为 allowlist 模式；生产显式开启公开模式后，旧 allowlist 内容不再限制大陆号码。非大陆号码和格式错误号码仍拒绝。邮件配置、AI 模型、数据库结构不变。

## 发行与备份

- 版本：`duduhire-20260913-native-5`，仅更新 `phoneAuthConfig.js`、`phoneAuthConfig.d.ts`、`phoneAuthRoutes.js` 及发行元数据，其他文件从完整验证的 native-4 复用。
- 完整包 SHA `5545ed9f39456e3ecdd1fb11b0c54d90e75ae71c8e55c44745809f7ac87181a0`；差异包 11,102 字节，SHA `1030a66e0b31bcc92d090a165303178cf357df105d42b90405997f9d9efd9f36`；完整新清单 SHA `e9d8bacf0fd33521e56fe32805064d63be1f04681ca8146c8ccee61a0453c147`。
- 固定升级脚本 `ops/native/upgrade-public-phone.py`，备份 runtime/unit/Nginx/current，重建完整 release 并逐文件校验；候选配置验证与 8789 预发布通过后，重新核对候选并切换。失败恢复原配置和服务。
- 备份 `/var/lib/duduhire-backup/duduhire-20260913T053740822Z-20653e3d4161.dump`，76,102 字节，归档列表通过，未恢复演练；包含此前 120 条示例数据。
- 服务器操作目录 `/root/duduhire-upgrade-native5`，原配置备份 root 私有。stage PID 98386，activate PID 98438，均返回成功；未触发回滚。native-4 目录保留。
- 激活脚本校验实际新进程的环境：公开模式 true、总额度 30、无截止时间。未输出其他进程环境或凭据。

## 检查

- API 全部 200 项测试通过，lint/build 通过；新增覆盖默认受限模式、空白名单公开模式、注册与登录、公用额度传递、耗尽拒绝、来源校验、非大陆号码拒绝、凭据仍必需。
- 预发布配置与 API live/ready、未注册邮箱拒绝登录、手机号资格查询通过，未自动发送短信/邮件。
- 17 项公网检查通过，前端文件逐项与既有指纹一致；本次没有更新前端或媒体。
- 稳定性检查证据将保存于 `/root/duduhire-upgrade-native5/stability.jsonl`。
- 本次没有申请真实短信；模拟 provider/仓储回归不能说成新的运营商送达和用户登录验收。

- 线上编译模块使用实际 runtime 配置、隔离仓储与模拟 provider：注册/登录均通过原白名单检查并传入全局额度 30；模拟耗尽返回 429，providerCalls=0。此测试没有生产数据库写入或真实短信。
- 手机注册页已实际读取 DOM 与截图，展示两种账户类型、手机号输入、验证码与发送入口，无服务停用提示。

## 最终验收

- 北京时间 2026-09-13 13:43:51–13:58:51，900 秒、31 次采样全部通过，failed_samples=0、changed_service_samples=0。
- API PID 98469、Nginx PID 17573，均 active/enabled，NRestarts=0；current 指向 native-5，Nginx 内容摘要不变。
- 采样窗口 journal 0–4 级均为 0；窗口开始以来 157 条结构化应用日志，warn/error/fatal/non_json 均为 0。浏览器 warn/error 列表为空。
- 运行中的公开访问模式、额度 30 和无截止时间均已核对；保留 60 秒冷却、每号码/每 IP 每小时 2 条。未清空已有短信记录，未执行真实短信发送或新的验证码登录。
