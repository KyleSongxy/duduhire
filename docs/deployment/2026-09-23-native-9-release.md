# 2026-09-23 native-9 部署验收

状态：已部署。北京时间 2026-09-23 02:02 前切换 native-9，公网、浏览器公开首页与 02:02:26–02:05:26 的服务器稳定性观察通过。AI 长输入仍保留一次失败、一次成功的验证边界。

用户明确授权部署。目标为杭州 ECS `i-bp1dhuuwx8r0zprhvnov`（`115.29.178.65`）及 `https://kylesong.top`，通过已登录阿里云控制台的云助手执行。

## 变更

- 桌面导航相对页面中线居中，921–1100px 收紧右侧操作间距，保留双身份切换及导航显隐。
- 用户消息保存、发送中显示及刷新回读均保留换行、空行、缩进和首尾空白。
- 兼容 Qwen 空 `tool_calls`；提示词明确结构化输出长度与数量上限；增加不包含用户内容或供应商原文的白名单失败分类日志。
- Qwen 请求与完整响应读取的默认及最大等待从 30 秒改为 55 秒，低于现行 Nginx 60 秒与浏览器发现请求 120 秒预算；不自动重试或切换模型。
- 模型响应最多接收 16 条引用，全部逐条验证后才整理为最多 4 条持久证据。需要删减时，仅允许单一本轮来源，按原文顺序保留连续末尾完整语境组；跨源、位置歧义、截选边界交叠或部分语境组均拒绝。`provided.value` 仅由保留原句构成，不再截断可能位于末尾的否定限定。详见 [AI 流程](../AI_FLOWS.md)。
- 依赖清单、锁文件、11 项迁移、权限脚本与实际 native-6 相同；不执行迁移、授权 SQL 或数据导入。运行配置、Qwen 模型与 Nginx 内容不变。
- 差分还包括声明文件、发行元数据和部署说明。实际 native-6 的 `pnvsProvider.js` 与候选对比只有注释、换行变化，SDK 构造表达式未变。

## 冻结产物与来源

- 版本：`duduhire-20260923-native-9`。
- 来源：`main` 的 `0bf415e3ddc45ffe819d98b1b611d68b30020cbd` 加本轮工作区修复，不是该提交的干净构建。
- 111 项输入复制到独立快照后构建，构建及打包前后内容一致；源码清单 SHA-256 `318406252264b2fcffe415454e44b98a03d48d720296c0cd2a12058721ca7358`。
- 完整包：`/tmp/duduhire-native9-candidate-20260923/releases/duduhire-20260923-native-9/duduhire-20260923-native-9.tar.gz`，52,466,752 bytes，SHA-256 `330c151d544fa9b1289e7d298de1583200407e684fa7e032da59f70dd2813f24`。
- 125 项清单（124 个负载文件及 RELEASE.json），SHA-256 `1c7001c6c2d364dd5cf50b5a012f3f4fd070d99c56f3cd731d3e6f5540f2e842`。
- native-6→9 差分：847,955 bytes、16 成员，SHA-256 `925eeedeec250d9ff243843b8a37ccb53b056586e911550cb88c9587ce065231`。使用固定 stored-DEFLATE 的标准 gzip，避免不同 zlib 实现重组出不同字节。
- 传输补丁：20,420 bytes、3 成员（RELEASE.json、SHA256SUMS、discoveryFlow.js），SHA-256 `19dc11b02b544639827f3be9def68ab8a58f9b26bf5ed256b0b0378c9a336173`；其余 13 个差分成员取自已验证的 native-8 差分包。固定重组程序先验证所有输入和成员，再生成全新 native-9 差分并核对最终摘要；没有覆盖 native-8。
- 实际服务器 native-6 基线清单 SHA-256 `8d864431ffa44a1eed5053b3231cebbc95cc5d483e4c7cce9e2f69736bfeba3f`。新发布目录从该基线与最终差分独立重建，旧版目录保留。
- Web 29 个文件与经过浏览器回归的 native-7/8 完全相同，入口为 `index-f232QiAj.js` / `index-C8y1uEN5.css`。API 相对 native-8 仅 discoveryFlow.js 变化，全部 105 个运行文件与冻结快照构建一致。

