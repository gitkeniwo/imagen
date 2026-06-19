# 🍌 Nano Banana Studio

一个轻量、自用的**图生图** Web App，通过 **Vertex AI**（ADC 鉴权）调用 "Nano Banana" 系列图像模型。

- 上传 N 张图、编辑 prompt、选择模型 / 比例 / 清晰度(1K/2K/4K)
- 用 **ADC（Application Default Credentials）** 鉴权，不存任何密钥；设置里只填非敏感的 **Project ID + Location**（存本机 SQLite）
- **图库 + 血缘复用**：用过的图自动入库；下次只需上传新增图、从图库引用旧图即可再生成
- 记录每次生成的「输入图组 → 输出图」，可在历史里一键复用 prompt + 参考图
- **生成队列**：延迟发送（可撤销、保证不计费）、运行中可取消、并发可调、实时显示每个任务的阶段
- 妥善处理 API 错误与 Vertex AI 安全策略（censor）：被拦截时给出明确提示，并记入历史
- 中 / 英双语界面（右上角一键切换，记忆在 localStorage）

## 技术栈

- 前端：React + Vite（TypeScript），单页三个标签：生成 / 图库 / 历史
  - 轻量 i18n（无第三方库）：词条集中在 `frontend/src/i18n.tsx`（`zh` / `en` 两份字典），新增语言只需再加一份字典
- 后端：Python + FastAPI；调用 Vertex AI 走官方 `google-genai` SDK（`genai.Client(vertexai=True, project=..., location=...)`，凭据由本机 ADC 提供）
- 存储：图片落本地文件系统（按 sha256 去重 + WebP 缩略图），元数据 / Vertex 配置存 SQLite

## 目录

```
imagen/
├─ backend/   FastAPI + sqlite + 图片存储  (data/ 运行时生成)
└─ frontend/  React + Vite SPA
```

## 安装

