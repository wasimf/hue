FROM python:3.11-slim
RUN apt-get update && apt-get install -y --no-install-recommends ffmpeg fonts-dejavu-core libraqm0 \
    && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt pillow-heif
COPY reels_agent ./reels_agent
COPY config.example.toml .
ENV REELS_CONFIG=/data/config.toml PYTHONUNBUFFERED=1
VOLUME ["/data"]
WORKDIR /data
ENTRYPOINT ["python", "-m", "reels_agent"]
CMD ["daemon"]
