# 技术路线决策

状态：Accepted

日期：2026-09-20
最近更新：2026-09-22（明确 `sequence_number` 允许稀疏；配置从客户端入口独立）

## 1. 产品目标

实现一个本地、API 驱动的 OpenAI 长任务聊天客户端。目标体验接近 ChatGPT Web：既能承载可持续数十分钟的任务，持续呈现推理摘要、托管工具进度和阶段性文本；也能在开放式闲聊和思想讨论中保持松弛、连续推进、密度扎实的长回答，而不是把每个 turn 都压缩成任务收束流程。

需要避免的不是 agent 行为，而是沉重 agent harness。核心运行时不应携带代码仓库治理、自动补丁、测试循环、权限编排、子代理或大段隐藏提示词。

### 1.1 Prompt 产品目标（已锁定）

Prompt 分为两层：base developer prompt 负责通用交互目标，只在 session 首轮发送一次；短的 session following instruction 负责延续当前会话已经形成的语气、概念和未完线索，每轮都作为请求级 `instructions` 发送。首轮 `instructions` 由两者组成，后续轮只有 following instruction，因此 base 不会被反复注入，following 也不会作为 native input item 在 replay history 中逐轮累积。每轮实际发送的 `instructions` 仍写入 journal configuration。

Base developer prompt 的目标是复刻网页端的回答轨迹，而不是建立一套必须逐条服从的行为规章：

- **松弛**：开放式交流不默认进入“接单、执行、汇报、收尾”的 agent 模式；除非用户明确要求，否则不主动制造进度报告、任务清单或结案句。
- **连续推进**：把用户的陈述、类比、判断和半成品想法当作正在展开的对话，沿其隐含问题继续推进，保留上下文中的概念和张力，不在第一个合理结论处提前关闭。
- **密度扎实**：当话题本身值得展开时，补充结构、推论、边界、反例、关联和更强的表述，让回答自然变长；长度由思想密度决定，不由固定字数或“尽快给最终答案”决定。
- **适配语境**：简单请求仍可简洁；复杂、开放、抽象或具有审美/理论张力的交流则允许多段连续论证，不被模板化的总结结构打断。

这不是“越长越好”，也不是要求暴露 chain-of-thought。prompt 应描述期望的交互结果，避免把每个局部行为都写成硬性命令。当前 `general-assistant-v1` 作为约束较密的实验样本保留用于回归，不代表最终 prompt。

## 2. 明确的非目标

第一阶段不实现：

- coding-agent 工作流；
- 本地 shell、文件系统、Git、浏览器或 computer-use 工具；
- 子代理和多代理编排；
- MCP 动态工具发现；
- ChatGPT Web 私有系统提示词、内部路由或产品级 Memory 的复刻；
- 运行中 steering。当前目标体验不依赖 mid-turn steering。

## 3. 决策摘要

| 领域 | 决策 |
| --- | --- |
| 语言 | TypeScript，Node.js 24 |
| 包管理 | pnpm workspace |
| API 客户端 | 官方 `openai` JavaScript SDK |
| API 地址 | `OPENAI_BASE_URL` 可配置；默认官方 `/v1`，替代端点必须兼容所需 Responses 生命周期接口 |
| 上层 agent 框架 | 不采用 Agents SDK、LangChain 或其他 agent runtime |
| 模型 | 默认 `gpt-6-astra`，允许配置 |
| 推理 | `reasoning.effort: "max"`，`reasoning.summary: "auto"` |
| 长任务 | 优先 Responses `background: true` + `stream: true`；可全局启用窄范围 foreground fallback |
| 断线恢复 | 服务 owner 丢失时，Background 持久化 `response_id`、`sequence_number` 并以 `starting_after` 显式重新附着；当前流错误或无终态断流直接失败 |
| 会话延续 | 强制 `store: false`；本地保存并原样重放完整 native input/output item history |
| 工具 | 第一阶段仅启用 OpenAI hosted tools；默认允许 `web_search`，`code_interpreter` 显式开启 |
| 本地状态 | append-only JSONL 事件日志 + 原子写入的会话元数据 JSON |
| 首个客户端 | 简单 CLI；不先投入完整 TUI/Web UI |
| 测试 | Vitest；协议 reducer、重放、断线恢复为核心 |

