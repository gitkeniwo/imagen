# Imagen → macOS 桌面 App（Tauri 2）重构计划

> 给实现 agent 的说明：按阶段顺序实现。每个阶段末尾的「完成标准」就是验收方的检查项。
> 写在前面的「安全红线」是硬性约束，违反任何一条都直接判不通过。

---

## 0. 安全红线（必须遵守）

1. **禁止读取、复制、移动、改写 `backend/data/`**，包括 `app.db*`、`images/`、`thumbs/`。用户的真实数据迁移由用户本人手动完成，见 §8。
2. **所有本地运行和测试都必须设置 `IMAGEN_DATA_DIR`**，指向会话临时目录（例如 `$TMPDIR/imagen-verify-*`）。不允许让桌面 App 用默认数据目录启动，因为这个目录以后就是用户的真实数据位置。
3. **不对真实 Vertex 项目发起生成请求。** 测试错误路径时，在隔离实例里填一个假的 project。
4. 不要 kill 端口 8000 或 47860 上已经在跑的进程，那可能是用户的 Docker 容器或正在用的 App。测试一律用 `IMAGEN_PORT` 指定其他端口。
5. Docker 部署路径（`Dockerfile`、`docker-compose*.yml`、`.github/workflows/docker-ghcr.yml`）必须继续可用。后端改动要同时兼容这两种运行方式。
6. **只用合成数据。** 测试用的图片、草稿、历史、标签全部由 `desktop/scripts/seed_synthetic.py`（见 §5 阶段 1）生成。
   **永远不要打开、列目录、复制或统计**以下位置：
   - `backend/data/`
   - `~/Library/Application Support/com.gitkeniwo.imagen/`（以后的真实数据目录）
   - `~/Library/WebKit/com.gitkeniwo.imagen/`
   - `~/.config/gcloud/` 下的凭据内容（只能检查文件是否存在）
   - `~/Downloads` 里不是你自己创建的文件
7. **实现方没有视觉能力。** 所有自测都必须能用命令或脚本判定结果，例如 `curl`、`lsof`、`ps`、日志、退出码、SQLite 查询、页面向后端回传的结果。需要肉眼确认的项目，在交付说明里列为「待人工测试」，交给验收方。

---

## 1. 目标与非目标

**目标**
- 产出一个可以双击打开的 `Imagen.app`（**仅 macOS 15 及以上 + Apple Silicon，`aarch64-apple-darwin`**），不依赖 Docker，也不需要开终端。
- 常驻内存目标 ≤ 400 MB：Rust 外壳、WebKit 各进程、Python 后端加起来，在隔离库里有 50 张图片、浏览一遍之后测量。
- 冷启动到界面可用 ≤ 3 秒，不含首次 Gatekeeper 校验。
- 前端代码尽量不改，在浏览器和 App 里共用一份。

**非目标**
- 不用 Rust 重写后端。
- 不做 Intel 或 universal 构建，不做自动更新。
- 发行（DMG 上传到 GitHub Release、Homebrew tap）**由验收方在最后完成**，见 §11。实现方只需要让 `build.sh --dmg` 能在本地产出 DMG。
- **不用 Developer ID 签名，不做公证，也不加发版 CI**。只用 ad-hoc 签名（`signingIdentity: "-"`），供用户自己使用。
- 不加多用户和鉴权功能。

---

## 2. 版本选择（2026-10-20 核实）

| 组件 | 版本 | 说明 |
|---|---|---|
| `tauri` crate | **2.12.x**（最新 2.12.4，发布于 2026-10-14） | Cargo.toml 写 `tauri = { version = "2.12", features = [] }`，提交 `Cargo.lock` |
| `tauri-build` | 2.7.x | 与 tauri 2.12 配套 |
| `@tauri-apps/cli` | **精确锁定 `2.12.3`** | 放在 `desktop/package.json` 的 devDependency 里，提交 lock 文件 |
| `tauri-plugin-single-instance` | 2.5.x | 防止开两个实例，两个实例会同时写同一个 SQLite |
| `tauri-plugin-window-state` | 2.5.x | 记住窗口大小和位置 |
| `tauri-plugin-dialog` | 2.8.x | 用于原生错误弹窗和退出确认，只在 Rust 侧调用 |
| PyInstaller | 6.22.x | **不能**加进运行时 `dependencies`。放在 `backend/pyproject.toml` 的 `[dependency-groups] desktop` 里（非默认组，Dockerfile 里的 `uv sync --no-dev` 不会安装它），或者构建时直接用 `uv run --with pyinstaller` |
| 构建目标 | `aarch64-apple-darwin`，`MACOSX_DEPLOYMENT_TARGET=15.0` | 只考虑 macOS 15 自带的 WKWebView（WebKit），不需要兼容更旧的系统 |
| 本机工具链 | rustc 1.97.1、Node 26.7、uv 0.9.5、Xcode，arm64，macOS 15.7 | 都已具备 |

