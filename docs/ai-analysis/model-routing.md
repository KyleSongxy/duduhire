# 国内模型路由与成本基线

更新日期：2026-07-26

## 当前选择

生产只使用国内模型供应商：

| 路径 | 首选模型 | 适用任务 | 官方按量价格 |
| --- | --- | --- | --- |
| 短痛点初次解析 | Qwen3.7 Flash | 低延迟结构提取、基础追问 | 32K 输入以内：输入 ¥0.20 / 百万 Token，输出 ¥0.80 / 百万 Token |
| 能力解析、长文本、二次解析 | Qwen3.7 Plus | 贡献边界、证据结构、完整重写 | 256K 输入以内：输入 ¥2 / 百万 Token，输出 ¥8 / 百万 Token |
| 快速容灾 | DeepSeek V4 Flash | Qwen 失败后的低成本降级 | 缓存未命中输入 ¥1 / 百万 Token，输出 ¥2 / 百万 Token |
| 复杂容灾 | DeepSeek V4 Pro | 复杂能力或二次解析降级 | 缓存未命中输入 ¥3 / 百万 Token，输出 ¥6 / 百万 Token |

Qwen 价格来源：[阿里云百炼模型调用价格](https://help.aliyun.com/zh/model-studio/model-pricing)。

DeepSeek 价格来源：[DeepSeek 模型与价格](https://api-docs.deepseek.com/zh-cn/quick_start/pricing/)。

价格会变化，代码中的成本只用于监控估算，账单以供应商返回的实际 Token 和官方结算为准。

## 路由原则

- `balanced`（默认）：短痛点初次解析优先 Qwen Flash；能力解析、长文本和追问后的统一重写优先 Qwen Plus；失败后切换对应 DeepSeek，再尝试同供应商另一档。
- `cost`：所有流程先尝试 Qwen Flash，再尝试 DeepSeek，最后使用 Qwen Plus。
- `quality`：所有流程先尝试 Qwen Plus，再尝试 DeepSeek 和 Qwen Flash。
- 单模型连续失败三次后熔断五分钟；每次尝试都会记录模型、状态、延迟、Token、估算成本、失败原因和路由原因。
- 当前默认规则是基于任务复杂度与官方价格的保守策略，不是最终质量结论。只有 100 条黄金集完成双人标注 / 仲裁并跑完同集对比后，才允许把某模型标记为质量优胜。

## 发布门槛

- Schema 成功率不低于 99.5%；
- 高风险错误为 0；
- 原文引用忠实率不低于 98%；
- Top-3 匹配召回率不低于 85%；
- 单次平均模型成本不高于 ¥0.05；
- 任一模型或提示词升级必须使用同一黄金集回归。