## 4. 为什么选择 TypeScript 与官方 SDK

UI 最终可能是终端、Web 或桌面应用。TypeScript 可以在这些界面之间共享协议类型和 reducer，同时官方 JavaScript SDK直接暴露 Responses 流式事件。采用官方 SDK可以避免维护第三方适配层对新事件类型的滞后。

`simonw/llm` 已证明轻量 runtime 可以正确保留 reasoning、tool call 和多消息结构，但它当前缺少 OpenAI background stream 的恢复控制，而且核心为 Python。我们复用其事件抽象思想，不把它作为产品依赖。

## 5. 组件边界

```text
CLI / Web UI
      │ commands + subscriptions
      ▼
SessionService ───────► RunRegistry
      │                  process-local in-flight ownership
      ├──────────────► SessionStore
      │                 metadata.json + events.jsonl
      ▼
RunController
      │ create / attach / cancel / retrieve
      ▼
OpenAI Responses transport
      │ raw typed events
      ▼
Event reducer ───────► normalized UI events
```

### `protocol`

只定义 UI 无关的数据结构：

- `RunCommand`: start、attach、cancel；
- `RunState`: queued、in_progress、completed、failed、incomplete、cancelled；
- `NormalizedEvent`: lifecycle、reasoning、assistant_text、tool、annotation、usage、terminal、error；
- 每个事件带 `responseId`、`sequenceNumber`、稳定的 item/content 索引和原始事件类型。

### `runtime`

`RunController` 负责：

1. 创建 background streaming Response；若全局策略允许且端点以 400 明确拒绝 `background`，将该未创建的 turn 记为 abort，并用新 foreground turn 重试一次；
2. 在事件交付 UI 前落盘游标；
3. 当前流若收到上游 `type: "error"`、transport 抛出 streaming error，或在 terminal event 前结束，则记录 `failed` 并结束，不尝试重新附着；服务 owner 丢失后的显式恢复仍从最后确认的 `sequence_number` 开始；
4. 过滤重复事件；`sequence_number` 是非负、可比较的恢复游标，只要求向前推进，允许 provider 产生天然稀疏的序号，不要求必须等于前一个序号加一；
5. 区分正常完成、失败、不完整和取消；
6. 暴露取消与重新附着，而不执行产品级 agent 编排。

### `application`

`SessionService` 是唯一的 session 用例层，负责 continue、retry、edit、explicit fork、attach、cancel 和启动恢复的顺序编排。它不解析 HTTP、环境变量或配置枚举，也不重复 storage/runtime 已有的机械校验。`RunRegistry` 只表达当前 service 进程正在消费哪些 session；它不被当成跨进程存活探针。

每个 CLI 命令或 Web 服务实例必须先取得 data directory 的单写者租约。Web 只在取得租约后、开始监听前处理上一 owner 遗留的不可恢复 turn。读取和列出 session 使用纯 journal projection，不触发恢复、失败转换或 metadata 修复。

### `config`

环境和 `.env` 只在 composition root 解析为显式 `MasChatConfig` 与 `RunPolicy`。API key 只进入 transport 构造；运行策略通过 application service 流入每次 turn，并以实际 request snapshot 写入 journal。Web 不依赖 CLI 模块。

### `storage`

第一阶段采用文件存储，不立即引入数据库：

```text
.chat-runtime/
  sessions/<session-id>/metadata.json
  sessions/<session-id>/events.jsonl
```

JSONL 是 append-only write-ahead journal，保留四类记录：新 turn 的原生 input items、Responses 原始流事件、terminal Response 的完整 output items，以及在创建远端 Response 前失败的本地 abort。它既支持协议升级、故障复现和 UI 重新投影，也能重建下一轮 API 输入。元数据使用临时文件加原子 rename 写入；journal 比 metadata 更新而 metadata 尚未更新时，以 journal 重建游标。需要全文搜索或大量会话后，再以 SQLite 建立可重建索引；SQLite 不成为初始正确性的依赖。

命令路径可以修复落后的 metadata cache；inspect/list 路径直接从 journal 派生快照且不写盘。orphan 判定不得隐藏在读取路径中。