**不使用**以下插件：`tauri-plugin-shell`（用 `std::process` 起子进程就够了）、`tauri-plugin-opener`（前端没有外链），也不注入任何 `@tauri-apps/api` JS。

---

## 3. 总体架构

```
Imagen.app
├─ Contents/MacOS/Imagen                 Rust 外壳（Tauri 2）
└─ Contents/Resources/imagen-backend/    PyInstaller onedir（含 Python 运行时）
     ├─ imagen-backend                   可执行文件
     └─ _internal/ …                     依赖 + frontend_dist/（前端构建产物）
```

启动流程：

1. Rust 启动。先注册 single-instance；如果已经有实例在跑，就聚焦已有窗口并退出。
2. 创建主窗口，加载本地的 `splash/index.html`（显示「正在启动…」）。
3. 确定运行参数：
   - `port` = 环境变量 `IMAGEN_PORT`，没有就用默认的 **47860**（不用 8000，避开 Docker）。
   - `data_dir` = 环境变量 `IMAGEN_DATA_DIR`，没有就用 `app.path().app_data_dir()`，即 `~/Library/Application Support/com.gitkeniwo.imagen`。
   - `token` = 每次启动随机生成的 32 位 hex。
   - `log` = `app_log_dir()/backend.log`，即 `~/Library/Logs/com.gitkeniwo.imagen/`。
4. 用 `std::process::Command` 启动后端：
   - 环境变量：`IMAGEN_DATA_DIR`、`IMAGEN_PORT`、`IMAGEN_INSTANCE_TOKEN`。
   - stdin 设为 `piped` 并一直持有，用作「父进程存活」信号。
   - stdout 和 stderr 重定向到日志文件。
5. 每 100 ms 轮询一次 `GET http://127.0.0.1:{port}/api/health`，直到返回的 `token` 与本次生成的一致，超时 20 s。
   - 成功：`window.navigate("http://127.0.0.1:{port}/")`。
   - 失败：splash 页显示错误和日志路径，同时弹出原生错误对话框。
6. 退出时（处理 `RunEvent::Exit`）：drop 掉子进程的 stdin，后端收到 EOF 后优雅退出；最多等 5 s，超时就 `kill()`。

**为什么让后端来提供前端页面，而不是把前端打包进 Tauri**

- `api.ts` 里所有请求都是相对路径 `/api/...`。窗口直接加载 FastAPI 的 origin，前端就**一行都不用改**，也不需要配 CORS。
- 页面属于远程 origin，Tauri 默认不给远程 origin 开放 IPC。前端拿不到任何原生能力，攻击面最小。
- 端口固定的原因：`localStorage` 按 origin 区分，里面存了侧栏宽度、并发数、价格表等设置，端口一变这些就全丢了。

**孤儿进程防护**：Rust 不管是正常退出、崩溃还是被 kill -9，内核都会关闭它持有的管道，后端的 stdin 就会读到 EOF，然后自行退出。这个机制不依赖轮询 ppid。

---

## 4. 目录与文件变更

```
desktop/                         新增
  package.json                   devDep: @tauri-apps/cli@2.12.3；scripts 见 §6
  package-lock.json
  build.sh                       一键构建，见 §6
  imagen-backend.spec            PyInstaller spec
  splash/index.html              启动页和错误页（纯静态，无外部资源）
  src-tauri/
    Cargo.toml  Cargo.lock  build.rs
    tauri.conf.json
    capabilities/default.json    只授权给本地 splash 窗口，最小权限
    icons/                       用 `tauri icon` 生成
    src/main.rs                  入口
    src/backend.rs               启动、健康检查、关闭后端
    src/download.rs              下载处理
    resources/                   构建产物，不提交（在 .gitignore 里忽略）
backend/
  app/desktop.py                 新增：桌面模式入口
  app/main.py                    小改：DIST 路径解析、health 返回 token
  pyproject.toml                 新增 desktop 依赖组（pyinstaller）
.gitignore                       见 §5 阶段 1.5
.dockerignore                    见 §5 阶段 1.5
.github/workflows/docker-ghcr.yml  加 paths-ignore，见 §5 阶段 1.5
README.md / CLAUDE.md            新增「桌面 App」章节
```

