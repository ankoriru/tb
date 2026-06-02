(function(){
    let USER_ID = localStorage.getItem('whisper_user_id');
    if (!USER_ID) {
        USER_ID = 'u-' + Math.random().toString(36).slice(2, 10) + '-' + Date.now().toString(36).slice(-4);
        localStorage.setItem('whisper_user_id', USER_ID);
    }

    const API = '';
    let pollTimer = null;
    let currentJobId = null;
    let currentSpeakers = {}; // {1: "Спикер 1", 2: "Иванов"}
    let mediaRecorder = null;
    let recChunks = [];
    let recStartTime = 0;
    let recTimerInterval = null;

    const els = {
        recordsList: document.getElementById('recordsList'),
        dropZone: document.getElementById('dropZone'),
        fileInput: document.getElementById('fileInput'),
        uploadScreen: document.getElementById('uploadScreen'),
        viewScreen: document.getElementById('viewScreen'),
        viewMeta: document.getElementById('viewMeta'),
        viewStatus: document.getElementById('viewStatus'),
        viewText: document.getElementById('viewText'),
        speakersPanel: document.getElementById('speakersPanel'),
        speakersList: document.getElementById('speakersList'),
        saveSpeakersBtn: document.getElementById('saveSpeakersBtn'),
        backBtn: document.getElementById('backBtn'),
        deleteJobBtn: document.getElementById('deleteJobBtn'),
        downloadTxtBtn: document.getElementById('downloadTxtBtn'),
        downloadSrtBtn: document.getElementById('downloadSrtBtn'),
        searchInput: document.getElementById('searchInput'),
        searchToggle: document.getElementById('searchToggle'),
        searchBox: document.getElementById('searchBox'),
        menuToggle: document.getElementById('menuToggle'),
        sidebar: document.getElementById('sidebar'),
        newRecordBtn: document.getElementById('newRecordBtn'),
        sidebarNewBtn: document.getElementById('sidebarNewBtn'),
        paramsToggle: document.getElementById('paramsToggle'),
        paramsBody: document.getElementById('paramsBody'),
        recordMicBtn: document.getElementById('recordMicBtn'),
        recordSystemBtn: document.getElementById('recordSystemBtn'),
        recordBothBtn: document.getElementById('recordBothBtn'),
        recorderStatus: document.getElementById('recorderStatus'),
        recTime: document.getElementById('recTime'),
        stopRecBtn: document.getElementById('stopRecBtn'),
        toastContainer: document.getElementById('toastContainer'),
        filterAll: document.getElementById('filterAll'),
        filterDone: document.getElementById('filterDone'),
        filterProcessing: document.getElementById('filterProcessing'),
    };

    let activeFilter = 'all';

    function toast(msg, type='info') {
        const el = document.createElement('div');
        el.className = 'toast ' + type;
        el.textContent = msg;
        els.toastContainer.appendChild(el);
        setTimeout(() => el.remove(), 4000);
    }

    async function apiGet(path) {
        const r = await fetch(API + path, { headers: { 'X-User-ID': USER_ID } });
        if (!r.ok) throw new Error(r.status + ' ' + r.statusText);
        return r.json();
    }
    async function apiPost(path, body) {
        const r = await fetch(API + path, { method: 'POST', headers: { 'X-User-ID': USER_ID }, body });
        if (!r.ok) throw new Error(r.status + ' ' + r.statusText);
        return r.json();
    }
    async function apiPostJson(path, body) {
        const r = await fetch(API + path, {
            method: 'POST',
            headers: { 'X-User-ID': USER_ID, 'Content-Type': 'application/json' },
            body: JSON.stringify(body)
        });
        if (!r.ok) throw new Error(r.status + ' ' + r.statusText);
        return r.json();
    }
    async function apiDelete(path) {
        const r = await fetch(API + path, { method: 'DELETE', headers: { 'X-User-ID': USER_ID } });
        if (!r.ok) throw new Error(r.status + ' ' + r.statusText);
        return r.json();
    }

    async function loadJobs() {
        try {
            const data = await apiGet('/api/jobs');
            renderJobs(data.jobs || []);
        } catch(e) {
            console.error(e);
        }
    }

    function formatDate(iso) {
        if (!iso) return '';
        const d = new Date(iso);
        return d.toLocaleString('ru-RU', { day:'2-digit', month:'2-digit', hour:'2-digit', minute:'2-digit' });
    }

    function renderJobs(jobs) {
        const term = (els.searchInput.value || '').toLowerCase();
        const filtered = jobs.filter(j => {
            if (activeFilter === 'done' && j.status !== 'done') return false;
            if (activeFilter === 'processing' && (j.status === 'done' || j.status === 'failed')) return false;
            if (!term) return true;
            return (j.filename || '').toLowerCase().includes(term) || (j.id || '').toLowerCase().includes(term);
        });

        if (!filtered.length) {
            els.recordsList.innerHTML = `
                <div class="empty-state">
                    <svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M12 2a3 3 0 0 0-3 3v7a3 3 0 0 0 6 0V5a3 3 0 0 0-3-3Z"></path><path d="M19 10v2a7 7 0 0 1-14 0v-2"></path><line x1="12" y1="19" x2="12" y2="22"></line></svg>
                    <p>Записей не найдено</p>
                </div>`;
            return;
        }

        els.recordsList.innerHTML = filtered.map(j => {
            const stClass = 'status-' + j.status;
            const stText = {pending:'В очереди', processing:'Обработка', done:'Готово', failed:'Ошибка'}[j.status] || j.status;
            const activeCls = currentJobId === j.id ? 'active' : '';
            return `
            <div class="record-card ${activeCls}" data-id="${j.id}">
                <div class="record-title">${esc(j.filename || 'Без имени')}</div>
                <div class="record-meta">
                    <span>${formatDate(j.created_at)}</span>
                    <span class="record-status ${stClass}">${stText}</span>
                </div>
                <div class="record-tags">
                    <span class="record-tag">${esc(j.id)}</span>
                </div>
            </div>`;
        }).join('');

        els.recordsList.querySelectorAll('.record-card').forEach(card => {
            card.addEventListener('click', () => openJob(card.dataset.id));
        });
    }

    function esc(s) {
        const d = document.createElement('div');
        d.textContent = s;
        return d.innerHTML;
    }

    async function openJob(id) {
        currentJobId = id;
        try {
            const j = await apiGet('/api/status/' + id);
            els.uploadScreen.style.display = 'none';
            els.viewScreen.style.display = 'block';
            els.viewMeta.textContent = `ID: ${j.job_id} | Создано: ${formatDate(j.created_at)} | Начато: ${formatDate(j.started_at)} | Завершено: ${formatDate(j.finished_at)}`;
            const stText = {pending:'В очереди', processing:'Обработка', done:'Готово', failed:'Ошибка'}[j.status] || j.status;
            const stClass = 'record-status status-' + j.status;
            els.viewStatus.innerHTML = `<span class="${stClass}">${stText}</span>`;

            if (j.status === 'done') {
                currentSpeakers = j.speakers || {};
                renderSpeakers(currentSpeakers);
                els.speakersPanel.style.display = 'block';
                try {
                    const txt = await fetch(API + '/api/download/' + id + '?format=txt', { headers: { 'X-User-ID': USER_ID } }).then(r => r.text());
                    els.viewText.textContent = txt;
                } catch(e) {
                    els.viewText.textContent = 'Текст недоступен';
                }
                els.downloadTxtBtn.style.display = '';
                els.downloadSrtBtn.style.display = '';
            } else if (j.error) {
                els.viewText.textContent = 'Ошибка: ' + j.error;
                els.speakersPanel.style.display = 'none';
                els.downloadTxtBtn.style.display = 'none';
                els.downloadSrtBtn.style.display = 'none';
            } else {
                els.viewText.textContent = 'Обработка... Пожалуйста, подождите. Автообновление каждые 5 сек.';
                els.speakersPanel.style.display = 'none';
                els.downloadTxtBtn.style.display = 'none';
                els.downloadSrtBtn.style.display = 'none';
            }
            renderJobs((await apiGet('/api/jobs')).jobs || []);
        } catch(e) {
            toast('Ошибка загрузки задачи: ' + e.message, 'error');
        }
    }

    function renderSpeakers(speakers) {
        if (!speakers || Object.keys(speakers).length === 0) {
            els.speakersList.innerHTML = '<p style="font-size:13px;color:var(--text-secondary)">Спикеры не определены</p>';
            return;
        }
        els.speakersList.innerHTML = Object.entries(speakers).map(([num, name]) => `
            <div class="speaker-row">
                <span class="speaker-label">Спикер ${esc(num)}</span>
                <input type="text" data-spk="${esc(num)}" value="${esc(name)}" placeholder="Введите ФИО или название">
            </div>
        `).join('');
    }

    async function saveSpeakers() {
        if (!currentJobId) return;
        const inputs = els.speakersList.querySelectorAll('input[data-spk]');
        const names = {};
        inputs.forEach(inp => { names[inp.dataset.spk] = inp.value; });
        try {
            await apiPostJson('/api/jobs/' + currentJobId + '/speakers', { names });
            toast('Имена участников сохранены', 'success');
            // перезагрузим текст с новыми именами
            openJob(currentJobId);
        } catch(e) {
            toast('Ошибка сохранения: ' + e.message, 'error');
        }
    }

    els.saveSpeakersBtn.addEventListener('click', saveSpeakers);

    function showUpload() {
        currentJobId = null;
        currentSpeakers = {};
        els.viewScreen.style.display = 'none';
        els.uploadScreen.style.display = 'block';
        loadJobs();
    }

    async function uploadFile(file) {
        const fd = new FormData();
        fd.append('file', file);
        const card = document.createElement('div');
        card.className = 'upload-progress';
        card.innerHTML = `
            <div class="upload-progress-file">${esc(file.name)}</div>
            <div class="progress-bar"><div class="progress-fill" style="width:0%"></div></div>
            <div class="progress-status">Загрузка...</div>
        `;
        els.dropZone.parentNode.insertBefore(card, els.dropZone.nextSibling);

        try {
            const data = await apiPost('/api/upload', fd);
            card.querySelector('.progress-fill').style.width = '100%';
            card.querySelector('.progress-status').textContent = 'Принято: ' + data.job_id;
            toast('Файл принят: ' + data.job_id, 'success');
            loadJobs();
        } catch(e) {
            card.querySelector('.progress-status').textContent = 'Ошибка: ' + e.message;
            toast('Ошибка загрузки: ' + e.message, 'error');
        }
    }

    els.dropZone.addEventListener('click', () => els.fileInput.click());
    els.dropZone.addEventListener('dragover', e => { e.preventDefault(); els.dropZone.classList.add('dragover'); });
    els.dropZone.addEventListener('dragleave', () => els.dropZone.classList.remove('dragover'));
    els.dropZone.addEventListener('drop', e => {
        e.preventDefault();
        els.dropZone.classList.remove('dragover');
        Array.from(e.dataTransfer.files).forEach(uploadFile);
    });
    els.fileInput.addEventListener('change', () => Array.from(els.fileInput.files).forEach(uploadFile));

    function formatRecTime(ms) {
        const s = Math.floor(ms / 1000);
        const m = Math.floor(s / 60);
        const sec = s % 60;
        return String(m).padStart(2,'0') + ':' + String(sec).padStart(2,'0');
    }

    async function startRecording(audioOnly=true) {
        try {
            let stream;
            if (audioOnly) {
                stream = await navigator.mediaDevices.getUserMedia({ audio: true });
            } else {
                stream = await navigator.mediaDevices.getDisplayMedia({ video: false, audio: true });
            }
            mediaRecorder = new MediaRecorder(stream);
            recChunks = [];
            mediaRecorder.ondataavailable = e => { if (e.data.size) recChunks.push(e.data); };
            mediaRecorder.onstop = () => {
                const blob = new Blob(recChunks, { type: 'audio/webm' });
                const file = new File([blob], 'recording_' + new Date().toISOString().slice(0,19).replace(/[:T]/g,'-') + '.webm', { type: 'audio/webm' });
                uploadFile(file);
                stream.getTracks().forEach(t => t.stop());
                stopRecUI();
            };
            mediaRecorder.start();
            recStartTime = Date.now();
            recTimerInterval = setInterval(() => {
                els.recTime.textContent = formatRecTime(Date.now() - recStartTime);
            }, 1000);
            els.recorderStatus.style.display = 'flex';
            toast('Запись началась', 'info');
        } catch(e) {
            toast('Ошибка доступа к микрофону: ' + e.message, 'error');
        }
    }

    function stopRecUI() {
        clearInterval(recTimerInterval);
        els.recorderStatus.style.display = 'none';
        els.recTime.textContent = '00:00';
    }

    els.recordMicBtn.addEventListener('click', () => startRecording(true));
    els.recordSystemBtn.addEventListener('click', () => startRecording(false));
    els.recordBothBtn.addEventListener('click', async () => {
        try {
            const micStream = await navigator.mediaDevices.getUserMedia({ audio: true });
            const sysStream = await navigator.mediaDevices.getDisplayMedia({ video: false, audio: true });
            const ctx = new AudioContext();
            const dest = ctx.createMediaStreamDestination();
            const micSrc = ctx.createMediaStreamSource(micStream);
            const sysSrc = ctx.createMediaStreamSource(sysStream);
            micSrc.connect(dest);
            sysSrc.connect(dest);
            mediaRecorder = new MediaRecorder(dest.stream);
            recChunks = [];
            mediaRecorder.ondataavailable = e => { if (e.data.size) recChunks.push(e.data); };
            mediaRecorder.onstop = () => {
                const blob = new Blob(recChunks, { type: 'audio/webm' });
                const file = new File([blob], 'recording_both_' + new Date().toISOString().slice(0,19).replace(/[:T]/g,'-') + '.webm', { type: 'audio/webm' });
                uploadFile(file);
                micStream.getTracks().forEach(t => t.stop());
                sysStream.getTracks().forEach(t => t.stop());
                ctx.close();
                stopRecUI();
            };
            mediaRecorder.start();
            recStartTime = Date.now();
            recTimerInterval = setInterval(() => {
                els.recTime.textContent = formatRecTime(Date.now() - recStartTime);
            }, 1000);
            els.recorderStatus.style.display = 'flex';
            toast('Запись микрофон + система началась', 'info');
        } catch(e) {
            toast('Ошибка: ' + e.message, 'error');
        }
    });
    els.stopRecBtn.addEventListener('click', () => { if (mediaRecorder && mediaRecorder.state !== 'inactive') mediaRecorder.stop(); });

    function setFilter(f) {
        activeFilter = f;
        [els.filterAll, els.filterDone, els.filterProcessing].forEach(b => b.classList.remove('active'));
        if (f === 'all') els.filterAll.classList.add('active');
        if (f === 'done') els.filterDone.classList.add('active');
        if (f === 'processing') els.filterProcessing.classList.add('active');
        loadJobs();
    }
    els.filterAll.addEventListener('click', () => setFilter('all'));
    els.filterDone.addEventListener('click', () => setFilter('done'));
    els.filterProcessing.addEventListener('click', () => setFilter('processing'));

    els.searchToggle.addEventListener('click', () => {
        const vis = els.searchBox.style.display !== 'none';
        els.searchBox.style.display = vis ? 'none' : 'block';
    });
    els.searchInput.addEventListener('input', () => loadJobs());

    els.backBtn.addEventListener('click', showUpload);
    els.newRecordBtn.addEventListener('click', showUpload);
    els.sidebarNewBtn.addEventListener('click', showUpload);
    els.menuToggle.addEventListener('click', () => els.sidebar.classList.toggle('collapsed'));

    els.deleteJobBtn.addEventListener('click', async () => {
        if (!currentJobId) return;
        if (!confirm('Удалить задачу ' + currentJobId + '?')) return;
        try {
            await apiDelete('/api/jobs/' + currentJobId);
            toast('Задача удалена', 'success');
            showUpload();
        } catch(e) {
            toast('Ошибка удаления: ' + e.message, 'error');
        }
    });

    // --- Очистить все ---
    const clearAllBtn = document.getElementById('clearAllBtn');
    if (clearAllBtn) {
        clearAllBtn.addEventListener('click', async () => {
            if (!confirm('⚠️ ВНИМАНИЕ\n\nВсе загруженные файлы, результаты транскрибации и записи будут безвозвратно удалены.\n\nПродолжить?')) return;
            try {
                const r = await fetch(API + '/api/jobs', {
                    method: 'DELETE',
                    headers: { 'X-User-ID': USER_ID }
                });
                if (!r.ok) throw new Error(r.status + ' ' + r.statusText);
                const data = await r.json();
                toast(data.msg || 'Все задачи удалены', 'success');
                currentJobId = null;
                currentSpeakers = {};
                showUpload();
            } catch(e) {
                toast('Ошибка очистки: ' + e.message, 'error');
            }
        });
    }

    els.downloadTxtBtn.addEventListener('click', () => {
        if (currentJobId) window.open(API + '/api/download/' + currentJobId + '?format=txt', '_blank');
    });
    els.downloadSrtBtn.addEventListener('click', () => {
        if (currentJobId) window.open(API + '/api/download/' + currentJobId + '?format=srt', '_blank');
    });

    els.paramsToggle.addEventListener('click', () => {
        const open = els.paramsBody.style.display !== 'none';
        els.paramsBody.style.display = open ? 'none' : 'block';
        els.paramsToggle.classList.toggle('open', !open);
    });

    function startPolling() {
        if (pollTimer) clearInterval(pollTimer);
        pollTimer = setInterval(() => {
            loadJobs();
            if (currentJobId && els.viewScreen.style.display !== 'none') openJob(currentJobId);
        }, 5000);
    }

    loadJobs();
    startPolling();
})();
