
# DSH WSL 插件规划：把「当前目录」变成 Linux 工作环境

> 目标读者：你自己（决策者）和我（实现者）。
> 基线环境：DSH Desktop `0.2.2-rc.1`，profile `desktop`，WSL2 `Ubuntu-24.04`，当前工作目录 `\\wsl.localhost\Ubuntu-24.04\home\chronos\develop`。
> 暂定包名：`dsh-remote-wsl`（备选 `dsh-wsl-attach`）。

---

## 0. 一页结论

1. **不要做「一堆 wsl_* 工具」**。那是给 Windows 会话加外挂，模型仍然要在两套路径和两套 shell 之间做选择，正是你想避免的东西。
2. **要做的是「会话级执行世界」**：同一个 DSH 窗口、同一个会话，把 `bash / read / write / edit / grep / glob / terminal` 全部换成 Linux 侧实现，**模型看到的 cwd 和所有路径都是 `/home/...`**。
3. **VS Code WSL 的本质不是「转发文件」，而是「换执行端 + 换路径命名空间 + 一条长连接」**。DSH 里对应的缝是 Agent Preset（每会话可挂不同 provider），不是工具层。
4. **社区已经有 5 个能用的实现**（最成熟的 `dsh-wsl-workspace` 已到 0.7.13）。我们不重复造，差异点只有四个：**打开即用（按 UNC 路径自动绑定）、模型侧路径统一为 Linux、常驻 RPC 而不是每次 `wsl.exe`、跨 DSH 版本不脆**。
5. 推荐分档：**M0 已完成**（传输 0.4 ms vs 124 ms，≈300×；注入方式已定）→ M1 可用 2–3 天 → M2 完整体验 2 天 → M3 稳定性 1–2 天。**5–8 人天**做到自用级；「WSL 内跑完整 DSH」是另一个项目（+3–5 天），不建议放进 v1。

---

## 1. 先看你机器的实测现状（这决定了设计细节）

我在规划前做了四项实测，其中三项会直接改变方案：

| # | 实测 | 结果 | 影响 |
|---|---|---|---|
| 1 | 当前目录形态 | `\\wsl.localhost\Ubuntu-24.04\home\chronos\develop` | 这是 **Windows 9P 网络重定向**，不是本地盘：每次 `stat`/`readdir` 3–16 ms，大目录遍历能到 20 s |
| 2 | 我在这个目录写文件 | **失败**：`permission denied`（DSH 的 `write` 和 PowerShell 的 `Out-File`、`.NET File.Create` 全都失败） | 你现在这个会话**根本改不了代码**。原因见第 3 条 |
| 3 | 这个目录的 Linux 属主 | `drwxr-xr-x root root`，而你是 `uid=1000(chronos)`，`sudo` 需要密码 | 谁都写不进去。`sudo chown -R chronos:chronos ~/develop` 才能修好。同时说明：**任何「靠 Windows 侧写 UNC」的方案在你机器上都是死路** |
| 4 | WSL 里的工具链 | Ubuntu 24.04.4 / kernel 6.18 / node v22.22.3 (`~/.local/bin`) / python3.12 / git 2.43 | **常驻 helper 进程可行，且零安装**（node 和 python3 都在），不必退回「每次 `wsl.exe`」 |
| 5 | DSH 版本 | `0.2.2-rc.1` | 社区插件大多声明到 `0.2.1-rc.something`。**你的版本比它们都新**，这本身就是「自己写」的一个理由：升级后它们可能直接加载失败 |

> 第 2/3 条是这次规划里最重要的发现：你现在不是「慢」，是「写不了」。

---

## 2. VS Code 的 WSL 插件到底是什么原理

`ms-vscode-remote.remote-wsl` 是 Remote Development 四件套之一（SSH / WSL / Containers / Tunnels）。它常被误解成「让 VS Code 能打开 WSL 路径」，实际是**远程开发架构的一个特例**。

### 2.1 五个机制