`frontend/`：默认不改。只有 §7 的 spike 或验证发现问题时，才按 §7 列出的条件改动。

---

## 5. 分阶段实现

### 阶段 0：WebKit 长请求 spike（先做，决定后面要不要改协议）

**风险**：`POST /api/generate` 会被后端的重试和退避挂住好几分钟，期间一个字节都不返回。WebKit（WKWebView）底层的 URL 请求可能有 **60 s 空闲超时**。如果真有这个超时：

- 请求会被浏览器断开；
- 后端的 `request.is_disconnected()` 检测到断开，就会**中止这次生成**（见 `routes/generate.py` 里的 disconnect watcher）；
- 用户看到的就是生成莫名失败。

**做法**：在会话临时目录里写一个一次性的测试服务，不要放进仓库：

- 一个 Python 小服务，提供 `/` 页面和 `/slow?s=N` 接口（sleep N 秒后返回 JSON）。
- 一个最小 Tauri 窗口加载这个服务。页面里依次 `fetch('/slow?s=75')` 和 `fetch('/slow?s=200')`。
- 因为实现方看不到页面，每个请求结束后（成功或报错都算），页面要 `fetch('/report', {method:'POST', body: JSON})`，把耗时、状态码、报错信息回传给测试服务，由测试服务写入日志文件。
- 同时在服务端记录：每个 `/slow` 请求的连接是否在中途被客户端断开，以及断开的时间点。
- 判断完成后关闭进程、删除临时文件。

**判定**：
- 两个请求都成功：协议不用改，进入阶段 1。
- 有超时：按 §7.1 的「保活流式响应」方案改 `/api/generate`，作为阶段 2.5 执行。

**完成标准**：在交付说明里写明 spike 的结果，附上原始输出。

### 阶段 1：后端适配（Docker 不受影响）

1. `backend/app/main.py`
   - `DIST` 的解析顺序：
     1. 环境变量 `IMAGEN_FRONTEND_DIST`；
     2. 打包模式下（`getattr(sys, "frozen", False)`）用 `Path(sys._MEIPASS) / "frontend_dist"`；
     3. 现有的仓库相对路径。
   - `/api/health` 返回 `{"ok": True, "app": "imagen", "token": os.environ.get("IMAGEN_INSTANCE_TOKEN")}`。Docker 下 token 为 null，HEALTHCHECK 只看状态码，不受影响。
2. 新增 `backend/app/desktop.py`，提供 `main()`，用 `python -m app.desktop` 或作为 PyInstaller 入口：
   - 开头调用 `multiprocessing.freeze_support()`。
   - **如果没有设置 `IMAGEN_DATA_DIR`，立即报错退出**（退出码非 0）。这样打包后的后端绝不会把数据写进 `_internal/` 或仓库。必须在 import `app.db` 之前检查。
   - 读取 `IMAGEN_PORT`（默认 47860）。host 固定为 `127.0.0.1`，不能绑 0.0.0.0。
   - 用 `uvicorn.Config(app, host, port, loop="asyncio", http="h11", ws="none", lifespan="on", access_log=False, log_level="info")` 加 `uvicorn.Server` 启动。显式指定 loop/http/ws 是为了避开 uvicorn 的动态导入，减少 PyInstaller 的 hidden import 问题。
   - 起一个 daemon 线程阻塞读 `sys.stdin.buffer`。读到 EOF 时：设置 `server.should_exit = True`，再起一个 5 s 的 `threading.Timer` 兜底调用 `os._exit(0)`。
   - 只有设置了 `IMAGEN_PARENT_WATCH=1` 才启用 stdin 监听，由 Rust 传入。这样在终端手动运行时，不会因为 stdin 是 TTY 或 /dev/null 而误退出。
