# DuduHire

DuduHire 面向有真实问题的需求方与用真实经历证明价值的专业人才。React Web 与 Fastify API 可独立构建，PostgreSQL 保存邮箱/手机号账户、会话、个人资料、发现对话、结构化草稿、主动发布的匹配资料和企业联系申请。

发现建议默认由服务端调用 Qwen API；离线开发和测试可显式使用本地流程演练，已有 OpenAI 配置保留可选兼容。当前可用范围是“账户 + 发现 + 明确发布后的双向匹配 + 企业线索”。匹配比较本站用户确认发布的工作标签与合作条件，不生成虚构人才或代替录用决定；支付、站内联系、文件托管和项目协作尚未实现。功能边界以 [产品事实与范围](docs/PRODUCT.md) 为准。

## 项目结构

```text
apps/web/                    React 19 + Vite 前端
apps/api/                    Fastify API、认证、资料、发现、匹配、联系申请和 AI 适配器
apps/api/migrations/         PostgreSQL 迁移
docs/                        架构、认证、安全、部署与运维文档
tools/                       品牌影片可再生成工具
.github/workflows/ci.yml     前后端检查和迁移验证
ops/                         发布/回滚、加密备份、探针和后台任务示例
compose.yaml                 PostgreSQL、Mailpit、API 与 Web 本地开发环境
compose.production.yaml      使用已发布镜像的单机生产参考编排
deployment.env.example       不含真实密钥的生产变量清单
```

## 技术要求

- Node.js 22.13 或更高版本
- PostgreSQL 14 或更高版本
- 启用邮箱认证时需要支持 TLS 的 SMTP；本地可使用 Mailpit。纯手机号运行可显式关闭邮箱认证。
- 阿里云百炼业务空间的 Qwen API 密钥与对应地域端点；默认模型 `qwen3.8-max`
- 生产环境必须使用 HTTPS

## 本地启动

安装依赖：

```bash
npm install
cp apps/api/.env.example apps/api/.env
cp apps/web/.env.example apps/web/.env
```

创建本地 PostgreSQL 数据库，在 `apps/api/.env` 中配置对应的 `DATABASE_URL` 与随机认证密钥：

```bash
openssl rand -hex 32
```

将输出写入 `AUTH_TOKEN_SECRET`。确认 PostgreSQL 已启动，再执行：

```bash
npm run db:migrate
npm run dev
```

默认地址：

- Web：`http://localhost:5173`
- API：`http://localhost:8787`
- Vite 将同源 `/api` 请求代理到 API。浏览器地址须与 `WEB_ORIGIN` 一致；若改用 `127.0.0.1`，也应同步修改该变量。

