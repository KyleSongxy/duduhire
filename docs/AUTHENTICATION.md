# 邮箱密码、邮件链接与手机号认证设计

更新日期：2026-09-14（按当前源码核对；不代表外部服务验收）

## 目标

在不改变现有登录/注册页视觉结构的前提下，启用邮箱时使用 Magic Link 完成账户注册、登录和邮箱所有权验证；也可显式停用邮箱并独立启用短信认证（号码白名单或显式公开号码访问）。验证页只在内存中读取 token，立即清除地址栏 fragment；token 不进入持久化 Web Storage 或服务器访问日志。验证页不得加载第三方脚本。

## API 合同

### 查询可用方式

`GET /api/v1/auth/methods` 禁止缓存，返回 `email.available`、`email.delivery` 与 `phone.available`、`phone.region`。邮件投递模式映射如下：

| 配置模式 | `email.available` | `email.delivery` | 行为 |
|---|---|---|---|
| `smtp` | `true` | `email` | 使用真实 SMTP；接口标记本身不证明投递成功 |
| `console` | `true` | `development` | 仅本机开发演练，生产禁止 |
| `disabled` | `false` | `disabled` | 邮件注册、登录和链接核验均拒绝 |

前端需先确认状态才能发送；邮箱停用时显示未启用，并在短信可用时默认选中短信。两种方式均停用时禁止发起认证，不能提示改用另一种已停用的方式。服务状态读取失败时展示重试入口，不推断任何方式已可用。

### 登录前检查

`POST /api/v1/auth/login-eligibility` 接受 `{ method: "email" | "phone", account }`，返回 `{ registered: boolean }`，需可信 Origin、禁止缓存并限制每 IP 60 次/10 分钟。该接口只查询账户存在性，不发送邮件/短信、不建立会话，也不表示认证渠道可用。申请 challenge 时仍独立检查未注册登录并返回 `409 ACCOUNT_NOT_REGISTERED`。

### 请求验证链接

`POST /api/v1/auth/email/challenges`

```json
{
  "email": "person@example.com",
  "intent": "signup",
  "role": "client",
  "returnTo": "/workspace"
}
```

- `intent=signup` 时 `role` 必填。
- `intent=login` 时忽略客户端角色，始终读取服务端既有角色。
- `returnTo` 只允许本站绝对路径；外部 URL、双斜杠、反斜杠和认证循环会回退到 `/workspace`。
- 成功返回 `202`；未知邮箱以登录意图申请时返回 `409 ACCOUNT_NOT_REGISTERED`，不发送邮件、不创建账户。
- 响应 `delivery=email` 表示 SMTP 已接受发送；`delivery=development` 表示仅写入开发日志，没有向收件箱投递。前端只有收到 `email` 才能展示已发送，不能仅凭 `202` 或 `accepted=true` 判断。SMTP 接受仍不保证进入收件箱，实际送达需由收件人确认。
- 同一邮箱默认 60 秒后才能重发，且每小时最多 5 次；数据库事务锁让并发请求也只能通过一次，路由同时按 IP 限流。
- API 设置短期限、HttpOnly 的浏览器绑定 Cookie，并把其 HMAC 与 challenge 一起保存。
- `EMAIL_DELIVERY_MODE=disabled` 时返回 `503 EMAIL_AUTH_DISABLED`，不调用发信适配器、不创建 challenge，也不借此签发 Cookie 或创建账户。

### 验证链接

邮件链接指向 Web：`/auth/verify#token=...`。URL fragment 不会发送给静态站点、反向代理或访问日志；页面读取后立即从地址栏移除，并调用：

`POST /api/v1/auth/email/verify`

```json
{ "token": "one-time-random-token" }
```

- token 由 32 字节加密安全随机数生成。
- 数据库只保存使用 `AUTH_TOKEN_SECRET` 计算的 HMAC-SHA256。
- 默认 15 分钟有效，只能消费一次。
- token 必须与发起请求浏览器的绑定 Cookie 同时匹配；Web 首次探测会话时即预置该 HttpOnly Cookie，申请邮件时再刷新有效期，降低邮件已投递但申请响应中断造成的上下文丢失风险。跨浏览器、跨设备或隔离邮件 WebView 会被拒绝，用户需回到原浏览器重新发送。
- 同一浏览器为同一邮箱重新申请后，较早的未消费链接失效；其他浏览器无法作废该浏览器的链接。
- 验证事务同时完成 challenge 锁定、账户创建或读取、`email_verified_at` 更新与会话创建。
- 成功响应设置会话 Cookie，并返回服务端保存且再次校验过的站内 `returnTo`；Web 随后替换当前地址。
- 邮件安全扫描器只抓取静态链接时不会消费 token，因为 fragment 不会到达服务端且验证必须使用同源 POST。
- 未注册邮箱从登录流程进入时，申请阶段提示先注册，不会静默注册；核验接口仍保留账户不存在的防御性响应。
- 邮箱显式停用时，即使链接尚未过期且浏览器绑定正确，也返回 `503 EMAIL_AUTH_DISABLED`，不消费 challenge 或建立会话；前端显示邮箱未启用及返回登录入口，不将其误报为网络错误或成功登录。