## 本地验证

- 修复完成后 API lint、build、235 项单元测试通过，其中发现流程 55 项；独立审阅另有 12 项对抗检查通过。
- 此前 `npm run check` 的仓库检查、lint、Web 18 项、API 220 项及构建全部通过；55 秒改动阶段 API 224 项通过，最后引用整理阶段更新为 235 项。Web 源码及产物保持相同，未重复运行无关测试。
- 相关浏览器回归 19 项：格式 2、发现引导 4、恢复与冲突 4、导航布局 3、双身份 6；E2E TypeScript 通过。使用隔离 API、数据库和合成账号。
- 导航覆盖 3 种身份与 1440/1280/1101/1100/921px，共 15 组桌面场景，中线偏差 ≤1px、两侧净距 ≥8px；另验证 390px 菜单及 320/390px 身份流程。
- 多行消息覆盖发送中、数据库保存及刷新后的原文一致，1280/390px 无横向溢出。证据：[格式与恢复](../qa/2026-09-22-discovery-repair/README.md)、[导航布局](../qa/2026-09-23-header-layout/README.md)。
- 全包与差分独立校验、125 项最终清单、16 项依赖/迁移/权限不变检查通过；本地重组差分与最终差分逐字节相同，并验证拒绝覆盖已有输出目录。

## 候选阶段发现的问题

native-7 和 native-8 均只完成候选启动检查，没有切换正式服务；各自目录和私有备份保留，不作为本次回滚基线。

- 生产 native-6 短合成输入：1 次 Qwen 请求，8,144ms、HTTP 200、ready。
- native-7 同一份 3,125 字符、33 行长合成履历：原生 30 秒上限在 30,009ms 超时。
- 仅探针延长等待的诊断：一次 44,055ms 返回 HTTP 200 后被结构校验拒绝；一次 40,428ms 返回且通过来源/结构校验。诊断覆盖了 fetch 信号，不能当成 native-7 原生验收。
- native-8 原生 55 秒：47,930ms 返回 HTTP 200，但 4 个字段的引用数组超限，最多 6 条；另有 1 条引用不直接包含于原文，尚未进入逐句恢复校验，不能称全部引用有效。这促成了 native-9 的有界引用整理及针对性回归。
- 原始摘要与边界见 [AI 诊断记录](../qa/2026-09-23-ai-diagnostics/README.md)。不得把较早 QA 中“未部署”的阶段描述或任何一次成功当作全部线上 AI 请求已恢复的证明。

## 服务器执行与终验

云助手已上传 20,420-byte 补丁与固定重组程序，从经过校验的 native-8 差分中复用 13 个文件，生成全新 native-9 差分；最终 SHA 与离线冻结产物一致，旧归档保持不变。

操作目录 `/root/duduhire-upgrade-native9`，驱动 SHA-256 `72ceb55b62fe25f2730fca901568a44e3af447fa8a9934b78dd193f9ed389d83`。`stage` 返回 0，候选 8789 启动、live/ready、认证拒绝、完整负载与依赖校验通过，退出候选后正式服务仍为 native-6。

本次私有数据库备份为 `/root/duduhire-upgrade-native9/database.before.dump`，94,752 bytes，SHA-256 `67be45d941fd07d418a945f0c522f533d1e923bf79b8ff9160488719c9924af9`。`pg_restore --list` 通过，没有进行恢复演练；原 unit/current/runtime/Nginx 快照保留。