3. `backend/pyproject.toml`：添加 `[dependency-groups] desktop = ["pyinstaller>=6.22,<7"]`，然后执行 `uv lock`。**不要**加进 `dependencies`，也不要设置 `default-groups`，保证 Docker 镜像里不会装上 PyInstaller。
4. `desktop/imagen-backend.spec`：
   - 入口：`backend/app/desktop.py`；打成 **onedir**，`name="imagen-backend"`，`console=True`，`target_arch="arm64"`。
   - `datas`：`("frontend/dist", "frontend_dist")`。
   - `collect_submodules`：`app`（routes 是静态 import 的，一般没问题，加上更保险）。
   - google-genai、google-auth、certifi、PIL 如果缺东西，用 `collect_data_files` 或 `collect_submodules` 补，以实测为准。
   - `excludes`：`tkinter`、`uvloop`、`httptools`、`watchfiles`、`websockets`，这些在桌面模式下不需要。

5. 新增 `desktop/scripts/seed_synthetic.py`（合成数据脚本），用法：`uv run --project backend python desktop/scripts/seed_synthetic.py --data-dir <tmp> [--images 50] [--port 47902]`。要求：
   - **安全检查**：`--data-dir` 必须显式传入。把路径 resolve 之后，如果落在仓库的 `backend/data`、`~/Library/Application Support/com.gitkeniwo.imagen` 或 `~/Library/WebKit` 之内，脚本要报错退出。目录不存在时允许新建；目录已存在但不为空时，只有在里面找到 `.synthetic` 标记文件才允许继续使用。
   - 用 `IMAGEN_DATA_DIR=<data-dir>` 在指定端口启动一个后端子进程，并校验 health 返回的 token。之后**只通过 HTTP API** 写入数据，不直接写 SQLite，这样不依赖表结构。写完关闭后端，并在目录里写入 `.synthetic` 标记。
   - 用 Pillow 生成图片：不同尺寸和比例（含 4K 级大图）、PNG/JPEG/WebP 三种格式，内容是渐变或噪声，加上序号文字，保证每张图的 sha256 都不同。
   - 除了图片，还要通过 API 生成以下数据：
     - 若干标签；
     - 给图片打标签、加星标；
     - 至少 2 张图片移入回收站；
     - 若干草稿（含 input/output 附件）；
     - 若干条手动历史记录（走 `/api/generations/manual`，不调用 Vertex），覆盖 success、blocked、error 三种状态；
     - 设置 Vertex project 为 `synthetic-not-a-project`。
   - 最后打印各类数据的数量摘要，作为机器可读的 JSON。
6. 新增 `desktop/scripts/smoke_backend.sh`（后端冒烟测试），在临时目录里完成以下检查，任意一项失败就以非 0 退出：
   - 用 uv 启动后端：检查 `/`、`/api/health`（token 是否匹配）、`/api/images`、`/api/drafts`、`/api/generations`、`/api/stats` 是否正常；
   - 不设置 `IMAGEN_DATA_DIR` 时，后端应当拒绝启动；
   - 关闭 stdin 后，后端应在 5 s 内退出；
   - 后端只监听 127.0.0.1；
   - 如果已经有 PyInstaller 产物，对产物重复以上全部检查。

**完成标准**
- `cd backend && IMAGEN_DATA_DIR=<tmp> IMAGEN_PORT=47901 uv run python -m app.desktop` 能起来，`/`、`/api/health`、`/api/images` 都正常。
- 不设置 `IMAGEN_DATA_DIR` 时立即退出，退出码非 0，而且仓库里没有生成 `backend/data` 之外的任何新目录。
- PyInstaller 产物 `imagen-backend` 单独运行（设好环境变量）也满足上面两条，并且页面资源来自 `_internal/frontend_dist`。
- `docker build .` 能成功。不要求运行容器。

### 阶段 1.5：隔离 Docker 和 CI（和阶段 1 一起提交）

1. `.dockerignore` 新增以下几行：
   ```
   desktop/
   backend/build/
   backend/dist/
   backend/build-desktop/
   *.spec
   ```
   不加的话，`docker build` 的 context 会把好几 GB 的 `desktop/src-tauri/target` 一起传进去；而 Dockerfile 里的 `COPY backend/ ./` 还会把 PyInstaller 的中间产物拷进镜像。
2. `.gitignore` 新增以下几行：
   ```
   desktop/src-tauri/target/
   desktop/src-tauri/resources/
   desktop/src-tauri/binaries/
   desktop/node_modules/
   backend/build-desktop/
   ```
   根目录已经忽略了 `dist/` 和 `build/`，PyInstaller 默认的 build 和 dist 目录因此已被覆盖。
   注意：`desktop/imagen-backend.spec` 是需要提交的源文件，**不能**在 `.gitignore` 里加 `*.spec`。只有 PyInstaller 在没有指定 spec 时自动生成的 `backend/*.spec`，才需要单独忽略。