每个新 `turn.input` 记录显式 lineage：`parentTurnId` 指向所选对话路径的上一轮，retry/edit 以 fork metadata 指向来源 turn。旧 journal 不重写；缺少 lineage 的旧 turn 按 journal 顺序连接到当时最近成功完成的 turn。一个 session 因此可以形成 turn tree，但下一轮请求只重放从根到所选父节点的单一路径。失败、截断、incomplete 和 cancelled turn 可保留并展示；继续输入时保留这些 turn 的 user input，但其 partial/terminal assistant output 绝不进入新请求的 replay history。

日志不追求人类可读 transcript。跨轮“完整”的标准是：按原顺序保留用户 input 与每个 `response.output` item，包括 encrypted reasoning、assistant `phase`、hosted-tool call、来源和 annotations，能够无损构造下一轮 Responses `input`。API key、Authorization header 和 SDK 请求头不得进入 journal。

显式 `parentTurnId: null` 表示根分支，首轮 retry/edit 必须保持为同一消息的 sibling；只有缺少整个 lineage 的旧日志才能推断线性父节点。该规则同时约束前端版本投影、再次重试和后续请求的 history，已有正确记录无需重写。

## 6. 初始请求策略

默认请求语义如下；model、reasoning effort/summary、text verbosity、两个 hosted-tool 开关和 background fallback 策略可由 `.env` 全局配置。`store:false` 与 `stream:true` 不可覆盖：

```ts
{
  model: "gpt-6-astra",
  background: true,
  stream: true,
  store: false,
  reasoning: {
    effort: "max",
    summary: "auto",
    context: "all_turns"
  },
  text: {
    verbosity: "medium"
  },
  tools: [
    { type: "web_search" }
  ],
  include: [
    "reasoning.encrypted_content",
    "web_search_call.action.sources"
  ]
}
```

`code_interpreter` 由用户显式开启，因为它具有单独的运行成本和容器生命周期。工具集、模型与 reasoning effort 都属于每次运行的可见配置，不由隐藏 prompt 偷偷决定。

CLI 从当前工作目录静态解析 `.env`，不依赖 `dotenv` 包。配置优先级固定为 `.env`、进程或系统环境变量、源码默认值。`OPENAI_BASE_URL` 显式传给官方 SDK；API key 只保留在进程内存中，不进入 request snapshot、JSONL 或日志。

`MAS_CHAT_BACKGROUND_FALLBACK` 默认为 `on_unsupported`，也可设为 `never`。Fallback 只匹配 HTTP 400 且错误明确为不支持 `background`；foreground 请求完全省略该字段，而不是发送 `background:false`。两次尝试分别拥有独立 turn 记录，首次 background turn 以 abort 封存，下一轮历史只纳入成功完成的 foreground turn。

`store: false` 是不可降级的产品边界。每轮请求由本地已完成 turn 的 input/output items 加上本轮新 input 组成，不设置 `previous_response_id`，也不依赖 Conversations API。reasoning item 的 `encrypted_content` 必须随其它 output item 一起原样保存和重放；开发者提示词与请求配置按 turn 保存，但凭据不落盘。

OpenAI Background Mode 在 `store: false` 下仍会为异步执行和轮询临时保存 Response 数据，官方当前描述为约 10 分钟。这种临时服务端状态只用于进行中的 create/attach/cancel，不作为跨轮历史或长期恢复来源。

## 7. 中间状态呈现原则

运行时保留而不混淆以下通道：

1. reasoning summary：展示为可折叠的推理摘要，不声称是原始 chain-of-thought；
2. hosted tool lifecycle：结构化展示搜索、Code Interpreter 等状态；
3. assistant message：保留 `commentary` 与 `final_answer` phase（若模型返回）；
4. final answer：只有最终阶段进入最终答案区域；
5. usage 与错误：单独记录，不拼接进回答文本。

UI 可以改变外观，但不得丢弃这些语义边界。

## 8. 恢复算法

