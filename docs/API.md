# DuduHire API 契约

更新日期：2026-09-14（按当前源码核对；不代表外部服务验收）
范围：当前仓库实际提供的 HTTP 接口

## 通用约定

- 业务 API 前缀为 `/api/v1`，请求和响应使用 JSON；健康探针位于 `/api/health`。
- Web/API 以同源方式部署。浏览器请求必须携带 Cookie（`credentials: include`）；认证凭据是 HttpOnly Cookie，不返回 Bearer token。
- 所有 `/api/v1` 的 `POST`、`PUT`、`PATCH`、`DELETE` 都要求 `Origin` 与生产 `WEB_ORIGIN` 精确一致，否则返回 `403 ORIGIN_NOT_ALLOWED`。
- JSON 请求体上限为 256 KiB。未知字段会被 JSON Schema 拒绝。
- 时间为 ISO 8601 UTC 字符串，真实业务记录 ID 为 UUID；独立匹配示例使用 `example-` 前缀的固定标识。客户端生成的 `requestId` 必须在一次逻辑操作的重试中保持不变。
- 前端 `/me/*` 请求携带 `X-DuduHire-Role: client | talent`。发现、匹配与工作台接口发现它与服务端会话不符时返回 `409 ACTIVE_ROLE_CHANGED`；无效值返回 `400 INVALID_REQUEST`。该头不能切换身份或授予权限；省略时按当前会话身份处理。客户端应刷新会话而非自动重放旧身份操作。
- 常规错误结构如下；部分领域错误会增加 `field` 或 `currentVersion`。`requestId` 可能在通用错误中出现，用于关联服务端日志。

```json
{
  "error": {
    "code": "INVALID_REQUEST",
    "message": "请求内容无效。",
    "requestId": "req-..."
  }
}
```

常见状态：`400` 请求不合法，`401` 未登录，`403` 来源/角色无权，`404` 不存在或不可见，`409` 版本/业务状态冲突，`413` 请求体过大，`429` 限流，`503` 邮件或 AI 依赖不可用。服务端不会把数据库、SMTP 或 Qwen/OpenAI 的原始错误返回给浏览器。

## 认证

### 密码登录与设置

所有密码响应（含错误）禁止缓存；POST 需可信 Origin，未知字段拒绝。

- `POST /api/v1/auth/password/login`：请求 `{ email, password, returnTo? }`。成功 `200 { authenticated: true, returnTo }` 并设置会话 Cookie，回跳只允许站内路径。未知邮箱、未设置密码或密码错误统一 `401 INVALID_CREDENTIALS`；无效输入 `400 INVALID_REQUEST`，不可用或哈希繁忙 `503 PASSWORD_AUTH_UNAVAILABLE`。按 IP 20 次/分钟和邮箱 HMAC 10 次/15 分钟限制，超限 `429 RATE_LIMITED`（Retry-After）。
- `GET /api/v1/auth/password/setup`：有效会话返回 `200 { canSetPassword: boolean, email: string | null }`，无会话 `401 AUTH_REQUIRED`。只有当前会话在 15 分钟前以内完成邮件验证，且资格与会话未被撤销，才可设置；普通密码/短信登录不赋予资格。
- `POST /api/v1/auth/password/setup`：请求 `{ password }`，新密码 12–128 个 Unicode 字符、UTF-8 至多 512 字节。成功 `200 { saved: true }`，同时撤销用户全部会话并清除 Cookie，使此前签发的邮件链接失效；须以新密码重新登录。无有效邮件验证资格（包括未登录）返回 `403 EMAIL_REVERIFICATION_REQUIRED`，密码不合法 `400 INVALID_PASSWORD`，结构不合法 `400 INVALID_REQUEST`，不可用 `503 PASSWORD_AUTH_UNAVAILABLE`；每 IP 最多 5 次/15 分钟。