3. `.github/workflows/docker-ghcr.yml`：在 `on.push` 下加上 `paths-ignore: ['desktop/**', 'docs/**']`，这样只改桌面版的提交不会触发镜像构建和推送。`tags: ['v*']` 和 `workflow_dispatch` 保持不变。
   GitHub 的行为是：`paths-ignore` 只作用于 branch push，打 tag 时照常触发，在交付说明里注明这一点。

**完成标准**
- 在构建过 `desktop/` 之后执行 `docker build .`，context 大小和镜像里的内容与改动前一致。检查方法：`docker run --rm <img> ls /app/backend` 的结果里不应出现 `build`、`dist` 或 `*.spec`。
- `docker run --rm <img> python -c "import PyInstaller"` 应当失败，说明镜像里没有 PyInstaller。

### 阶段 2：Tauri 外壳

1. `tauri.conf.json` 要点：
   - `productName: "Imagen"`，`identifier: "com.gitkeniwo.imagen"`，`version` 与 pyproject 保持一致。
   - `build.frontendDist: "../splash"`。不配置 devUrl，也不配置 beforeBuildCommand，构建统一由 `build.sh` 负责。
   - `app.windows: []`，窗口在 Rust 里创建，方便挂 `on_download` 和 `on_navigation`。
   - `app.withGlobalTauri: false`；`app.security.csp` 只约束 splash 页。
   - `bundle.targets: ["app"]`；`bundle.resources: { "resources/imagen-backend/": "imagen-backend/" }`；`bundle.macOS.minimumSystemVersion: "15.0"`；`bundle.macOS.signingIdentity: "-"`（ad-hoc 签名）。
2. 主窗口用 `WebviewWindowBuilder` 创建：
   - 标题 `Imagen`，尺寸 1400×900，最小 960×640。
   - **调用 `.disable_drag_drop_handler()`**。这一步必须做，否则 HTML5 文件拖放会被 Tauri 拦截，`ReferenceTray` 和 `AddHistoryModal` 的拖拽上传就失效了。
   - `.on_navigation(...)`：只允许 `tauri://localhost`（splash 页）和 `http://127.0.0.1:{port}`，其余一律拒绝。
   - `.on_download(...)`，见下面第 4 条。
3. 插件：
   - `single-instance`：回调里 `unminimize` 并 `set_focus` 主窗口。
   - **例外**：如果设置了环境变量 `IMAGEN_DATA_DIR`（开发或测试实例），**不要注册 single-instance**，避免测试实例去聚焦用户正在用的 App。
   - `window-state`：记住窗口状态。
   - `dialog`：用于错误提示。
4. 下载处理（`download.rs`）。前端在这几处用 `<a download>` 触发下载：`ImageViewer.tsx:292`、`QueueList.tsx:358`、`Library.tsx` 的 `download()` 和 `downloadSelected()`（zip 包，`Content-Disposition: attachment; filename=images.zip`）。处理方式：
   - `DownloadEvent::Requested`：目标路径设为 `~/Downloads/<建议文件名>`。如果文件已存在，就加后缀 ` (1)`、` (2)` 等，不能覆盖已有文件。返回 `true`。
   - `DownloadEvent::Finished`：失败时弹原生错误；成功时可以静默，也可以弹一个可选的通知，不强制。
5. 菜单：保留 Tauri 在 macOS 上的默认菜单（`Menu::default`）。**必须保证 Edit 菜单还在**，否则 WKWebView 里 ⌘C、⌘V、⌘A、⌘Z 都不能用。
6. 生命周期：
   - 关闭最后一个窗口时退出 App。
   - 在 `RunEvent::Exit` 里关闭后端（见 §3 第 6 条）。
   - 后端如果意外退出（`try_wait` 返回 Some），主窗口切换到 splash 的错误页，显示「后端已退出」和日志路径，并提供「重启后端」按钮。这个按钮可以做成 splash 页的 IPC 调用；splash 是本地页面，可以在 capability 里给它授权一个自定义 command。
7. 调试构建：`cargo tauri dev` 或 `debug_assertions` 下，后端命令改为 `uv run python -m app.desktop`，cwd 设为 `CARGO_MANIFEST_DIR/../../backend`，这样不用每次都跑 PyInstaller。数据目录规则和发布版一样（§3 第 3 条）。

**完成标准**：见 §9 验收清单。