1. 只让 `response.*` 与 `error` 事件进入 Responses reducer；其余带类型的附加事件跳过，不推进游标或落盘，已观察到 `codex.rate_limits`、`codex.response.metadata` 和 `responsesapi.websocket_timing`。无序号 `error` 作为上游流错误结束 turn。Responses 事件验证 `response_id` 与非负、单调前进的 `sequence_number`；序号允许稀疏，不把 `received > last + 1` 单独视为协议错误。兼容缺少游标的生命周期事件和终态事件：原始事件落盘并标记 `unsequenced`，使用当前已确认游标作为本地记录序号（尚无已确认游标时使用非负的本地序号 `0`），只更新 response ID/status，不推进 provider 游标；缺少游标的正文事件仍失败，错误记录只保留事件类型和字段名，不写入原始内容或 headers；
2. 原始事件追加到 JSONL 并完成 flush；
3. 原子更新 `lastSequenceNumber`；
4. reducer 生成 UI 事件；
5. 服务 owner 丢失且 turn 仍可恢复时，通过官方 SDK `responses.retrieve(id, { stream: true, starting_after: N })` 显式重新附着；当前消费链路的流错误或无终态结束不走此路径；
6. 对 `sequence_number <= N` 的重复或回放事件执行幂等丢弃；对大于 `N` 的事件按 provider 给出的序号推进游标；
7. 收到 terminal event 后，在向 UI 交付终态前保存完整 `response.output`；取消 API 返回的最终 Response 以本地 terminal snapshot 落盘，不伪造 SSE sequence；
8. 下一轮从所有已封存 turn 重建 native item history；未完成或在远端创建前 abort 的 turn 不进入历史。

远端 Responses create/retrieve/stream/cancel 返回明确 HTTP 4xx/5xx、stream transport 抛出异常、收到上游 `type: "error"`，或 stream 在 terminal event 前结束时，当前 turn 都记录为 `failed` 并结束本次执行；不得把这类 provider error 留在 `queued/in_progress`，也不得把失败的 attach 重试解释成新的生成。只有服务 owner 丢失且尚未消费当前 background stream 时，带 response ID 的 background turn 才可由显式 attach 恢复。

Foreground fallback 仍按相同顺序落盘 SSE 和 terminal output；任何流错误或无终态结束都将 turn 标记为本地失败，不允许 attach；同步 Response 的取消语义是终止当前连接，因此另一个 CLI 进程不得调用 background cancel endpoint 并伪装成功。

Application service 维护进程内 run registry，用来区分“页面连接已断但服务仍在消费”与当前实例没有消费。跨进程排他性由 data-directory lease 保证，因此只有取得租约的新 owner 才能在启动阶段处理遗留状态：foreground turn 和没有 response ID 的 background turn记为 owner-lost failure；带 response ID 的 background turn保持 attachable。GET/list 不做 reconciliation。用户重试会在同一 session 中创建 sibling turn，复用原 user input 和原 turn 的父节点；若来源 background response 仍可恢复，则必须成功执行服务端 cancel 并持久化真实 terminal 状态后才能创建 sibling，不以吞掉 cancel 失败的旁路继续运行。已落盘的 partial assistant output 只用于展示。

停止生成沿同一条所有权链路传播：Web 先请求 application 的 cancel 用例；服务层在本地 turn 收敛为 `cancelled` 或 `failed` 后 abort 当前 run handle；controller 将 `AbortSignal` 传给 Responses transport，再由官方 SDK 中止 create/retrieve stream。这样远端 cancel 的真实 terminal 状态与本地消费者的结束保持一致，foreground 或远端 cancel 失败也不会留下继续 attach 的 active turn。

当前锁定的官方 `openai` JavaScript SDK 已直接暴露 streaming retrieve 与 `starting_after`。runtime 仍保留独立 SSE parser，用于协议测试和 SDK/REST 能力发生短期错位时的薄 fallback，不建立第二套 provider abstraction。

## 9. 开发阶段

### Phase 1：协议内核

状态：已实现并通过离线测试。

- workspace 与包骨架；
- normalized event 类型；
- SSE 解析和 reducer；
- JSONL journal 与游标元数据；
- 全套合成事件测试。

### Phase 2：真实长任务

状态：foreground fallback 的 live smoke 已通过；background attach/resume/cancel 仍等待支持该能力的端点验证。

