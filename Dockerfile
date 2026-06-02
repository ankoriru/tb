FROM python:3.11-slim-bookworm

# Все кэши и временные файлы — строго в Persistent Volume
ENV HF_HOME=/app/data/hf_cache
ENV HUGGINGFACE_HUB_CACHE=/app/data/hf_cache
ENV HUGGINGFACE_HUB_VERBOSITY=error
ENV TRANSFORMERS_CACHE=/app/data/transformers_cache
ENV XDG_CACHE_HOME=/app/data/cache
ENV HOME=/app/data/home
ENV PYTHONDONTWRITEBYTECODE=1
ENV PYTHONUNBUFFERED=1

# Установка ffmpeg и системных библиотек
RUN apt-get update && apt-get install -y --no-install-recommends \
    ffmpeg \
    libgomp1 \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Зависимости (без кэша pip)
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

# Создаём директории для persistent данных и кэшей
RUN mkdir -p /app/data/uploads /app/data/results /app/data/models \
    /app/data/hf_cache /app/data/cache /app/data/home/.cache
VOLUME ["/app/data"]

# Копируем код и статику
COPY app.py .
COPY static/ ./static/

# Gunicorn: таймаут 120 сек, 1 воркер (мало RAM), 4 потока для API
CMD ["gunicorn", "app:app", "-b", "0.0.0.0:8080", \
     "--workers", "1", "--threads", "4", "--timeout", "120", \
     "--preload"]
