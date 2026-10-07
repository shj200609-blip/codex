# Codex Changes Review

在 VS Code 中查看和逐 Hunk 审核 Codex 的代码修改。终端 CLI、官方 Codex IDE 插件和 Changes 面板连接同一个 **Shared App Server**，由这个服务器执行 Turn、工具调用和 `apply_patch`，并生成同一份 ChangeSet。

这是基于 [OpenAI Codex](https://github.com/openai/codex) 的社区 fork，包含配套 VS Code 插件，当前版本 **0.5.0**。插件通过 VSIX 安装，尚未发布到 VS Code Marketplace。

## 能做什么

- **CHANGES 文件树**：按 Turn / 文件 / Hunk 展示已记录的修改。
- **原生 Diff**：左侧为修改前基线，右侧为当前文件；点击 Hunk 跳到 Core 定位的实际位置。
- **逐 Hunk、逐文件、整组 Accept / Revert**：Accept 记录审核决定；Revert 由 Core 检查并回退对应修改。
- **保护后续编辑**：内容不再准确匹配时返回 Conflict；存在未保存的编辑器内容时阻止审核操作。
- **CLI 和 IDE 联动**：两种 producer 都能在 shared 模式下生成同一服务器可审核的 ChangeSet。
- **工作区隔离**：自动发现 canonical cwd 匹配当前工作区的 loaded / 新建 thread，无需手工复制 ID。
- **保留原有使用方式**：不指定 shared endpoint 时，CLI 继续原有 local 行为；IDE 接入可以恢复。

## 为什么需要同一个服务器

```text
                         Shared App Server
                    Thread / Turn / Tools / Core
                       ChangeSet / Approvals
                                │
              ┌─────────────────┼─────────────────┐
              │                 │                 │
        Codex CLI / TUI   官方 Codex IDE      Changes Review
          producer          producer             observer
        prompt / 输出      prompt / 输出      Diff / Accept / Revert
        自己线程的审批      自己线程的审批       不响应工具审批
```

CLI / IDE 的请求直接进入 shared server，修改和 ChangeSet 在同一个 Core Session 中产生。插件接收 `changeSet/created` / `changeSet/updated`，并通过服务器 API 审核。它不通过 Git diff、文件扫描或跨进程复制 diff 来获取 Codex 修改。

普通 local CLI 与独立启动的 IDE 各自拥有服务器。仅安装 Changes 插件不能让这些独立 Session 自动合并；按下面步骤接入 shared server。

## 安装

需要 Git、Node.js 20+、VS Code 1.95+，以及仓库指定的 Rust 工具链。当前安装后的官方 IDE 接入支持本地 macOS / Linux 和 loopback WebSocket。

### 1. 克隆并构建服务器

```bash
git clone https://github.com/shj200609-blip/codex.git
cd codex
cd codex-rs
cargo build --locked -p codex-cli -p codex-app-server -p codex-code-mode-host -p codex-exec-server
cd ..
```

构建出的 `codex`、`codex-code-mode-host` 和 `exec-server` 应保留在同一个 `codex-rs/target/debug/` 目录。官方 IDE 的 Code Mode 工具需要后两个运行时组件；只构建 CLI 可能能够连接，却无法执行工具。

Rust / V8 构建依赖较大。当前基线在 macOS ARM 上曾遇到 V8 预编译资源下载 404；如果 host 构建失败，需要解决该依赖或提供经过兼容性验证的运行时组件，不能把“连接成功”当成“工具可用”。详见 [shared server 文档](docs/shared-app-server.md)。本仓库不提交本机运行时二进制或用户凭据。

### 2. 安装 Changes 插件

在仓库根目录运行：

```bash
code --install-extension releases/codex-changes-review-0.5.0.vsix
```

也可以下载 [0.5.0 VSIX](https://github.com/shj200609-blip/codex/raw/refs/heads/main/releases/codex-changes-review-0.5.0.vsix)，在 VS Code 扩展视图右上角选择 **Install from VSIX... / 从 VSIX 安装...**。

使用原来的 VS Code 用户配置与登录。无需新建隔离 profile。打开需要审核的项目，并确认它是受信任的本地工作区。

## 启动和使用

### 1. 启动 Shared App Server

在终端 A、仓库根目录运行，并保持这个终端打开：

```bash
./codex-rs/target/debug/codex app-server --listen ws://127.0.0.1:4510
```

服务器读取启动它的用户的正常 Codex 配置和凭据。模型、认证和服务器级 feature 配置由服务器负责。这不会替换系统安装的 `codex`。

### 2A. 通过终端 CLI 发起修改

在终端 B 切换到 VS Code 打开的同一项目：

```bash
cd /path/to/your/project
/absolute/path/to/codex/codex-rs/target/debug/codex --remote ws://127.0.0.1:4510
```

`/absolute/path/to/codex` 是步骤 1 克隆的仓库路径。保持正常 TUI 操作：输入 prompt、看流式输出、批准工具、Ctrl+C 中断、继续下一轮。

在 VS Code 的设置 JSON 中配置 reviewer：

```json
{
  "codexChanges.connectionMode": "websocket",
  "codexChanges.websocketUrl": "ws://127.0.0.1:4510"
}
```

也支持仅对这次 CLI 启动设置环境变量：

```bash
CODEX_APP_SERVER_URL=ws://127.0.0.1:4510 /absolute/path/to/codex/codex-rs/target/debug/codex
```

需要恢复某个 thread 时使用 `--remote ... resume THREAD_ID`。显式 shared 连接失败会报错，不会静默创建 local Session。退出 CLI 不会关闭 shared server。

### 2B. 通过官方 Codex IDE 插件发起修改

安装官方 `openai.chatgpt` 插件后，在普通 VS Code 窗口中只需做一次：

1. 打开命令面板：macOS 按 **Cmd+Shift+P**，Linux 按 **Ctrl+Shift+P**。
2. 执行 **Codex Changes: Connect Codex IDE to Shared Server**。
3. 填入 `ws://127.0.0.1:4510`，选择本仓库构建的 `codex-rs/target/debug/codex`。
4. 结束原有聊天，然后执行一次 **Developer: Reload Window**，切换现有 IDE 连接。
5. 在当前项目中新建 Codex 聊天，再发起修改请求。

连接保存到现有 VS Code profile；以后打开受信任的本地项目会自动连接，无需每次登录、重载或运行演示脚本。shared server 仍需保持运行。连接断开会自动重试，不会自动切换到另一个 local Core。

该流程只配置官方 IDE 的 `chatgpt.cliExecutable`，通过 stdio ↔ WebSocket proxy 连接到 shared server；非服务器辅助命令保留原来的官方执行程序。可执行 **Codex Changes: Restore Original Codex IDE Connection** 恢复原配置。

**旧聊天的 cwd 不会随新窗口改变。** 切换项目后请新建聊天，避免继续对旧项目发起请求。可执行 **Codex Changes: Show Connection and Workspace** 检查 endpoint、工作区和 ChangeSet 身份。

### 3. 审核修改

在 CLI 或 IDE 中请求：

```text
用 apply_patch 修改 src/a.rs 中两处相隔较远的内容。
```

Turn 完成或中断并完成收尾后，左侧 Activity Bar 的 **Codex Changes → CHANGES** 自动显示对应文件和 Hunk。点击打开 Diff，选择一个 Hunk 的 **Accept Change**，另一个的 **Revert Change**。无需同步文件或复制 thread ID。

Accept 只记录决定，Revert 才回退磁盘内容。请先保存或放弃目标文件的未保存编辑；Conflict / Unsupported 不会强制覆盖文件。

如果右侧 Codex 已执行修改而 CHANGES 为空，先检查：双方 endpoint 是否一致、聊天 cwd 是否为当前项目、工具是否真的执行成功，以及这次修改是否通过 `apply_patch` 完成。

## Producer / Observer 规则

线程创建者或在旧 producer 断开后驱动 Turn 的 client 拥有该线程的交互请求。订阅、warm resume 或读取 ChangeSet 不会转移 ownership。工具、命令和 patch 审批仅发给 producer；服务器检查响应归属，reviewer 不能抢答或拒绝。

多个 client 可观察同一线程。任一 reviewer 的 Accept / Revert 会在同一个服务器中更新状态并通知其他订阅者。不同项目默认只看到与自己 cwd / workspace 对应的线程修改。

## 源码与开发

```text
codex-rs/core/                   ChangeSet 基线、定位、安全回退、session 内存
codex-rs/protocol/               Core ChangeSet 类型
codex-rs/app-server/             authoritative Session、review API、订阅、审批路由
codex-rs/app-server-protocol/    v2 API 和生成的 JSON / TypeScript schema
codex-rs/app-server-client/      Rust remote client、stdio ↔ WebSocket proxy
codex-rs/cli/ + tui/             现有 TUI 的 shared backend
vscode-extension/               Changes Tree、native diff、CodeLens、IDE 接入
releases/                       可安装的最终 VSIX
```

从源码构建和验证插件：

```bash
cd vscode-extension
npm ci
npm run typecheck
npm test
npm run build
```

打包：

```bash
npx @vscode/vsce package --no-dependencies --no-rewrite-relative-links --out ../releases/codex-changes-review-0.5.0.vsix
```

当前自动化覆盖协议/状态/定位/冲突/审批隔离等 51 个 Node 测试。`npm run smoke` 使用真实 debug App Server 和确定性 mock 模型测试 stdio / WebSocket 的 patch 与 review；`npm run host:shared-cli` 使用真实 Rust TUI、shared server、两个 VS Code Extension Host 验证完整链路、第二轮、审批和 workspace 隔离。模型推理使用 mock，工具执行与文件修改使用真实 Core。鼠标交互与可见 UI 检查单独记录在 [手动验收清单](vscode-extension/MANUAL-ACCEPTANCE.md)。

插件直接引用 Rust 生成的协议类型，不维护第二份 wire model。本机原有 `codex-ide/{codex,vscode-extension}` 兄弟目录布局仍受支持，无需移动源码。

详细说明：[插件开发文档](vscode-extension/README.md) · [ChangeSet 语义](docs/change-set-review.md) · [Shared App Server 架构](docs/shared-app-server.md) · [上游构建说明](docs/install.md)。

## 当前限制

- `coverage = applyPatchOnly`：不记录任意 shell / MCP / hook / 后台进程写入。
- `storage = sessionMemory`：shared server 重启或线程卸载后，审核状态和基线可能丢失。
- 不包含 ChangeSet 持久化、Git 同步、Memory 或完整 Conversation UI。
- 二进制、非 UTF-8、过大文件、rename、symlink 和非精确 patch 等输入可能 Unsupported。
- review 接入仅支持 unauthenticated loopback `ws://`；未增加远程部署、TLS 或 daemon/service 安装。
- 官方 IDE 接入依赖当前支持的 CLI 启动协议与运行时兼容性；升级官方插件后需重新验证。

## 上游与许可

基于 [openai/codex](https://github.com/openai/codex)，保留上游历史、[Apache-2.0 LICENSE](LICENSE)、[NOTICE](NOTICE) 和其他第三方许可。本 fork 的 README 与插件说明用于介绍 shared Changes Review；原有 Codex 使用文档见 [OpenAI Codex 文档](https://developers.openai.com/codex)。