| 机制 | 做法 | 为什么关键 |
|---|---|---|
| **① 双进程** | 本地是 Electron UI；WSL 里跑一个 `VS Code Server`（装在 `~/.vscode-server/bin/<commit>/`） | 所有重活（文件 IO、搜索、终端、语言服务、调试）在 Linux 内核侧跑，不走 9P |
| **② 远程权威（remote authority）** | 工作区 URI 是 `vscode-remote://wsl+Ubuntu-24.04/home/me/proj`，`wsl+发行版` 就是「在哪台机器上执行」的身份 | 环境成为**可持久化、可重开**的一等身份，而不是一次性的路径转换 |
| **③ 扩展分端** | 工作区扩展装到远端并在 WSL 内运行；UI/主题类扩展（`extensionKind: ui`）留在本地 | 插件看到的是 Linux 的 `process.platform`、Linux 路径、Linux 依赖，不需要任何适配 |
| **④ 连接通道** | 客户端用 `wsl.exe` 把服务器拉起来（**不需要 sshd、不监听公网端口**），再通过该子进程的 stdio 建立隧道（本质是本地端口/管道转发） | 免配置、免密钥、免防火墙；断线重连用同一套 authority 重建 |
| **⑤ 单向路径转译** | `wslpath` / `\\wsl$` 只在「从 Windows 打开」和「在 Windows Explorer 看」这类边界上用 | 内核工作流内部**只有 Linux 路径**，不存在两套路径并存 |

### 2.2 它为什么「稳定、快、方便」

- **快**：文件、搜索、git、构建全部在 ext4 上，`inotify` 可用；9P 只在极少数边界出现。
- **稳**：路径语义只有一套；不依赖「Windows 能不能写 UNC」这种由 9P + ACL 决定的不确定行为。
- **方便**：打开文件夹就完事，没有「模式选择」「先起服务」「先装依赖」；发行版、工作区、历史都记在 authority 里。

### 2.3 它不做什么

- 不做「Windows 侧跑、Linux 侧执行」的混合模式——那是 Dev Containers 的 `mounts` 才勉强做的事。
- 不在 Windows 侧做路径翻译层；因此也没有「模型输出里混着 `C:\` 和 `/mnt/c`」的问题。

---

## 3. 映射到 DSH：概念对照与差距

DSH 没有「远程 host」概念（`0.2.2` 的 Host 服务表里没有 remote transport；`ssh` 服务是给工具用的）。所以 VS Code 那套不能照抄，要映射：

| VS Code | DSH 对应物 | 现状 | 缺口 |
|---|---|---|---|
| UI 进程 | Electron/Web GUI | 有 | — |
| 远程 server + 扩展宿主 | **会话级 Agent Preset**（可 `isolate` 并替换 `fs` / `shell` / `sandbox` / 搜索套件） | 机制存在 | 没有内置 WSL 世界；社区靠「读宿主 preset 文本再改写」实现，脆 |
| remote authority | 会话 cwd + workspace 注册表 | cwd 是 Windows 路径 | 没有「distro + linux cwd」这个身份 |
| 扩展装到远端 | 无需安装（用 distro 自带 node/python 做 helper） | 可做到 | 需要设计传输与降级 |
| 端口转发 | 不需要（agent 直接执行命令） | — | — |

**关键结论**：DSH 里唯一能「按会话换执行端」的缝是 **preset 的 isolate 世界**。工具层的 `wsl_*` 只是外挂，改变不了「当前目录是不是 Linux」这件事。

DSH 里还有两个被低估的缝：

- `ctx.workingDirectory.set(agent, path)`：把会话「生效工作目录」改成另一个绝对路径，模型收到的是 `Current working directory: <json>` 的**用户上下文**，且会跨重放保存。这是让模型看见 `/home/...` 的官方入口。
- `ctx.systemPrompt.context()` / `section()`：注入「你在 WSL 里」的环境事实与路径规则，且不进系统提示词前缀（不破坏 KV cache）。

---

## 4. 社区 DSH WSL 插件盘点

生态里 WSL 分类有 **85 个**插件，真正解决「执行环境」的只有 5 个。按 30 天下载量 / 星标排：

| 插件 | 下载/星 | 一句话思路 |
|---|---|---|
| `XINY11451/dsh-wsl`（npm `dsh-wsl-tool`） | 6275 / ★10 | 十个 `wsl*` 工具 + 侧栏面板 + 在 WSL 终端里敲 `dsh` |
| `yishuiliufang/dsh-wsl-first` | 1288 / ★1 | 只加一段系统提示词，让模型优先用 WSL 执行 |
| `LyuYuxin/dsh-wsl-folder` | 881 / ★1 | 侧栏「添加工作区」支持 WSL 目录；终端开在发行版里；补 UNC 写文件 |
| `WilliamShi666/dsh-wsl-workspace-picker` | 852 / ★2 | 只改目录选择器 UI（`/mnt` 直达、面包屑） |
| `Wang1462604987/dsh-wsl-sidebar` | 774 / — | WSL 控制台：管发行版、编辑 `.wslconfig`、`wslx-*` 工具 |
| `TGWgulugu/dsh-wsl-bridge` | 664 / ★2 | `wsl_*` 工具 + 新建会话时的 **WSL 模式**（替换 bash/read/write/edit/grep/glob） |
| `6Mikao9/dsh-wsl-workspace` | — / ★106 | 最完整：GUI 加 WSL 工作区 + 四个 `wsl-*` 模式变体 + PTY + 发行版内搜索 + 技能目录 |
| `Han-1413141/dsh-wsl-native` | — / ★3 | 双层：WSL 工具 + 在 WSL 里跑一个完整 DSH，同窗口内嵌切换 |

### 4.1 四条路线

```
路线 A：提示词层      dsh-wsl-first, dsh-wsl-env
        └ 只影响模型习惯，不改执行端        —— 便宜，但没有实质改变

