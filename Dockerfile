FROM python:3.11-slim

# Установка ffmpeg и системных библиотек для CTranslate2
RUN apt-get update && apt-get install -y --no-install-recommends \
    ffmpeg \
    libgomp1 \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Зависимости
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

# Предзагружаем модель small в образ (не качаем при старте контейнера)
# Это добавит ~244 МБ к образу, но ускорит старт на Amvera
RUN python -c "from faster_whisper import WhisperModel; WhisperModel('small', device='cpu', compute_type='int8')"

# Директория для persistent данных (очередь, загрузки, результаты)
RUN mkdir -p /app/data/uploads /app/data/results
VOLUME ["/app/data"]

COPY . .

# 1 воркер (чтобы не было race condition за GPU/RAM), 4 потока для API
CMD ["gunicorn", "app:app", "-b", "0.0.0.0:8080", "--workers", "1", "--threads", "4", "--timeout", "120"]
