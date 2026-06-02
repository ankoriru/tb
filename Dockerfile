FROM python:3.11-slim-bookworm

ENV HF_HOME=/app/data/hf_cache
ENV HUGGINGFACE_HUB_CACHE=/app/data/hf_cache
ENV HUGGINGFACE_HUB_VERBOSITY=error
ENV TRANSFORMERS_CACHE=/app/data/transformers_cache
ENV XDG_CACHE_HOME=/app/data/cache
ENV HOME=/app/data/home
ENV PYTHONDONTWRITEBYTECODE=1
ENV PYTHONUNBUFFERED=1

RUN apt-get update && apt-get install -y --no-install-recommends \
    ffmpeg \
    libgomp1 \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

RUN mkdir -p /app/data/uploads /app/data/results /app/data/models \
    /app/data/hf_cache /app/data/cache /app/data/home/.cache
VOLUME ["/app/data"]

COPY app.py .
COPY static/ ./static/

CMD ["gunicorn", "app:app", "-b", "0.0.0.0:8080", \
     "--workers", "1", "--threads", "4", "--timeout", "600", \
     "--preload"]