### 阶段 2.5（只有阶段 0 发现超时时才做）

见 §7.1。

### 阶段 3：文档

- README 新增「桌面 App」章节，内容包括：构建命令、数据目录位置、日志位置、§8 的数据迁移步骤、怎样同时保留 Docker 方式。
- README 里写明分发方式：只支持 macOS 15 及以上 + Apple Silicon；App 未签名、未公证，**其他人要用请自行从源码编译**；如果是从别处拷来或下载的 `.app`，首次打开前要先执行 `xattr -dr com.apple.quarantine Imagen.app`。
- CLAUDE.md 补充以下内容：桌面模式的端口（47860）、数据目录、`IMAGEN_PORT` 和 `IMAGEN_DATA_DIR` 的测试约定、不要随便 kill 47860 端口上的进程。

---

## 6. 构建流程

`desktop/build.sh` 用 `set -euo pipefail`，可以在仓库根目录直接执行：

```bash
export MACOSX_DEPLOYMENT_TARGET=15.0
# 1. 前端
(cd frontend && npm ci && npm run build)
# 2. 后端（PyInstaller onedir）
(cd backend && uv sync --group desktop --frozen && \
  uv run pyinstaller ../desktop/imagen-backend.spec \
    --distpath ../desktop/src-tauri/resources --workpath ./build-desktop --noconfirm)
# 3. Tauri 打包
(cd desktop && npm ci && npx tauri build --target aarch64-apple-darwin --bundles app)
# 产物：desktop/src-tauri/target/aarch64-apple-darwin/release/bundle/macos/Imagen.app
```

`desktop/package.json` 的 scripts：
- `"build": "../desktop/build.sh"`，或者直接调用该脚本；
- `"tauri": "tauri"`。

**签名备注**：PyInstaller 会给自己产出的 Mach-O 做 ad-hoc 签名，Tauri 再用 `-` 对整个 bundle 签一次。如果 `open Imagen.app` 后后端起不来，比如报 `code signature invalid` 或被 `killed: 9`：

- 先尝试在 `tauri build` 之后执行 `codesign --force --deep -s - Imagen.app`；
- 如果还是不行，改用 `bundle.externalBin` 加 PyInstaller **onefile** 作为回退方案。代价是每次启动要解压，启动会慢 1–2 s。

不管用哪种，都要在交付说明里写清楚最终采用的方案。

---

## 7. 前端兼容性：已知风险和对应处理

| 位置 | 用法 | 在 Tauri/WKWebView 下的情况 | 处理 |
|---|---|---|---|
| `ReferenceTray.tsx`、`AddHistoryModal.tsx` | HTML5 拖放文件 | Tauri 默认会拦截 | `disable_drag_drop_handler()`，不改前端 |
| `ImageViewer.tsx:292`、`QueueList.tsx:358`、`Library.tsx:129/175` | `<a download>` | WKWebView 默认不处理下载 | Rust 侧 `on_download`，不改前端 |
| `Bin.tsx:56/67`、`Library.tsx:137` | `window.confirm` | 不确定 wry 在 macOS 上有没有实现 JS confirm 面板 | **先验证**。如果返回值不对或者没有弹窗，就新增一个 React `ConfirmDialog` 组件替换这 3 处。替换后浏览器里同样生效，不要引入 Tauri JS |
| `ImageViewer.tsx:117`、`Favorites.tsx:118` | `navigator.clipboard.writeText` | 127.0.0.1 属于安全上下文，又是在点击事件里调用，预计可用 | 验证 |
| `DraftEditorModal.tsx:157`、`ReferenceTray.tsx:174`、`AddHistoryModal.tsx:311` | `<input type=file>` | wry 实现了打开文件面板 | 验证（包括多选） |
| 全局 | `localStorage` | 持久化在 `~/Library/WebKit/com.gitkeniwo.imagen`，按 origin 区分 | 端口固定 |
| `App.tsx` 生成队列 | 最多 5 个并发长连接，加上进度轮询 | WebKit 对同一 host 同样限制 6 个 HTTP/1.1 连接，与 Chrome 相同 | 无需处理 |
| `POST /api/generate` | 长时间挂起、没有任何字节返回 | **可能有 60 s 空闲超时** | 阶段 0 spike；如果超时，执行 §7.1 |

### 7.1 保活流式响应（条件执行）

把 `/api/generate` 的成功响应改成 `StreamingResponse(media_type="application/json")`：