后端用 [uv](https://docs.astral.sh/uv/) 管理依赖（`pyproject.toml` + `uv.lock`）。

```bash
# 后端（uv 自动创建 .venv 并按 lock 安装）
cd backend
uv sync

# 前端
cd ../frontend
npm install
```

## 开发模式（前后端分离，热更新）

```bash
# 终端 1：后端
cd backend && uv run uvicorn app.main:app --reload --port 8000

# 终端 2：前端（Vite 把 /api 代理到 :8000）
cd frontend && npm run dev
# 打开 http://localhost:5173
```

## 生产 / 单进程模式

构建前端后，FastAPI 会直接托管 `frontend/dist`，单端口运行：

```bash
cd frontend && npm run build
cd ../backend && uv run uvicorn app.main:app --port 8000
# 打开 http://localhost:8000
```

## Docker 部署

仓库根目录提供了 `Dockerfile`（多阶段：Node 构建前端 → `python:3.11-slim` 运行后端并托管 `frontend/dist`，单进程、轻量镜像）和 `docker-compose.yml`。

前提：先在**宿主机**做一次性 ADC 配置（见下方「首次使用」），生成 `~/.config/gcloud/application_default_credentials.json`。compose 会把它**只读挂载**进容器，并把数据目录挂出来持久化。

```bash
docker compose up --build -d      # 构建并后台启动
# 打开 http://localhost:8000
```

- **数据持久化**：`docker-compose.yml` 里 `./backend/data:/data` 把数据目录（`app.db` + 图片 + 缩略图）挂到宿主机。想换位置只改**冒号左边**（宿主机路径），右边 `/data` 不要动——它与环境变量 `IMAGEN_DATA_DIR=/data` 对应。
- **凭据**：ADC 文件在执行过 `... set-quota-project` 后已内含 quota project，无需额外环境变量；Vertex 的 Project/Location 仍在 App 的「设置」里填。
- 改挂载/凭据后 `docker compose up -d` 即生效（无需 `--build`）；改了代码才需要 `--build`。

> Pillow 在 slim 镜像下一般直接用预编译 wheel；若构建时报缺库，在 `Dockerfile` 运行阶段补一行
> `apt-get install -y --no-install-recommends libjpeg62-turbo zlib1g` 即可。

## 首次使用

> 本 App 用 **ADC** 鉴权（很多 GCP 组织策略禁用 API key，故走 ADC）。先在本机做一次性配置：
>
> ```bash
> gcloud config set project <你的项目ID>
> gcloud services enable aiplatform.googleapis.com          # 启用 Vertex AI
> gcloud auth application-default login                     # 浏览器登录，写入 ADC 凭据
> gcloud auth application-default set-quota-project <你的项目ID>
> ```
> 账号需有 `Vertex AI User`（`roles/aiplatform.user`）角色。多账号/多项目用 `gcloud config configurations` 隔离；
> 注意 **ADC 全机只有一份**，想让 App 用哪个账号，就用该账号跑一次 `application-default login`。

1. 右上角「设置 Vertex」填入 **Project ID**（Location 一般用 `global`）。
2. 在「生成」页拖拽上传参考图、写 prompt、选模型/比例/清晰度，点「生成」。
3. 之后想复用：到「图库」点图加入参考，或在「历史」点「复用」回填上次的 prompt 与参考图。

> 清晰度 1K/2K/4K 仅 **Nano Banana Pro**（`gemini-3-pro-image-preview`）支持；
> 选普通 Nano Banana（`gemini-2.5-flash-image`）时该选项自动禁用。

## 生成队列：延迟发送 / 取消 / 并发 / 实时状态

提交后任务进入右侧**队列**（前端内存态，切换面板不丢；刷新页面会丢掉尚未跑完的任务——已完成的早已存进历史/图库）。

- **延迟发送（undo-send）**：提交后先倒计时（默认 5 秒，可在「设置」里调，填 `0` = 立即发送）再真正调用 Vertex。倒计时内点「撤销发送」=请求从未发出，**保证不计费**。
- **取消运行中任务**：点「取消」前端立即标记为已取消；后端采用**合作式取消**——**做完当前正在进行的这一次**调用，然后停止后续重试。卡在 429 反复重试、尚未成功的任务，取消即真省钱。关键：**绝不"付了钱却被丢弃"**——若正在进行的那次恰好生成成功，结果仍会存入图库/历史（反正已计费，至少拿到图）；只有它失败或后续重试被掐掉时，任务才记为 `aborted`。注意：已经生成完成的那一次仍会被 Vertex 计费（断开连接无法退费，这是计费机制决定的）。
- **并发可调**：队列头部可选 **1–5** 路并发，**默认 1（串行）**。Pro（`gemini-3-pro-image-preview`）是 preview 模型、配额很低，多个请求并发会互相挤爆配额导致一起卡 429；串行通常一个请求就能落在配额内直接出图。跑普通 Flash 时可按需调高。
- **实时状态**：每张卡片显示当前阶段——`延迟发送中` / `排队中·等待空位` / `已发送·第 N 次尝试` / `重试中（429）·约 Ns 后`，一眼看出是不是卡在限流重试上。

> 后端对 429 / 5xx 会**自动重试 + 退避**（最多约 30 次，见 `app/gemini.py`），单个请求可能开很久——这是预期行为，不是卡死。想中断就用上面的「取消」。

> **关于 censor**：后端已把所有**可配置**的安全类别（文本侧 + 图像侧，见 `app/gemini.py`
> 的 `_SAFETY_CATEGORIES`）阈值都设为 `OFF`，尽量减少拦截。但 Vertex 对图像仍有一层
> **不可关闭**的底层安全过滤，极端内容仍可能以 `IMAGE_SAFETY` 被拦——这是平台限制，
> App 会把它作为 blocked 状态如实展示。

## 校验 / 联调（可选）

做完上面的 ADC 配置后，跑一次探针确认 Vertex AI 模型可用、能产出图片：

```bash
cd backend
PROJECT=<你的项目ID> uv run python scripts/probe_gemini.py [可选的输入图.png]
# 测 Pro + 分辨率：
PROJECT=<你的项目ID> MODEL=gemini-3-pro-image-preview RESOLUTION=2K \
    uv run python scripts/probe_gemini.py
```

探针会把返回的图片写到 `probe_out_*.png`。若结构与 `app/gemini.py` 的解析不符，按输出微调即可。

## 数据与隐私

- 所有图片、缩略图、SQLite 数据库、Vertex 配置都只存在本机 `backend/data/`（已被 gitignore）；不存任何密钥。
- 鉴权用本机 ADC（`~/.config/gcloud/application_default_credentials.json`）。
- 纯本机自用，未做鉴权；如需联网暴露请自行加访问控制。
```
