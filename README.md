# MAS Chat

本仓库用于实现一个 OpenAI-native 的本地长任务聊天客户端：保留 ChatGPT Web 的长程推理、推理摘要、托管工具进度和最终答案体验，但不引入 Codex 式仓库扫描、补丁、测试、子代理与权限编排 harness。

当前状态：协议、stateless journal、事件 reducer、断线恢复控制器、集中配置和最小 CLI 已实现。真实 API 烟测已在 foreground fallback 下完成；background 恢复链路仍需使用支持该参数的端点验证。

## 已确定的方向

- TypeScript + Node.js 24，使用 pnpm workspace。
- 直接使用官方 `openai` JavaScript SDK；不使用 Agents SDK。
- 核心是 UI 无关的 Responses runtime，UI 通过事件订阅接入。
- 默认目标模型为 `gpt-6-astra`，推理档位为 `max`，推理摘要为 `auto`。
- 长任务优先使用 `background: true` 与 `stream: true`；端点明确拒绝 `background` 时可按全局策略重试一次 foreground。只有 background 模式支持断线后 `starting_after` 恢复。
- 所有请求强制 `store: false`；跨轮会话通过本地保存并原样重放全部 Responses input/output items 延续，不使用 `previous_response_id`。
- 第一阶段只允许 OpenAI 托管工具，如 `web_search` 和 `code_interpreter`；不提供本地 shell、文件系统、仓库读取、MCP 或子代理。
- 开发者提示词保持短小、可见、可编辑：首轮 `instructions` 为 base prompt 加 following cue，后续每轮只发送 following cue。

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
pnpm cli -- --help
pnpm cli -- new "任务内容"
pnpm cli -- continue <session-id> "后续问题"
pnpm cli -- attach <session-id>
pnpm cli -- cancel <session-id>
pnpm cli -- config
```

## 配置

复制示例文件并填写本地值：

```powershell
Copy-Item .env.example .env
pnpm cli -- config
```

CLI 会静态读取当前工作目录的 `.env`，无需 `dotenv` 包。项目有意采用以下优先级：

```text
.env > 进程或系统环境变量 > 源码默认值
```

| 配置项 | 默认值 | 说明 |
| --- | --- | --- |
| `OPENAI_API_KEY` | 无 | API 命令必需；不会写入 journal 或 `config` 输出 |
| `OPENAI_BASE_URL` | `https://api.openai.com/v1` | 完整 API root，可指向兼容网关 |
| `MAS_CHAT_MODEL` | `gpt-6-astra` | 请求模型 ID |
| `MAS_CHAT_REASONING_EFFORT` | `max` | `minimal/low/medium/high/xhigh/max` |
| `MAS_CHAT_REASONING_SUMMARY` | `auto` | `auto/concise/detailed` |
| `MAS_CHAT_TEXT_VERBOSITY` | `medium` | `low/medium/high` |
| `MAS_CHAT_WEB_SEARCH` | `true` | 是否启用 hosted Web Search |
| `MAS_CHAT_CODE_INTERPRETER` | `false` | 是否启用 Code Interpreter |
| `MAS_CHAT_BACKGROUND_FALLBACK` | `on_unsupported` | `on_unsupported` 或 `never`；仅针对明确拒绝 background 的 400 |
| `MAS_CHAT_DATA_DIR` | `.chat-runtime` | JSONL 与 metadata 根目录 |
| `MAS_CHAT_DEVELOPER_PROMPT` | 内置短 prompt | 每个 session 仅在首轮 `instructions` 中发送一次 |
| `MAS_CHAT_SESSION_FOLLOWING_INSTRUCTION` | 内置短 continuation cue | 每轮作为请求级 `instructions` 注入；后续轮不再拼接 base prompt |

替代 `OPENAI_BASE_URL` 至少必须支持 streaming Responses。若还支持 background streaming create、带 `starting_after` 的 streaming retrieve 和 cancel，客户端可提供完整长任务恢复；否则在全局 fallback 为 `on_unsupported` 时降级为不可恢复、不可通过服务端 API 取消的 foreground stream。仅兼容 Chat Completions 的代理仍不能运行本客户端。

标准 `pnpm cli` 与 `pnpm smoke:api` 入口使用 Node 24 的 `--use-env-proxy`，因此会在系统设置 `HTTP_PROXY`、`HTTPS_PROXY` 或 `NO_PROXY` 时自动遵循这些代理变量；未设置代理时仍直接连接。

`store:false` 与 `stream:true` 是不可覆盖的边界。Background 是首选模式；foreground fallback 只在服务端以 400 明确报告 `Unsupported parameter: background` 时触发，不用于掩盖鉴权、限流、模型或网络错误。

## API 烟测

```powershell
pnpm smoke:api
```

脚本依次验证脱敏配置、`/models`、Responses stream、托管工具事件、terminal output 和本地 journal。当前真实烟测记录到 background 被兼容端点拒绝后成功降级为 foreground，Web Search、引用、SSE 序列与 terminal 落盘均正常。该次响应未返回 reasoning output item，因此此端点的 reasoning summary 与 encrypted reasoning 兼容性仍未得到验证。
