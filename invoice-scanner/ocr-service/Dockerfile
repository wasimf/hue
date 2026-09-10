FROM python:3.11-slim

# OpenCV (a PaddleOCR dependency) needs these shared libraries at runtime.
RUN apt-get update && apt-get install -y --no-install-recommends \
      libgl1 libglib2.0-0 libgomp1 curl \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /srv

COPY requirements.txt ./
RUN pip install --no-cache-dir -r requirements.txt

COPY app.py ./

ENV PADDLE_LANGS=en \
    PYTHONUNBUFFERED=1
EXPOSE 8868

HEALTHCHECK --interval=30s --timeout=5s --start-period=120s --retries=5 \
  CMD curl -fsS http://127.0.0.1:8868/health || exit 1

CMD ["uvicorn", "app:app", "--host", "0.0.0.0", "--port", "8868"]
