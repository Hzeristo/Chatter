# 技术路线决策

状态：Accepted

日期：2026-09-20
最近更新：2026-09-20（强制 `store: false`；增加全局 foreground fallback）

## 1. 产品目标

实现一个本地、API 驱动的 OpenAI 长任务聊天客户端。目标体验接近 ChatGPT Web 的高强度任务模式：单次任务可持续数十分钟，持续呈现推理摘要、托管工具进度和阶段性文本，最后明确收束为最终答案。

需要避免的不是 agent 行为，而是沉重 agent harness。核心运行时不应携带代码仓库治理、自动补丁、测试循环、权限编排、子代理或大段隐藏提示词。

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
| 断线恢复 | Background 持久化 `response_id`、`sequence_number` 并以 `starting_after` 重新附着；foreground 不可恢复 |
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
CLI / future UI
      │ commands + subscriptions
      ▼
Application service
      │
      ├──────────────► Session store
      │                 metadata.json
      │                 events.jsonl
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
3. 连接中断后从最后确认的 `sequence_number` 恢复；
4. 过滤重复事件；
5. 区分正常完成、失败、不完整和取消；
6. 暴露取消与重新附着，而不执行产品级 agent 编排。

### `storage`

第一阶段采用文件存储，不立即引入数据库：

```text
.chat-runtime/
  sessions/<session-id>/metadata.json
  sessions/<session-id>/events.jsonl
```

JSONL 是 append-only write-ahead journal，保留四类记录：新 turn 的原生 input items、Responses 原始流事件、terminal Response 的完整 output items，以及在创建远端 Response 前失败的本地 abort。它既支持协议升级、故障复现和 UI 重新投影，也能重建下一轮 API 输入。元数据使用临时文件加原子 rename 写入；journal 比 metadata 更新而 metadata 尚未更新时，以 journal 重建游标。需要全文搜索或大量会话后，再以 SQLite 建立可重建索引；SQLite 不成为初始正确性的依赖。

日志不追求人类可读 transcript。跨轮“完整”的标准是：按原顺序保留用户 input 与每个 `response.output` item，包括 encrypted reasoning、assistant `phase`、hosted-tool call、来源和 annotations，能够无损构造下一轮 Responses `input`。API key、Authorization header 和 SDK 请求头不得进入 journal。

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

1. 每次接收事件，验证 `response_id` 与单调 `sequence_number`；
2. 原始事件追加到 JSONL 并完成 flush；
3. 原子更新 `lastSequenceNumber`；
4. reducer 生成 UI 事件；
5. 连接中断时通过官方 SDK `responses.retrieve(id, { stream: true, starting_after: N })` 重新附着；
6. 对 `sequence_number <= N` 的重复事件执行幂等丢弃；
7. 收到 terminal event 后，在向 UI 交付终态前保存完整 `response.output`；取消 API 返回的最终 Response 以本地 terminal snapshot 落盘，不伪造 SSE sequence；
8. 下一轮从所有已封存 turn 重建 native item history；未完成或在远端创建前 abort 的 turn 不进入历史。

Foreground fallback 仍按相同顺序落盘 SSE 和 terminal output，但连接中断即将 turn 标记为本地失败，不允许 attach；同步 Response 的取消语义是终止当前连接，因此另一个 CLI 进程不得调用 background cancel endpoint 并伪装成功。

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

- 在 runtime 稳定后选择 TUI、Web 或桌面壳；
- UI 只能消费 protocol，不得重新实现 Responses 状态机。

## 10. 验收标准

第一版完成必须同时满足：

- Astra max 请求参数可从日志验证；
- reasoning summary 在生成时可见；
- hosted tool 状态与来源可见；
- commentary 与最终答案不会互相覆盖；
- 客户端断开至少一次后可从游标恢复；
- 恢复后文本和工具事件无重复、无缺失；
- 可取消 queued 或 in-progress 任务；
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

## 12. 官方依据

- Background mode: <https://developers.openai.com/api/docs/guides/background>
- Reasoning models and summaries: <https://developers.openai.com/api/docs/guides/reasoning>
- Conversation state: <https://developers.openai.com/api/docs/guides/conversation-state>
- Streaming Responses: <https://developers.openai.com/api/docs/guides/streaming-responses>
- GPT-6 Astra: <https://developers.openai.com/api/docs/models/gpt-6-astra>
