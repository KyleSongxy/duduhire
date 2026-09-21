# 2026-09-21 清理与 GitHub 同步

## 本次清理

- 删除 API 内无引用的 `ProblemBriefArtifact`、`CapabilityIdentityArtifact` 和 `MatchingState` 类型，共 14 行；不修改请求与响应。
- 删除工作台旧空态的 13 个无引用 CSS 规则及空媒体块，共 92 行；现役页面布局和资源保持原样。
- 退役 cinematic V3–V7 工具目录。先将现役产品影片制作仍需的首页截图和探针纹理迁入当前工具，校验 SHA-256 相同，再移出旧工具、历史素材和生成缓存；制作脚本与素材清单改用新路径。
- 移出生成的 Playwright 报告、trace/test-results、Python 字节码缓存和无引用的 Blender `.blend1` 备份。保留人工 QA 结论、有效截图、现役影片、打包工程与数据库迁移。
- 将固定 native-3 指纹的校验脚本及当时浏览器清单移入 `ops/native/archive/native-3/`，避免当作当前验收入口。
- 更新核心文档中迁移版本、密码登录、公开短信配置、示例数量和部署记录口径；修复历史 AI 流程文档归档后的相对链接。
- 统一 8 份文档、历史测试记录和 CSV 的行尾格式，保留记录内容与指标数值。

共移出 **1,493 个文件、353,579,625 字节（约 337.2 MiB）**。备份仍占用本机磁盘，这一数字表示工作区缩减。

## 恢复

备份目录：`/Users/xiangyusong/.local/share/duduhire/cleanup/20260921-212330`。`manifest.json` 记录每个移出文件的原路径、大小和 SHA-256；`removed/` 保留原目录结构，`originals/` 保存清理前的三个源码文件。恢复时逐项复制并核对，不覆盖后续修改。

## GitHub 同步范围

目标为现有仓库 `KyleSongxy/duduhire`。本地原先没有 Git 提交或 remote，远端 `main` 是旧版；以远端历史为父提交，使用 `codex/` 分支提交当前源码、必要运行资源和维护文档，并通过 PR 提供完整差异。旧版源码保留在 Git 历史。

`output/` 中的会议原件与用户交付物只在本机保留；依赖、构建缓存、浏览器 trace、环境配置和 Blender 自动备份不进入提交。此操作同步 GitHub，不部署生产站点，也不触发手动镜像发布流程。

## 验证

- `npm run check`：通过，包含 18 项 Web 测试、204 项 API 测试以及 lint、构建和仓库引用检查。
- `npm audit --omit=dev --audit-level=high`：通过，0 个生产依赖漏洞。
- 从 Git 暂存区导出的独立快照通过 88 个本地文档链接、25 个静态资源引用检查；`git diff --cached --check` 通过。
- `bash ops/test-operations.sh`：通过，覆盖操作确认、发布/回滚与不安全恢复路径保护。
- 影片制作脚本通过 Python 语法解析；迁移的两个素材 SHA-256 与原文件一致。未重新渲染影片。
- Git 暂存内容检查排除本地环境配置、会议原件、依赖和生成缓存；未发现凭据特征或超过 GitHub 单文件限制的文件。

同步分支：[codex/cleanup-sync-20260921](https://github.com/KyleSongxy/duduhire/tree/codex/cleanup-sync-20260921)。提交和 PR 记录以 GitHub 为准；生产环境未在本次清理中变更或验收。

## 合并前的测试修复

GitHub 首次完整 CI 的浏览器阶段暴露测试隔离问题：所有用例共享 loopback IP，超过生产邮件接口每小时 20 次的限制后出现 429。E2E 支撑层现为每个用例分配固定虚拟 IP，仅隔离测试 API 信任本机代理；同一用例内部仍保留真实限流和邮箱冷却。真实路由验证确认同 IP 前 20 次返回 202，第 21 次返回 429，另一 IP 可正常申请。另将短信注册测试的旧邮件停用提示断言更新为当前短信验证提示，保留禁止请求邮件接口及完成短信注册的检查。

本地完整浏览器验收 66/66 通过（隔离 PostgreSQL、捕获邮件和模拟短信）；Web/API lint、E2E TypeScript 检查、API 构建及 11 项 PNVS provider 测试通过。PNVS CommonJS 导入增加显式类型以兼容 E2E Bundler 检查，转译后的运行 JavaScript 与修改前相同。GitHub 完整 CI 结果见 PR，不将本地结果视为生产验收。
