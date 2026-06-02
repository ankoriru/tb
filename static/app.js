(function(){
    'use strict';
    console.log('[APP] Script loaded v2');

    var USER_ID = localStorage.getItem('whisper_user_id');
    if (!USER_ID) {
        USER_ID = 'u-' + Math.random().toString(36).slice(2, 10) + '-' + Date.now().toString(36).slice(-4);
        localStorage.setItem('whisper_user_id', USER_ID);
        console.log('[APP] New user ID:', USER_ID);
    } else {
        console.log('[APP] Existing user ID:', USER_ID);
    }

    var API = '';
    var pollTimer = null;
    var currentJobId = null;
    var currentSpeakers = {};
    var mediaRecorder = null;
    var recChunks = [];
    var recStartTime = 0;
    var recTimerInterval = null;
    var activeFilter = 'all';
    var MAX_FILE_SIZE_MB = 200;
    var editingSpeakers = false; // true когда пользователь редактирует спикеров // загрузится с /api/health

    function $(id) {
        var el = document.getElementById(id);
        if (!el) console.warn('[APP] Element not found: #' + id);
        return el;
    }

    function on(id, event, handler) {
        var el = $(id);
        if (el) {
            el.addEventListener(event, handler);
            console.log('[APP] Bound', event, 'to #' + id);
        }
    }

    function toast(msg, type) {
        type = type || 'info';
        var el = document.createElement('div');
        el.className = 'toast ' + type;
        el.textContent = msg;
        var container = $('toastContainer');
        if (container) container.appendChild(el);
        setTimeout(function() { if (el.parentNode) el.parentNode.removeChild(el); }, 4000);
    }

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

    function loadJobs() {
        console.log('[APP] loadJobs');
        apiGet('/api/jobs').then(function(data) {
            renderJobs(data.jobs || []);
        }).catch(function(e) {
            console.error('[APP] loadJobs error:', e);
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
            if (list) list.innerHTML = '<div class="empty-state"><div style="font-size:48px">🎙️</div><p>Записей не найдено</p></div>';
            return;
        }

        if (list) {
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
    }

    function openJob(id) {
        console.log('[APP] openJob', id);
        currentJobId = id;
        apiGet('/api/status/' + id).then(function(j) {
            var us = $('uploadScreen');
            var vs = $('viewScreen');
            if (us) us.style.display = 'none';
            if (vs) vs.style.display = 'block';

            var vm = $('viewMeta');
            if (vm) vm.textContent = 'ID: ' + j.job_id + ' | Создано: ' + formatDate(j.created_at) + ' | Начато: ' + formatDate(j.started_at) + ' | Завершено: ' + formatDate(j.finished_at);

            var stText = {pending:'В очереди', processing:'Обработка', done:'Готово', failed:'Ошибка'}[j.status] || j.status;
            var vsb = $('viewStatus');
            if (vsb) vsb.innerHTML = '<span class="record-status status-' + j.status + '">' + stText + '</span>';

            if (j.status === 'done') {
                currentSpeakers = j.speakers || {};
                // Не перерисовывать спикеров если пользователь их редактирует
                if (!editingSpeakers) {
                    renderSpeakers(currentSpeakers);
                }
                var sp = $('speakersPanel');
                if (sp) sp.style.display = 'block';

                fetch(API + '/api/download/' + id + '?format=txt', { headers: { 'X-User-ID': USER_ID } })
                    .then(function(r) { return r.text(); })
                    .then(function(txt) {
                        var vt = $('viewText');
                        if (vt) vt.textContent = txt;
                    }).catch(function() {
                        var vt = $('viewText');
                        if (vt) vt.textContent = 'Текст недоступен';
                    });

                var dtb = $('downloadTxtBtn');
                var dsb = $('downloadSrtBtn');
                if (dtb) dtb.style.display = '';
                if (dsb) dsb.style.display = '';
            } else if (j.error) {
                var vt = $('viewText');
                if (vt) vt.textContent = 'Ошибка: ' + j.error;
                var sp = $('speakersPanel');
                if (sp) sp.style.display = 'none';
                var dtb = $('downloadTxtBtn');
                var dsb = $('downloadSrtBtn');
                if (dtb) dtb.style.display = 'none';
                if (dsb) dsb.style.display = 'none';
            } else {
                var vt = $('viewText');
                if (vt) vt.textContent = 'Обработка... Пожалуйста, подождите. Автообновление каждые 5 сек.';
                var sp = $('speakersPanel');
                if (sp) sp.style.display = 'none';
                var dtb = $('downloadTxtBtn');
                var dsb = $('downloadSrtBtn');
                if (dtb) dtb.style.display = 'none';
                if (dsb) dsb.style.display = 'none';
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
            if (list) list.innerHTML = '<p style="font-size:13px;color:var(--text-secondary)">Спикеры не определены</p>';
            return;
        }
        if (list) {
            list.innerHTML = keys.map(function(num) {
                return '<div class="speaker-row"><span class="speaker-label">Спикер ' + esc(num) + '</span><input type="text" data-spk="' + esc(num) + '" value="' + esc(speakers[num]) + '" placeholder="Введите ФИО или название"></div>';
            }).join('');
            // Добавить обработчики focus/blur для остановки polling
            list.querySelectorAll('input[data-spk]').forEach(function(inp) {
                inp.addEventListener('focus', function() {
                    editingSpeakers = true;
                    console.log('[APP] editingSpeakers = true');
                });
                inp.addEventListener('blur', function() {
                    editingSpeakers = false;
                    console.log('[APP] editingSpeakers = false');
                });
            });
        }
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
        console.log('[APP] showUpload');
        currentJobId = null;
        currentSpeakers = {};
        var vs = $('viewScreen');
        var us = $('uploadScreen');
        if (vs) vs.style.display = 'none';
        if (us) us.style.display = 'block';
        loadJobs();
    }

    function uploadFile(file) {
        console.log('[APP] uploadFile', file.name, file.size);
        var sizeMb = file.size / (1024 * 1024);
        if (sizeMb > MAX_FILE_SIZE_MB) {
            toast('Файл слишком большой (' + sizeMb.toFixed(1) + ' МБ). Максимум: ' + MAX_FILE_SIZE_MB + ' МБ. Разбейте на части или сожмите.', 'error');
            return;
        }
        var fd = new FormData();
        fd.append('file', file);
        var card = document.createElement('div');
        card.className = 'upload-progress';
        card.innerHTML = '<div class="upload-progress-file">' + esc(file.name) + ' (' + (file.size/1024/1024).toFixed(1) + ' МБ)</div><div class="progress-bar"><div class="progress-fill" style="width:0%"></div></div><div class="progress-status">Загрузка...</div>';
        var zone = $('dropZone');
        if (zone && zone.parentNode) zone.parentNode.insertBefore(card, zone.nextSibling);

        apiPost('/api/upload', fd).then(function(data) {
            console.log('[APP] Upload success', data);
            var fill = card.querySelector('.progress-fill');
            if (fill) fill.style.width = '100%';
            var status = card.querySelector('.progress-status');
            if (status) status.textContent = 'Принято: ' + data.job_id;
            toast('Файл принят: ' + data.job_id, 'success');
            loadJobs();
        }).catch(function(e) {
            console.error('[APP] Upload error', e);
            var status = card.querySelector('.progress-status');
            if (status) status.textContent = 'Ошибка: ' + e.message;
            toast('Ошибка загрузки: ' + e.message, 'error');
        });
    }

    function formatRecTime(ms) {
        var s = Math.floor(ms / 1000);
        var m = Math.floor(s / 60);
        var sec = s % 60;
        return String(m).padStart(2,'0') + ':' + String(sec).padStart(2,'0');
    }

    function startRecording(audioOnly) {
        console.log('[APP] startRecording', audioOnly);
        if (!navigator.mediaDevices) {
            toast('Ваш браузер не поддерживает запись аудио. Используйте Chrome или Edge.', 'error');
            return;
        }
        var constraints;
        if (audioOnly) {
            constraints = navigator.mediaDevices.getUserMedia({ audio: true });
        } else {
            // Системный звук — только Chrome/Edge, требует video:true в некоторых случаях
            if (!navigator.mediaDevices.getDisplayMedia) {
                toast('Захват системного звука не поддерживается в этом браузере. Используйте Chrome или Edge.', 'error');
                return;
            }
            constraints = navigator.mediaDevices.getDisplayMedia({ video: true, audio: true });
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
            var msg = e.message || String(e);
            if (msg.indexOf('NotAllowed') !== -1 || msg.indexOf('Permission denied') !== -1) {
                toast('Доступ запрещён. Разрешите доступ в диалоге браузера.', 'error');
            } else if (msg.indexOf('NotSupported') !== -1 || msg.indexOf('not supported') !== -1) {
                toast('Захват системного звука не поддерживается. Используйте Chrome/Edge и включите «Поделиться аудио» при выборе вкладки.', 'error');
            } else {
                toast('Ошибка доступа: ' + msg, 'error');
            }
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
        console.log('[APP] startBothRecording');
        if (!navigator.mediaDevices || !navigator.mediaDevices.getDisplayMedia) {
            toast('Захват системного звука не поддерживается в этом браузере. Используйте Chrome или Edge.', 'error');
            return;
        }
        Promise.all([
            navigator.mediaDevices.getUserMedia({ audio: true }),
            navigator.mediaDevices.getDisplayMedia({ video: true, audio: true })
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
            var msg = e.message || String(e);
            if (msg.indexOf('NotAllowed') !== -1 || msg.indexOf('Permission denied') !== -1) {
                toast('Доступ запрещён. Разрешите доступ в диалоге браузера.', 'error');
            } else if (msg.indexOf('NotSupported') !== -1 || msg.indexOf('not supported') !== -1) {
                toast('Захват системного звука не поддерживается. Используйте Chrome/Edge и включите «Поделиться аудио» при выборе вкладки.', 'error');
            } else {
                toast('Ошибка записи: ' + msg, 'error');
            }
        });
    }

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

    // === EVENT BINDINGS ===
    console.log('[APP] Binding events...');

    // Drag & Drop (на dropZone, не на input)
    on('dropZone', 'dragover', function(e) {
        e.preventDefault();
        var dz = $('dropZone');
        if (dz) dz.classList.add('dragover');
    });
    on('dropZone', 'dragleave', function() {
        var dz = $('dropZone');
        if (dz) dz.classList.remove('dragover');
    });
    on('dropZone', 'drop', function(e) {
        e.preventDefault();
        console.log('[APP] dropZone drop', e.dataTransfer.files.length, 'files');
        var dz = $('dropZone');
        if (dz) dz.classList.remove('dragover');
        Array.from(e.dataTransfer.files).forEach(uploadFile);
    });

    // File input change (input overlay перехватывает клики сам)
    on('fileInput', 'change', function() {
        console.log('[APP] fileInput change', this.files.length, 'files');
        var inp = $('fileInput');
        if (inp) {
            Array.from(inp.files).forEach(uploadFile);
            inp.value = ''; // сброс для повторной загрузки того же файла
        }
    });

    on('recordMicBtn', 'click', function() { startRecording(true); });
    on('recordSystemBtn', 'click', function() { startRecording(false); });
    on('recordBothBtn', 'click', startBothRecording);
    on('stopRecBtn', 'click', function() {
        if (mediaRecorder && mediaRecorder.state !== 'inactive') mediaRecorder.stop();
    });

    on('filterAll', 'click', function() { setFilter('all'); });
    on('filterDone', 'click', function() { setFilter('done'); });
    on('filterProcessing', 'click', function() { setFilter('processing'); });

    on('searchToggle', 'click', function() {
        var box = $('searchBox');
        if (box) box.style.display = box.style.display === 'none' ? 'block' : 'none';
    });
    on('searchInput', 'input', loadJobs);

    on('menuToggle', 'click', function() {
        var sb = $('sidebar');
        if (sb) sb.classList.toggle('collapsed');
    });

    on('newRecordBtn', 'click', function() {
        console.log('[APP] newRecordBtn click');
        showUpload();
    });
    on('sidebarNewBtn', 'click', function() {
        console.log('[APP] sidebarNewBtn click');
        showUpload();
    });
    on('backBtn', 'click', showUpload);

    on('deleteJobBtn', 'click', function() {
        if (!currentJobId) return;
        if (!confirm('Удалить задачу ' + currentJobId + '?')) return;
        apiDelete('/api/jobs/' + currentJobId).then(function() {
            toast('Задача удалена', 'success');
            showUpload();
        }).catch(function(e) {
            toast('Ошибка удаления: ' + e.message, 'error');
        });
    });

    on('downloadTxtBtn', 'click', function() {
        if (currentJobId) window.open(API + '/api/download/' + currentJobId + '?format=txt', '_blank');
    });
    on('downloadSrtBtn', 'click', function() {
        if (currentJobId) window.open(API + '/api/download/' + currentJobId + '?format=srt', '_blank');
    });

    on('saveSpeakersBtn', 'click', saveSpeakers);

    on('paramsToggle', 'click', function() {
        var body = $('paramsBody');
        var toggle = $('paramsToggle');
        var chevron = $('paramsChevron');
        if (!body || !toggle) return;
        var open = body.style.display !== 'none';
        body.style.display = open ? 'none' : 'block';
        toggle.classList.toggle('open', !open);
        if (chevron) chevron.textContent = open ? '▼' : '▲';
    });

    on('bannerClose', 'click', function() {
        var banner = $('sessionBanner');
        if (banner) banner.style.display = 'none';
        localStorage.setItem('banner_closed', '1');
    });

    if (localStorage.getItem('banner_closed') === '1') {
        var banner = $('sessionBanner');
        if (banner) banner.style.display = 'none';
    }

    on('clearAllBtn', 'click', function() {
        console.log('[APP] clearAllBtn click');
        if (!confirm('⚠️ ВНИМАНИЕ\n\nВсе загруженные файлы, результаты транскрибации и записи будут безвозвратно удалены.\n\nПродолжить?')) return;
        // Удалить все прогресс-карточки из DOM
        document.querySelectorAll('.upload-progress').forEach(function(el) { el.remove(); });
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
            // Не обновлять view если пользователь редактирует спикеров
            if (currentJobId && !editingSpeakers && $('viewScreen') && $('viewScreen').style.display !== 'none') {
                openJob(currentJobId);
            }
        }, 5000);
    }

    // Init
    console.log('[APP] Initializing...');
    loadJobs();
    startPolling();
    console.log('[APP] Initialized');
})();