路线 B：工具外挂      dsh-wsl, dsh-wsl-native(前一半), dsh-wsl-sidebar
        └ 新增 wsl_* 工具，Windows 工具仍在  —— 模型要选，双份路径并存

路线 C：执行世界      dsh-wsl-bridge, dsh-wsl-workspace
        └ 新建会话选 WSL，替换整套工具       —— 方向正确，体验最好

路线 D：双环境        dsh-wsl-native(后一半)
        └ 在 WSL 里再跑一个 DSH，窗口内切换  —— 最接近 VS Code，成本最高
```

### 4.2 逐个点评（只挑值得对标的）

**① `6Mikao9/dsh-wsl-workspace`（路线 C，最成熟，值得认真对标）**

- 优点：
  - 真正做到了「一整套世界」：bash（有状态 PTY）、fs、grep/glob（发行版内 GNU 工具）、技能目录、后台任务、访问模式（workspace-write 围栏）全部补齐。
  - 刻意做到**零安装**：PTY relay 跑在宿主 node 上、把 stdio 交给 `wsl.exe ... bash`，distro 里什么都不装。
  - 兼容矩阵做得极细（12 个 DSH 版本、每版 13–15 项检查），changelog 把每个坑写清楚了——**这是最好的免费教材**。
- 缺点：
  - **模型看到的是 UNC 路径**（它的 fs provider 底层仍是 `\\wsl.localhost` 共享），你想要的「AI 在 Linux 路径里」只做到一半。
  - **写文件有硬伤**：9P 上 `rename` 是 `ENOTSUP`、DACL 是 `EIO`，它的绕法是符号链接 + 权限判断，复杂且慢；你机器上 `develop` 目录 root 属主，它同样写不了。
  - **靠改写宿主 preset 文本**（改 persona 的 `suffix`/`prefix`、往 YAML 里插行）。DSH 0.2.2 的 preset 面已经换过一轮（`read()` → `readDocument()`），每次升级都要修；它自己声明的是到 `0.2.1-rc.2`。
  - 体量大（1.7 MB 未压缩、45 个文件），调试成本高。

**② `XINY11451/dsh-wsl`（路线 B，装机量最大）**

- 优点：工具面最全（`wsl` / `wsl-path` / `wsl-env` / `wsl-doctor` / `wsl-bootstrap` / `wsl-term` / `wsl-read|write|edit|grep`）；`wsl-doctor` 会告诉你「这个项目缺什么、PATH 上的 `npm` 其实是 Windows 的」——这个洞察非常好，值得抄。侧栏终端可改 `terminal-controller` 行，`dsh` 命令能在 WSL 终端里用。
- 缺点：**Windows 工具原样保留**，模型每个任务都要在 `bash` 和 `wsl` 之间选；cwd 仍是 Windows 目录（默认「跟随会话工作区」= `/mnt/d/...` 或 UNC），相对路径经常落到 `~`；每次调用起一个 `wsl.exe`（它自己承认冷启动开销）；终端协作那套要插件在浏览器里挂桥，DSH 0.2.1 之后就重写过。

**③ `TGWgulugu/dsh-wsl-bridge`（路线 C，最接近我们的目标形态）**

- 优点：**新建会话选 WSL → 整套工具换成 Linux**，且工作区从 `$HOME` 里挑；`wsl_bash` 是每会话一个持久 shell；文件工具带 `sha256` 乐观锁；有危险命令守卫和 `promptSection` 路由提示。
- 缺点：**cwd 仍是 `wslpath -w` 出来的 UNC 路径**（README 明说「chosen directory is whatever `wslpath -w` prints」），所以模型仍会看到 `\\wsl.localhost\...`；会话开始后不能换模式；`grep/glob` 不读 `.gitignore`；整体比 6Mikao9 薄。
- 但它验证了一件重要的事：**「模式」这个交互是对的**，而且不用改宿主 preset 文本就能挂世界（`wsl-world.js` 单独导出）。

**④ `LyuYuxin/dsh-wsl-folder`（路线 C 的轻量版，最像「把当前目录接进 WSL」）**

- 优点：改的是**工作区入口**而不是工具——「+」里多一个「WSL 文件夹」，Linux 目录注册成 `\\wsl.localhost\...`；侧栏终端自动 `wsl.exe --cd`；专门修了 UNC 写文件（`ENOTSUP`/`EIO`）和「丢开头反斜杠变成 `C:\wsl.localhost\...`」这两个真实 bug。
- 缺点：作者自己写明「**agent 的工具仍是 Windows 的**」，只是能读写，速度慢；靠包装 `TerminalController.spawn`、`LocalFileSystem.writeText`、甚至**进程级 monkey-patch `node:fs`** 实现——这类方案在宿主升级时第一个碎。

**⑤ `Han-1413141/dsh-wsl-native`（路线 D，最接近 VS Code 的真正形态）**

- 优点：唯一做到「同一个窗口里跑两套 DSH」的方案；常驻进程通信，短命令中位 4.6 ms（对比每次 `wsl.exe` 289 ms，**62 倍**）——这个数据说明传输层值多少钱；双向文件复制带 sha256；环境交接。
- 缺点：要求在 WSL 里装 Node + npm + 一整套 DSH（安装、更新、插件继承都要管）；两套会话数据不互通；体量与维护成本最高。

### 4.3 它们共同的五个天花板（也就是我们的机会）

1. **cwd 都还是 Windows 形态**：UNC 或 `/mnt/...`。模型仍会时不时写出 Windows 路径——这是你抱怨的核心，没有一个插件真正解决。
2. **注入方式都脆**：要么改写宿主 preset 文本、要么包装内部方法、要么进程级 patch `node:fs`。
3. **传输要么慢要么依赖**：每次 `wsl.exe` ≈ 0.3 s；常驻进程要 node；9P 写不可用。
4. **沙箱语义丢失且说明不足**：WSL 内的写不受宿主 ACL 约束，多数插件只在 README 里提一句。
5. **没有「环境身份」**：不像 `vscode-remote://wsl+Ubuntu` 那样可持久化、可重开、可迁移。