### 会话

`GET /api/v1/auth/session`

无会话时返回：

```json
{ "session": null }
```

有效会话返回 user id、邮箱与手机号（未设置的身份为 `null`）、当前会话角色、可用角色列表 `roles: ["client", "talent"]`、各联系方式验证时间、登录时间、过期时间与当前服务端个人资料。手机号账户不生成虚构邮箱，`emailVerifiedAt` 为 `null`；响应禁止缓存。

`POST /api/v1/auth/logout` 会在数据库撤销当前会话并清除 Cookie。退出、资料更新和验证邮件请求都执行精确 Origin 检查。

## 邮箱密码登录与设置

登录页默认使用邮箱密码，`?method=email` 与 `?method=phone` 分别保留邮件链接和短信入口。注册仍须完成联系方式验证；邮箱注册可选择验证后设置密码，已有账号可从“首次设置密码 / 忘记密码”申请邮件并回到 `/account/password`。手机号独立账户不因此生成邮箱或密码身份。

首次设置与重置共用同一流程：当前浏览器消费一次性邮件链接后，会话得到 15 分钟的 `password_setup_expires_at` 资格。普通密码登录或短信登录不授予该资格，普通登录状态也不能延长它。设置接口在计算哈希前后都核验资格；保存后撤销该用户的全部会话、清除当前 Cookie，并使此前签发的邮件链接失效，用户须以新密码重新登录。

新密码为 12–128 个 Unicode 字符且 UTF-8 不超过 512 字节，允许中文和空格。使用 scrypt（N=131072、r=8、p=1）与每次随机的 16 字节盐，保存 32 字节派生值；不保存明文。未知账户或未设置密码仍执行哈希校验并返回统一凭据错误，不通过密码接口暴露区别。单进程最多并行 4 次内存密集的哈希计算，繁忙时明确返回暂不可用。

密码登录按 IP 每分钟最多 20 次，数据库按邮箱 HMAC 的 15 分钟窗口最多允许 10 次尝试；超限返回 429 和 Retry-After。设置接口另限制每 IP 15 分钟 5 次。`EMAIL_DELIVERY_MODE=disabled` 不删除已有密码，密码登录独立校验；但新的首次设置或重置仍依赖重新验证邮件，不能绕过邮件停用。

迁移 `010_password_authentication.sql` 建立 `user_passwords`、`password_login_limits` 和会话资格期限。部署前执行全部 001–011 迁移并重应用列级授权。上述为代码合同，真实邮件送达、实际重置和生产登录验收需另行记录。

## Cookie

生产默认：

```text
__Host-duduhire_session=<opaque-token>; HttpOnly; Secure; SameSite=Lax; Path=/
__Host-duduhire_auth_intent=<browser-binding>; HttpOnly; Secure; SameSite=Lax; Path=/
```

- 原始 token 只在 Cookie 中出现，数据库保存 HMAC。
- `__Host-` 禁止 Domain 属性并要求根 Path 与 Secure。
- 默认 30 天过期；退出或服务端撤销后立即失效。
- `auth_intent` 只绑定验证发起浏览器，默认与 Magic Link 同期过期，不代表已登录状态。
- 本地 HTTP 使用独立的 `duduhire_session` 名称和非 Secure Cookie，生产配置会拒绝这种降级。

## 使用身份与会话切换

所有账户都可使用 `client` 与 `talent`，会话响应的 `user.roles` 固定为这两个值，`user.role` 表示当前会话身份。`users.role` 保留首次注册选择；`sessions.active_role` 保存当前身份，迁移 011 将旧会话回填为原初始身份，并通过 INSERT 触发器兼容旧 API 省略 active_role 的写入，沿用该账户初始身份。新建会话以注册初始身份开始，同一会话刷新后保持已选择身份。

`POST /api/v1/auth/role` 请求 `{ role: "client" | "talent" }`，必须登录并来自可信 Origin，返回与 GET session 相同的完整会话和共用个人资料。切换只更新当前有效会话；同一浏览器共享 Cookie 的页面会受影响，其他独立会话不因此切换。它不修改注册初始身份、不建立新账户、不复制个人资料，也不撤回另一身份的已保存内容。