首次与重置密码共用 setup 合同，GET 的资格只是读取快照，POST 保存时仍复核。密码保存使用随机盐 scrypt；完整算法与存储说明见 [认证设计](AUTHENTICATION.md#邮箱密码登录与设置)。接口存在不证明真实邮件或生产重置已验收。

### `POST /api/v1/auth/login-eligibility`

公开登录预检查，需可信 Origin；每 IP 最多 60 次/10 分钟。请求 `{ method: "email" | "phone", account: string }`，仅接受这两个字段。规范化邮箱或中国大陆手机号后返回 `200 { registered: boolean }`；格式错误返回 `400 INVALID_EMAIL` 或 `400 INVALID_PHONE`，响应禁止缓存。该结果只表示账户是否存在，不表示认证方式已启用、所有权已验证或已登录；不发送邮件或短信、不创建账户。申请 challenge 时仍会再次核对注册状态，不能用预检查代替服务端校验。

### 手机号方式（默认关闭，可配置号码白名单或公开号码访问）

`GET /api/v1/auth/methods` 返回 `{ email: { available: boolean, delivery: "email" | "development" | "disabled" }, phone: { available: boolean, region: "CN" } }`，不公开号码允许名单或密钥。`EMAIL_DELIVERY_MODE=disabled` 时邮箱不可用；手机号需显式启用、配置凭据与号码策略。`PHONE_AUTH_ALLOW_ALL_NUMBERS=true` 支持格式有效的中国大陆号码，默认仍为白名单模式；代码支持不表示当前部署已开放或真实短信已验收。

`POST /api/v1/auth/phone/challenges` 请求 `{ phone, intent, role?, returnTo? }`。`phone` 为中国大陆 11 位手机号或 `+86` 前缀格式；注册必填 `role`。未注册号码以 `intent=login` 请求时，在发送前返回 `409 ACCOUNT_NOT_REGISTERED`，不发送短信、不创建账户。成功 `202` 返回 `{ accepted: true, delivery: "sms", challengeId, expiresInSeconds, resendAfterSeconds }` 并设置浏览器绑定 Cookie，仅表示服务商受理且本地 challenge 已可核验，不保证运营商送达。验证码明文不返回给浏览器。

`POST /api/v1/auth/phone/verify` 请求 `{ challengeId, code }`，验证码必须为六位数字，需同一浏览器绑定。本地 HMAC、尝试次数和有效期检查后再调用 PNVS Check；成功及未知账户响应与邮箱核验相同。未知登录不注册，注册初始身份仅首次注册确定，当前会话身份可另行切换，验证码只能完成一次认证。

错误包括 `SMS_TEST_WINDOW_CLOSED`（403，固定发送窗口结束，但有效验证码仍可核验）、`ACCOUNT_NOT_REGISTERED`（409）、`PHONE_AUTH_UNAVAILABLE`、`PHONE_NOT_ALLOWED`、`INVALID_PHONE`、`INVALID_REQUEST`、`RATE_LIMITED`（带 Retry-After）、`SMS_UNAVAILABLE`、`BROWSER_CONTEXT_REQUIRED`、`INVALID_OR_EXPIRED_CODE`、`SMS_VERIFICATION_UNAVAILABLE`。默认 300 秒有效、60 秒重发、每号码 3 次/小时、每 IP 5 次/小时、全局滚动 24 小时 10 次；失败发送也占额度。路由额外限制发送 10 次/IP/小时、核验 15 次/IP/分钟，具体配置与上线边界见 [认证设计](AUTHENTICATION.md#手机号注册受限联调)。全部认证响应禁止缓存，编码路径也按实际匹配路由执行 Origin 与错误脱敏保护。

### `POST /api/v1/auth/email/challenges`

请求 Magic Link。每 IP 最多 20 次/小时；数据库还按邮箱执行冷却和小时配额。

```json
{
  "email": "person@example.com",
  "intent": "signup",
  "role": "client",
  "returnTo": "/workspace"
}
```

- `intent`：`signup | login`。
- `signup` 必须提供 `role: client | talent`；`login` 的客户端 role 不会改写注册初始身份；当前会话切换使用独立接口。
- `returnTo` 只接受本站路径，非法值或认证循环会规范化为 `/workspace`。
- API 设置短期浏览器绑定 Cookie。成功 `202`：

```json
{
  "accepted": true,
  "delivery": "email",
  "expiresInSeconds": 900,
  "resendAfterSeconds": 60
}
```

`delivery=email` 表示 SMTP 已接受邮件，尚不保证投递到收件箱。仅开发使用的 `EMAIL_DELIVERY_MODE=console` 返回 `delivery=development`：没有发送真实邮件，前端不得显示已发送或引导检查收件箱。响应不包含 token、验证链接或发信凭据。

领域错误：`400 INVALID_REQUEST`、`409 ACCOUNT_NOT_REGISTERED`、`429 RATE_LIMITED`（带 `Retry-After`）、`503 EMAIL_UNAVAILABLE`、`503 EMAIL_AUTH_DISABLED`。未知邮箱登录在申请链接阶段返回账户不存在，不发送邮件或创建账户；邮箱停用时不创建 challenge。

### `POST /api/v1/auth/email/verify`

```json
{ "token": "one-time-token-from-url-fragment" }
```

必须在申请链接的同一浏览器调用。每 IP 最多 30 次/分钟。

验证成功 `200` 并设置会话 Cookie：

```json
{ "authenticated": true, "returnTo": "/workspace" }
```

核验阶段仍保留账户不存在的防御性响应 `200`（正常未注册登录已在申请阶段被拒绝）：

```json
{
  "authenticated": false,
  "reason": "account_not_found",
  "returnTo": "/workspace"
}
```

领域错误：`400 BROWSER_CONTEXT_REQUIRED`、`400 INVALID_OR_EXPIRED_LINK`、`503 EMAIL_AUTH_DISABLED`。token 只能消费一次；邮箱停用时不消费链接或创建会话。

### `GET /api/v1/auth/session`

未登录 `200`：

```json
{ "session": null }
```

已登录 `200`：

```json
{
  "session": {
    "user": {
      "id": "uuid",
      "email": "person@example.com",
      "role": "client",
      "roles": ["client", "talent"],
      "emailVerifiedAt": "2026-09-03T00:00:00.000Z",
      "phone": null,
      "phoneVerifiedAt": null
    },
    "signedInAt": "2026-09-03T00:00:00.000Z",
    "expiresAt": "2026-10-03T00:00:00.000Z",
    "profile": {
      "displayName": "",
      "countryCode": "",
      "contact": "",
      "organization": "",
      "jobTitle": "",
      "professionalTitle": "",
      "bio": "",
      "version": 0,
      "updatedAt": null
    }
  }
}
```

该接口也会预置/刷新浏览器绑定 Cookie。响应禁止缓存。

手机号账户的 `email` / `emailVerifiedAt` 为 `null`，`phone` / `phoneVerifiedAt` 为已验证手机号及时间；邮箱账户的手机号字段可以为 `null`。工作台摘要同时给出真实 `emailVerified` 和 `phoneVerified`。当前不提供身份绑定、换绑或合并。

### `POST /api/v1/auth/role`

必须登录且来自可信 Origin。请求 `{ "role": "client" | "talent" }`，不接受额外字段；成功 `200` 返回与 `GET /api/v1/auth/session` 相同的 `{ session }`。`session.user.roles` 为 `["client", "talent"]`，`session.user.role` 是本次选中的身份。更新当前会话的 `sessions.active_role`，刷新后保持；其他独立会话不变。不会改写 `users.role` 注册初始身份、共用个人资料或另一身份的发现/发布记录。无有效会话返回 `401 AUTH_REQUIRED`；格式错误返回 `400 INVALID_REQUEST`，响应禁止缓存。

### `POST /api/v1/auth/logout`

撤销当前数据库会话并清除 Cookie。无论是否已有会话，成功返回 `204`。

## 个人资料

以下接口必须登录。登录邮箱、手机号和注册初始身份不在资料写入合同中。基本资料按用户共用；当前使用身份通过独立的 `/auth/role` 接口切换。

可选 `contact` 由 API 使用 `CONTACT_DATA_KEY` 加密后落库。新写入使用 v2 envelope，其认证附加数据同时绑定 `profile` 数据域、用户记录 ID 和当前 key id，因此密文不能在记录或数据域之间置换。只有资料所有者通过当前会话读取时由 API 解密；日志不得记录其明文。004 迁移前的历史明文和使用旧固定 AAD 的 v1 envelope 只作兼容读取；用户下次保存会写成 v2，离线轮换工具也能解密旧明文/v1，并在轮换成功提交后将所有非空资料联系值统一为 v2。

### `GET /api/v1/me/profile`

成功 `200`：`{ "profile": <与 session.profile 相同结构> }`。

### `PUT /api/v1/me/profile`

所有字段和客户端最后读取的 `version` 都必填；不使用的可编辑字段传空字符串。浏览器的未保存草稿仅缓存修改字段；恢复时与服务端最新其余字段合并，API 仍提交完整资料并校验 version，不是新增 PATCH 合同。冲突时读取最新资料、保留本次修改字段，待用户重新确认后保存，不自动覆盖。

```json
{
  "displayName": "示例姓名",
  "countryCode": "CN",
  "contact": "",
  "organization": "示例组织",
  "jobTitle": "负责人",
  "professionalTitle": "",
  "bio": "",
  "version": 0
}
```

`countryCode` 为空或两个大写字母。成功 `200` 返回递增版本的 profile。`displayName` 为空返回 `400 DISPLAY_NAME_REQUIRED`。若其他标签页先保存，返回：

```json
{
  "error": {
    "code": "PROFILE_VERSION_CONFLICT",
    "message": "资料已在其他页面更新，请刷新后再试。",
    "currentVersion": 2
  }
}
```

客户端应重新读取并让用户确认，不得无条件覆盖。

## 首页 intake

### `POST /api/v1/discovery/intakes`

公开接口，每 IP 最多 30 次/小时：

```json
{ "prompt": "描述一个真实问题，最多 12000 字符" }
```

成功 `201`：

```json
{
  "intakeId": "uuid",
  "expiresAt": "2026-09-03T01:00:00.000Z"
}
```

正文保存在 PostgreSQL，URL 只携带 `intakeId`。intake 有效 60 分钟并绑定创建它的浏览器；同一浏览器再次创建时，上一份未领取草稿会保留审计记录但立即失效。

### `POST /api/v1/me/discovery/intakes/:intakeId/claim`

必须登录且只允许 `client`。成功 `200` 返回 `{ "prompt": "..." }`。人才账户返回 `403 INTAKE_ROLE_FORBIDDEN`；过期、已领取、跨浏览器或不存在统一返回 `404 INTAKE_NOT_FOUND`，避免暴露记录状态。

## 发现对话

所有发现接口必须登录。类型由服务端当前会话身份决定：

| 服务端当前身份 | 发现类型 | Web 入口 |
|---|---|---|
| `client` | `problem` | `/talent` |
| `talent` | `capability` | `/projects` |

每个账户都可使用两种身份；先调用 `/auth/role` 切换，再读取对应流程，不能仅凭发现参数越过当前会话身份。数据按账户与 `kind` 分离，两种流程互不覆盖。

### `GET /api/v1/me/discovery`

返回当前活跃会话；没有记录时 `threadId`、`artifact` 为 `null`，`turns` 为空。

```json
{
  "discovery": {
    "threadId": "uuid",
    "version": 1,
    "kind": "problem",
    "turns": [
      {
        "id": "uuid",
        "requestId": "uuid",
        "question": "用户输入",
        "answer": "服务端建议",
        "attachments": [
          { "name": "brief.txt", "mediaType": "text/plain", "size": 1200 }
        ],
        "createdAt": "2026-09-03T00:00:00.000Z"
      }
    ],
    "artifact": {
      "id": "uuid",
      "kind": "problem",
      "draft": { "kind": "problem_brief" },
      "version": 1,
      "updatedAt": "2026-09-03T00:00:00.000Z"
    }
  }
}
```

`draft` 的具体字段由类型决定：问题发现为 `problem_brief`，能力发现为 `capability_identity`。保留旧展示字段，`flow` 包含：`schemaVersion:2`、`status:collecting|ready|confirmed`、`stage`、`fields`、`missingFields`、`nextQuestion`、`confirmedAt`。字段值包含 `value`、`status:provided|inferred|skipped` 和 `evidence:[{sourceId,quote}]`。当前提示版本为 `duduhire.discovery.v2.1`，不改变 JSON 的 `schemaVersion:2`。`version` 是会话 CAS 版本，无会话为 0；它不同于草稿版本。旧草稿读取兼容，但没有确认状态时不能算完成。完整语义见 [AI 流程](AI_FLOWS.md)。

需求的必要字段为 `context/work/outcome`，能力的必要字段为 `situation/role/actions/outcome`。一段输入可以同时更新多个字段；必要字段均为 `provided` 后立即进入 `ready`，`stage=review`、`nextQuestion=""`，不等待全部可选项填写。只有明确确认才进入 `confirmed`；主动“继续完善”可回到可选提问，直接修改事实会撤销旧确认。`inferred` 与 `skipped` 不满足必要事实。

### `POST /api/v1/me/discovery/turns`

每 IP 最多 30 次/小时；不再设固定对话轮数上限，模型上下文仍有界。

```json
{
  "requestId": "uuid-generated-once-per-send",
  "expectedThreadId": "uuid-of-current-thread-or-null",
  "expectedVersion": 1,
  "prompt": "最多 12000 字符",
  "attachments": [
    {
      "name": "brief.txt",
      "contentType": "text/plain",
      "sizeBytes": 1200,
      "textExcerpt": "浏览器提取的有限文字，最多 8000 字符"
    }
  ]
}
```

- 最多 5 个附件条目；`sizeBytes` 上限 10 MiB 只是客户端原文件的元数据限制，不表示服务器上传了 10 MiB 文件。
- API 不接收二进制。仅把文件名、MIME、大小保存为附件元数据，把非空 `textExcerpt` 合并后最多取 12000 字符作为本轮分析上下文。
- 一次逻辑发送在网络超时或结果不确定后重试时，必须复用原 `requestId`；只有用户改变提交内容、成功收到响应或明确新建对话后，才为下一次逻辑发送生成新 ID。当前 Web 客户端会按“输入 + 附件摘要”指纹保留失败请求的 `requestId`。
- 数据库以 `(thread_id, request_id)` 去重；已成功落库后的重复请求返回当前持久化状态，不追加第二轮。并发重试仍可能在去重前触发重复的上游推理调用，因此客户端不得主动并发发送同一操作。
- API 在调用 AI 前记录当前活跃 thread ID 与版本。若推理期间其他页面重置了对话或写入了新轮次，旧响应不会落库，而是返回 `409 DISCOVERY_STATE_CONFLICT`。客户端应先重新读取服务端状态，再让用户确认是否重试。
- `expectedThreadId` / `expectedVersion` 必须成对提供，首次发送使用 `null` / `0`。普通消息为兼容旧客户端可省略，但“确认保存当前版本”等明确确认命令必须提供版本；缺失返回 `409 DISCOVERY_VERSION_REQUIRED`。版本已过期时，在调用模型之前返回 `409 DISCOVERY_STATE_CONFLICT`，用户需先阅读最新内容。
- 确认命令不能同时附带新材料，否则返回 `400 CONFIRMATION_HAS_ATTACHMENTS`；先处理材料和审阅更新后的草稿，再单独确认，避免跳过未读内容。
- 成功 `200` 返回与 GET 相同的完整 discovery 状态。AI 不可用/超时/输出不合法返回 `503 AI_UNAVAILABLE`；并发状态变化返回 `409 DISCOVERY_STATE_CONFLICT`；角色仓储校验失败返回 `403 DISCOVERY_KIND_FORBIDDEN`。

默认适配器把当前问题、已收集字段、有界用户/附件来源及相关领域方法提示发送给 Qwen，使用 JSON mode。服务端验证结构和逐字引用，并用有效引用的原句生成每个 `provided.value`；模型扩写的工具、职责、指标和硬条件不能直接写成事实。模型生成的原 `provided.value` 和 `summary.value` 不用于结果，数字改写或长篇扩写会被丢弃，不导致有效原句整轮失败；建议标题过长或数字无据时省略该标题。非连续引用仅在每个完整片段都逐字存在于同一来源时拆成独立证据，不做模糊匹配。`n8n`、`B2B` 等标识符中的数字不作为业绩指标。知识库仅帮助归类和提问，不是用户事实来源；无来源或虚构引用仍拒绝。

模型不能输出确认状态。明确确认、查看草稿、跳过和继续完善命令由流程引擎执行，无需模型调用；快捷按钮使用同一接口和版本规则。仍含 `【示例输入，请替换为真实情况】` 等明确示例标记时，不调用模型、不更新事实，保留旧草稿并提示改为实际情况。该提示会作为正常对话响应返回，不是已确认经历。数据库另外保存 provider、model、prompt version 和分析上下文用于追溯；内部供应商请求细节不返回前端。

### `POST /api/v1/me/discovery/reset`

把当前活跃会话标为归档，并返回同类型空状态。可传 `{expectedThreadId,expectedVersion}`，在事务内检查版本，避免旧页面归档新内容；无 body 兼容旧客户端。成功 `200`；没有活跃会话也幂等成功。不会立即删除旧内容，归档记录按 owner-only `data_retention_policy` 中的保留期清理。

## 工作台

### `GET /api/v1/me/workspace`

必须登录，按当前会话身份汇总其对应发现进度。成功 `200`：

```json
{
  "role": "client",
  "emailVerified": true,
  "phoneVerified": false,
  "discoveryKind": "problem",
  "discoveryCompleted": true,
  "activeThreadId": "uuid",
  "turnCount": 1,
  "artifactVersion": 1,
  "updatedAt": "2026-09-03T00:00:00.000Z",
  "paymentAccountStatus": "not_configured"
}
```

`discoveryCompleted` 仅在当前活跃草稿 `flow.status=confirmed` 且有确认时间时为真；必要信息不足、未确认、修改后待确认均为假。不表示匹配、身份或证据已验证。`paymentAccountStatus` 当前永远是 `not_configured`，因为没有接入支付服务。

## 双向匹配

以下接口均要求当前已验证账户会话；`client → problem`、`talent → capability` 由服务器决定，不接收 `ownerUserId`、接口内角色切换或模型生成的候选人 ID；身份切换使用 `/auth/role`，每个账户可分别保留两种类型的资料。全部匹配响应（包括错误）设置 `Cache-Control: no-store`。发布、撤回和私密示例预览都要求可信 Origin。

### 展示字段与权限

`MatchingDraft` 和对外资料使用以下字段：

| 字段 | 约束与含义 |
|---|---|
| `title` | 规范化后 2–60 字符；用户预览确认的工作/能力标题 |
| `summary` | 规范化后 10–500 字符；公开摘要 |
| `skills` | 从服务端受控词表中选择 1–8 项，不重复 |
| `requiredSkills` | 最多 8 项，必须是 `skills` 子集；仅需求方可非空，匹配时全部满足才返回 |
| `workMode` | `any` 可协商、`remote` 远程、`onsite` 现场、`hybrid` 混合办公 |
| `engagement` | `any` 可协商、`project` 项目合作、`part_time` 兼职、`full_time` 全职 |
| `location` | 最多 60 字符，现场/混合办公必填；只填一个城市，不接受多个地点分隔列表 |
| `notes` | 最多 200 字符；仅供展示，不自动判断相容性 |
| `constraints` | 可省略的结构化合作条件；字段和双向含义见下表 |

`constraints` 可以只提供部分字段；缺失值按空数组、`null` 或空字符串补齐，未知字段拒绝：

| 字段 | 校验与双向含义 |
|---|---|
| `markets` | 最多 8 个不重复、每项 1–40 字符的市场名称；需求方为必须覆盖的市场经验，人才方为本人声明的覆盖范围 |
| `languages` | 同上；需求方为必须使用的工作语言，人才方为本人声明的工作语言能力 |
| `budgetMin` / `budgetMax` | 正数且不超过 1,000,000,000，或 `null`；同时填写时下限不得高于上限。需求方为预算，人才方为报价/期望报酬 |
| `budgetCurrency` | `CNY | USD | EUR | null` |
| `budgetPeriod` | `project | month | hour | null`；项目/月/小时计价 |
| `weeklyHours` | 大于 0 且不超过 168，或 `null`；需求方为最低所需投入，人才方为最多可投入时间 |
| `availableFrom` | 有效 `YYYY-MM-DD` 或空字符串；需求方为最晚可接受开始日，人才方为最早可开始日 |

发布文本会检查常见邮箱、电话、URL、证件/密钥和联系方式标记，命中则拒绝；预览建议会遮盖这些常见模式。这只是辅助防护，不保证匿名化，用户仍必须检查所有公开字段。模型不能代替用户勾选同意。

对外真实 `MatchingListing` 仅含上述展示字段以及 `id`（发布资料 UUID）、`kind`、`version`、`createdAt`、`updatedAt`；不返回账户 ID、邮箱、个人联系方式、原始对话、附件、引用或源线程标识。独立示例另含 `isExample:true`、`contactable:false` 和 `exampleDomain`，其 `id` 是以 `example-` 开头的固定字符串，不是用户或真实发布 ID。当前用户自己的 `OwnedMatchingListing` 另含 `sourceThreadId`、`sourceThreadVersion`、`status:published|withdrawn` 与 `active`。

`status=published` 不一定仍可匹配：只有来源线程仍活跃、当前必要事实已确认，而且线程及草稿版本均与发布快照一致，`active` 才为真。任何新对话版本都会使旧发布暂停，即使是一句普通问答；需要重新读取并预览发布，不自动公开新内容。

### `GET /api/v1/me/matching`

返回当前用户的匹配状态，尚未确认也可读取，不会自动发布或查询对端结果：

```ts
{
  kind: "problem" | "capability";
  source: { threadId: string; version: number; confirmed: boolean } | null;
  listing: OwnedMatchingListing | null;
  suggestion: MatchingDraft;
  suggestionEvidence: Array<{ field: string; value: string; quote: string }>;
  knowledgeSources: Array<{ id: string; title: string; url: string }>;
  skills: string[]; // 当前 34 个受控工作标签
  workModes: Record<"any" | "remote" | "onsite" | "hybrid", string>;
  engagements: Record<"any" | "project" | "part_time" | "full_time", string>;
}
```

`suggestion` 从当前已确认草稿中的 `provided` 字段预填可编辑标题、摘要、技能和能明确识别的合作条件。需求技能来自 `work/outcome`，人才技能来自 `role/actions`；团队背景、否定能力与学习意向不能自动增加个人技能。自然语言可以识别远程与合作方式、目标市场、工作语言、预算的明确金额/币种/计价周期、每周投入和明确开始日期。模糊金额、未知日期和语言加分项不被自动升级为硬条件。

`requiredSkills` 不自动设为必须，仍由需求方选择；`location` 不从经历地点推断。现场/混合办公建议不会自动设为已确认到场安排，须由用户选择方式并填城市。未确认时返回空建议。所有建议均可修改或删除，预填不代表发布同意。

`suggestionEvidence` 仅向本人提供建议所依据的原句（经过常见敏感文本遮盖、每条最多 160 字符）；字段可能为 `skills`、`workMode`、`engagement` 或 `constraints.<key>`。`knowledgeSources` 是相关方法来源，不是个人能力证明，也不随真实候选结果公开。

### `PUT /api/v1/me/matching/listing`

每 IP 最多 60 次/小时。第一次发布与更新共用此接口；除 `constraints` 可选外，下列顶层字段全部必填：

```json
{
  "expectedThreadId": "uuid-of-current-confirmed-thread",
  "expectedVersion": 2,
  "expectedListingVersion": 0,
  "consent": true,
  "title": "内部知识资料整理与问答项目",
  "summary": "整理已批准的制度资料，建立便于同事查找的知识分类，并验证常见问题是否容易找到答案。",
  "skills": ["知识库", "智能问答"],
  "requiredSkills": ["知识库"],
  "workMode": "remote",
  "engagement": "project",
  "location": "",
  "notes": "具体交付材料需另行确认。",
  "constraints": {
    "markets": [],
    "languages": ["中文"],
    "budgetMin": 30000,
    "budgetMax": 50000,
    "budgetCurrency": "CNY",
    "budgetPeriod": "project",
    "weeklyHours": 20,
    "availableFrom": "2026-10-01"
  }
}
```

- `expectedThreadId` 必须为当前线程 UUID，`expectedVersion` 为 GET 返回的来源版本；两者在写入事务内再次校验。来源未确认或在预览后变化，返回 `409 MATCHING_VERSION_CONFLICT`。
- `expectedListingVersion` 第一次为 `0`，更新为最后读取的发布资料版本。其他页面先发布/更新/撤回时，旧版本返回 `409 MATCHING_VERSION_CONFLICT`。
- `consent` 必须严格为 `true`；浏览器恢复匹配预览时只恢复文字和来源/发布版本，不恢复 consent，也不解除过期版本保护。没有勾选同意或未知字段在 JSON Schema 层拒绝。每个账户同一类型最多一份记录；发布绑定源线程及草稿版本并记录同意时间。
- 成功 `200 { "listing": OwnedMatchingListing }`；版本递增，`status=published`、`active=true`。格式错误返回 `400 INVALID_REQUEST`，内容/标签/条件校验失败返回 `400 INVALID_MATCHING_LISTING`。
- 该接口没有 `requestId`。结果不确定时先读取 GET 核实是否已发布；不要把版本冲突当作可以自动改用新版本重试的许可，也不要自动重新勾选同意。CAS 阻止重复覆盖，不保证同一过期写入重复返回成功。

### `POST /api/v1/me/matching/preview`

每 IP 最多 120 次/小时。先确认当前发现内容，再用尚未发布、可继续修改的草稿私密比较示例；不需要 `consent`、发布版本或真实发布记录：

```ts
{ draft: MatchingDraft }
```

`draft` 使用发布资料相同的字段白名单和内容校验；顶层只接受 `draft`。成功 `200`：

```ts
{
  matches: MatchingResult[]; // 与真实结果相同的解释结构，listing 必为虚构示例
  total: number;
  catalogLimited: false;
  algorithm: "evidence-skills-v2";
  catalog: "examples";
  catalogStatus: "ready" | "empty";
  exampleCount: number;
  notice: string;
}
```

接口只读取独立 `matching_examples` 表，校验每条记录 `isExample=true`、`contactable=false` 且 ID 以 `example-` 开头；不读取真实发布作为示例、不创建发布记录、不保留本次预览草稿。开发 seed 定义 22 条（11 条需求与 11 条人才），实际数据库数量取决于导入批次。接口按当前会话身份仅比较对侧，按 ID 最多读取 100 条；`exampleCount` 为本次实际读取的对侧示例数，`total` 为硬条件筛选后符合的数量。

示例未导入时返回 `catalogStatus="empty"`、`exampleCount=0` 和明确提示；有示例但无符合项时 `catalogStatus="ready"`、`matches=[]`。两种情况都不放宽硬条件、不伪造真实候选。示例没有联系人，不能用于联系或建立真实合作。

来源未确认返回 `409 MATCHING_NOT_CONFIRMED`；草稿不合法返回 `400 INVALID_MATCHING_LISTING` 或 Schema 层 `400 INVALID_REQUEST`。此接口没有发布所需的 CAS 版本和公开同意语义：预览结果不是当前版本已经发布的凭证，真实匹配仍需单独调用发布接口。

### `POST /api/v1/me/matching/withdraw`

每 IP 最多 60 次/小时：

```json
{ "expectedListingId": "uuid-of-current-listing", "expectedListingVersion": 1 }
```

`expectedListingId` 与 `expectedListingVersion` 均必填，在事务锁内同时比较，避免旧页面在账户或发布记录变化后误撤回另一份同版本资料。没有记录时仅允许 `null` / `0`；已有记录必须传其 UUID 和当前版本。

成功 `200 { "listing": OwnedMatchingListing | null }`。已有发布变为 `withdrawn`、`active=false` 并递增版本，后续结果查询不再返回；没有记录且期望 ID/版本为 `null` / `0` 时返回 `null`。已撤回记录以其当前 ID/版本重复撤回时幂等成功；使用首次撤回前的旧版本或不同 ID 重试仍返回 `409 MATCHING_VERSION_CONFLICT`，应先 GET 核实状态。

撤回不删除用户、对话或发布记录，也不会撤销他人已阅读/保存的内容。归档发现线程被保留期清理时关联发布随外键级联删除。

### `GET /api/v1/me/matching/results`

每 IP 最多 120 次/小时。当前用户也必须有有效的主动发布记录；没有、已撤回或来源版本过期时返回 `409 MATCHING_NOT_PUBLISHED`。只读取当前仍有效的对端发布，排除本人和同类型记录。

```ts
{
  matches: Array<{
    listing: MatchingListing;
    sharedSkills: string[];
    missingSkills: string[];
    reasons: string[];
    gaps: string[];
    readiness: "needs_confirmation" | "conditions_aligned";
    followUpQuestions: string[]; // 最多 3 条，供后续人工核实
  }>;
  total: number;
  catalogLimited: boolean;
  algorithm: "evidence-skills-v2";
  catalog: "published";
}
```

数据库先取最多 500 份有共同标签的有效对端资料，再执行项目必需标签、明确合作方式、办公方式和现场地点过滤。另按以下结构化条件排除明确冲突，硬条件不能被其他相关标签或排序加分抵消：

- 需求方填了市场经验或工作语言，人才也明确填写但不能覆盖全部要求时排除；人才未填写时列入 `gaps` 待核实。使用受控的常见中英文名称别名比较，不把部分字符串、相邻国家或某一国家当作整个区域。
- 预算和报酬在币种、计价周期一致时比较可判断的上下限，明显不相容时排除；金额/币种/周期不全、不同币种或只有无法相互比较的同侧上下限时列为待确认，不自动换汇。
- 人才每周最多可投入时间低于需求最低时间，或人才最早可开始日期晚于需求最晚可接受日期时排除；任一侧未明确时列为待确认。

结果按共同标签数、已知相容条件数降序排列，再按资料 ID 稳定排序，最多返回 20 条；不使用姓名、年龄、性别、国籍或学校加分，无分数、概率或模型推荐身份。

`total` 是本次最多 500 份候选中通过规则的总数，可能大于 `matches.length`，不是全平台总人数。`catalogLimited=true` 表示数据库候选超过批次上限，不能把本批结果或空结果解释为已穷尽全部资料。

城市只做文本规范化比较，不做地图、通勤距离或跨语言地点推断；双方都要求现场/混合办公且城市不同时排除，一方方式可协商时明确列为到场安排待确认。`notes` 仅供展示，不自动判断其全部条款。`missingSkills` 表示公开资料暂未列出的非必需技能，不是认定对方不会；必需技能缺失的条目已被排除。

`readiness=conditions_aligned` 只表示已填写条件没有待确认差距，`needs_confirmation` 表示条件或资料仍有缺口；两者都不能表示经历通过核验。`gaps` 始终提醒用户陈述未经独立验证，`followUpQuestions` 提供案例、本人贡献和条件核对问题，不自动发给任何人。

真实结果只读取 `matching_listings`，没有符合项时返回真实空数组，不读取示例表补位。当前没有候选人联系、消息、短名单、合同或付款接口。

## 企业联系申请

### `POST /api/v1/enterprise/inquiries`

公开接口，可选地关联当前有效会话；每 IP 最多 10 次/小时。

```json
{
  "requestId": "uuid-generated-once-per-submit",
  "method": "phone",
  "contactValue": "+86 138 0000 0000",
  "source": "enterprise_page"
}
```

- `method`：`phone | wechat`；`source`：`home_pricing | pricing_page | enterprise_page`。
- `requestId` 同时是申请主键。网络失败后重试相同的“联系方式 + 联系值 + 来源”时必须复用它，重复提交不会生成第二条申请或第二个 outbox 事件。当前 Web 客户端会在失败后保留该 ID，成功、关闭表单或修改上述内容后才生成新 ID。
- 手机号按允许字符及 6–15 位数字校验；微信号去除首尾 Unicode 空白后必须为 2–32 字符且内部无空白。
- 成功 `202`：`{ "accepted": true }`。无效联系值返回 `400 INVALID_CONTACT`。
- 联系值使用 `CONTACT_DATA_KEY` 做 AES-256-GCM v2 信封加密；AAD 绑定 `enterprise_inquiry` 数据域、申请 ID 和 `CONTACT_DATA_KEY_ID`。数据库另存不可逆 HMAC 与 `encryption_key_id`，outbox payload 不含明文或密文联系值。旧 v1 envelope 仅由离线密钥轮换工具兼容读取；轮换成功提交后所有企业联系密文均为 v2。

`202` 只表示申请已在数据库事务中可靠接收。独立通知 worker 在配置收件邮箱后处理企业咨询 outbox；通知只含咨询 ID、来源和后台链接。它不代表已经完成联系。CRM 同步尚未接入。配置、重试和运营流程见 [运营与通知](OPERATIONS.md)。

## 企业咨询运营后台

复用已验证账户的普通会话。权限完全由服务器 `ADMIN_USER_IDS` 中的已有用户 UUID 白名单决定，默认空；注册请求、用户资料或 `client/talent` 身份不能授予管理权限。所有后台响应（包括错误）均设置 `Cache-Control: no-store`。未登录返回 `401 AUTH_REQUIRED`；非白名单账户访问列表或执行动作返回 `403 ADMIN_REQUIRED`。

### `GET /api/v1/admin/access`

已登录返回 `200 { "authorized": true | false }`，用于显示后台入口。它不会改变权限或会话。

### `GET /api/v1/admin/inquiries`

参数：`status=new|contacted|closed`（默认 `new`）、`limit=1..100`（默认 `20`）、`cursor`（上一页返回的 opaque cursor，首次省略）。按 `createdAt DESC, id DESC` 排序。既有 `spam` 数据不进入这三个列表。

```json
{
  "items": [{
    "id": "uuid", "source": "pricing_page", "contactMethod": "wechat",
    "status": "new", "version": 1,
    "createdAt": "2026-09-05T00:00:00.000Z", "updatedAt": "2026-09-05T00:00:00.000Z",
    "notificationStatus": "pending"
  }],
  "nextCursor": null,
  "counts": { "new": 1, "contacted": 0, "closed": 0 }
}
```

列表不包含用户 ID、邮箱、联系方式、联系值 hash、密文或密钥标识。`counts` 是三个状态各自的当前总数，不受分页限制；并发更新时与列表可能存在短暂时间差。`notificationStatus` 为 `pending | sent | failed`，分别表示等待/退避中、SMTP 已接受、已进入 dead-letter；`sent` 不保证收件箱投递。

### `PATCH /api/v1/admin/inquiries/:id`

```json
{ "status": "contacted", "expectedVersion": 1 }
```

仅接受 `new | contacted | closed`。成功 `200 { "inquiry": { ... } }` 返回更新后同列表结构、递增版本，并在同一事务内记录操作者和前后状态；版本过期返回 `409 INQUIRY_VERSION_CONFLICT`，记录不存在返回 `404 NOT_FOUND`。必须带可信 Origin。

### `POST /api/v1/admin/inquiries/:id/reveal-contact`

```json
{ "reason": "根据客户咨询安排首次业务沟通" }
```

`reason` 去除首尾空白后必须有 5–300 字符；填写业务原因，不要在原因中重复联系方式。每 IP 最多 30 次/小时。必须带可信 Origin。数据库提交 `contact_revealed` 审计后，API 才解密并返回：

```json
{ "contactMethod": "wechat", "contactValue": "requested_contact" }
```

审计记录包括咨询 ID、操作者 ID、动作、原因和时间，不含联系明文或密文。审计失败时不返回联系值。只接受当前 `CONTACT_DATA_KEY_ID` 的 v2 记录；历史 v1 或旧密钥记录应先通过离线密钥轮换升级。浏览器不应将明文联系方式写入 localStorage、日志或分析事件。

## 健康探针

### `GET /api/health/live`

进程可响应时返回 `200 { "status": "ok" }`。不能用它判断数据库可用。

### `GET /api/health/ready`

数据库连接、核心表、咨询审计表/安全列表视图、匹配发布表、独立示例表、手机号 challenge 表、`users.phone_verified_at`、`sessions.active_role` 非空列、`sessions.password_setup_expires_at` 列和 `011_session_active_role.sql` 迁移记录及非空校验和就绪时返回 `200 { "status": "ready" }`；否则返回 5xx。当前迁移历史已到 `011_session_active_role.sql`，发布步骤必须另行核对 001–011 全部迁移和校验和，不能只依赖上述探针。示例表存在不表示已经导入示例数据，空示例库由预览接口另行说明。负载均衡只应把 ready 成功的 API 实例加入流量。

## 明确不存在的 API

当前端点仅覆盖本文件列出的认证、资料、发现、私密示例预览、明确发布后的真实匹配、工作台汇总、企业申请与咨询运营；未实现的业务范围见 [产品事实与范围](PRODUCT.md#5-尚未实现)。营销页面或工作台中的路径说明不代表对应服务已经存在。