- 创建 `background + stream` 任务；
- attach、resume、cancel；
- Astra `max + summary:auto`；
- hosted web search；
- 最小 CLI 展示。
- 非官方端点 foreground fallback 与实际模式 journal。

### Phase 3：可靠性验证

- 强制断开连接后恢复；
- 进程退出并重启后恢复；
- 重复事件、乱序防御、无 terminal event；
- 30 分钟真实任务验收与成本记录。

### Phase 4：产品 UI

状态：Web initial slice complete；后续以实际使用反馈驱动。

- 已增加一个只绑定本地地址的原生 Web 壳，作为 protocol consumer；
- UI 只能消费 protocol，不得重新实现 Responses 状态机；
- 已支持在 user message 下重试/重新生成或原位编辑后重试，并在同一 session 内切换 sibling turn 版本；
- 已支持从完成的历史 turn 显式 fork，并记录 `fork.kind: "explicit"`；
- 视觉、Markdown、会话列表、设置编辑和多用户部署暂不预设，避免在真实交互反馈前过度设计。

## 10. 验收标准

第一版完成必须同时满足：

- Astra max 请求参数可从日志验证；
- reasoning summary 在生成时可见；
- hosted tool 状态与来源可见；
- commentary 与最终答案不会互相覆盖；
- 服务 owner 丢失且 background response 已持久化 `response_id` 时可显式从游标恢复；streaming error 或无终态断流后的 turn 必须保持 `failed`，不可再次 attach；
- 恢复后文本和工具事件无重复、无缺失；
- 可取消 queued 或 in-progress 任务；
- Web 与 CLI 都能显式停止当前生成；停止失败的远端 cancel 也会将本地 turn 收敛为 `failed`，并保留 cancel error；
- `store: false` 可从本地原生 item history 构造第二轮请求，且不包含 `previous_response_id`；
- 30 分钟任务完成后仍能恢复并读取最终结果；
- 默认运行不读取本地仓库、不执行本地命令、不创建子代理；
- developer prompt 可见且保持短小。

## 11. 主要风险

- API 事件类型会继续演进：保留原始 JSONL，未知事件不得导致运行失败；
- background stream 首 token 延迟高于同步流：UI 应显示 queued/in-progress，而不是假死；
- `store: false` background Response 仍有短时服务端暂存；约 10 分钟窗口与 30 分钟任务的实际恢复行为必须通过 live disconnect 测试确认，当前不得宣称已满足长期耐久性；
- 长任务成本高：运行前展示模型、effort、工具和成本风险，运行中记录 usage；
- SDK 与 REST 新能力可能不同步：transport 封装必须薄，避免依赖未公开内部实现。
- 非官方 `OPENAI_BASE_URL` 可能只兼容基础生成而不支持 background stream、`starting_after` 或 cancel；必须按能力逐项烟测，不能因一次普通请求成功就判定兼容。
- Foreground fallback 牺牲运行中断线恢复和跨进程取消，只用于扩大兼容性，不能用于宣称已经满足 30 分钟耐久性验收。
- 过密的行为约束可能把开放式交流重新解释成 agent 任务：`complete the task`、`answer directly`、`final answer` 等收束语义可能提高 premature closure 和“working as agent”轨迹的概率，削弱松弛的连续长回答。API 不暴露 logits，因此这目前是待验证的机制假设，不是已证实的因果结论。
- Prompt 实验不能只看输出字符数：需要同时记录 reasoning token、输出结构、论证推进、结论出现位置和盲评的语境适配度，避免把无效冗长误判为网页端风格。

## 12. 官方依据

- Background mode: <https://developers.openai.com/api/docs/guides/background>
- Reasoning models and summaries: <https://developers.openai.com/api/docs/guides/reasoning>
- Conversation state: <https://developers.openai.com/api/docs/guides/conversation-state>
- Streaming Responses: <https://developers.openai.com/api/docs/guides/streaming-responses>
- Prompting: <https://developers.openai.com/api/docs/guides/prompting>
- Reasoning best practices: <https://developers.openai.com/api/docs/guides/reasoning-best-practices>
- GPT-6 Astra: <https://developers.openai.com/api/docs/models/gpt-6-astra>
