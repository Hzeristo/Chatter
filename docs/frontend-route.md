# 前端初始边界

状态：Initial slice complete

第一版前端是一个本地 Web 壳，不是新的 agent framework：

- `apps/web` 使用 Node 内置 `http` 服务，不增加 React、UI kit、状态库或 Markdown 依赖；
- HTTP server 只负责请求解析、状态码/SSE 和静态资源；session 用例统一进入 `@mas-chat/application`；
- 服务端持有 OpenAI client、配置和 `SessionStore`，浏览器永远不接触 API key；
- `/api/sessions/:id/turn` 和 `/attach` 以 SSE 转发 runtime 的 `NormalizedEvent`；
- `/api/sessions/:id` 只返回由本地 journal 投影出的 user/assistant 文本和状态，不把 encrypted reasoning 或原始事件发送到浏览器；
- 浏览器只维护临时渲染状态，session ID 放在 localStorage，刷新时可重新投影并尝试 attach；
- `reasoning` 和 hosted tool 只作为运行状态显示，不声称展示原始 chain-of-thought；
- 消息气泡和运行状态日志共用本地 bundle 的 Markdown + LaTeX 渲染：在 Markdown 词法阶段识别 `$…$`、`$$…$$`、`\(…\)`、`\[…\]`，公式内容交由 KaTeX DOM API 渲染以兼容现有 CSP；代码中的公式标识符保留原样。推理摘要按 response/item 累积增量后重新渲染，忽略重复序号，保留段落、列表、代码块和表格。主输入区和消息编辑区使用 Tiptap 的单一 WYSIWYG 编辑 DOM，由 ProseMirror 内核维护光标、MarkdownManager 解析出的 marks、列表缩进、KaTeX inline math nodes 与序列化；输入块的自动格式化作为可撤销事务进入编辑历史，撤销时保留原始 Markdown；不使用独立预览区或覆盖层；消息展示仍会转义原始 HTML 并移除危险 URL/事件属性；
- 输入交互：粗体、斜体、删除线等行内格式在输入空格后退出，空格保留为普通文本；行内代码保留空格及格式。光标处按 Esc 可退出当前行内格式，原有文字不变；格式切换沿用 Tiptap 快捷键。删除内容至输入框为空时清除残留的行内格式标记；仅切换格式的操作不会触发空内容清理。自动 Markdown 转换仅处理光标所在的普通文本片段，保留两侧空白、已有格式和公式；输入法组词期间暂停转换和格式清理，待选词提交及编辑器收尾更新完成后再处理，空格、Esc 和回车交由输入法完成选词或取消，不触发格式退出或发送。
- 聊天记录使用独立滚动容器，打开或切换 session 时定位到底部；流式更新只在用户已经接近底部时继续跟随，用户查看历史位置时不会被抢回最新消息；运行状态日志同样只在接近底部时自动跟随；composer 固定在视口底部，不随聊天记录滚出屏幕；
- 桌面端采用左侧可滚动历史会话栏，主区承载当前聊天；运行状态收纳在左栏底部，不占用主聊天记录和 composer 的垂直空间；窄屏自动切换为单栏。
- 已支持从本地 session 列表选择并接续既有会话；列表只返回状态、时间、首条用户消息摘要和消息数量，不返回原始 journal。
- user message 下提供重试/重新生成和原位编辑后重试；新结果作为同一 session 中的 sibling turn 保存，版本按钮切换整条 branch path；
- 完成的历史 turn 提供显式分支入口；后端为分支创建独立 session ID，复制截至所选 turn 的完整原生历史，并在 session creation metadata 中记录来源 session/turn。原会话与分支会话分别占据会话列表入口；
- 未终结 turn 会从已落盘 response events 重建 partial 文本。仍在本进程运行时前端轮询，持久化了 response ID 的 background 可 attach；失去进程所有者的 foreground 或没有 response ID 的 background 自动记为失败。attach 断开后允许直接输入，发送时先 supersede 旧 response，再保留其 user input 接续新 turn；
- 远端 API 4xx/5xx、streaming error、上游 `type: "error"` 事件以及没有 terminal event 就结束的流都会显示为错误并结束当前 turn，重新打开 session 不会再次 attach。composer 在运行中显示“停止生成”，优先调用 cancel，foreground 或 cancel 失败时将本地 turn 收敛为 failed；
- session GET/list 是纯 projection，不执行恢复或写盘。Web 取得 data-directory 单写者租约后，在监听端口前统一处理上一实例遗留的不可恢复 turn；
- 当前不实现设置编辑、主题系统、鉴权、多用户或跨机器部署。

启动：

```powershell
pnpm web
```

默认只绑定 `127.0.0.1:8787`。`MAS_CHAT_WEB_HOST` 和 `MAS_CHAT_WEB_PORT` 可以覆盖监听地址；公开绑定之前必须另行设计鉴权和 CSRF 边界。