- 输入校验和 `project` 检查仍然在流式开始**之前**完成，这样 4xx 还能正常返回；
- 每 15 s 输出一个 `b" "`，JSON 允许前导空白；
- 最后输出完整的 JSON 结果。

前端的 `handle()` 不需要改，因为 `res.json()` 能容忍前导空白。

必须同时满足：
- disconnect watcher 和 cancel 的语义不变；
- 浏览器（Chrome 和 Safari）和 App 里都能完成一次「假 project → error」的往返；
- Docker 下的行为保持一致。

### 7.2 网络代理提示

从 Finder 启动的 App 不会继承 shell 里的 `HTTPS_PROXY` 等环境变量。不过 httpx 和 requests 会通过 `urllib.request.getproxies()` 读取 **macOS 系统代理设置**，TUN 模式的代理对 App 也是透明的。

在 README 里写一句说明即可。不要实现代理配置界面。

---

## 8. 使用已有图库（由用户手动执行，agent 只写文档）

桌面 App 不再要求把数据复制到 Application Support。图库原地使用，第一步由用户在 App 里选择：

1. 停掉 Docker 容器：`docker compose down`。
2. 打开 `Imagen.app`，选择「打开已有图库…」，指向 compose 文件里挂载的**宿主机目录**（例如 `./imagen-data` 或 `backend/data`）。
3. 数据不会被复制、移动或重新初始化。App 会先校验目录和 `app.db`（含 SQLite 文件头与 `images`、`generations` 表），再原地打开。
4. 每次自然日第一次打开时，App 在 `<图库>/backups/` 下用 SQLite backup API 生成一份 `app-YYYYMMDD-HHMMSS.db`，只保留最近 7 份；随后才执行 `init_storage` 迁移。备份失败会拒绝启动。
5. Docker 和 App 可以轮流使用同一个图库，但**不能同时使用**。`.imagen.lock` 只能防住桌面实例，防不住 Docker；用 App 前必须先 `docker compose down`。
6. 如果图库位于「文稿」「桌面」、iCloud Drive 或外置盘，macOS 会请求访问权限。目录不存在、硬盘未挂载、软链接断开或校验失败时，App 显示错误页和「重试 / 选择其他图库 / 在 Finder 中显示配置」，绝不会在那里新建空库。

`storage.file_on_disk` 只按文件名在当前数据目录里定位图片，所以数据库里存的旧绝对路径不影响使用。Vertex 的 project 和 location 存在 `app.db` 里，会一起保留。

---

## 9. 验收清单（验收方逐项检查）

全部在隔离环境下执行：`IMAGEN_DATA_DIR=<临时目录> IMAGEN_PORT=47999`，直接运行 `Imagen.app/Contents/MacOS/Imagen`。

**构建与结构**
- [ ] 在干净的 checkout 上，`desktop/build.sh` 一次成功。
- [ ] `cargo clippy` 没有 warning。
- [ ] `npm run build`（前端）类型检查为零错误。
- [ ] `Imagen.app` 体积 ≤ 150 MB。
- [ ] `git status` 里没有构建产物，也没有 `backend/data` 的变动。
- [ ] `docker build .` 成功（要在构建过 `desktop/` 之后测）。镜像里没有 PyInstaller、`build/`、`dist/`、`*.spec`（阶段 1.5 的完成标准）。
- [ ] `.dockerignore`、`.gitignore`、`docker-ghcr.yml` 的 `paths-ignore` 都已按阶段 1.5 修改；workflow 的 tag 触发和手动触发没有变化。
- [ ] `pyproject.toml` 的运行时 `dependencies` 里没有 PyInstaller。
- [ ] `Info.plist` 里 `LSMinimumSystemVersion = 15.0`；`lipo -archs` 显示外壳和后端的可执行文件都只有 `arm64`。
- [ ] `codesign -dv Imagen.app` 显示 `Signature=adhoc`。
- [ ] tauri、cli 和插件版本与 §2 一致，lock 文件已提交。

**启动与生命周期**
- [ ] 冷启动 ≤ 3 s 显示主界面；先出现 splash，再切到主界面。
- [ ] 后端只监听 `127.0.0.1:47999`，用 `lsof -iTCP -sTCP:LISTEN` 确认。
- [ ] 隔离目录里生成了 `app.db`、`images/`、`thumbs/`；`backend/data` 的 mtime 没有变化。
- [ ] ⌘Q 后 5 s 内后端进程消失。
- [ ] `kill -9` Rust 进程后，后端在 5 s 内自行退出（孤儿进程防护生效）。
- [ ] 端口被别的进程占用时，显示明确的错误页和日志路径，不会白屏，也不会连到别的服务上（token 校验生效）。
- [ ] 后端被 kill 之后，窗口显示「后端已退出」，点击重启能恢复。
- [ ] 不带 `IMAGEN_DATA_DIR` 运行打包后的后端二进制时，拒绝启动。