---

## 5. 我们的方案

---

> 以下为 2026-11-08 v1.8.0 的当前状态。早期 5–13 节的详细历史在一次
> PowerShell 5.1 编码事故中损坏；原始损坏文件保留为 `PLAN.corrupted.md`。
> 当前实现、验证证据和边界以本节为准。

## 5. 当前实现（v1.8.0）

### 5.1 架构

- **Host 行** `dsh-remote-wsl`：注册 `/dsh-remote-wsl/*` 路由；包装
  `sessionController.create`、`workingDirectory.contextText`、
  `fileReferences.list`、`workspaceChanges.summary/diff`。
- **WSL preset** `wsl`：隔离 `fs`/`subprocess`/`shell`，挂 `fs-service`、
  `search-tools`、`tool-bash`、`tool-fs`、`tool-worktree-wsl` 等；模型看到
  Linux cwd，实际工具都在发行版里。
- **broker**：每个 `(distro,user)` 一个常驻 helper，NDJSON RPC；命令通过
  `wsl.exe -- node helper` 进入，clean login PATH 剔除 `/mnt`。
- **设置** `~/.dsh/remote-wsl-settings.json`：per-distro user、defaultDistro；
  panel、world、search、`@` 共用。

### 5.2 1–5 项状态

| 项 | 状态 | 关键文件 |
|---|---|---|
| Doctor / 一键修复 | Host live：`/doctor`、`/doctor/fix`（node/ssh-key/ssh-config）；panel 代码已装 | `src/doctor.mjs`、`host.js`、`client.js` |
| WSL diff recorder | live 验证 `source:"wsl"`；晚到 seq 用 turn 映射；Host 回退 | `src/wsl-diff-v2.mjs`、helper git ops |
| 兼容探针 / CI / 元数据 | `/state.capabilities` 8 项；`icon.svg`、`locale/*.json`、CI、CHANGELOG | `host.js`、`package.json`、`.github/workflows/ci.yml` |
| 每发行版/用户配置 | 设置 GET/POST live；root 默认自动切到第一个普通用户；panel 用户下拉；诊断仅按钮触发 | `src/settings.mjs`、`src/doctor.mjs`、`world.js` |
| 非 root 默认/图标/名称 | Ubuntu-26.04 创建 `chronos` 并写入设置；新 26.04 会话 `whoami=chronos`；panel/icon 企鹅轮廓；显示标题 `WSL` | `client.js`、`icon.svg`、`locale/*.json` |
| SSH / 网络 / 搜索 / 终端 | SSH key/config 修复、`.wslconfig` 检查、`rg --files` 优先、终端 clean PATH live 探针 | `src/doctor.mjs`、`src/helper.mjs`、`terminal-launcher.mjs` |
| WSL worktree（附加） | `create_wsl_worktree` 单元测试 5 项；1.3.5 live 调用返回 path/branch/base；1.8.0 的 info/exclude 变更等下次重启 | `worktree-tool-v2.mjs` |

