# Prompt 产品目标与实验假设

状态：实验基线，目标已锁定

## 目标

MAS Chat 的最终 prompt 要复刻网页端的通用 assistant 体验，核心不是让模型像一个更严格的 agent，而是让它在开放式交流中保持：

1. 松弛：不把每个 turn 自动解释成待完成的工单，不抢先汇报进度或宣布完成；
2. 连续推进：把用户的想法当作正在展开的线索，继续处理其中的隐含问题、张力和后果，而不是停留在确认、复述或第一个合理结论；
3. 密度扎实：对值得展开的主题给出足够长、连续、有内部结构的论证，增加区分、连接、反例、限定和更强的概念表述；
4. 语境适配：简单问题可以短，复杂闲聊和抽象讨论允许自然变长；不以统一模板强行收束。

目标是回答轨迹和交互质感，不是原样复制 ChatGPT Web 的私有系统 prompt、内部路由或 Model Spec 全文。

## 反目标

- 机械执行一长串行为条款；
- 把“help the user complete the requested task”当作所有对话的默认框架；
- 把每次回答都写成工作流、报告、计划或最终交付物；
- 为了字数而灌水，或把显式“think step by step”当成长回答开关；
- 要求模型暴露隐藏 chain-of-thought。

## 主要机制假设

当前 `general-assistant-v1` 是一份约束密度较高的完整行为合同。它包含“answer or perform directly”“complete”“final answer”等任务收束词。待验证假设是：这些词与大量禁止项叠加后，可能把开放式用户输入映射到“完成任务/working as agent”的轨迹，增加 premature closure，使模型在已经形成一个可交付结论后减少继续展开的倾向。

这里的“logits spike”只能作为生成机制的直觉描述。Responses API 不提供逐 token logits 或内部决策轨迹，项目不能把它当作直接观测量，也不能从一次输出的长短反推出因果关系。

## 可观测代理指标

每个 fresh session 记录：

- output 字符数和段落数；
- reasoning token 数、reasoning item 数和 summary 段数；
- 第一处总结/结论出现的位置；
- 是否出现任务收束词、进度汇报或自动的“还可以继续”式尾句；
- 是否在用户原始想法之外增加了有效的结构、区分、推论、反例或关联；
- 盲评的连续性、思想密度、自然度和语境匹配度。

字符数和 reasoning token 只能是辅助指标。最终判断必须使用相同输入、相同模型与工具配置下的多次 fresh-run，并进行隐藏 variant 的 pairwise 人评；不能把“更长”直接等同于“更好”。

## Prompt 实验矩阵

- **Native**：完全省略 `instructions`，测模型服务端原生行为；
- **Constraint-heavy**：当前 `general-assistant-v1`，用于回归和确认规则密度的副作用；
- **Web-relaxed**：当前 `web-relaxed-v3` 候选；保留一句核心交互目标，增加一段续航目标，并用一句话压缩通用行为底座，避免恢复规则清单或让 agent/task-completion 词汇成为主导框架。

每个用例至少三次 fresh-run，固定 model、reasoning、verbosity、tools、endpoint 和输入；结果随机化并隐藏 variant 名称。用例至少覆盖开放式闲聊、抽象观点、技术解释、简短事实问答、明确执行任务和需要检索的时效问题。

## 当前决策

在 Web-relaxed 通过上述评测前，不把 Constraint-heavy prompt 设为最终默认值。任何 prompt 改动都应整体审查和版本化，不能以“遇到一个失败就追加一句”的方式无限堆叠规则。

## 2026-09-21 探索性 A/B/C

使用相同的 WA2 开放式输入、`gpt-5.6-sol`、`reasoning.effort: xhigh`、`text.verbosity: medium` 和 hosted Web Search 配置，分别创建三个 fresh session：

| Variant | Session | Instructions | 输出字符 | 段落 | Reasoning tokens | Reasoning items |
| --- | --- | ---: | ---: | ---: | ---: | ---: |
| A Native | `cd415bae-cf05-4ba2-b809-cd3385d5149f` | omitted | 694 | 4 | 192 | 1 |
| B Constraint-heavy | `a0e95cad-643d-4ffe-86e6-70bb61a998f0` | 5092 chars | 1218 | 18 | 516 | 1 |
| C Web-relaxed v1 | `67f52f0f-a2b5-4e3e-bb5e-ff0ceb021421` | 2655 chars | 2517 | 13 | 2547 | 5 |

三组均一次 background attempt 完成，`store:false`、`previous_response_id:null`，且没有调用 Web Search。C 不仅更长，还在第一个可交付结论之后继续推进到 open term/free variable、玩家记忆作为持久状态、音乐共同体、effect/非合流性，以及原类比的失效边界，初步符合“松弛、连续推进、密度扎实”的目标。

这是单输入、每组单次运行，只能视为强烈的探索信号。它不能证明 prompt 的因果机制、跨任务稳定性或整体优越性，也不能排除随机生成差异。下一步仍需多用例、多次 fresh-run 和隐藏 variant 的盲评。

### Web-relaxed v2/v3 canary

在相同 WA2 输入与运行配置下又各做了一次 fresh canary：

| Variant | Session | Instructions | 输出字符 | 段落 | Reasoning tokens | Reasoning items |
| --- | --- | ---: | ---: | ---: | ---: | ---: |
| Web-relaxed v2 | `736a2023-16e9-4ce7-a5da-9f4af7561033` | 751 chars | 1616 | 15 | 516 | 1 |
| Web-relaxed v3 | `8ed659c6-fafa-4a7a-aba8-a32f2c3162d2` | 1150 chars | 2534 | 26 | 516 | 1 |

v2 保留了更自然的承接语气，但相较 v1 明显失去续航。v3 保留 v2 的一句核心交互目标，增加一段“越过首个合理解释继续推进”的目标，并用一个长句压缩 v1 的通用底座。该次 v3 在 reasoning token 数与 v2 相同的情况下恢复到 v1 级别的输出长度，并继续推进到路线幽灵、闭包、垃圾回收、主体由关系生成、真实性与正当性分离、信息越充分越不可解，以及动画作为公式提出而非完整证明。

这表明续航目标对该样本有强烈效果，同时没有恢复 v1 的高 reasoning token 消耗；但仍然只是单次 canary，不能据此判定 v3 在其它任务类型上稳定胜出。

## 依据

- [OpenAI Prompting](https://developers.openai.com/api/docs/guides/prompting)：总体 role/tone 放在高优先级指令中，把生产 prompt 当代码管理，并用代表性测试和评测覆盖变更。
- [OpenAI Reasoning best practices](https://developers.openai.com/api/docs/guides/reasoning-best-practices)：reasoning model 通常适合直接、简单的 prompt；不建议用“think step by step”强行触发推理；同时应明确成功目标并允许模型持续迭代到目标。
