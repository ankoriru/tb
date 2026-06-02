(function(){
    // --- User ID ---
    let USER_ID = localStorage.getItem('whisper_user_id');
    if (!USER_ID) {
        USER_ID = 'u-' + Math.random().toString(36).slice(2, 10) + '-' + Date.now().toString(36).slice(-4);
        localStorage.setItem('whisper_user_id', USER_ID);
    }

    const API = '';
    let pollTimer = null;
    let currentJobId = null;
    let currentSpeakers = {};
    let mediaRecorder = null;
    let recChunks = [];
    let recStartTime = 0;
    let recTimerInterval = null;
    let activeFilter = 'all';

    // --- DOM helpers ---
    function $(id) { return document.getElementById(id); }

    // --- Toast ---
    function toast(msg, type) {
        type = type || 'info';
        var el = document.createElement('div');
        el.className = 'toast ' + type;
        el.textContent = msg;
        var container = $('toastContainer');
        if (container) container.appendChild(el);
        setTimeout(function() { if (el.parentNode) el.parentNode.removeChild(el); }, 4000);
    }

    // --- API ---
    function apiGet(path) {
        return fetch(API + path, { headers: { 'X-User-ID': USER_ID } }).then(function(r) {
            if (!r.ok) throw new Error(r.status + ' ' + r.statusText);
            return r.json();
        });
    }
    function apiPost(path, body) {
        return fetch(API + path, { method: 'POST', headers: { 'X-User-ID': USER_ID }, body: body }).then(function(r) {
            if (!r.ok) throw new Error(r.status + ' ' + r.statusText);
            return r.json();
        });
    }
    function apiPostJson(path, body) {
        return fetch(API + path, {
            method: 'POST',
            headers: { 'X-User-ID': USER_ID, 'Content-Type': 'application/json' },
            body: JSON.stringify(body)
        }).then(function(r) {
            if (!r.ok) throw new Error(r.status + ' ' + r.statusText);
            return r.json();
        });
    }
    function apiDelete(path) {
        return fetch(API + path, { method: 'DELETE', headers: { 'X-User-ID': USER_ID } }).then(function(r) {
            if (!r.ok) throw new Error(r.status + ' ' + r.statusText);
            return r.json();
        });
    }

    // --- Jobs ---
    function loadJobs() {
        apiGet('/api/jobs').then(function(data) {
            renderJobs(data.jobs || []);
        }).catch(function(e) {
            console.error('loadJobs error', e);
        });
    }

    function formatDate(iso) {
        if (!iso) return '';
        var d = new Date(iso);
        return d.toLocaleString('ru-RU', { day:'2-digit', month:'2-digit', hour:'2-digit', minute:'2-digit' });
    }

    function esc(s) {
        var d = document.createElement('div');
        d.textContent = s || '';
        return d.innerHTML;
    }

    function renderJobs(jobs) {
        var term = ($('searchInput') && $('searchInput').value || '').toLowerCase();
        var filtered = jobs.filter(function(j) {
            if (activeFilter === 'done' && j.status !== 'done') return false;
            if (activeFilter === 'processing' && (j.status === 'done' || j.status === 'failed')) return false;
            if (!term) return true;
            return (j.filename || '').toLowerCase().indexOf(term) !== -1 || (j.id || '').toLowerCase().indexOf(term) !== -1;
        });

        var list = $('recordsList');
        if (!filtered.length) {
            list.innerHTML = '<div class="empty-state"><svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M12 2a3 3 0 0 0-3 3v7a3 3 0 0 0 6 0V5a3 3 0 0 0-3-3Z"></path><path d="M19 10v2a7 7 0 0 1-14 0v-2"></path><line x1="12" y1="19" x2="12" y2="22"></line></svg><p>Записей не найдено</p></div>';
            return;
        }

        list.innerHTML = filtered.map(function(j) {
            var stClass = 'status-' + j.status;
            var stText = {pending:'В очереди', processing:'Обработка', done:'Готово', failed:'Ошибка'}[j.status] || j.status;
            var activeCls = currentJobId === j.id ? 'active' : '';
            return '<div class="record-card ' + activeCls + '" data-id="' + esc(j.id) + '">' +
                '<div class="record-title">' + esc(j.filename || 'Без имени') + '</div>' +
                '<div class="record-meta"><span>' + formatDate(j.created_at) + '</span><span class="record-status ' + stClass + '">' + stText + '</span></div>' +
                '<div class="record-tags"><span class="record-tag">' + esc(j.id) + '</span></div>' +
                '</div>';
        }).join('');

        list.querySelectorAll('.record-card').forEach(function(card) {
            card.addEventListener('click', function() { openJob(card.dataset.id); });
        });
    }

    // --- View job ---
    function openJob(id) {
        currentJobId = id;
        apiGet('/api/status/' + id).then(function(j) {
            $('uploadScreen').style.display = 'none';
            $('viewScreen').style.display = 'block';
            $('viewMeta').textContent = 'ID: ' + j.job_id + ' | Создано: ' + formatDate(j.created_at) + ' | Начато: ' + formatDate(j.started_at) + ' | Завершено: ' + formatDate(j.finished_at);
            var stText = {pending:'В очереди', processing:'Обработка', done:'Готово', failed:'Ошибка'}[j.status] || j.status;
            $('viewStatus').innerHTML = '<span class="record-status status-' + j.status + '">' + stText + '</span>';

            if (j.status === 'done') {
                currentSpeakers = j.speakers || {};
                renderSpeakers(currentSpeakers);
                $('speakersPanel').style.display = 'block';
                fetch(API + '/api/download/' + id + '?format=txt', { headers: { 'X-User-ID': USER_ID } })
                    .then(function(r) { return r.text(); })
                    .then(function(txt) { $('viewText').textContent = txt; })
                    .catch(function() { $('viewText').textContent = 'Текст недоступен'; });
                $('downloadTxtBtn').style.display = '';
                $('downloadSrtBtn').style.display = '';
            } else if (j.error) {
                $('viewText').textContent = 'Ошибка: ' + j.error;
                $('speakersPanel').style.display = 'none';
                $('downloadTxtBtn').style.display = 'none';
                $('downloadSrtBtn').style.display = 'none';
            } else {
                $('viewText').textContent = 'Обработка... Пожалуйста, подождите. Автообновление каждые 5 сек.';
                $('speakersPanel').style.display = 'none';
                $('downloadTxtBtn').style.display = 'none';
                $('downloadSrtBtn').style.display = 'none';
            }
            loadJobs();
        }).catch(function(e) {
            toast('Ошибка загрузки задачи: ' + e.message, 'error');
        });
    }

    function renderSpeakers(speakers) {
        var list = $('speakersList');
        var keys = Object.keys(speakers || {});
        if (!keys.length) {
            list.innerHTML = '<p style="font-size:13px;color:var(--text-secondary)">Спикеры не определены</p>';
            return;
        }
        list.innerHTML = keys.map(function(num) {
            return '<div class="speaker-row"><span class="speaker-label">Спикер ' + esc(num) + '</span><input type="text" data-spk="' + esc(num) + '" value="' + esc(speakers[num]) + '" placeholder="Введите ФИО или название"></div>';
        }).join('');
    }

    function saveSpeakers() {
        if (!currentJobId) return;
        var inputs = $('speakersList').querySelectorAll('input[data-spk]');
        var names = {};
        inputs.forEach(function(inp) { names[inp.dataset.spk] = inp.value; });
        apiPostJson('/api/jobs/' + currentJobId + '/speakers', { names: names }).then(function() {
            toast('Имена участников сохранены', 'success');
            openJob(currentJobId);
        }).catch(function(e) {
            toast('Ошибка сохранения: ' + e.message, 'error');
        });
    }

    function showUpload() {
        currentJobId = null;
        currentSpeakers = {};
        $('viewScreen').style.display = 'none';
        $('uploadScreen').style.display = 'block';
        loadJobs();
    }

    // --- Upload ---
    function uploadFile(file) {
        var fd = new FormData();
        fd.append('file', file);
        var card = document.createElement('div');
        card.className = 'upload-progress';
        card.innerHTML = '<div class="upload-progress-file">' + esc(file.name) + '</div><div class="progress-bar"><div class="progress-fill" style="width:0%"></div></div><div class="progress-status">Загрузка...</div>';
        var zone = $('dropZone');
        if (zone && zone.parentNode) zone.parentNode.insertBefore(card, zone.nextSibling);

        apiPost('/api/upload', fd).then(function(data) {
            var fill = card.querySelector('.progress-fill');
            if (fill) fill.style.width = '100%';
            var status = card.querySelector('.progress-status');
            if (status) status.textContent = 'Принято: ' + data.job_id;
            toast('Файл принят: ' + data.job_id, 'success');
            loadJobs();
        }).catch(function(e) {
            var status = card.querySelector('.progress-status');
            if (status) status.textContent = 'Ошибка: ' + e.message;
            toast('Ошибка загрузки: ' + e.message, 'error');
        });
    }

    // --- Recording ---
    function formatRecTime(ms) {
        var s = Math.floor(ms / 1000);
        var m = Math.floor(s / 60);
        var sec = s % 60;
        return String(m).padStart(2,'0') + ':' + String(sec).padStart(2,'0');
    }

    function startRecording(audioOnly) {
        audioOnly = audioOnly !== false;
        var constraints;
        if (audioOnly) {
            constraints = navigator.mediaDevices.getUserMedia({ audio: true });
        } else {
            constraints = navigator.mediaDevices.getDisplayMedia({ video: false, audio: true });
        }
        constraints.then(function(stream) {
            mediaRecorder = new MediaRecorder(stream);
            recChunks = [];
            mediaRecorder.ondataavailable = function(e) { if (e.data.size) recChunks.push(e.data); };
            mediaRecorder.onstop = function() {
                var blob = new Blob(recChunks, { type: 'audio/webm' });
                var fname = 'recording_' + new Date().toISOString().slice(0,19).replace(/[:T]/g,'-') + '.webm';
                var file = new File([blob], fname, { type: 'audio/webm' });
                uploadFile(file);
                stream.getTracks().forEach(function(t) { t.stop(); });
                stopRecUI();
            };
            mediaRecorder.start();
            recStartTime = Date.now();
            recTimerInterval = setInterval(function() {
                var el = $('recTime');
                if (el) el.textContent = formatRecTime(Date.now() - recStartTime);
            }, 1000);
            var st = $('recorderStatus');
            if (st) st.style.display = 'flex';
            toast('Запись началась', 'info');
        }).catch(function(e) {
            toast('Ошибка доступа к микрофону: ' + e.message, 'error');
        });
    }

    function stopRecUI() {
        clearInterval(recTimerInterval);
        var st = $('recorderStatus');
        if (st) st.style.display = 'none';
        var el = $('recTime');
        if (el) el.textContent = '00:00';
    }

    function startBothRecording() {
        Promise.all([
            navigator.mediaDevices.getUserMedia({ audio: true }),
            navigator.mediaDevices.getDisplayMedia({ video: false, audio: true })
        ]).then(function(streams) {
            var micStream = streams[0];
            var sysStream = streams[1];
            var ctx = new AudioContext();
            var dest = ctx.createMediaStreamDestination();
            var micSrc = ctx.createMediaStreamSource(micStream);
            var sysSrc = ctx.createMediaStreamSource(sysStream);
            micSrc.connect(dest);
            sysSrc.connect(dest);
            mediaRecorder = new MediaRecorder(dest.stream);
            recChunks = [];
            mediaRecorder.ondataavailable = function(e) { if (e.data.size) recChunks.push(e.data); };
            mediaRecorder.onstop = function() {
                var blob = new Blob(recChunks, { type: 'audio/webm' });
                var fname = 'recording_both_' + new Date().toISOString().slice(0,19).replace(/[:T]/g,'-') + '.webm';
                var file = new File([blob], fname, { type: 'audio/webm' });
                uploadFile(file);
                micStream.getTracks().forEach(function(t) { t.stop(); });
                sysStream.getTracks().forEach(function(t) { t.stop(); });
                ctx.close();
                stopRecUI();
            };
            mediaRecorder.start();
            recStartTime = Date.now();
            recTimerInterval = setInterval(function() {
                var el = $('recTime');
                if (el) el.textContent = formatRecTime(Date.now() - recStartTime);
            }, 1000);
            var st = $('recorderStatus');
            if (st) st.style.display = 'flex';
            toast('Запись микрофон + система началась', 'info');
        }).catch(function(e) {
            toast('Ошибка: ' + e.message, 'error');
        });
    }

    // --- Event bindings (все через addEventListener на document.getElementById) ---
    function bind(id, event, handler) {
        var el = $(id);
        if (el) el.addEventListener(event, handler);
        else console.warn('Element not found: #' + id);
    }

    bind('dropZone', 'click', function() { var inp = $('fileInput'); if (inp) inp.click(); });
    bind('dropZone', 'dragover', function(e) { e.preventDefault(); $('dropZone').classList.add('dragover'); });
    bind('dropZone', 'dragleave', function() { $('dropZone').classList.remove('dragover'); });
    bind('dropZone', 'drop', function(e) {
        e.preventDefault();
        $('dropZone').classList.remove('dragover');
        Array.from(e.dataTransfer.files).forEach(uploadFile);
    });
    bind('fileInput', 'change', function() {
        var inp = $('fileInput');
        if (inp) Array.from(inp.files).forEach(uploadFile);
    });

    bind('recordMicBtn', 'click', function() { startRecording(true); });
    bind('recordSystemBtn', 'click', function() { startRecording(false); });
    bind('recordBothBtn', 'click', startBothRecording);
    bind('stopRecBtn', 'click', function() {
        if (mediaRecorder && mediaRecorder.state !== 'inactive') mediaRecorder.stop();
    });

    bind('filterAll', 'click', function() { setFilter('all'); });
    bind('filterDone', 'click', function() { setFilter('done'); });
    bind('filterProcessing', 'click', function() { setFilter('processing'); });

    function setFilter(f) {
        activeFilter = f;
        ['filterAll','filterDone','filterProcessing'].forEach(function(id) {
            var el = $(id);
            if (el) el.classList.remove('active');
        });
        var active = {all:'filterAll', done:'filterDone', processing:'filterProcessing'}[f];
        var el = $(active);
        if (el) el.classList.add('active');
        loadJobs();
    }

    bind('searchToggle', 'click', function() {
        var box = $('searchBox');
        if (box) box.style.display = box.style.display === 'none' ? 'block' : 'none';
    });
    bind('searchInput', 'input', loadJobs);

    bind('menuToggle', 'click', function() {
        var sb = $('sidebar');
        if (sb) sb.classList.toggle('collapsed');
    });

    bind('newRecordBtn', 'click', showUpload);
    bind('sidebarNewBtn', 'click', showUpload);
    bind('backBtn', 'click', showUpload);

    bind('deleteJobBtn', 'click', function() {
        if (!currentJobId) return;
        if (!confirm('Удалить задачу ' + currentJobId + '?')) return;
        apiDelete('/api/jobs/' + currentJobId).then(function() {
            toast('Задача удалена', 'success');
            showUpload();
        }).catch(function(e) {
            toast('Ошибка удаления: ' + e.message, 'error');
        });
    });

    bind('downloadTxtBtn', 'click', function() {
        if (currentJobId) window.open(API + '/api/download/' + currentJobId + '?format=txt', '_blank');
    });
    bind('downloadSrtBtn', 'click', function() {
        if (currentJobId) window.open(API + '/api/download/' + currentJobId + '?format=srt', '_blank');
    });

    bind('saveSpeakersBtn', 'click', saveSpeakers);

    bind('paramsToggle', 'click', function() {
        var body = $('paramsBody');
        var toggle = $('paramsToggle');
        if (!body || !toggle) return;
        var open = body.style.display !== 'none';
        body.style.display = open ? 'none' : 'block';
        toggle.classList.toggle('open', !open);
    });

    // Banner close
    bind('bannerClose', 'click', function() {
        var banner = $('sessionBanner');
        if (banner) banner.style.display = 'none';
        localStorage.setItem('banner_closed', '1');
    });
    if (localStorage.getItem('banner_closed') === '1') {
        var banner = $('sessionBanner');
        if (banner) banner.style.display = 'none';
    }

    // Clear all
    bind('clearAllBtn', 'click', function() {
        if (!confirm('⚠️ ВНИМАНИЕ

Все загруженные файлы, результаты транскрибации и записи будут безвозвратно удалены.

Продолжить?')) return;
        fetch(API + '/api/jobs', {
            method: 'DELETE',
            headers: { 'X-User-ID': USER_ID }
        }).then(function(r) {
            if (!r.ok) throw new Error(r.status + ' ' + r.statusText);
            return r.json();
        }).then(function(data) {
            toast(data.msg || 'Все задачи удалены', 'success');
            currentJobId = null;
            currentSpeakers = {};
            showUpload();
        }).catch(function(e) {
            toast('Ошибка очистки: ' + e.message, 'error');
        });
    });

    // Polling
    function startPolling() {
        if (pollTimer) clearInterval(pollTimer);
        pollTimer = setInterval(function() {
            loadJobs();
            if (currentJobId && $('viewScreen') && $('viewScreen').style.display !== 'none') {
                openJob(currentJobId);
            }
        }, 5000);
    }

    // Init
    loadJobs();
    startPolling();
})();
