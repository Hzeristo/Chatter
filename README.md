# MAS Chat

本仓库用于实现一个 OpenAI-native 的本地长任务聊天客户端：保留 ChatGPT Web 的长程推理、推理摘要、托管工具进度和最终答案体验，但不引入 Codex 式仓库扫描、补丁、测试、子代理与权限编排 harness。

当前状态：协议、stateless journal、事件 reducer、断线恢复控制器和最小 CLI 已实现并通过离线测试；尚未配置 API key，也尚未执行 live API 烟测。

## 已确定的方向

- TypeScript + Node.js 24，使用 pnpm workspace。
- 直接使用官方 `openai` JavaScript SDK；不使用 Agents SDK。
- 核心是 UI 无关的 Responses runtime，UI 通过事件订阅接入。
- 默认目标模型为 `gpt-6-astra`，推理档位为 `max`，推理摘要为 `auto`。
- 长任务使用 `background: true` 与 `stream: true`；持久化 `response_id` 和 `sequence_number`，支持断线后 `starting_after` 恢复。
- 所有请求强制 `store: false`；跨轮会话通过本地保存并原样重放全部 Responses input/output items 延续，不使用 `previous_response_id`。
- 第一阶段只允许 OpenAI 托管工具，如 `web_search` 和 `code_interpreter`；不提供本地 shell、文件系统、仓库读取、MCP 或子代理。
- 默认开发者提示词保持短小、可见、可编辑。

正式决策见 [docs/technical-route.md](docs/technical-route.md)，开源项目审计见 [docs/open-source-audit.md](docs/open-source-audit.md)。

## 目录约定

实现采用以下边界：

```text
apps/
  cli/                 最小参考客户端，用于验证长任务体验
packages/
  runtime/             RunController、Responses transport、事件归一化
  protocol/            UI 无关的事件和命令类型
  storage/             本地运行日志、会话元数据和恢复游标
docs/                  架构决策与研究记录
```

`work/` 保存本地调研镜像，不进入 Git；`outputs/` 保存临时生成物，不进入 Git。

## 本地验证

```powershell
pnpm install
pnpm run typecheck
pnpm test
```

测试不读取 `OPENAI_API_KEY`，也不会发起 API 请求。

## 最小 CLI

构建后可用以下命令；在配置 `OPENAI_API_KEY` 前不要执行需要 API 的命令：

```powershell
pnpm run build
node apps/cli/dist/index.js --help
node apps/cli/dist/index.js new "任务内容"
node apps/cli/dist/index.js continue <session-id> "后续问题"
node apps/cli/dist/index.js attach <session-id>
node apps/cli/dist/index.js cancel <session-id>
```

本地状态默认写入显式的 `.chat-runtime/` 数据目录，可用 `MAS_CHAT_DATA_DIR` 覆盖。开发者提示词可用 `MAS_CHAT_DEVELOPER_PROMPT` 覆盖，并随每次请求的配置快照写入 journal；API key 不进入日志。