### 5.3 验证证据

- 全部测试通过：preset-default、changes-paths、search-gitignore、file-refs、
  git-diff、wsl-diff、worktree、path、launch。
- 实际 WSL diff：`session-2e63...` 编辑 `diff-live-4.txt`；`/changes` 返回
  `source:"wsl"`、`cwd` UNC、相对路径、added 2；`/changes/diff` 返回
  `+one`/`+two` hunk。`wslDiff.stats`：`summaries=1, late=1, entries=1,
  errors=0`。
- 1.3.6 live：`session-0c44...` 调用 `create_wsl_worktree` 返回
  `/home/chronos/dsh-final-test/.agents/worktrees/live-2`、`dsh/live-2`、
  `c1ccd27...`；`session-5e1e...` 的 `/changes` 只列 `verify-live-2.txt`，
  不含 `.agents/worktrees`，diff 为 `+three`。
- `node tools/verify-live.mjs` 在 12450 端口：HOST ACCEPTANCE PASS（1.8.0、
  capabilities、doctor node/PATH、settings）。
- Doctor live：Ubuntu-24.04（chronos，node v22.22.3）、Ubuntu-26.04（chronos，
  node v22.22.1）；两发行版登录 PATH `/mnt 21 → 0`。
- 1.8.0 非 root：创建 Ubuntu-26.04 用户 `chronos`，设置写入
  `{"Ubuntu-26.04":"chronos"}`；新 26.04 WSL 会话 `whoami=chronos`、
  `pwd=/home/chronos/dsh-user-test`。
- 1.8.0 修复：`userFromLinuxPath` 移到新 `src/path-user.mjs`，绕开 live
  升级时旧 `settings.mjs` 模块缓存导致的 named export 激活失败。