**功能**（使用隔离 DB 和假的 Vertex project）
- [ ] 设置页保存假 project → 生成 → 得到 `error` 卡片；history 里有记录；没有发出真实计费请求。
- [ ] 文件选择上传（含多选）、拖拽上传到参考图托盘、AddHistoryModal 拖拽，都能用。
- [ ] 单张下载和批量 zip 下载都保存到 `~/Downloads`；同名文件不会被覆盖。
- [ ] 回收站「清空」和 Library「删除」的确认框能弹出，取消时确实不执行。
- [ ] 复制提示词后，剪贴板内容正确。
- [ ] 在提示词输入框里 ⌘C、⌘V、⌘A、⌘Z 都能用。
- [ ] 侧栏宽度等 localStorage 设置在重启后保留。
- [ ] 窗口大小和位置在重启后保留。
- [ ] 点击 Dock 图标再开一次时，聚焦已有窗口，不会启动第二个实例（用不带 `IMAGEN_DATA_DIR` 的实例测试时，要由用户在场确认，见红线第 2 条）。
- [ ] 阶段 0 的结论：长请求（≥ 200 s）没有被 WebKit 断开；或者 §7.1 已经实现并验证。

**资源**
- [ ] 隔离库里导入 50 张测试图片，浏览 Library、History、Drafts 后静置 1 分钟，测量 `Imagen`、`imagen-backend`、`com.apple.WebKit.WebContent`、`com.apple.WebKit.Networking` 这几个进程的 RSS 总和，要求 ≤ 400 MB。在交付说明里附上各进程的具体数值。

---

## 10. 交付物

1. 代码改动，按阶段分 commit，提交到新分支 `feat/tauri-desktop`。
2. 交付说明，内容包括：
   - 阶段 0 spike 的结果；
   - 签名最终用的是 onedir 还是 onefile；
   - `window.confirm` 的验证结果，以及是否新增了 ConfirmDialog；
   - §9 验收清单的自测结果，附上内存数值。
3. 不合并到 main，等验收通过后再说。

### 10.1 分批交付

实现方按 batch 工作。每个 batch 完成后停下来，等验收方验收通过才进入下一个 batch。

| Batch | 内容 |
|---|---|
| 1 | 阶段 0 spike、阶段 1 后端适配、阶段 1.5 Docker/CI 隔离、合成数据脚本、后端冒烟脚本 |
| 2 | 阶段 2 Tauri 外壳、`build.sh`，产出可运行的 `Imagen.app`；**§7.1 保活流式响应**（阶段 0 实测：WebKit 在空闲 61 s 时断开连接，因此这一项必须做） |
| 3 | 条件项（ConfirmDialog）、缩略图 Content-Type 固定为 image/webp、生命周期健壮性、`build.sh --dmg`（用 `hdiutil create … -format UDZO`，不要用依赖 Finder 和 AppleScript 的 DMG 布局脚本）、阶段 3 文档 |
| 4 | 发行，由验收方完成，见 §11 |

每个 batch 的交付说明都要包含三部分：
- 改了什么（commit 列表）；
- 自动化自测的命令和原始输出；
- 「待人工测试」清单。

## 11. 发行（验收方负责，实现方不用做）

- 用 `gh release create vX.Y.Z` 上传 `Imagen_X.Y.Z_aarch64.dmg`，并附上 sha256。
- 用 `gh repo create gitkeniwo/homebrew-imagen --public` 建 tap 仓库，在 `Casks/imagen.rb` 里写好 `version`、`sha256`、`url`（指向 release 资产）、`depends_on macos: ">= :sequoia"`、`depends_on arch: :arm64`、`app "Imagen.app"`。
- 因为 App 未签名，cask 需要处理隔离属性：在 `postflight` 里执行 `xattr -dr com.apple.quarantine "#{appdir}/Imagen.app"`。到时要以当前版本的 Homebrew 实测一遍。
- 最终安装命令：`brew install --cask gitkeniwo/imagen/imagen`。

