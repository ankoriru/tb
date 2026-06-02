FROM python:3.11-slim

# Установка ffmpeg и системных библиотек
RUN apt-get update && apt-get install -y --no-install-recommends \
    ffmpeg \
    libgomp1 \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Зависимости
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

# Директории для persistent данных
RUN mkdir -p /app/data/uploads /app/data/results /app/data/models
VOLUME ["/app/data"]

COPY . .

# Модель НЕ качаем здесь — скачается при первом старте в /app/data/models
CMD ["gunicorn", "app:app", "-b", "0.0.0.0:8080", "--workers", "1", "--threads", "4", "--timeout", "120"]
