#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
Оффлайн транскрибатор видео для Amvera с веб-интерфейсом.
Все кэши пишутся в /app/data (Persistent Volume).
Модель грузится лениво — только при первой задаче.
"""

import os
import sys
import uuid
import sqlite3
import threading
import subprocess
import tempfile
import time
from pathlib import Path
from datetime import datetime
from flask import Flask, request, jsonify, send_file, send_from_directory

app = Flask(__name__)

# --- Конфигурация ---
DATA_DIR = Path("/app/data")
UPLOAD_DIR = DATA_DIR / "uploads"
RESULT_DIR = DATA_DIR / "results"
MODELS_DIR = DATA_DIR / "models"
DB_PATH = DATA_DIR / "jobs.db"
STATIC_DIR = Path(__file__).parent / "static"

MODEL_SIZE = "small"
COMPUTE_TYPE = "int8"
MAX_FILE_SIZE_MB = 100
ALLOWED_EXT = {".mp4", ".mkv", ".avi", ".mov", ".wmv", ".webm", ".mpeg", ".mpg", ".mp3", ".wav", ".m4a", ".webm", ".ogg"}

UPLOAD_DIR.mkdir(parents=True, exist_ok=True)
RESULT_DIR.mkdir(parents=True, exist_ok=True)
MODELS_DIR.mkdir(parents=True, exist_ok=True)

# --- Проверка Persistent Volume при старте ---
def check_volume():
    test_file = DATA_DIR / ".write_test"
    try:
        test_file.write_text("ok")
        test_file.unlink()
        return True
    except Exception as e:
        print(f"❌ Persistent Volume {DATA_DIR} НЕ доступен: {e}")
        return False

volume_ok = check_volume()

# --- Инициализация БД ---
def init_db():
    with sqlite3.connect(DB_PATH) as conn:
        conn.execute("""
            CREATE TABLE IF NOT EXISTS jobs (
                id TEXT PRIMARY KEY,
                filename TEXT,
                status TEXT DEFAULT 'pending',
                created_at TEXT,
                started_at TEXT,
                finished_at TEXT,
                error TEXT,
                txt_path TEXT,
                srt_path TEXT,
                tags TEXT
            )
        """)

init_db()

# --- Ленивая загрузка модели (только при первой задаче) ---
_model = None
_model_lock = threading.Lock()

def get_model():
    global _model
    if _model is None:
        with _model_lock:
            if _model is None:
                from faster_whisper import WhisperModel
                print("⏳ Загрузка / скачивание модели Whisper small...")
                print(f"   Кэш HF: {os.environ.get('HF_HOME')}")
                print(f"   HOME: {os.environ.get('HOME')}")
                _model = WhisperModel(
                    MODEL_SIZE,
                    device="cpu",
                    compute_type=COMPUTE_TYPE,
                    cpu_threads=2,
                    download_root=str(MODELS_DIR),
                    local_files_only=False
                )
                print("✅ Модель готова")
    return _model

# --- Утилиты ---
def extract_audio(video_path: Path, wav_path: Path):
    cmd = [
        "ffmpeg", "-hide_banner", "-loglevel", "error",
        "-i", str(video_path),
        "-vn", "-acodec", "pcm_s16le", "-ar", "16000", "-ac", "1", "-y",
        str(wav_path)
    ]
    subprocess.run(cmd, check=True)

def seconds_to_srt_time(seconds: float) -> str:
    hours = int(seconds // 3600)
    minutes = int((seconds % 3600) // 60)
    secs = int(seconds % 60)
    millis = int((seconds - int(seconds)) * 1000)
    return f"{hours:02d}:{minutes:02d}:{secs:02d},{millis:03d}"

def process_job(job_id: str, video_path: Path):
    """Фоновая обработка одного видео."""
    conn = sqlite3.connect(DB_PATH)
    try:
        conn.execute("UPDATE jobs SET status=?, started_at=? WHERE id=?",
                     ("processing", datetime.now().isoformat(), job_id))
        conn.commit()

        model = get_model()

        with tempfile.TemporaryDirectory(dir=UPLOAD_DIR) as tmpdir:
            wav_path = Path(tmpdir) / "audio.wav"
            extract_audio(video_path, wav_path)

            segments, info = model.transcribe(
                str(wav_path),
                language="ru",
                beam_size=5,
                vad_filter=True,
                vad_parameters=dict(min_silence_duration_ms=500)
            )

            txt_lines = []
            srt_lines = []
            idx = 1
            for seg in segments:
                text = seg.text.strip()
                txt_lines.append(text)
                srt_lines.append(str(idx))
                srt_lines.append(f"{seconds_to_srt_time(seg.start)} --> {seconds_to_srt_time(seg.end)}")
                srt_lines.append(text)
                srt_lines.append("")
                idx += 1

            base = RESULT_DIR / job_id
            txt_file = base.with_suffix(".txt")
            srt_file = base.with_suffix(".srt")

            txt_file.write_text("\n".join(txt_lines), encoding="utf-8")
            srt_file.write_text("\n".join(srt_lines), encoding="utf-8")

        conn.execute(
            "UPDATE jobs SET status=?, finished_at=?, txt_path=?, srt_path=? WHERE id=?",
            ("done", datetime.now().isoformat(), str(txt_file), str(srt_file), job_id)
        )
        conn.commit()

    except Exception as e:
        conn.execute(
            "UPDATE jobs SET status=?, finished_at=?, error=? WHERE id=?",
            ("failed", datetime.now().isoformat(), str(e), job_id)
        )
        conn.commit()
    finally:
        if video_path.exists():
            video_path.unlink()
        conn.close()

# --- Фоновый воркер (1 задача, стартует через 10 сек после импорта) ---
worker_lock = threading.Lock()

def worker_loop():
    time.sleep(10)
    print("🔄 Worker запущен")
    while True:
        with worker_lock:
            with sqlite3.connect(DB_PATH) as conn:
                cur = conn.execute(
                    "SELECT id, filename FROM jobs WHERE status='pending' ORDER BY created_at LIMIT 1"
                )
                row = cur.fetchone()

            if row:
                job_id, filename = row
                video_path = UPLOAD_DIR / f"{job_id}_{filename}"
                if video_path.exists():
                    print(f"🔄 Обработка задачи {job_id}")
                    process_job(job_id, video_path)
                else:
                    conn.execute("UPDATE jobs SET status=?, error=? WHERE id=?",
                                 ("failed", "Файл не найден на диске", job_id))
                    conn.commit()

        time.sleep(5)

threading.Thread(target=worker_loop, daemon=True).start()

# --- Статика и SPA ---
@app.route("/")
def index():
    return send_from_directory(str(STATIC_DIR), "index.html")

@app.route("/static/<path:filename>")
def static_files(filename):
    return send_from_directory(str(STATIC_DIR), filename)

# --- API ---

@app.route("/api/health")
def health():
    return jsonify({"status": "ok", "model": MODEL_SIZE, "volume_ready": volume_ok})

@app.route("/api/jobs")
def list_jobs():
    with sqlite3.connect(DB_PATH) as conn:
        conn.row_factory = sqlite3.Row
        rows = conn.execute(
            "SELECT id, filename, status, created_at, started_at, finished_at, error, tags FROM jobs ORDER BY created_at DESC"
        ).fetchall()
    jobs = [dict(r) for r in rows]
    return jsonify({"jobs": jobs})

@app.route("/api/upload", methods=["POST"])
def upload():
    if "file" not in request.files:
        return jsonify({"status": "error", "msg": "Нет файла"}), 400

    file = request.files["file"]
    if not file or file.filename == "":
        return jsonify({"status": "error", "msg": "Пустой файл"}), 400

    ext = Path(file.filename).suffix.lower()
    if ext not in ALLOWED_EXT:
        return jsonify({"status": "error", "msg": f"Формат {ext} не поддерживается"}), 400

    file.seek(0, os.SEEK_END)
    size_mb = file.tell() / (1024 * 1024)
    file.seek(0)
    if size_mb > MAX_FILE_SIZE_MB:
        return jsonify({"status": "error", "msg": f"Файл слишком большой ({size_mb:.1f} МБ > {MAX_FILE_SIZE_MB})"}), 400

    job_id = str(uuid.uuid4())[:12]
    safe_name = Path(file.filename).name.replace(" ", "_")
    save_path = UPLOAD_DIR / f"{job_id}_{safe_name}"
    file.save(save_path)

    with sqlite3.connect(DB_PATH) as conn:
        conn.execute(
            "INSERT INTO jobs (id, filename, status, created_at) VALUES (?, ?, ?, ?)",
            (job_id, safe_name, "pending", datetime.now().isoformat())
        )
        conn.commit()

    return jsonify({
        "status": "ok",
        "job_id": job_id,
        "msg": "Файл принят в обработку. Проверяйте статус через /api/status"
    }), 202

@app.route("/api/status/<job_id>")
def status(job_id):
    with sqlite3.connect(DB_PATH) as conn:
        conn.row_factory = sqlite3.Row
        row = conn.execute(
            "SELECT status, created_at, started_at, finished_at, error, txt_path, srt_path FROM jobs WHERE id=?",
            (job_id,)
        ).fetchone()

    if not row:
        return jsonify({"status": "error", "msg": "Задача не найдена"}), 404

    d = dict(row)
    result = {
        "job_id": job_id,
        "status": d["status"],
        "created_at": d["created_at"],
        "started_at": d["started_at"],
        "finished_at": d["finished_at"],
        "error": d["error"]
    }
    if d["status"] == "done":
        result["files"] = {
            "txt": f"/api/download/{job_id}?format=txt",
            "srt": f"/api/download/{job_id}?format=srt"
        }
    return jsonify(result)

@app.route("/api/download/<job_id>")
def download(job_id):
    fmt = request.args.get("format", "txt")
    with sqlite3.connect(DB_PATH) as conn:
        row = conn.execute(
            "SELECT txt_path, srt_path, status FROM jobs WHERE id=?", (job_id,)
        ).fetchone()

    if not row or row[2] != "done":
        return jsonify({"status": "error", "msg": "Результат не готов"}), 400

    txt_path, srt_path, _ = row
    path = Path(txt_path if fmt == "txt" else srt_path)
    if not path.exists():
        return jsonify({"status": "error", "msg": "Файл удалён"}), 404

    return send_file(path, as_attachment=True)

@app.route("/api/jobs/<job_id>", methods=["DELETE"])
def delete_job(job_id):
    with sqlite3.connect(DB_PATH) as conn:
        row = conn.execute("SELECT txt_path, srt_path FROM jobs WHERE id=?", (job_id,)).fetchone()
        if row:
            for p in row:
                if p:
                    try:
                        Path(p).unlink(missing_ok=True)
                    except Exception:
                        pass
        conn.execute("DELETE FROM jobs WHERE id=?", (job_id,))
        conn.commit()
    return jsonify({"status": "ok", "msg": "Задача удалена"})

if __name__ == "__main__":
    app.run(host="0.0.0.0", port=8080)
