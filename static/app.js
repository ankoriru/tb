(function(){
    'use strict';
    console.log('[APP] Script loaded v5');

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
    var currentSegments = [];
    var editingSpeakers = false;
    var mediaRecorder = null;
    var recChunks = [];
    var recStartTime = 0;
    var recTimerInterval = null;
    var activeFilter = 'all';
    var activeTab = 'transcript';
    var MAX_FILE_SIZE_MB = 200;
    var chatHistory = [];

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
    function apiPatchJson(path, body) {
        return fetch(API + path, {
            method: 'PATCH',
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

    function formatTime(seconds) {
        var m = Math.floor(seconds / 60);
        var s = Math.floor(seconds % 60);
        return String(m).padStart(2,'0') + ':' + String(s).padStart(2,'0');
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

    // --- LLM Models ---
    function loadModels() {
        apiGet('/api/models').then(function(data) {
            var select = $('llmModelSelect');
            var row = $('llmModelRow');
            var hint = $('llmModelHint');
            if (!select || !row) return;
            if (data.models && data.models.length) {
                row.style.display = '';
                if (hint) hint.style.display = 'none';
                select.innerHTML = data.models.map(function(m) {
                    return '<option value="' + esc(m) + '">' + esc(m) + '</option>';
                }).join('');
                // Восстановить сохранённую или выбрать первую
                var saved = localStorage.getItem('llm_model');
                if (saved && data.models.indexOf(saved) !== -1) {
                    select.value = saved;
                } else {
                    select.selectedIndex = 0;
                    localStorage.setItem('llm_model', select.value);
                }
                select.addEventListener('change', function() {
                    localStorage.setItem('llm_model', select.value);
                });
            } else {
                if (hint) hint.textContent = data.error || 'Модели не загружены';
            }
        }).catch(function(e) {
            var row = $('llmModelRow');
            var hint = $('llmModelHint');
            if (row) row.style.display = '';
            if (hint) hint.textContent = 'LLM не настроен';
        });
    }

    function getSelectedModel() {
        var sel = $('llmModelSelect');
        if (sel && sel.value) return sel.value;
        return localStorage.getItem('llm_model') || '';
    }

    // --- View job ---
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

            // Аудио плеер
            var apw = $('audioPlayerWrap');
            var ap = $('audioPlayer');
            if (j.status === 'done' && j.files && j.files.audio) {
                if (apw) apw.style.display = 'block';
                if (ap) {
                    ap.src = j.files.audio;
                    ap.load();
                }
            } else {
                if (apw) apw.style.display = 'none';
                if (ap) { ap.pause(); ap.src = ''; }
            }

            if (j.status === 'done') {
                currentSpeakers = j.speakers || {};
                currentSegments = [];
                if (j.speakers_json) {
                    try {
                        currentSegments = JSON.parse(j.speakers_json);
                    } catch(e) {}
                }

                if (!editingSpeakers) {
                    renderSpeakers(currentSpeakers);
                }
                renderTranscript(currentSegments, currentSpeakers);

                var sp = $('speakersPanel');
                if (sp) sp.style.display = 'block';

                // Вкладки
                var tb = $('tabsBar');
                if (tb) tb.style.display = 'flex';
                switchTab(activeTab);

                // Резюме
                var summaryActions = $('summaryActions');
                var summaryHint = $('summaryHint');
                var summaryContent = $('summaryContent');
                if (summaryActions) {
                    if (j.llm_configured) {
                        summaryActions.style.display = 'flex';
                        if (summaryHint) summaryHint.style.display = 'none';
                    } else {
                        summaryActions.style.display = 'flex';
                        if (summaryHint) summaryHint.style.display = '';
                        var genBtn = $('generateSummaryBtn');
                        if (genBtn) {
                            genBtn.disabled = true;
                            genBtn.textContent = '🔒 API ключ не настроен';
                        }
                    }
                }
                if (j.summary) {
                    if (summaryContent) summaryContent.innerHTML = markdownToHtml(j.summary);
                    if (summaryActions) summaryActions.style.display = 'none';
                } else {
                    if (summaryContent) summaryContent.innerHTML = '';
                }
                // Сброс редактирования резюме
                if (summaryContent) summaryContent.contentEditable = 'false';
                var esb = $('editSummaryBtn');
                var ssb = $('saveSummaryBtn');
                if (esb) esb.style.display = '';
                if (ssb) ssb.style.display = 'none';

                // Чат
                var chatSection = $('chatSection');
                if (chatSection) {
                    if (j.llm_configured) {
                        chatSection.style.display = 'block';
                        loadChat(id);
                    } else {
                        chatSection.style.display = 'none';
                    }
                }

                var dtb = $('downloadTxtBtn');
                var dsb = $('downloadSrtBtn');
                if (dtb) dtb.style.display = '';
                if (dsb) dsb.style.display = '';
            } else if (j.error) {
                var tc = $('transcriptContent');
                if (tc) tc.innerHTML = '<pre>Ошибка: ' + esc(j.error) + '</pre>';
                var sp = $('speakersPanel');
                if (sp) sp.style.display = 'none';
                var tb = $('tabsBar');
                if (tb) tb.style.display = 'none';
                var apw = $('audioPlayerWrap');
                if (apw) apw.style.display = 'none';
                var dtb = $('downloadTxtBtn');
                var dsb = $('downloadSrtBtn');
                if (dtb) dtb.style.display = 'none';
                if (dsb) dsb.style.display = 'none';
                var chatSection = $('chatSection');
                if (chatSection) chatSection.style.display = 'none';
            } else {
                var tc = $('transcriptContent');
                if (tc) tc.innerHTML = '<pre>Обработка... Пожалуйста, подождите. Автообновление каждые 5 сек.</pre>';
                var sp = $('speakersPanel');
                if (sp) sp.style.display = 'none';
                var tb = $('tabsBar');
                if (tb) tb.style.display = 'none';
                var apw = $('audioPlayerWrap');
                if (apw) apw.style.display = 'none';
                var dtb = $('downloadTxtBtn');
                var dsb = $('downloadSrtBtn');
                if (dtb) dtb.style.display = 'none';
                if (dsb) dsb.style.display = 'none';
                var chatSection = $('chatSection');
                if (chatSection) chatSection.style.display = 'none';
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

    function renderTranscript(segments, speakerNames) {
        var container = $('transcriptContent');
        if (!container) return;
        if (!segments || !segments.length) {
            container.innerHTML = '<pre id="viewText"></pre>';
            if (currentJobId) {
                fetch(API + '/api/download/' + currentJobId + '?format=txt', { headers: { 'X-User-ID': USER_ID } })
                    .then(function(r) { return r.text(); })
                    .then(function(txt) {
                        var vt = $('viewText');
                        if (vt) vt.textContent = txt;
                    });
            }
            return;
        }
        container.innerHTML = segments.map(function(seg, idx) {
            var name = (speakerNames && speakerNames[String(seg.speaker)]) || ('Спикер ' + seg.speaker);
            return '<div class="transcript-segment" data-start="' + seg.start + '" data-end="' + seg.end + '" title="Кликните для прослушивания">' +
                '<span class="seg-time">[' + formatTime(seg.start) + ']</span>' +
                '<span class="seg-speaker">' + esc(name) + ':</span>' +
                '<span class="seg-text">' + esc(seg.text) + '</span>' +
                '</div>';
        }).join('');

        container.querySelectorAll('.transcript-segment').forEach(function(el) {
            el.addEventListener('click', function() {
                playSegment(parseFloat(el.dataset.start), parseFloat(el.dataset.end));
            });
        });
    }

    function playSegment(start, end) {
        var ap = $('audioPlayer');
        if (!ap || !ap.src) {
            toast('Аудио недоступно', 'error');
            return;
        }
        ap.currentTime = start;
        ap.play().catch(function(e) {
            console.error('Audio play error:', e);
        });
        var stopAt = end;
        var checkInterval = setInterval(function() {
            if (ap.currentTime >= stopAt || ap.paused) {
                ap.pause();
                clearInterval(checkInterval);
            }
        }, 100);
    }

    function switchTab(tab) {
        activeTab = tab;
        var tt = $('tabTranscript');
        var ts = $('tabSummary');
        var tc = $('tabTranscriptContent');
        var sc = $('tabSummaryContent');
        if (tab === 'transcript') {
            if (tt) tt.classList.add('active');
            if (ts) ts.classList.remove('active');
            if (tc) tc.classList.add('active');
            if (sc) sc.classList.remove('active');
        } else {
            if (tt) tt.classList.remove('active');
            if (ts) ts.classList.add('active');
            if (tc) tc.classList.remove('active');
            if (sc) sc.classList.add('active');
        }
    }

    // --- Chat ---
    function loadChat(jobId) {
        apiGet('/api/jobs/' + jobId + '/chat').then(function(data) {
            chatHistory = data.messages || [];
            renderChat();
        }).catch(function(e) {
            console.error('Chat load error:', e);
        });
    }

    function renderChat() {
        var container = $('chatMessages');
        if (!container) return;
        if (!chatHistory.length) {
            container.innerHTML = '<div style="text-align:center;color:var(--text-secondary);font-size:13px;padding:20px;">Задайте первый вопрос об этой записи</div>';
            return;
        }
        container.innerHTML = chatHistory.map(function(msg) {
            var isUser = msg.role === 'user';
            var avatar = isUser ? '👤' : '🤖';
            var cls = isUser ? 'user' : 'assistant';
            return '<div class="chat-message ' + cls + '">' +
                '<div class="chat-avatar">' + avatar + '</div>' +
                '<div class="chat-bubble">' + esc(msg.content) + '</div>' +
                '</div>';
        }).join('');
        container.scrollTop = container.scrollHeight;
    }

    function sendChat() {
        if (!currentJobId) return;
        var input = $('chatInput');
        var btn = $('chatSendBtn');
        if (!input || !input.value.trim()) return;
        var msg = input.value.trim();
        input.value = '';
        if (btn) btn.disabled = true;

        chatHistory.push({role: 'user', content: msg});
        renderChat();

        apiPostJson('/api/jobs/' + currentJobId + '/chat', {
            message: msg,
            model: getSelectedModel()
        }).then(function(data) {
            if (data.status === 'ok' && data.message) {
                chatHistory.push({role: 'assistant', content: data.message});
                renderChat();
            } else {
                chatHistory.push({role: 'assistant', content: 'Ошибка: ' + (data.msg || 'Неизвестная ошибка')});
                renderChat();
                toast('Ошибка чата: ' + (data.msg || ''), 'error');
            }
            if (btn) btn.disabled = false;
        }).catch(function(e) {
            chatHistory.push({role: 'assistant', content: 'Ошибка сети: ' + e.message});
            renderChat();
            toast('Ошибка чата: ' + e.message, 'error');
            if (btn) btn.disabled = false;
        });
    }

    // --- Summary ---
    function generateSummary() {
        if (!currentJobId) return;
        var btn = $('generateSummaryBtn');
        var content = $('summaryContent');
        if (btn) {
            btn.disabled = true;
            btn.innerHTML = '<span class="spinner"></span> Генерация...';
        }
        if (content) content.innerHTML = '<div style="text-align:center;padding:40px"><span class="spinner"></span><p>Анализируем транскрипцию через LLM...</p><p style="font-size:12px;color:var(--text-secondary)">Это может занять 30–60 секунд</p></div>';

        apiPostJson('/api/jobs/' + currentJobId + '/summary', {
            model: getSelectedModel()
        }).then(function(data) {
            if (data.summary) {
                if (content) content.innerHTML = markdownToHtml(data.summary);
                var actions = $('summaryActions');
                if (actions) actions.style.display = 'none';
                toast('Резюме сгенерировано', 'success');
            } else {
                if (content) content.innerHTML = '<p>Ошибка: ' + esc(data.msg) + '</p>';
                toast('Ошибка генерации: ' + data.msg, 'error');
            }
            if (btn) {
                btn.disabled = false;
                btn.textContent = '🤖 Сгенерировать резюме (LLM)';
            }
        }).catch(function(e) {
            if (content) content.innerHTML = '<p>Ошибка: ' + esc(e.message) + '</p>';
            if (btn) {
                btn.disabled = false;
                btn.textContent = '🤖 Сгенерировать резюме (LLM)';
            }
            toast('Ошибка генерации: ' + e.message, 'error');
        });
    }

    // --- Edit / Copy / Word ---
    function toggleEdit(type) {
        var content, editBtn, saveBtn;
        if (type === 'transcript') {
            content = $('transcriptContent');
            editBtn = $('editTranscriptBtn');
            saveBtn = $('saveTranscriptBtn');
        } else {
            content = $('summaryContent');
            editBtn = $('editSummaryBtn');
            saveBtn = $('saveSummaryBtn');
        }
        if (!content) return;
        var isEditing = content.contentEditable === 'true';
        if (isEditing) {
            content.contentEditable = 'false';
            if (editBtn) editBtn.style.display = '';
            if (saveBtn) saveBtn.style.display = 'none';
        } else {
            content.contentEditable = 'true';
            content.focus();
            if (editBtn) editBtn.style.display = 'none';
            if (saveBtn) saveBtn.style.display = '';
            toast('Режим редактирования. Нажмите Сохранить чтобы применить изменения.', 'info');
        }
    }

    function saveEdit(type) {
        var content;
        if (type === 'transcript') {
            content = $('transcriptContent');
        } else {
            content = $('summaryContent');
        }
        if (!content || !currentJobId) return;
        var text = type === 'transcript' ? content.innerText : content.innerText;
        apiPatchJson('/api/jobs/' + currentJobId + '/content', {
            type: type,
            text: text
        }).then(function() {
            toast('Изменения сохранены', 'success');
            toggleEdit(type);
            if (type === 'summary') {
                // Перезагрузим чтобы обновить summary в статусе
                openJob(currentJobId);
            }
        }).catch(function(e) {
            toast('Ошибка сохранения: ' + e.message, 'error');
        });
    }

    function copyContent(type) {
        var content;
        if (type === 'transcript') {
            content = $('transcriptContent');
        } else {
            content = $('summaryContent');
        }
        if (!content) return;
        var text = content.innerText;
        navigator.clipboard.writeText(text).then(function() {
            toast('Скопировано в буфер обмена', 'success');
        }).catch(function() {
            // Fallback
            var ta = document.createElement('textarea');
            ta.value = text;
            document.body.appendChild(ta);
            ta.select();
            document.execCommand('copy');
            document.body.removeChild(ta);
            toast('Скопировано в буфер обмена', 'success');
        });
    }

    function downloadWord(type) {
        var content, title;
        if (type === 'transcript') {
            content = $('transcriptContent');
            title = 'Транскрипция ' + currentJobId;
        } else {
            content = $('summaryContent');
            title = 'Резюме ' + currentJobId;
        }
        if (!content) return;
        var html = '<html xmlns:o="urn:schemas-microsoft-com:office:office" xmlns:w="urn:schemas-microsoft-com:office:word" xmlns="http://www.w3.org/TR/REC-html40"><head><meta charset="utf-8"><title>' + esc(title) + '</title></head><body>' + content.innerHTML + '</body></html>';
        var blob = new Blob(['\ufeff', html], { type: 'application/msword' });
        var url = URL.createObjectURL(blob);
        var a = document.createElement('a');
        a.href = url;
        a.download = title + '.doc';
        a.click();
        URL.revokeObjectURL(url);
    }

    // --- Markdown ---
    function markdownToHtml(md) {
        if (!md) return '';
        var html = esc(md);
        html = html.replace(/^## (.*$)/gim, '<h2>$1</h2>');
        html = html.replace(/^### (.*$)/gim, '<h3>$1</h3>');
        html = html.replace(/\*\*(.*?)\*\*/g, '<strong>$1</strong>');
        html = html.replace(/^\- (.*$)/gim, '<li>$1</li>');
        html = html.replace(/(<li>.*<\/li>\n?)+/g, function(match) {
            return '<ul>' + match + '</ul>';
        });
        if (html.indexOf('|') !== -1) {
            var lines = html.split('\n');
            var inTable = false;
            var tableHtml = '';
            var result = [];
            lines.forEach(function(line) {
                if (line.trim().startsWith('|')) {
                    var cells = line.split('|').map(function(c) { return c.trim(); }).filter(function(c) { return c !== ''; });
                    if (cells.length > 1) {
                        if (!inTable) {
                            inTable = true;
                            tableHtml = '<table>';
                        }
                        if (cells.every(function(c) { return c.replace(/-/g,'') === ''; })) return;
                        tableHtml += '<tr>' + cells.map(function(c) { return '<td>' + esc(c) + '</td>'; }).join('') + '</tr>';
                        return;
                    }
                }
                if (inTable) {
                    tableHtml += '</table>';
                    result.push(tableHtml);
                    inTable = false;
                    tableHtml = '';
                }
                result.push(line);
            });
            if (inTable) {
                tableHtml += '</table>';
                result.push(tableHtml);
            }
            html = result.join('\n');
        }
        html = html.replace(/\n\n/g, '</p><p>');
        html = '<p>' + html + '</p>';
        html = html.replace(/<p><\/p>/g, '');
        html = html.replace(/<p>(<h[23]>.*?<\/h[23]>)<\/p>/g, '$1');
        html = html.replace(/<p>(<table>.*?<\/table>)<\/p>/g, '$1');
        html = html.replace(/<p>(<ul>.*?<\/ul>)<\/p>/g, '$1');
        return html;
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
        currentSegments = [];
        editingSpeakers = false;
        activeTab = 'transcript';
        chatHistory = [];
        var vs = $('viewScreen');
        var us = $('uploadScreen');
        if (vs) vs.style.display = 'none';
        if (us) us.style.display = 'block';
        var ap = $('audioPlayer');
        if (ap) { ap.pause(); ap.src = ''; }
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
        card.innerHTML = '<div class="upload-progress-file">' + esc(file.name) + ' (' + sizeMb.toFixed(1) + ' МБ)</div><div class="progress-bar"><div class="progress-fill" style="width:0%"></div></div><div class="progress-status">Загрузка...</div>';
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

    on('fileInput', 'change', function() {
        console.log('[APP] fileInput change', this.files.length, 'files');
        var inp = $('fileInput');
        if (inp) {
            Array.from(inp.files).forEach(uploadFile);
            inp.value = '';
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

    on('tabTranscript', 'click', function() { switchTab('transcript'); });
    on('tabSummary', 'click', function() { switchTab('summary'); });
    on('generateSummaryBtn', 'click', generateSummary);

    // Edit / Copy / Word events
    on('editTranscriptBtn', 'click', function() { toggleEdit('transcript'); });
    on('saveTranscriptBtn', 'click', function() { saveEdit('transcript'); });
    on('copyTranscriptBtn', 'click', function() { copyContent('transcript'); });
    on('downloadTranscriptWordBtn', 'click', function() { downloadWord('transcript'); });

    on('editSummaryBtn', 'click', function() { toggleEdit('summary'); });
    on('saveSummaryBtn', 'click', function() { saveEdit('summary'); });
    on('copySummaryBtn', 'click', function() { copyContent('summary'); });
    on('downloadSummaryWordBtn', 'click', function() { downloadWord('summary'); });

    // Chat events
    on('chatSendBtn', 'click', sendChat);
    on('chatInput', 'keydown', function(e) {
        if (e.key === 'Enter' && !e.ctrlKey) {
            e.preventDefault();
            sendChat();
        }
    });

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
            currentSegments = [];
            editingSpeakers = false;
            activeTab = 'transcript';
            chatHistory = [];
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
            if (currentJobId && !editingSpeakers && $('viewScreen') && $('viewScreen').style.display !== 'none') {
                openJob(currentJobId);
            }
        }, 5000);
    }

    // Init
    console.log('[APP] Initializing...');
    apiGet('/api/health').then(function(data) {
        if (data.max_file_size_mb) {
            MAX_FILE_SIZE_MB = data.max_file_size_mb;
            var lbl = $('maxSizeLabel');
            if (lbl) lbl.textContent = MAX_FILE_SIZE_MB + ' МБ';
        }
        if (data.llm_configured) {
            loadModels();
        }
    }).catch(function() {});
    loadJobs();
    startPolling();
    console.log('[APP] Initialized');
})();