- 1.8.1 变体：新增隐藏 `wsl-ptc`/`wsl-minimal`，PTC 保持 run_code，
  Minimal 用 read_image + `wsl_term` 持久 shell。
- 1.8.0 架构：WSL 不再是可见模式；新增隐藏 `wsl-standard`/`wsl-cordis`
  变体，按全局模式映射；roster 过滤内部 preset；模型/权限保持全局。
- 1.8.0 修复：`glob`/`grep` 在 rg 路径也 prune node_modules；新增
  client bundle/packaging contract 测试、release check；CI 跑全部 pure 测试。
- 1.8.0 工具：`wsl_term` 增加原始 `input` 与 `resize`，可驱动 TUI/REPL。
- 1.8.0 修复：client bundle id 改为包名 `@chronosun/dsh-wsl`；之前是
  `dsh-wsl`，导致 client-modules 报 loaded without registering / duplicate。
- 1.8.0 修复：`wsl_term` 输出 schema 的 exitCode 改为单一 number，避免
  工具 schema 校验拒绝；文档补充 Windows CWD 和旧 terminal patch 迁移。
- 1.8.0 工具：`wsl_term` 持久 PTY（run/read/interrupt/close，每会话一个
  shell）；面板新增只读项目检查卡（/doctor/project + 路径输入）。
- 1.8.0 工具：新增 `wsl_bootstrap`（node/python/build/tools 配方，默认
  dry-run，显式 dryRun:false 才以 root apt 安装）；Doctor 增加 python/build/tools。
- 1.8.0 工具：新增模型侧 `wsl_path`（Linux/Windows 路径互转）和
  `wsl_project_check`（只读项目 doctor：manifest + 工具探测）；合并重复
  engines，DSH 范围放宽到 >=0.2.2-rc.1。
- 1.8.0 面板/文档：首屏 Linux Node 就绪卡 + 安装 CTA；Doctor 增加 kernel/
  systemd/cgroup/docker/GPU/mounts；市场标题改为 WSL World，README 增加
  “完整 world 而非 wsl_* 工具集”对比、安全边界和提交文案。
- 1.8.0 发布元数据：`repository`/`homepage`/`bugs` 指向
  `chronosun/dsh-plugin`；`market/index.json` 为 format 1 索引，
  `.github/workflows/pages.yml` 部署到 GitHub Pages。
- 1.8.0 发布名：npm 包名/`cordis.patch` 子路径改为 `@chronosun/dsh-wsl`
  （`dsh-wsl` 被 npm 判为与 `is-wsl` 太相似）；host/client id/route 保留
  `dsh-wsl`；旧 `dsh-remote-wsl` 必须先卸载。
- 1.8.0 面板：distro/broker 缓存 + localStorage + apply 预加载，tab 栏立即
  出现；首次无缓存显示“加载发行版…”骨架。
- 1.8.0 面板：发行版 tab 改为底部规则线 + 激活项 accent 文字和 2px 下划线，
  去掉不明显的浅灰 pill。
- 1.8.0 面板：发行版改成简单 tab bar（选中 accent 下划线），下方显示选中分支的
  user@home、node、broker 状态/refcount 和连接按钮。
- 1.8.0 面板：去掉用户下拉；`/home/<user>`、`/root` 路径选择 Linux 身份；
  长说明收进 `?` 帮助按钮；broker 行按配置用户匹配并优先 ready。
- 1.8.0 面板：发行版下拉支持点击页面其他位置/Escape 自动收起。
- 1.8.0 面板：添加工作区改为深色 split button（plus + 文案 + 分隔线 +
  chevron）；右侧菜单选发行版并直接打开该发行版的目录选择器。
- 1.8.0 面板：左栏设置/发行版/连接/空闲，右栏诊断与修复，外层
  `maxWidth:1180` + flex-wrap；client 代码语法通过，视觉渲染待页面刷新。
- 1.8.0 idle/icon：默认 `idleDays=5`（源码/设置测试通过）；企鹅轮廓（无蓝色
  tile）用 Edge headless 渲染检查；面板打开不再自动诊断，仅点击按钮；
  `npm publish --dry-run` 打包 29 个文件成功，但 npm 未登录，真实发布待
  `npm login`。