首次原生 55 秒长输入探针在 41,741ms 返回 HTTP 200，但正式流程因 `discovery_unsupported_evidence` 拒绝。外层结构无违规、原始引用最多 6 条、1 条并非直接子串；当前计数尚不能区分不精确引用与安全裁剪规则。该次失败完整保留于 [候选证据](../qa/2026-09-23-ai-diagnostics/native9-candidate-probe.json)，不作为成功验收。

只增加安全原因分类的第二次诊断使用同一冻结正式模块和输入，不覆盖 fetch 截止、不修改校验规则。36,342ms、1 次 Qwen 请求、HTTP 200，正式流程 `ready`、缺失必填项 0；原始及最终引用最多 4 条，所有 `provided.value` 均由保留原句组成、最长 205 字符。九类影子诊断计数均为 0、原函数和插桩函数结果相同。这一次响应本身无失败，因此不能用它解释前一次失败原因，也不能推断长期成功率。两次结果均保留，没有再次调用模型。证据：[第二次诊断](../qa/2026-09-23-ai-diagnostics/native9-evidence-diagnostic.json)。

`activate` 返回 0，`COMPLETE=true`、`ROLLED_BACK=false`、`ROLLBACK_UNVERIFIED=false`。API 与 current 已切换 native-9；生产认证拒绝检查和本机 HTTPS Web 文件摘要通过，运行配置与 Nginx 内容不变，迁移写入、权限 SQL、邮件、短信和账号写入均为 0。

公网 [8 项检查](../qa/2026-09-23-ai-diagnostics/native9-public-checks.jsonl)全通过：HTML、退役 service-worker、主 JS/CSS、管理页 JS/CSS 六项 HTTP 200 且摘要与冻结清单一致；主域与 API 子域 readiness 均为 200/ready。初次本机 Python 验证受失效的 localhost 代理及缺失默认 CA 影响，在收到 HTTP 响应前报 URLError；[初次结果](../qa/2026-09-23-ai-diagnostics/native9-public-checks-initial.jsonl)保留。仅对后续验证进程设置 no_proxy 与系统 `/etc/ssl/cert.pem`，保留 TLS 验证，未修改系统设置或服务器配置。

独立浏览器标签页实际加载 `index-f232QiAj.js`。1280px 访客首页导航中心为 640px，页面宽度 1280px，无横向溢出；[截图](../qa/2026-09-23-ai-diagnostics/native9-production-home.png)与[测量值](../qa/2026-09-23-ai-diagnostics/native9-production-layout.json)已保存。真实账号登录后的身份与原始简历未在本次线上浏览器测试；相关隔离环境回归见前文。

服务器 [稳定性摘要](../qa/2026-09-23-ai-diagnostics/native9-stability-summary.json)通过：北京时间 02:02:26–02:05:26，实际 180.06 秒、19 次采样，失败 0、服务身份变化 0。API PID 149015 与 Nginx PID 17573 均保持不变、NRestarts=0，live/ready 全部 HTTP 200。current 指向 native-9，unit 匹配候选；runtime/Nginx/清单/受监控文件保持不变，125 个负载摘要在观察前后均匹配。日志未截断，结构化 warning/error、journal error、advisor failure reason 和非 JSON 记录均为 0。观察中模型调用与账号修改均为 0；该空闲健康观察不证明真实流量下 AI 成功率。完整服务器记录 `/root/duduhire-upgrade-native9/stability.jsonl`，退出码 0。

## 回滚与验证边界

直接回滚基线是 `duduhire-20260916-native-6`。本次驱动保留原 unit/current/runtime/Nginx 及数据库 dump；只有实际校验成功才记录应用回滚成功。回滚不恢复数据库 dump，不覆盖切换后用户数据；没有进行数据库恢复演练。

本次未发送真实邮件/短信，未使用用户原始履历、创建账号或改变真实密码。合成模型调用只证明该次候选业务解析；来源和结构校验不等于内容真实性核验。真实账号登录后的完整业务流程及实际送达不作为本次已完成验收。