发现、匹配与工作台请求使用当前会话身份；前端 `/me/*` 请求携带 `X-DuduHire-Role`。服务端对发现、匹配和工作台校验该值，旧身份请求返回 `409 ACTIVE_ROLE_CHANGED`，页面需刷新会话并保留尚未提交的文字，不能自动重放旧身份操作。该请求头只用于冲突检测，不能授权另一个身份或用户。未提交头的兼容客户端仍使用服务端当前身份。

基本资料按用户共用，发现与匹配资料按用户和 `kind` 分离；需求方 intake 仍只能由当前需求方身份领取。身份切换不赋予管理员权限。

## 邮件

生产 Compose 默认 `EMAIL_DELIVERY_MODE=smtp`，必须提供有认证的 `SMTP_URL` 和已验证 `EMAIL_FROM`，并强制 TLS/STARTTLS。原生生产启动须显式选择模式；缺少 SMTP 必填值时启动失败，不自动降级。主题、正文和按钮不包含密码；链接只承载随机 token，并提示在申请邮件的同一浏览器打开。API 会等待 SMTP 明确接受邮件后才返回 202，不把投递伪装成不可持久化的后台任务；连接、问候和空闲阶段都有短超时且不自动重排。投递失败时 challenge 会立即失效，API 返回可重试错误并按 challenge id 写入安全日志。

尚未接入邮件时可显式设置 `EMAIL_DELIVERY_MODE=disabled`，主 API 无需 `SMTP_URL` 或 `EMAIL_FROM`，不会创建 SMTP 传输器或输出开发验证链接。已有有效会话的读取与退出保持正常，但任何邮件入口都不能建立新会话。生产 HTTPS、数据库 TLS、认证密钥、资料加密密钥及 Qwen/OpenAI 配置仍必须通过校验；通知 worker 的 SMTP 配置独立校验。此模式交付的是“邮箱未启用”，不表示邮件投递已验收；后续开启 SMTP 后仍需真实邮箱送达及完整登录测试。