- 终端探针：24.04 与 26.04 的交互 shell 都是 `chronos`，PATH 无 `/mnt`。
- 设置 live：GET/POST 正常；SSH config 幂等（1 个 `Host *`）；node fix
  `ALREADY`。
- 清理：eval bridge 已移除，测试 Session 归档，临时 workspace/repo 删除；
  `dist/` 只保留 `dsh-remote-wsl-1.8.0.tgz`。

### 5.4 已知边界

- **1.8.0 live 加载**：plugin_manager 报 `restart-required`；Host 端 idle 单位/
  默认值、client 企鹅 tile 和用户下拉要重启后生效。1.4.0 的 Host/Doctor/Settings/
  terminal 已验证 live。
- **发布**：npm 未登录（`ENEEDAUTH`）；包已按 `dsh-remote-wsl@1.8.0` 打包，
  需用户 `npm login` 后 `npm publish`。`dsh-wsl` 名称也可用，但需要完整 rename。
- **非 root 用户**：Ubuntu-26.04 的 `chronos` 是 locked password、没有 sudo；
  需要 sudo 时由用户自行配置。24.04 的 chronos 原有 passwordless sudo。
- **名称**：显示标题已改为 `WSL`；包 id 仍是 `dsh-remote-wsl`，避免破坏
  profile/路由。`dsh-wsl` 是完整 rename（包名、profile 依赖、include id、
  route/id），未做。
- **面板视觉**：Doctor/Settings 的 Host 端点已 live，页面渲染没有浏览器控制，
  仍需要人工看一眼。
- **Worktree**：上游 `create_worktree` 的“进入 checkout”语义没有复刻；本工具
  只创建并返回路径，cwd 不变。根因已确认：ToolExecution 的 `agent` 没有
  `cwd` 字段，旧代码退化成 `/`；v2 用 `session.header.cwd`。
- **WSL diff 晚到竞态**：摘要晚于 Host 事件时用 seqByTurn 补映射；卡片首次
  请求可能先拿到 Host 回退（数据正确，来源不同）。
- **沙箱/权限映射**：Host read-only/workspace-write 不约束 WSL 内写入；建议
  普通用户，不要 root；路径 guard 留待 P2。
- **Forge/Change request** 的 WSL 原生集成未接。

### 5.5 发布清单

- 包名 `dsh-remote-wsl`，版本 1.8.0，profile 指向
  `dist/dsh-remote-wsl-1.8.0.tgz`。
- 依赖：DSH Desktop 0.2.2-rc.1 tested；其他 0.2.x capability-probed。
- 元数据：企鹅 tile `icon.svg`、`locale/en.json`/`zh.json` 的 `title: WSL`、
  README 兼容表、CHANGELOG、LICENSE、CI 纯单测。
- 默认用户：root 发行版自动选第一个普通用户；26.04 已创建 `chronos`。
- 默认空闲：5 天（`idleDays`，0 = 永不），设置持久化。
- 发布：`dsh-remote-wsl@1.8.0` 已 `npm publish --dry-run`；npm 未登录，
  真实发布需 `npm login`。`dsh-wsl` 名称未占用，但需完整 rename。
- 运行要求：发行版内有 Linux node（Doctor 可装）；默认普通用户；SSH key
  由用户点击生成。

### 5.6 版本历史（简）

- 0.x：M0/M1 原型；UNC 写失败修复；broker/fs/search。
- 1.0.x：preset 自动绑定、Linux model cwd、clean PATH、gitignore 搜索、
  `@`/diff 路径映射；现场 bug 修复。
- 1.1.x：Doctor、settings、capabilities、metadata、CI、WSL diff companion。
- 1.2.x：WSL worktree 工具。
- 1.3.x：diff exec 回退/晚到映射/stats/source；worktree v2 header fallback；
  清理旧模块。

### 5.7 下一步

1. 人工确认 WSL 面板 Doctor/Settings 渲染；下次重启会加载 1.8.0 的
   worktree info/exclude 变更。
2. 视需要做 WSL 沙箱/权限 guard、Forge 集成、worktree enter 语义。
