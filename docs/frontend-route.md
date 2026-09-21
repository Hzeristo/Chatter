# 前端初始边界

状态：Initial slice complete

第一版前端是一个本地 Web 壳，不是新的 agent framework：

- `apps/web` 使用 Node 内置 `http` 服务，不增加 React、UI kit、状态库或 Markdown 依赖；
- 服务端持有 OpenAI client、配置和 `SessionStore`，浏览器永远不接触 API key；
- `/api/sessions/:id/turn` 和 `/attach` 以 SSE 转发 runtime 的 `NormalizedEvent`；
- `/api/sessions/:id` 只返回由本地 journal 投影出的 user/assistant 文本和状态，不把 encrypted reasoning 或原始事件发送到浏览器；
- 浏览器只维护临时渲染状态，session ID 放在 localStorage，刷新时可重新投影并尝试 attach；
- `reasoning` 和 hosted tool 只作为运行状态显示，不声称展示原始 chain-of-thought；
- 消息气泡使用本地 bundle 的 Markdown + inline LaTeX 渲染；输入框保留原生 textarea，并在下方显示同样的实时预览；原始 HTML 会被转义，危险 URL/事件属性会被移除；
- 已支持从本地 session 列表选择并接续既有会话；列表只返回状态、时间、首条用户消息摘要和消息数量，不返回原始 journal。
- 当前不实现设置编辑、主题系统、鉴权、多用户或跨机器部署。

启动：

```powershell
pnpm web
```

默认只绑定 `127.0.0.1:8787`。`MAS_CHAT_WEB_HOST` 和 `MAS_CHAT_WEB_PORT` 可以覆盖监听地址；公开绑定之前必须另行设计鉴权和 CSRF 边界。
