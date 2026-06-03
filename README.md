# 🍌 Nano Banana Studio

一个轻量、自用的**图生图** Web App，通过 **Vertex AI**（ADC 鉴权）调用 "Nano Banana" 系列图像模型。

- 上传 N 张图、编辑 prompt、选择模型 / 比例 / 清晰度(1K/2K/4K)
- 用 **ADC（Application Default Credentials）** 鉴权，不存任何密钥；设置里只填非敏感的 **Project ID + Location**（存本机 SQLite）
- **图库 + 血缘复用**：用过的图自动入库；下次只需上传新增图、从图库引用旧图即可再生成
- 记录每次生成的「输入图组 → 输出图」，可在历史里一键复用 prompt + 参考图
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
