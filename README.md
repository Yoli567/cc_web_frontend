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

## 前置条件

| 条件 | 说明 |
|------|------|
| VPS / 云服务器 | 推荐 Ubuntu 22.04+，2核2G以上（Claude Code CLI 本身需要一定资源） |
| Claude Code 订阅 | 需要有效的 Claude Max/Pro 订阅，用于运行 CLI |
| Node.js 18+ | 前端构建 |
| Python 3.10+ | 后端运行 |
| tmux | 维持 Claude Code CLI 常驻会话 |
| 域名 + SSL（推荐） | 用于 HTTPS 访问；无域名也可通过 IP 直连 |

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

### 1. 启动 Claude Code tmux 会话

```bash
# 创建持久 tmux 会话
tmux new-session -d -s cc-main

# 在会话中启动 Claude Code
tmux send-keys -t cc-main 'claude' Enter
```

### 2. 构建前端

```bash
cd frontend
npm run build    # 产出 dist/ 目录
```

### 3. 配置后端

```bash
cd backend
cp ../deploy/cc-env.template .env
# 编辑 .env，设置：
#   AUTH_USERNAME=你的登录用户名
#   AUTH_PASSWORD=你的登录密码
#   TMUX_SESSION=cc-main
#   FRONTEND_DIST=../frontend/dist
```

### 4. 配置 MCP Server

将 `mcp-server/` 注册到 Claude Code 的 MCP 配置中，使 Claude Code 可以调用 `send_message` 等工具主动推送消息至前端。

### 5. 配置 systemd

```bash
# 复制服务模板
sudo cp deploy/systemd/cc-backend.service.template /etc/systemd/system/cc-backend.service
sudo cp deploy/systemd/cc-tmux.service.template /etc/systemd/system/cc-tmux.service

# 编辑 service 文件，修改路径和用户名
sudo systemctl enable cc-backend cc-tmux
sudo systemctl start cc-tmux cc-backend
```

### 6. 配置 Nginx + HTTPS（推荐）

```bash
# 复制 Nginx 配置模板
sudo cp deploy/nginx/your-domain.com.conf.template \
    /etc/nginx/sites-available/your-domain.com

# 编辑配置，替换域名和路径
sudo ln -s /etc/nginx/sites-available/your-domain.com /etc/nginx/sites-enabled/

# 自动配置 SSL 证书
sudo certbot --nginx -d your-domain.com
sudo nginx -t && sudo systemctl reload nginx
```

关键 Nginx 配置说明：

```nginx
# WebSocket 代理（必须配置，否则实时通信不工作）
location /ws {
    proxy_pass http://127.0.0.1:8001;
    proxy_http_version 1.1;
    proxy_set_header Upgrade $http_upgrade;
    proxy_set_header Connection "upgrade";
}

# API 代理
location /api {
    proxy_pass http://127.0.0.1:8001;
}

# 前端静态文件（SPA 路由回退）
location / {
    root /path/to/frontend/dist;
    try_files $uri /index.html;
}
```

### 无域名部署

没有域名也可以直接通过 IP 访问：

```bash
# 后端绑定 0.0.0.0
uvicorn main:app --host 0.0.0.0 --port 8001

# 浏览器访问 http://你的VPS-IP:8001
```

> 注意：无域名方式没有 HTTPS 加密，不建议在公网长期使用。

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
