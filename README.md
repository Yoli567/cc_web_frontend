# Claude Code Web 前端

自托管的 Claude Code Web 前端。在手机浏览器上即可与 VPS 上常驻的 Claude Code 实例聊天——保留 thinking chain、tool use、MCP 能力，使用订阅额度而非 API token。

## 架构

```
┌─────────────┐        WebSocket + HTTPS        ┌──────────────────┐
│  手机浏览器  │ ◄──────────────────────────────► │  Nginx (反向代理) │
│ (React SPA) │                                  └────────┬─────────┘
└─────────────┘                                           │
                                               ┌──────────┴──────────┐
                                               │                     │
                                               ▼                     ▼
                                        ┌──────────────┐     ┌────────────────┐
                                        │ FastAPI 后端  │     │ 前端静态文件    │
                                        │  /ws  /api   │     │ (React dist)   │
                                        └──────┬───────┘     └────────────────┘
                                               │
                          ┌────────────────────┼────────────────────┐
                          │                    │                    │
                          ▼                    ▼                    ▼
                   ┌─────────────┐    ┌──────────────┐    ┌──────────────┐
                   │ tmux bridge │    │ JSONL 文件    │    │ MCP Server   │
                   │ (输入桥接)   │    │ watcher      │    │ (消息推送)    │
                   └──────┬──────┘    │ (输出监听)    │    └──────────────┘
                          │           └──────┬───────┘
                          ▼                  │
                   ┌─────────────────────────┴───┐
                   │  Claude Code CLI (tmux 常驻) │
                   └─────────────────────────────┘
```

- **输入**：前端 → WebSocket → FastAPI → `tmux send-keys` → Claude Code CLI
- **输出**：Claude Code 写 JSONL → watcher 监听 → FastAPI → WebSocket → 前端
- **多消息回复**：Claude Code 调用 MCP `send_message` 工具 → 直接推送至前端

## 功能特性

### 前端
- **双模式交互**：Message（短消息聊天）与 Cabin（长文本协作）共享上下文
- 流式 Markdown 渲染、Thinking 折叠展示、Tool Use 可视化
- 多媒体支持：图片多选与全屏预览、文档附件、语音录制与转写
- Liquid Glass 主题系统，支持深度 UI 个性化
- WebSocket 自动重连、离线降级至 Mock 模式
- IndexedDB 聊天持久化、完整备份导出/导入
- PWA 支持

### 后端
- FastAPI + WebSocket 实时通信
- tmux bridge 安全处理多行文本输入
- JSONL watcher 解析 Claude Code 输出流（thinking / message / tool_use / turn_complete）
- Cookie 登录认证

### MCP Server
- `send_message`：多气泡回复
- `reply_message`：引用回复
- `send_image` / `send_voice`：富媒体推送
- `wait_for_user`：等待用户下一条消息

## 技术栈

| 层 | 技术 |
|---|------|
| 前端 | React 19 + Vite + TypeScript + Tailwind 4 |
| Markdown | react-markdown + remark-gfm |
| 后端 | Python 3.10+ FastAPI + websockets + watchfiles |
| MCP | Python stdio (mcp>=1.9) |
| 反向代理 | Nginx + Let's Encrypt |
| 进程管理 | systemd |
| 常驻会话 | tmux |

## 本地开发

```bash
# 安装依赖
cd frontend && npm install
cd ../backend && pip install -r requirements.txt
cd ../mcp-server && pip install -r requirements.txt

# 启动（分别在不同终端）
cd backend && uvicorn main:app --reload    # http://localhost:8000
cd frontend && npm run dev                  # http://localhost:5173
```

## 部署

项目通过 systemd 管理后端服务和 tmux 会话，Nginx 反向代理提供 HTTPS 和 WebSocket 支持。详见 `deploy/` 目录下的配置模板。

## 项目结构

```
cc-web-frontend/
├── frontend/          # React SPA
│   └── src/
│       ├── pages/     # Home / Message / Cabin / Sessions / Settings
│       ├── components/chat/   # 聊天组件
│       ├── hooks/     # WebSocket、聊天、音频等 hooks
│       └── utils/     # 存储、备份、去重等工具
├── backend/           # FastAPI 后端
│   ├── main.py        # 应用入口与路由
│   ├── tmux_bridge.py # tmux 输入桥接
│   ├── watcher.py     # JSONL 输出监听
│   └── ws_manager.py  # WebSocket 连接管理
├── mcp-server/        # Claude Code MCP 工具
│   └── server.py      # 5 个消息推送工具
└── deploy/            # 部署配置模板
```

## 设计理念

Claude Code 是一个强大的 CLI 工具，但缺乏移动端入口。本项目通过 tmux 桥接输入、文件监听捕获输出、MCP 工具实现主动推送，将 CLI 包装成可在手机浏览器中使用的实时聊天应用，同时保留了 Claude Code 的全部能力。