开发环境使用 `EMAIL_DELIVERY_MODE=console` 时，验证链接只写入 API 日志。AI 默认使用 `AI_MODE=qwen`，需在 API 服务端配置 `QWEN_API_KEY`（或 `DASHSCOPE_API_KEY`）；默认模型 `qwen3.8-max`，地域由 `QWEN_BASE_URL` 指定。项目位于 Dropbox 等同步目录时，不要把真实密钥写入项目 `.env`：本机密钥放在非同步的 `~/.config/duduhire/qwen.env`，目录权限 `700`、文件权限 `600`，通过显式本地加载模式读取；普通生产 `start` 不自动读取个人文件。没有密钥时会明确报配置错误，不会自动使用规则回复。离线开发和测试可显式设置 `AI_MODE=local`。生产配置拒绝控制台邮件和本地规则；启用邮箱认证时须配置认证 SMTP，也可显式关闭邮箱认证。生产须配置真实 Qwen（或显式选择 OpenAI）及独立联系信息加密密钥。配置方式见 [部署指南](docs/DEPLOYMENT.md#qwen-api-接入)。

如果本机已安装 Docker，也可运行：

```bash
AUTH_TOKEN_SECRET="$(openssl rand -hex 32)" docker compose up --build
```

然后访问 `http://localhost:8080`；测试邮件位于 `http://localhost:8025`。

## 常用命令

| 命令 | 作用 |
|---|---|
| `npm run dev` | 同时启动 API 与 Web |
| `npm run dev:api` | 仅启动 API |
| `npm run dev:web` | 仅启动 Web |
| `npm run db:migrate` | 按顺序执行 PostgreSQL 迁移，可重复运行 |
| `npm run db:migrate:compiled` | 在构建产物或运行镜像中执行迁移 |
| `npm run data:cleanup` | 以 maintenance 连接执行 owner 控制的无参数保留期清理 |
| `npm run auth:cleanup` | `data:cleanup` 的兼容别名 |
| `npm run contact-key:rotate` | 默认 dry-run 的联系方式数据密钥轮换；生产流程见部署指南 |
| `npm run lint` | 检查两个工作区 |
| `npm test` | 运行 Web 与 API 单元/路由测试 |
| `npm run check:repository` | 检查核心文档本地链接与页面静态资源引用 |
| `RUN_POSTGRES_TESTS=true TEST_DATABASE_URL=... npm run test:integration` | 仅在专用 `*_test`/`*_validation` 库运行真实 PostgreSQL 集成测试 |
| `npm run build` | 构建两个工作区 |
| `npm run check` | 依次检查仓库引用、lint、test 和 build |
| `npm run test:e2e` | 在隔离 PostgreSQL 与 Chromium 中运行浏览器回归 |
| `RUN_QWEN_SMOKE=true npm run test:qwen` | 配好服务端密钥后，用合成案例执行最多 4 次真实 Qwen 请求，可能产生费用 |
| `npm run start:api` | 启动已构建的 API |
| `npm run preview:web` | 预览已构建的 Web |

## 核心流程

登录页默认使用邮箱密码；`?method=email` 保留邮件链接，`?method=phone` 保留短信入口。首次设置或重置密码须先在当前浏览器完成邮件验证，并在 15 分钟资格期内保存；保存后退出全部会话、旧邮件链接失效，再用新密码登录。密码设置页为 `/account/password`，具体安全与限流规则见 [账户认证](docs/AUTHENTICATION.md#邮箱密码登录与设置)。此流程仍需真实邮件送达验收。

邮箱方式申请后，用户须在同一浏览器打开15分钟有效的 Magic Link。API 验证所有权后创建服务端会话；注册时保留初始身份；每个账户均可在需求方和专业人才之间切换当前会话身份，工作台的邮箱验证状态来自数据库。

手机号方式已实现 PNVS 验证码与独立身份；默认关闭，启用后默认限指定号码，显式 `PHONE_AUTH_ALLOW_ALL_NUMBERS=true` 支持大陆号码公开访问。不会生成虚构邮箱或自动合并账户。额度、窗口和真实送达边界见 [账户认证](docs/AUTHENTICATION.md)。已有部署记录不代表本次重新验证线上服务。

需求方通过 `/talent` 梳理问题，专业人才通过 `/projects` 构建能力身份卡；两端在 `/workspace` 查看进度，在 `/workspace?tab=profile` 编辑资料。发现对话、草稿和企业申请均由服务端保存。原始附件二进制不上传，只提交有限文字摘录与元数据。

确认发现结果后，可在原页面预览并明确同意发布匹配摘要，随后查看相关人才或项目。Qwen 负责发现对话；匹配使用服务端受控标签与条件规则，不额外调用模型或暴露对话、附件、邮箱及联系方式。退出匹配或继续对话产生新版本后，旧发布不再进入后续匹配查询；新版本须重新预览发布。真实市场为空时显示空结果；另有用户主动选择的私密示例预览，读取独立示例表并明确标记不可联系，不自动填充真实结果。完整边界见 [AI 与匹配流程](docs/AI_FLOWS.md#5-确认之后双向匹配)。

企业申请入库会同时生成 outbox 事件；独立 worker 可向显式配置的运营邮箱发送不含联系方式的通知，管理员在授权后台跟进。正式启用需配置运营账号、独立数据库权限、真实收件邮箱与负责人。完整数据流见 [技术架构](docs/ARCHITECTURE.md)，接口见 [API 契约](docs/API.md)。

## 正式部署

仓库最近的部署记录为 [2026-09-16 native-6](docs/deployment/2026-09-16-native-6-release.md)，包含密码认证和会话身份切换。当日公网、公开页面与稳定性检查通过，但未重测真实邮件/短信送达和真实账号完整登录；历史记录不代表本次已重新检查线上状态。

推荐让浏览器始终访问同一站点：

```text
https://duduhire.com/       → Web 静态资源
https://duduhire.com/api/   → Fastify API
```

部署前必须配置 PostgreSQL 备份、启用邮件所需的 SMTP 域名与 SPF/DKIM/DMARC、Qwen 业务空间限额、HTTPS、生产密钥、监控、日志留存和企业联系申请处理责任人。GitHub Pages 只能托管静态 Web，不能承载本项目的 API、数据库、邮件或服务端 AI。

仓库提供不含秘密值的 `deployment.env.example` 和单机参考编排。把变量注入 Secret Manager 后可先检查配置：

```bash
docker compose --env-file .env.production -f compose.production.yaml config --quiet
docker compose --env-file .env.production -f compose.production.yaml --profile release run --rm migrate
# 应用 docs/DATABASE_ROLES.md 的迁移后授权，再启动服务。
docker compose --env-file .env.production -f compose.production.yaml up -d api web
```

迁移后必须先应用最小权限授权，再让新 API 接流量；完整、可回滚的顺序见部署指南。生产镜像应使用不可变 tag 或 digest，不要直接使用浮动的 `latest`。

仓库提供手动触发的镜像发布工作流和显式确认的部署/回滚脚本。脚本只更新镜像，不自动逆转数据库；失败会恢复已记录的兼容版本或停止 API/Web。配置与执行方式见 [运维脚本](ops/README.md)。这些文件尚不代表外部服务已配置或站点已发布。

## 文档导航

完整入口、维护分工、历史证据和会议需求见 [文档索引](docs/README.md)。当前原生发行流程见 [原生部署](docs/NATIVE_DEPLOYMENT.md)，容器部署保留为另一种部署方式。


| 文档 | 内容 |
|---|---|
| [产品事实与范围](docs/PRODUCT.md) | 已实现功能、限制、术语与上线前需确认的产品问题 |
| [技术架构](docs/ARCHITECTURE.md) | 应用结构、数据模型、路由与状态来源 |
| [API 契约](docs/API.md) | 请求、响应、错误、版本与幂等约定 |
| [AI 交互流程](docs/AI_FLOWS.md) | 两端采集、确认、发布/退出匹配、来源与异常恢复 |
| [账户认证](docs/AUTHENTICATION.md) | 邮箱密码/Magic Link、手机号 PNVS、会话、浏览器绑定与会话身份切换 |
| [部署指南](docs/DEPLOYMENT.md) | 环境配置、发布、备份、回滚和密钥轮换 |
| [数据库角色](docs/DATABASE_ROLES.md) | 迁移、运行、维护与临时轮换权限 |
| [安全基线](docs/SECURITY.md) | 已有控制与尚未覆盖的风险 |
| [运行手册](docs/RUNBOOK.md) | 日常维护、监控和故障处理 |
| [企业咨询运营](docs/OPERATIONS.md) | 管理员授权、联系信息访问审计与独立通知 worker |
| [自动化验证](docs/TESTING.md) | 浏览器回归、临时数据库与测试边界 |
| [运维脚本](ops/README.md) | 确认式发布/回滚、备份恢复验收与 systemd 示例 |

接口、迁移和命令以代码为准；产品范围以 PRODUCT 为准。行为变更时同步更新对应文档，避免在多处重复维护同一合同。