本地 `console` 适配器会把链接写入开发日志，因此禁止用于共享环境或生产环境。该模式下页面会明确提示未发送真实邮件，不进入“检查收件箱”状态；请求仍受重试冷却限制。真实启用步骤见 [部署指南](DEPLOYMENT.md#真实邮箱注册)。

## 旧数据

- 旧 `localStorage:duduhire-session` 和 `duduhire-local-roles` 不可信，不会迁移。
- 有效服务端会话加载后会删除这两个键。
- 旧个人资料和发现记录不会自动上传；上传本机历史内容需要单独的用户确认与迁移设计。

## 手机号注册：受限联调

阿里云 PNVS 短信认证与上述邮箱 Magic Link 是独立流程。已实现验证码发送、核验、手机号账户、会话和原表单内的方式切换；默认关闭真实发送；启用后默认只接受配置的号码白名单，也支持显式设置 `PHONE_AUTH_ALLOW_ALL_NUMBERS=true` 允许格式有效的中国大陆号码。公开号码访问仍受发送额度和冷却限制，是否实际开放必须检查部署配置。保存 AccessKey、模拟测试或服务商受理成功均不等于手机实际收到短信，更不等于可面向公众上线。

本地准备命令：

```sh
npm run auth:configure:pnvs
```

- 在真实交互式终端依次粘贴专用 RAM 用户的 AccessKey ID 和 Secret；两项均不回显，不接受命令行参数或管道输入。
- 等对应提示出现后再粘贴；若复制的字段自带换行，粘贴后可能已进入下一项，不必再次按 Enter。空输入或不合格的内容会给出不包含密钥的提示，只重录当前项；取消、保存位置问题和写入失败分别提示，不输出原始异常。
- 仅保存到当前用户的 `~/.config/duduhire/pnvs.json`，目录必须为 `0700`、文件为 `0600`；拒绝仓库内目录、符号链接及不安全的目录权限。
- JSON 文件仅包含 `accessKeyId`、`accessKeySecret`，与 Qwen 配置隔离；不猜测云服务密钥字符格式，只拒绝空值、超长值及内部空白/控制字符。已存在的文件不会被覆盖，不提供自动轮换/覆盖选项。
- 此命令不发送短信、不调用阿里云、不读取原有密钥，也不自动启用手机号注册。独立的 `loadLocalPnvsEnvironment` 仅在 `DUDUHIRE_LOAD_LOCAL_ENV=true` 且非生产环境读取该文件；已有注入凭据时不混用，Qwen 加载逻辑不变。
- AccessKey 必须由用户本人在阿里云创建与保管，不得发送到聊天、截图、前端、Git 或同步网盘。已暴露的密钥须在 RAM 禁用，重新创建后保存。

### 验证流程与身份边界

1. `GET /api/v1/auth/methods` 返回当前方式是否可用，不返回凭据或允许名单。
2. `POST /api/v1/auth/phone/challenges` 接受中国大陆 11 位手机号（或明确的 `+86` 前缀）、intent、注册角色及站内 returnTo。可信 Origin、号码策略和持久化额度检查通过后，先创建不可核验的 pending challenge，再调用 PNVS。
3. PNVS 生成六位数字验证码；服务端用 ReturnVerifyCode 结果生成绑定 challenge ID 的 HMAC，与 sent 状态一起落库。验证码明文只在本次内存中使用，不进入浏览器响应、日志或数据库。失败或超时作废本地 challenge，禁止自动重发；超时不代表短信未发送。
4. `POST /api/v1/auth/phone/verify` 只接受 challengeId 和验证码。先检查浏览器绑定、有效期、失败次数及本地 HMAC，领取 30 秒核验租约；再在事务之外调用 PNVS Check，最后在数据库事务中消费 challenge 并创建用户/会话。并发、重复和过期请求不能重复认证。
5. 未注册号码走登录入口时，在申请阶段返回 `409 ACCOUNT_NOT_REGISTERED`，不发送短信、不静默建号；核验接口仍保留账户不存在的防御性响应。已有号码从注册入口进入仍保留原角色。手机号与邮箱各自识别账户，不按资料中的联系方式自动合并；绑定/换绑、账号合并和号码回收处理尚未提供。

PNVS 默认使用平台提供的签名「恒创联众」和登录/注册模板 `100001`，仅用 `dypns:SendSmsVerifyCode`、`dypns:CheckSmsVerifyCode`。自定义验证码不能由 PNVS Check 核验，因此不采用本地生成明文后直接发送的方案。[官方发送接口](https://help.aliyun.com/zh/pnvs/developer-reference/api-dypnsapi-2017-05-25-sendsmsverifycode)、[核验接口](https://help.aliyun.com/zh/pnvs/developer-reference/api-dypnsapi-2017-05-25-checksmsverifycode)。

### 显式开关与限制

| 变量 | 默认 / 约束 |
|---|---|
| `PHONE_AUTH_ENABLED` | `false`；启用前配置号码策略、凭据与发送额度 |
| `PHONE_AUTH_SEND_UNTIL` | 可选固定 UTC 截止时间，最多设为启动时 24 小时内；到期只阻止新发送，仍允许有效验证码核验。一次短信授权应配合小于 24 小时的固定窗口、全局额度 1 和长于验证码有效期的重发冷却；不得通过重启延长窗口或清空计数 |
| `PHONE_AUTH_ALLOWED_NUMBERS` | 空；限制模式下至多 20 个号码，逗号分隔；不支持 `*` |
| `PHONE_AUTH_ALLOW_ALL_NUMBERS` | 默认 `false`；显式设为 `true` 时允许所有格式有效的中国大陆手机号，仍受全局、号码/IP 额度与冷却限制。持续开放时不设置 `PHONE_AUTH_SEND_UNTIL` |
| `PNVS_ACCESS_KEY_ID` / `PNVS_ACCESS_KEY_SECRET` | 本地独立安全加载；生产由秘密管理服务注入，不读取个人文件 |
| `PHONE_AUTH_CODE_TTL_SECONDS` | 300 秒，允许 60–600 秒 |
| `PHONE_AUTH_RESEND_SECONDS` | 60 秒，最低 60 秒 |
| `PHONE_AUTH_PHONE_HOURLY_LIMIT` | 每号码滚动一小时 3 次 |
| `PHONE_AUTH_IP_HOURLY_LIMIT` | 每 IP 滚动一小时 5 次，IP 仅保存 HMAC |
| `PHONE_AUTH_DAILY_LIMIT` | 所有号码滚动 24 小时 10 次；首次联调应按批准次数降低 |
| `PHONE_AUTH_MAX_ATTEMPTS` | 每 challenge 最多 5 次，不能调高到 5 次以上 |

发送失败也计入数据库配额；多进程共用持久化限额。路由另限制每 IP 发起 10 次/小时、核验 15 次/分钟。新申请使同一手机号旧 challenge 失效。清理遵循 owner 控制的 challenge 保留期，并至少保留 24 小时发送计数。

手机号表来自 `009_phone_authentication.sql`；当前发布须执行全部 001–011 迁移并重新应用列级数据库授权。账户与验证码表含个人信息，须保护数据库、备份和运维访问。真正验收还需用户批准号码/发送次数，完成运营商送达、本人输入验证码、刷新会话、退出/再次登录及旧码失效测试。代码包含公开号码访问模式及限流测试，但本文不据此宣称当前部署开放、真实送达或公开注册反滥用验收完成；启用邮箱时仍需单独的 SMTP 与收件箱送达验收，显式停用邮箱时须标明该能力未启用。
