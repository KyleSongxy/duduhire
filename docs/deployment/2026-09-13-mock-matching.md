# 2026-09-13 模拟需求与能力档案

用户明确要求在现有生产数据库 mock 20 个需求、100 个能力档案。使用现有独立 `matching_examples` 表，为私有示例匹配提供数据；不插入用户、正式发布记录、联系方式或验证/同意记录。

## 数据与生成

- 批次：`mock-20260913-20-demands-100-capabilities-v1`。
- 数据：`ops/mock/matching-batch-20260913.json`，SHA-256 `0cb51d6f440831f30af984bee6a98cc3590fe0cb8c51326abbefd5fbaa96289a`。
- 生成脚本：`ops/mock/generate-matching-batch.mjs`；导入脚本：`ops/mock/import-matching-batch.mjs`。现有仅限开发环境的 seed 命令及其保护未修改。
- 10 个 AI 场景和 10 个出海场景，每个需求配 5 类能力：方案设计、工程实施、质量评估、交付协调、持续运营。包含技能、预算、工时、地域/语言、协作方式、到岗时间等差异。
- 120 个 ID 和标题均唯一；所有 draft 使用实际 `validateMatchingDraft` 校验。全部明确标记虚构与 Mock，不包含真实个人信息。

## 生产写入

- 目标为 native-4 当前 ECS 的 `duduhire` 数据库；写入前基线：1 用户、1 正式发布记录、0 示例。
- 通过现有 Workbench root 免密连接；迁移连接使用 `MIGRATION_DATABASE_SSL` 映射至数据库模块的 TLS 参数，保持证书严格校验，未更改生产环境文件。
- 备份：`/var/lib/duduhire-backup/duduhire-20260913T031250567Z-440b0bb31ae6.dump`，67,250 字节，归档列表检查通过，未恢复演练。
- 执行进程 PID 97801；证据 `/root/duduhire-mock-20260913/import.log`、`backup-result.json`、`COMPLETE`。
- 事务已提交，实际 inserted=120，表内 problem=20、capability=100。固定 ID，重复运行只接受内容完全相同的已有记录，不覆盖冲突数据；其他示例行哈希保持不变。
- 在提交前读取数据库内容并运行实际匹配算法，每个需求至少匹配到 3 个能力档案。按应用 `ORDER BY id LIMIT 100` 验证全部批次可读取。
- 本次只变更示例数据，不改应用版本、API/Nginx 配置或认证限额。

## 回滚边界

如用户要求移除这批数据，只删除 `matching_examples` 中 `seed_version='mock-20260913-20-demands-100-capabilities-v1'` 且 ID 属于本地批次清单的记录，在事务内核对数量；不删除正式数据或用户。本轮没有执行删除或数据库恢复。

## 验证边界

模拟数据用于登录用户确认整理结果后的“示例匹配”；不会自动出现在真实可联系人才/需求列表。数据库校验和生产仓储读取不等同于新建用户或完整浏览器登录流程验收。

- 提交后使用生产 runtime 账号与真实 `PostgresRepository.readMatchingExamples` 复核：读取 100 个能力档案，合成需求返回 3 个匹配，全部 `isExample=true / contactable=false`。总数 users=1、matching_listings=1、problem=20、capability=100。
- API 本地 live/ready 均 200，公网 ready 为 ready；API PID 95447、NRestarts=0、active，与数据导入前相同。未执行应用重新部署或重启。
