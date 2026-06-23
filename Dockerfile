# --- Stage 1: build frontend ---
FROM node:22-alpine AS frontend
WORKDIR /frontend
COPY frontend/package.json frontend/package-lock.json ./
RUN npm ci
COPY frontend/ ./
RUN npm run build            # tsc -b && vite build -> /frontend/dist

# --- Stage 2: runtime (lightweight) ---
FROM python:3.11-slim AS runtime
# Copy uv binary from official image to avoid pip bootstrapping
COPY --from=ghcr.io/astral-sh/uv:latest /uv /usr/local/bin/uv

WORKDIR /app/backend
ENV UV_LINK_MODE=copy \
    UV_PYTHON_DOWNLOADS=never \
    PATH="/app/backend/.venv/bin:$PATH" \
    IMAGEN_DATA_DIR=/data

# Install deps first (leverage layer cache): package=false, uv sync only installs deps into .venv
COPY backend/pyproject.toml backend/uv.lock ./
RUN uv sync --frozen --no-dev

# Copy backend source + frontend build output (preserve relative layout expected by main.py)
COPY backend/ ./
COPY --from=frontend /frontend/dist /app/frontend/dist

EXPOSE 8000
HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
  CMD python -c "import urllib.request,sys; sys.exit(0 if urllib.request.urlopen('http://127.0.0.1:8000/api/health').status==200 else 1)"

CMD ["uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "8000"]
