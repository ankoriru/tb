#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
Оффлайн транскрибатор видео для Amvera.
- Изоляция по пользователям (X-User-ID)
- Автоудаление файлов и записей старше 48 часов
"""

import os
import uuid
import sqlite3
import threading
import subprocess
import tempfile
import time
from pathlib import Path
from datetime import datetime, timedelta
from flask import Flask, request, jsonify, send_file, send_from_directory

app = Flask(__name__)
app.config['MAX_CONTENT_LENGTH'] = 500 * 1024 * 1024

# --- Конфигурация ---
DATA_DIR = Path("/app/data")
UPLOAD_DIR = DATA_DIR / "uploads"
RESULT_DIR = DATA_DIR / "results"
MODELS_DIR = DATA_DIR / "models"
DB_PATH = DATA_DIR / "jobs.db"
STATIC_DIR = Path(__file__).parent / "static"

MODEL_SIZE = "small"
COMPUTE_TYPE = "int8"
MAX_FILE_SIZE_MB = 500
ALLOWED_EXT = {".mp4", ".mkv", ".avi", ".mov", ".wmv", ".webm", ".mpeg", ".mpg", ".mp3", ".wav", ".m4a", ".ogg"}
RETENTION_HOURS = 48

UPLOAD_DIR.mkdir(parents=True, exist_ok=True)
RESULT_DIR.mkdir(parents=True, exist_ok=True)
MODELS_DIR.mkdir(parents=True, exist_ok=True)

# --- Helpers ---
def get_user_id():
    """Извлекает user_id из заголовка X-User-ID или генерирует новый."""
    uid = request.headers.get('X-User-ID', '') or request.args.get('user_id', '')
    if not uid or len(uid) > 64:
        uid = str(uuid.uuid4())[:16]
    # sanitize: только буквы, цифры, дефис
    uid = ''.join(c for c in uid if c.isalnum() or c == '-')
    return uid or 'anonymous'

def user_dirs(uid):
    u_upload = UPLOAD_DIR / uid
    u_result = RESULT_DIR / uid
    u_upload.mkdir(parents=True, exist_ok=True)
    u_result.mkdir(parents=True, exist_ok=True)
    return u_upload, u_result

# --- Инициализация БД ---
def init_db():
    with sqlite3.connect(DB_PATH) as conn:
        conn.execute("""
            CREATE TABLE IF NOT EXISTS jobs (
                id TEXT PRIMARY KEY,
                user_id TEXT NOT NULL,
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
        # Миграция: добавить user_id если таблица старая
        try:
            conn.execute("SELECT user_id FROM jobs LIMIT 1")
        except sqlite3.OperationalError:
            conn.execute("ALTER TABLE jobs ADD COLUMN user_id TEXT DEFAULT 'legacy'")
        conn.execute("CREATE INDEX IF NOT EXISTS idx_jobs_user ON jobs(user_id)")
        conn.execute("CREATE INDEX IF NOT EXISTS idx_jobs_created ON jobs(created_at)")
        conn.commit()

init_db()

# --- Ротация: удаление старше 48 часов ---
def cleanup_old_files():
    """Удаляет файлы и записи старше RETENTION_HOURS."""
    cutoff = (datetime.now() - timedelta(hours=RETENTION_HOURS)).isoformat()
    with sqlite3.connect(DB_PATH) as conn:
        rows = conn.execute(
            "SELECT id, user_id, txt_path, srt_path FROM jobs WHERE created_at < ?",
            (cutoff,)
        ).fetchall()
        for job_id, uid, txt, srt in rows:
            for p in (txt, srt):
                if p:
                    try:
                        Path(p).unlink(missing_ok=True)
                    except Exception:
                        pass
            # очистка upload-файлов этого пользователя старше cutoff
            u_upload, _ = user_dirs(uid)
            for f in u_upload.iterdir():
                try:
                    if f.stat().st_mtime < (datetime.now() - timedelta(hours=RETENTION_HOURS)).timestamp():
                        f.unlink(missing_ok=True)
                except Exception:
                    pass
        conn.execute("DELETE FROM jobs WHERE created_at < ?", (cutoff,))
        conn.commit()
    print(f"🧹 Ротация выполнена. Удалены записи старше {RETENTION_HOURS}ч.")

def cleaner_loop():
    while True:
        time.sleep(3600)  # раз в час
        try:
            cleanup_old_files()
        except Exception as e:
            print(f"Ошибка ротации: {e}")

threading.Thread(target=cleaner_loop, daemon=True).start()

# --- Ленивая загрузка модели ---
_model = None
_model_lock = threading.Lock()

def get_model():
    global _model
    if _model is None:
        with _model_lock:
            if _model is None:
                from faster_whisper import WhisperModel
                print("⏳ Загрузка модели Whisper small...")
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

def process_job(job_id: str, uid: str, video_path: Path):
    """Фоновая обработка одного видео."""
    _, u_result = user_dirs(uid)
    conn = sqlite3.connect(DB_PATH)
    try:
        conn.execute("UPDATE jobs SET status=?, started_at=? WHERE id=? AND user_id=?",
                     ("processing", datetime.now().isoformat(), job_id, uid))
        conn.commit()

        model = get_model()

        with tempfile.TemporaryDirectory(dir=u_result) as tmpdir:
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

            base = u_result / job_id
            txt_file = base.with_suffix(".txt")
            srt_file = base.with_suffix(".srt")

            txt_file.write_text("\n".join(txt_lines), encoding="utf-8")
            srt_file.write_text("\n".join(srt_lines), encoding="utf-8")

        conn.execute(
            "UPDATE jobs SET status=?, finished_at=?, txt_path=?, srt_path=? WHERE id=? AND user_id=?",
            ("done", datetime.now().isoformat(), str(txt_file), str(srt_file), job_id, uid)
        )
        conn.commit()

    except Exception as e:
        conn.execute(
            "UPDATE jobs SET status=?, finished_at=?, error=? WHERE id=? AND user_id=?",
            ("failed", datetime.now().isoformat(), str(e), job_id, uid)
        )
        conn.commit()
    finally:
        if video_path.exists():
            video_path.unlink()
        conn.close()

# --- Фоновый воркер ---
worker_lock = threading.Lock()

def worker_loop():
    time.sleep(10)
    print("🔄 Worker запущен")
    while True:
        with worker_lock:
            with sqlite3.connect(DB_PATH) as conn:
                cur = conn.execute(
                    "SELECT id, user_id, filename FROM jobs WHERE status='pending' ORDER BY created_at LIMIT 1"
                )
                row = cur.fetchone()

            if row:
                job_id, uid, filename = row
                u_upload, _ = user_dirs(uid)
                video_path = u_upload / f"{job_id}_{filename}"
                if video_path.exists():
                    print(f"🔄 Обработка задачи {job_id} (user {uid})")
                    process_job(job_id, uid, video_path)
                else:
                    conn.execute("UPDATE jobs SET status=?, error=? WHERE id=? AND user_id=?",
                                 ("failed", "Файл не найден на диске", job_id, uid))
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
    return jsonify({"status": "ok", "model": MODEL_SIZE, "retention_hours": RETENTION_HOURS})

@app.route("/api/jobs")
def list_jobs():
    uid = get_user_id()
    with sqlite3.connect(DB_PATH) as conn:
        conn.row_factory = sqlite3.Row
        rows = conn.execute(
            "SELECT id, filename, status, created_at, started_at, finished_at, error, tags FROM jobs WHERE user_id=? ORDER BY created_at DESC",
            (uid,)
        ).fetchall()
    jobs = [dict(r) for r in rows]
    return jsonify({"jobs": jobs, "user_id": uid})

@app.route("/api/upload", methods=["POST"])
def upload():
    uid = get_user_id()
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
        return jsonify({"status": "error", "msg": f"Файл слишком большой ({size_mb:.1f} МБ > лимит {MAX_FILE_SIZE_MB} МБ)"}), 400

    job_id = str(uuid.uuid4())[:12]
    safe_name = Path(file.filename).name.replace(" ", "_")
    u_upload, _ = user_dirs(uid)
    save_path = u_upload / f"{job_id}_{safe_name}"
    file.save(save_path)

    with sqlite3.connect(DB_PATH) as conn:
        conn.execute(
            "INSERT INTO jobs (id, user_id, filename, status, created_at) VALUES (?, ?, ?, ?, ?)",
            (job_id, uid, safe_name, "pending", datetime.now().isoformat())
        )
        conn.commit()

    return jsonify({
        "status": "ok",
        "job_id": job_id,
        "user_id": uid,
        "msg": "Файл принят в обработку"
    }), 202

@app.route("/api/status/<job_id>")
def status(job_id):
    uid = get_user_id()
    with sqlite3.connect(DB_PATH) as conn:
        conn.row_factory = sqlite3.Row
        row = conn.execute(
            "SELECT status, created_at, started_at, finished_at, error, txt_path, srt_path FROM jobs WHERE id=? AND user_id=?",
            (job_id, uid)
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
    uid = get_user_id()
    fmt = request.args.get("format", "txt")
    with sqlite3.connect(DB_PATH) as conn:
        row = conn.execute(
            "SELECT txt_path, srt_path, status FROM jobs WHERE id=? AND user_id=?", (job_id, uid)
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
    uid = get_user_id()
    with sqlite3.connect(DB_PATH) as conn:
        row = conn.execute("SELECT txt_path, srt_path FROM jobs WHERE id=? AND user_id=?", (job_id, uid)).fetchone()
        if row:
            for p in row:
                if p:
                    try:
                        Path(p).unlink(missing_ok=True)
                    except Exception:
                        pass
        cur = conn.execute("DELETE FROM jobs WHERE id=? AND user_id=?", (job_id, uid))
        conn.commit()
        if cur.rowcount == 0:
            return jsonify({"status": "error", "msg": "Задача не найдена"}), 404
    return jsonify({"status": "ok", "msg": "Задача удалена"})

if __name__ == "__main__":
    app.run(host="0.0.0.0", port=8080)
