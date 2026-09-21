# 开源项目审计

审计日期：2026-09-20

方法：GitHub 仓库搜索、Sourcegraph 全局代码搜索，以及当前主分支源码核验。README 声明未作为唯一证据。

## 结论

没有找到同时满足以下条件的成熟开源项目：

- 通用聊天而非 coding agent；
- 原生 OpenAI Responses API；
- Astra `reasoning.effort=max`；
- 实时 reasoning summary 与 hosted-tool 状态；
- `background + stream`；
- 以 `sequence_number/starting_after` 断线恢复；
- 不附带重型 agent harness。

因此采用官方 SDK实现薄 runtime，同时复用开源项目已经验证过的事件抽象与 UI 模式。

## 主要候选

| 项目 | 源码核验结果 | 决策 |
| --- | --- | --- |
| [simonw/llm](https://github.com/simonw/llm) | 注册 Astra；支持 `max`、reasoning summary、WebSearch、CodeInterpreter 和结构化 StreamEvent；没有 background/resume，CLI 只直接渲染 text/reasoning | 复用设计思想和测试案例，不作为运行时依赖 |
| [OpenAI Responses starter](https://github.com/openai/openai-responses-starter-app) | 官方 Responses SSE，多轮、tool cards、web/file search、Code Interpreter、MCP；模型仍硬编码 GPT-5.2，缺 reasoning summary 与 background resume | 作为 OpenAI 事件处理参考，不直接 fork 产品 |
| [Neo Chat](https://github.com/u14app/neo-chat) | 通用聊天模式支持 Responses、summary:auto 和 hosted search；README 明确前台执行、关闭页面中断 | 可作 UI 参考，不采用其 agent/research runtime |
| [LibreChat](https://github.com/danny-avila/LibreChat) | Astra 自动路由 Responses，支持 reasoning mode/summary、commentary phase 与搜索 | 功能强但部署和 harness 过重，排除为核心依赖 |
| [Chatbox](https://github.com/chatboxai/chatbox) | 桌面 UI、Responses、reasoning；强制 `store:false` 并重发完整历史，无 background | UI 参考；GPL-3.0，不复制代码到本仓库 |
| [Sdcb Chats](https://github.com/sdcb/chats) | 实现 `background:true` 与轮询，也支持 reasoning summary 和 web search；background 路径为 `stream:false` | 后台轮询可作参考，但不满足实时中间状态 |
| [ChatKit](https://github.com/openai/chatkit-js) | 完整的线程、附件、工具和流式 UI；Web component 从 OpenAI CDN 加载，后端偏 Agents SDK/hosted workflow | 不作为完全本地、可审计的核心依赖 |

## 排除项

- Pi、AgentX、Aider、Codex CLI：coding-agent harness，与产品边界冲突；
- AIChat、NextChat：当前源码未提供所需 Responses 事件栈；
- Open WebUI：存在 `/v1/responses` 代理和部分事件转换，但主聊天路径不是目标所需的原生 background Responses runtime；
- `console-chat-gpt`：有 Responses、summary 和托管工具，但项目已 deprecated，且无可靠 background/resume。

## 可复用模式

从 `simonw/llm` 借鉴：

- text、reasoning、tool call、tool result 分离；
- 服务端工具与本地工具分离；
- 完整结构化消息而非字符串历史；
- reasoning summary 显示与隐藏开关。

从官方 Responses starter 借鉴：

- `response.output_item.added/done` reducer；
- web search、file search、Code Interpreter 的状态卡语义；
- annotations/citations 的增量合并；
- function-call output 继续下一轮的结构。

从 Sdcb Chats 借鉴：

- background create/retrieve/cancel 的状态处理；
- queued、in_progress 与各 terminal status 的显式分支；
- reasoning summary 与 web-search output 的解析测试。
