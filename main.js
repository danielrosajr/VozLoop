'use strict';

const $ = id => document.getElementById(id);
const esc = value => String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const formatTime = s => { const n = Math.max(0, Number(s) || 0); return `${String(Math.floor(n / 60)).padStart(2, '0')}:${String(Math.floor(n % 60)).padStart(2, '0')}.${Math.floor(n * 10) % 10}`; };
const uid = () => (crypto.randomUUID?.() || ('id-' + Date.now() + '-' + Math.random().toString(36).slice(2)));
const clamp = (n, lo, hi) => { const v = Number(n); return Math.max(lo, Math.min(hi, Number.isFinite(v) ? v : lo)); };
const loopLength = p => 4 * Number(p.bars) * 60 / Number(p.bpm);
const colors = ['#ad92ff', '#7ed9b4', '#ff9cbd', '#87b8ff', '#ffd08b', '#c2a1f4', '#8be3e1'];
const engine = new VozAudioEngine();
const state = {
  db: null, projects: [], project: null, tracks: [], buffers: new Map(),
  playing: false, playStart: 0, playingEnd: 0, recording: null, busy: false,
  frameTimer: null, toastTimer: null, changes: new Map(), selectedMode: 'free'
};

function toast(message, error = false) {
  const el = $('toast'); el.textContent = message; el.classList.toggle('error', error); el.classList.add('show');
  clearTimeout(state.toastTimer); state.toastTimer = setTimeout(() => el.classList.remove('show'), 4400);
}

function openDatabase() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open('vozloop-db', 1);
    req.onupgradeneeded = () => {
      const db = req.result;
      db.createObjectStore('projects', { keyPath: 'id' });
      const tracks = db.createObjectStore('tracks', { keyPath: 'id' });
      tracks.createIndex('projectId', 'projectId');
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}
function storeRequest(store, method, arg) {
  return new Promise((resolve, reject) => {
    const tx = state.db.transaction(store, method === 'get' || method === 'getAll' || method === 'getByProject' ? 'readonly' : 'readwrite');
    const os = tx.objectStore(store);
    let request;
    if (method === 'getByProject') request = os.index('projectId').getAll(arg);
    else if (method === 'getAll') request = os.getAll();
    else request = os[method](arg);
    let result;
    request.onsuccess = () => { result = request.result; };
    request.onerror = () => reject(request.error);
    tx.oncomplete = () => resolve(result);
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error || new Error('Transação interrompida.'));
  });
}
async function deleteProjectData(projectId) {
  const tracks = await storeRequest('tracks', 'getByProject', projectId);
  const tx = state.db.transaction(['tracks', 'projects'], 'readwrite');
  for (const t of tracks) tx.objectStore('tracks').delete(t.id);
  tx.objectStore('projects').delete(projectId);
  return new Promise((resolve, reject) => { tx.oncomplete = resolve; tx.onerror = () => reject(tx.error); });
}
async function persistProject() {
  if (!state.project) return;
  state.project.updatedAt = Date.now();
  await storeRequest('projects', 'put', state.project);
  $('saveIndicator').textContent = 'Salvo automaticamente';
}

async function renderHome() {
  state.projects = (await storeRequest('projects', 'getAll')).sort((a, b) => b.updatedAt - a.updatedAt);
  $('projectCount').textContent = `${state.projects.length} projeto${state.projects.length !== 1 ? 's' : ''}`;
  if (!state.projects.length) {
    $('projectsList').innerHTML = '<div class="empty-projects"><strong>Nenhuma gravação ainda.</strong>Crie uma música para começar seu primeiro projeto.</div>';
  } else {
    $('projectsList').innerHTML = state.projects.map(p => `
      <div class="project-card" data-project="${esc(p.id)}" role="button" tabindex="0" aria-label="Abrir ${esc(p.name)}">
        <div class="project-card-top"><span class="project-type">${p.mode === 'loop' ? '↻ LOOPS' : '〰 GRAVAÇÃO LIVRE'}</span>
          <button class="track-mini-button danger" data-delete-project="${esc(p.id)}" title="Apagar projeto" aria-label="Apagar ${esc(p.name)}">✕</button></div>
        <h3>${esc(p.name)}</h3>
        <div class="project-card-meta">${new Date(p.updatedAt).toLocaleDateString('pt-BR')} · Abrir projeto →</div>
      </div>`).join('');
  }
  $('studioView').classList.add('hidden'); $('homeView').classList.remove('hidden');
  document.title = 'VozLoop — Estúdio de bolso';
  try { history.replaceState({}, '', location.pathname + location.search); } catch {}
}

async function openProject(id) {
  if (state.recording || state.busy) { toast('Finalize a gravação antes de sair.', true); return; }
  stopPlayback();
  await flushPendingChanges();
  state.project = await storeRequest('projects', 'get', id);
  if (!state.project) { toast('Projeto não encontrado.', true); return renderHome(); }
  state.tracks = (await storeRequest('tracks', 'getByProject', id)).sort((a, b) => a.createdAt - b.createdAt);
  state.buffers = new Map();
  for (const track of state.tracks) {
    try { state.buffers.set(track.id, await engine.decode(track.blob)); }
    catch (e) { console.error('Falha ao ler camada', track.id, e); toast(`Não foi possível ler a camada ${track.name}`, true); }
  }
  $('homeView').classList.add('hidden'); $('studioView').classList.remove('hidden');
  $('projectName').value = state.project.name;
  $('modeBadge').textContent = state.project.mode === 'loop' ? '↻ ESTÚDIO DE LOOPS' : '〰 GRAVAÇÃO LIVRE';
  $('loopControls').classList.toggle('hidden', state.project.mode !== 'loop');
  $('bpmInput').value = state.project.bpm || 100;
  $('barsSelect').value = state.project.bars || 2;
  updateLoopControls();
  $('saveIndicator').textContent = 'Salvo automaticamente';
  document.title = `${state.project.name} · VozLoop`;
  renderTracks(); refreshTransport();
  localStorage.setItem('vozloop-last', id);
  window.scrollTo({ top: 0, behavior: 'instant' });
}

async function createProject() {
  const name = $('newProjectName').value.trim() || 'Minha música';
  const mode = document.querySelector('input[name="recordingMode"]:checked')?.value || 'free';
  const project = { id: uid(), name: name.slice(0, 70), mode, bpm: 100, bars: 2, createdAt: Date.now(), updatedAt: Date.now() };
  await storeRequest('projects', 'put', project);
  $('newDialog').close();
  await openProject(project.id);
  toast('Projeto criado. Pode começar a gravar!');
}

function updateLoopControls() {
  if (!state.project) return;
  $('loopDuration').textContent = loopLength(state.project).toLocaleString('pt-BR', { maximumFractionDigits: 2 }) + 's';
  const locked = state.tracks.length > 0 || !!state.recording || state.busy;
  $('bpmInput').disabled = locked; $('barsSelect').disabled = locked;
  $('bpmDown').disabled = locked; $('bpmUp').disabled = locked;
  $('bpmInput').title = locked ? 'O ritmo não pode ser alterado depois de gravar a primeira camada.' : '';
}

function renderTracks() {
  $('trackCount').textContent = `${state.tracks.length} camada${state.tracks.length !== 1 ? 's' : ''}`;
  $('emptyTracks').classList.toggle('hidden', state.tracks.length > 0);
  const list = $('tracksList');
  list.innerHTML = state.tracks.map((t, i) => {
    const color = colors[i % colors.length];
    return `<div class="track-card ${t.muted ? 'is-muted' : ''}" data-track="${esc(t.id)}" style="--track-color:${color}">
      <div class="track-head">
        <div class="track-mark">${i + 1}</div>
        <div class="track-name"><input aria-label="Nome da camada ${i+1}" data-field="name" maxlength="60" value="${esc(t.name)}" /><small>${formatTime(t.duration)} · ${state.project.mode === 'loop' ? 'em loop' : 'áudio'}</small></div>
        <button class="track-mini-button ${t.muted ? 'muted' : ''}" data-track-action="mute" title="${t.muted ? 'Ativar áudio' : 'Silenciar'}" aria-label="${t.muted ? 'Ativar' : 'Silenciar'} ${esc(t.name)}">${t.muted ? '◌' : '♫'}</button>
        <button class="track-mini-button danger" data-track-action="delete" title="Excluir camada" aria-label="Excluir ${esc(t.name)}">✕</button>
      </div>
      <canvas class="track-wave" data-wave-id="${esc(t.id)}" height="50" aria-label="Forma de onda da camada"></canvas>
      <div class="track-controls">
        <div><div class="track-control-label"><span>Volume</span><output data-out="volume">${Math.round(t.volume * 100)}%</output></div><input type="range" aria-label="Volume de ${esc(t.name)}" min="0" max="150" value="${Math.round(t.volume * 100)}" step="5" data-field="volume" /></div>
        <div><div class="track-control-label"><span>Sincronização</span><output data-out="offset">${formatOffset(t.offsetMs)}</output></div><input type="range" aria-label="Ajuste de tempo de ${esc(t.name)}" min="-500" max="500" value="${t.offsetMs || 0}" step="10" data-field="offsetMs" /></div>
      </div>
    </div>`;
  }).join('');
  requestAnimationFrame(() => {
    for (const [index, track] of state.tracks.entries()) {
      const el = Array.from(list.querySelectorAll('[data-wave-id]')).find(e => e.dataset.waveId === track.id);
      if (el) drawWave(el, state.buffers.get(track.id), colors[index % colors.length]);
    }
    drawMaster();
  });
  updateLoopControls();
}
function formatOffset(ms) { return `${ms > 0 ? '+' : ''}${Math.round(ms || 0)} ms`; }

function drawWave(canvas, buffer, color, empty = false) {
  if (!canvas) return;
  const bounds = canvas.getBoundingClientRect();
  const width = Math.max(1, Math.round(bounds.width));
  const height = Math.max(1, Math.round(bounds.height));
  const dpr = Math.min(devicePixelRatio || 1, 2);
  canvas.width = Math.round(width * dpr); canvas.height = Math.round(height * dpr);
  const ctx = canvas.getContext('2d'); ctx.scale(dpr, dpr);
  ctx.clearRect(0, 0, width, height);
  ctx.strokeStyle = '#ffffff12'; ctx.beginPath(); ctx.moveTo(0, height / 2); ctx.lineTo(width, height / 2); ctx.stroke();
  const n = Math.max(10, Math.floor(width / 5));
  const data = buffer?.getChannelData(0);
  const chunk = data ? Math.max(1, Math.floor(data.length / n)) : 1;
  for (let i = 0; i < n; i++) {
    let amplitude = 0;
    if (data) {
      const a = i * chunk, b = Math.min(data.length, a + chunk);
      for (let j = a; j < b; j += Math.max(1, Math.floor(chunk / 90))) amplitude = Math.max(amplitude, Math.abs(data[j]));
    } else amplitude = empty ? 0.05 + Math.abs(Math.sin(i * .7) * Math.cos(i * .19)) * .15 : .02;
    const h = Math.max(2, amplitude * (height - 10));
    ctx.fillStyle = color; ctx.globalAlpha = buffer ? .80 : .24;
    ctx.fillRect(i * (width / n) + 1, (height - h) / 2, Math.max(2, width / n - 2), h);
  }
  ctx.globalAlpha = 1;
}
function drawMaster() {
  const canvas = $('masterCanvas');
  if (!canvas || !state.project) return;
  const first = state.tracks.find(t => !t.muted && state.buffers.has(t.id));
  drawWave(canvas, first && state.buffers.get(first.id), '#b39afa', !first);
}

function stopPlayback() {
  engine.stopSources();
  state.playing = false; state.playStart = 0; state.playingEnd = 0;
  $('wavePlayline').classList.remove('active');
  refreshTransport();
}
async function startPlayback() {
  if (!state.project || state.busy || state.recording) return;
  if (!state.tracks.some(t => !t.muted && state.buffers.has(t.id))) { toast('Grave ou ative uma camada para tocar.'); return; }
  try {
    stopPlayback();
    await engine.init();
    const start = engine.ctx.currentTime + .12;
    engine.scheduleBacking(state.tracks, state.buffers, start, state.project.mode === 'loop', loopLength(state.project));
    state.playing = true; state.playStart = start;
    state.playingEnd = state.project.mode === 'loop' ? Infinity : Math.max(0, ...state.tracks.filter(t => !t.muted && state.buffers.has(t.id)).map(t => state.buffers.get(t.id).duration + (t.offsetMs || 0) / 1000));
    refreshTransport();
  } catch (err) { toast(err.message, true); }
}
function updateTicker() {
  if (!state.project || !engine.ctx) return;
  const now = engine.ctx.currentTime;
  if (state.recording) {
    const r = state.recording;
    const remaining = r.startTime - now;
    if (remaining > 0) {
      $('countdownView').classList.remove('hidden');
      $('countdownValue').textContent = String(Math.max(1, Math.min(r.beats, Math.ceil(remaining / r.beatSeconds))));
      $('timerLabel').textContent = formatTime(0);
    } else {
      $('countdownView').classList.add('hidden');
      const elapsed = Math.min(now - r.startTime, state.project.mode === 'loop' ? loopLength(state.project) : Infinity);
      $('timerLabel').textContent = formatTime(elapsed);
      setPlayline(state.project.mode === 'loop' ? elapsed / loopLength(state.project) : elapsed / Math.max(elapsed, state.playingEnd, 10));
    }
  } else if (state.playing) {
    const elapsed = Math.max(0, now - state.playStart);
    if (Number.isFinite(state.playingEnd) && elapsed > state.playingEnd + .10) { stopPlayback(); return; }
    const duration = state.project.mode === 'loop' ? loopLength(state.project) : Math.max(.01, state.playingEnd);
    $('timerLabel').textContent = formatTime(state.project.mode === 'loop' ? elapsed % duration : elapsed);
    setPlayline(state.project.mode === 'loop' ? (elapsed % duration) / duration : elapsed / duration);
  }
}
function setPlayline(ratio) {
  const el = $('wavePlayline'); el.classList.add('active');
  el.style.left = `${clamp(ratio, 0, 1) * 100}%`;
}
function refreshTransport() {
  const r = state.recording;
  const live = r && engine.ctx && engine.ctx.currentTime >= r.startTime;
  const lbl = $('transportState');
  lbl.className = 'transport-state ' + (r ? 'is-recording' : state.playing ? 'is-playing' : '');
  lbl.innerHTML = `<span class="neutral-dot"></span> ${state.busy ? 'PREPARANDO MICROFONE' : r ? (live ? 'GRAVANDO NOVA CAMADA' : 'CONTAGEM REGRESSIVA') : state.playing ? 'REPRODUZINDO CAMADAS' : 'PRONTO PARA GRAVAR'}`;
  $('recordBtn').classList.toggle('is-recording', !!r);
  $('recordBtn').disabled = state.busy;
  $('playBtn').disabled = state.busy || !!r || state.tracks.length === 0;
  $('stopBtn').disabled = state.busy || (!r && !state.playing);
  $('playIcon').textContent = state.playing ? 'Ⅱ' : '▶';
  $('recordBtn').title = r ? 'Finalizar gravação' : 'Gravar nova camada';
  $('recordBtn').setAttribute('aria-label', r ? 'Finalizar gravação' : 'Gravar nova camada');
  $('recordHint').textContent = state.busy ? 'Solicitando microfone e preparando áudio...' : r ?
    (state.project.mode === 'loop' ? 'O loop será salvo automaticamente ao terminar. Toque em parar para cancelar antes do início.' : 'Toque novamente no vermelho ou em parar para finalizar.') :
    state.playing ? 'Você pode parar e gravar outra camada por cima.' :
    state.tracks.length ? 'Grave de novo: suas camadas vão tocar no fone, desde o início.' :
    'Toque no botão vermelho para gravar a primeira camada.';
  if (!r) $('countdownView').classList.add('hidden');
  if (!r && !state.playing) { $('timerLabel').textContent = '00:00.0'; $('wavePlayline').classList.remove('active'); }
  updateLoopControls();
}

async function startRecording() {
  if (!state.project || state.busy || state.recording) return;
  stopPlayback();
  state.busy = true; refreshTransport();
  let microphone = null;
  try {
    await engine.init();
    microphone = await engine.requestMicrophone();
    const beatSeconds = state.project.mode === 'loop' ? 60 / state.project.bpm : 1;
    const countBeats = state.project.mode === 'loop' ? 4 : 3;
    const count = beatSeconds * countBeats;
    const lead = .35;
    const clickTime = engine.ctx.currentTime + lead;
    const startTime = clickTime + count;
    const duration = state.project.mode === 'loop' ? loopLength(state.project) : Infinity;
    const capture = await engine.beginCapture(startTime, Number.isFinite(duration) ? startTime + duration : Infinity, microphone);
    microphone = null;
    engine.scheduleBacking(state.tracks, state.buffers, startTime, state.project.mode === 'loop', loopLength(state.project));
    engine.playClicks(clickTime, countBeats, beatSeconds);
    state.recording = { capture, startTime, beatSeconds, beats: countBeats };
    state.busy = false;
    refreshTransport();
    capture.promise.then(handleRecordingDone).catch(err => { state.recording = null; stopPlayback(); toast('Erro de gravação: ' + err.message, true); });
  } catch (err) {
    if (microphone) microphone.getTracks().forEach(t => t.stop());
    state.busy = false; state.recording = null;
    stopPlayback(); refreshTransport();
    toast(err.message || 'Erro ao gravar.', true);
  }
}
async function handleRecordingDone(result) {
  const wasRecording = !!state.recording;
  state.recording = null; state.busy = true; engine.stopSources(); state.playing = false;
  refreshTransport();
  if (result && result.frames > 0 && wasRecording) {
    try {
      const track = {
        id: uid(), projectId: state.project.id,
        name: `Camada ${state.tracks.length + 1}`, volume: 1, offsetMs: 0, muted: false,
        duration: result.duration, blob: result.blob, createdAt: Date.now()
      };
      await storeRequest('tracks', 'put', track);
      state.tracks.push(track);
      state.buffers.set(track.id, await engine.decode(track.blob));
      await persistProject();
      renderTracks();
      toast(`Camada ${state.tracks.length} salva! Adicione outra quando quiser.`);
    } catch (err) {
      toast('Não foi possível salvar. Verifique o espaço do navegador: ' + err.message, true);
    }
  } else if (result && result.frames === 0) toast('Nenhum áudio capturado. Tente novamente.', true);
  state.busy = false; refreshTransport();
}
function stopRecord() {
  const r = state.recording;
  if (!r) return;
  if (engine.ctx.currentTime < r.startTime) {
    r.capture.cancel(); engine.stopSources(); toast('Gravação cancelada antes de começar.');
  } else r.capture.stop();
}

async function downloadMix() {
  const btn = $('exportConfirmBtn'); btn.disabled = true; btn.textContent = 'Misturando as camadas...';
  try {
    await engine.init();
    const loops = state.project.mode === 'loop' ? Number($('exportLoops').value) : 1;
    const blob = await engine.renderMix(state.tracks, state.buffers, state.project.mode, loopLength(state.project), loops);
    downloadBlob(blob, safeFilename(state.project.name) + '-vozloop.wav');
    $('exportDialog').close(); toast('Mixagem exportada com sucesso!');
  } catch (err) { toast('Falha na exportação: ' + err.message, true); }
  finally { btn.disabled = false; btn.textContent = 'Baixar áudio .WAV'; }
}
function safeFilename(s) { return String(s || 'minha-musica').normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/[^\w\- ]/g, '').trim().replace(/\s+/g, '-').slice(0, 60) || 'projeto'; }
function downloadBlob(blob, filename) {
  const url = URL.createObjectURL(blob), anchor = document.createElement('a');
  anchor.href = url; anchor.download = filename; document.body.appendChild(anchor); anchor.click(); anchor.remove();
  setTimeout(() => URL.revokeObjectURL(url), 60000);
}
async function blobDataURL(blob) { return new Promise((resolve, reject) => { const reader = new FileReader(); reader.onload = () => resolve(reader.result); reader.onerror = () => reject(reader.error); reader.readAsDataURL(blob); }); }
async function backupProject() {
  if (!state.project || state.busy || state.recording) return;
  const button = $('backupBtn'); button.disabled = true; button.textContent = 'Preparando...';
  try {
    const tracks = [];
    for (const t of state.tracks) {
      const { blob, ...meta } = t;
      tracks.push({ ...meta, wavDataUrl: await blobDataURL(blob) });
    }
    const json = JSON.stringify({ format: 'vozloop-project', version: 1, exportedAt: new Date().toISOString(), project: state.project, tracks });
    downloadBlob(new Blob([json], { type: 'application/json' }), safeFilename(state.project.name) + '-backup.json');
    toast('Backup gerado. Guarde o arquivo em lugar seguro.');
  } catch (e) { toast('Falha no backup: ' + e.message, true); }
  finally { button.disabled = false; button.textContent = 'Backup'; }
}
async function importBackup(file) {
  if (!file) return;
  if (file.size > 150 * 1024 * 1024) { toast('Backup grande demais (máximo: 150 MB).', true); return; }
  try {
    const data = JSON.parse(await file.text());
    if (data.format !== 'vozloop-project' || data.version !== 1 || !data.project || !Array.isArray(data.tracks) || data.tracks.length > 100) throw new Error('Arquivo não é um backup VozLoop válido.');
    const old = data.project;
    if (!['free', 'loop'].includes(old.mode)) throw new Error('Modo de projeto desconhecido.');
    const project = { id: uid(), name: String(old.name || 'Projeto importado').slice(0, 70), mode: old.mode, bpm: clamp(old.bpm || 100, 40, 240), bars: [1,2,4,8,16].includes(Number(old.bars)) ? Number(old.bars) : 2, createdAt: Date.now(), updatedAt: Date.now() };
    const tracks = [];
    for (const [i, t] of data.tracks.entries()) {
      if (typeof t.wavDataUrl !== 'string' || !t.wavDataUrl.startsWith('data:audio/wav;base64,')) throw new Error('Dados de áudio inválidos.');
      const blob = await (await fetch(t.wavDataUrl)).blob();
      if (blob.size < 44 || blob.size > 60 * 1024 * 1024) throw new Error('Gravação inválida ou grande demais.');
      // Valida que o áudio é decodificável ANTES de gravar qualquer conteúdo do backup.
      const audio = await engine.decode(blob);
      tracks.push({ id: uid(), projectId: project.id, name: String(t.name || `Camada ${i+1}`).slice(0,60), volume: clamp(t.volume ?? 1, 0, 1.5), offsetMs: clamp(t.offsetMs ?? 0, -500, 500), muted: !!t.muted, duration: audio.duration, blob, createdAt: Date.now() + i });
    }
    await storeRequest('projects', 'put', project);
    for (const t of tracks) await storeRequest('tracks', 'put', t);
    await openProject(project.id);
    toast('Projeto e camadas importados com sucesso.');
  } catch (e) { toast('Não foi possível importar: ' + e.message, true); }
}

async function flushPendingChanges() {
  if (!state.project || state.changes.size === 0) return;
  for (const timer of state.changes.values()) clearTimeout(timer);
  state.changes.clear();
  try {
    for (const track of state.tracks) await storeRequest('tracks', 'put', track);
    await persistProject();
  } catch (err) { toast('Não foi possível salvar todas as alterações: ' + err.message, true); }
}

function queueTrackSave(t) {
  const oldTimer = state.changes.get(t.id);
  if (oldTimer) clearTimeout(oldTimer);
  state.changes.set(t.id, setTimeout(async () => {
    state.changes.delete(t.id);
    try { await storeRequest('tracks', 'put', t); await persistProject(); }
    catch (err) { toast('Não foi possível salvar o ajuste: ' + err.message, true); }
  }, 350));
  $('saveIndicator').textContent = 'Salvando...';
}

function installUIEvents() {
  $('brandBtn').addEventListener('click', async () => { if (state.project && (state.recording || state.busy)) return toast('Finalize a gravação antes de sair.', true); await flushPendingChanges(); state.project = null; stopPlayback(); await renderHome(); });
  $('backBtn').addEventListener('click', async () => { if (state.recording || state.busy) return toast('Finalize a gravação antes de sair.', true); await flushPendingChanges(); stopPlayback(); state.project = null; await renderHome(); });
  $('helpBtn').addEventListener('click', () => $('helpDialog').showModal());
  $('newProjectBtn').addEventListener('click', () => { $('newProjectName').value = 'Minha música'; $('newDialog').showModal(); });
  $('newProjectForm').addEventListener('submit', async e => { e.preventDefault(); try { await createProject(); } catch (err) { toast('Não foi possível criar projeto: ' + err.message, true); } });
  document.querySelectorAll('[data-close-dialog]').forEach(btn => btn.addEventListener('click', () => $(btn.dataset.closeDialog).close()));
  $('projectsList').addEventListener('click', async e => {
    const remove = e.target.closest('[data-delete-project]');
    if (remove) {
      const p = state.projects.find(x => x.id === remove.dataset.deleteProject);
      if (p && confirm(`Apagar "${p.name}" e TODAS as gravações? Essa ação não pode ser desfeita.`)) {
        try { await deleteProjectData(p.id); await renderHome(); toast('Projeto excluído.'); }
        catch (err) { toast(err.message, true); }
      }
      return;
    }
    const card = e.target.closest('[data-project]'); if (card) await openProject(card.dataset.project);
  });
  $('projectsList').addEventListener('keydown', e => { if ((e.key === 'Enter' || e.key === ' ') && e.target.classList.contains('project-card')) { e.preventDefault(); openProject(e.target.dataset.project); } });
  $('projectName').addEventListener('change', async e => {
    if (!state.project) return;
    state.project.name = e.target.value.trim().slice(0,70) || 'Minha música';
    e.target.value = state.project.name;
    try { await persistProject(); document.title = state.project.name + ' · VozLoop'; } catch (err) { toast(err.message, true); }
  });
  const saveLoopSettings = async () => {
    if (!state.project || state.tracks.length || state.recording || state.busy) return;
    state.project.bpm = clamp($('bpmInput').value,40,240);
    state.project.bars = Number($('barsSelect').value);
    $('bpmInput').value = state.project.bpm;
    updateLoopControls();
    try { await persistProject(); } catch (err) { toast(err.message, true); }
  };
  $('bpmInput').addEventListener('change', saveLoopSettings);
  $('barsSelect').addEventListener('change', saveLoopSettings);
  $('bpmDown').addEventListener('click', async () => { $('bpmInput').value = Math.max(40, Number($('bpmInput').value)-5); await saveLoopSettings(); });
  $('bpmUp').addEventListener('click', async () => { $('bpmInput').value = Math.min(240, Number($('bpmInput').value)+5); await saveLoopSettings(); });
  $('recordBtn').addEventListener('click', () => { if (state.recording) stopRecord(); else startRecording(); });
  $('playBtn').addEventListener('click', () => { if (state.playing) stopPlayback(); else startPlayback(); });
  $('stopBtn').addEventListener('click', () => { if (state.recording) stopRecord(); else stopPlayback(); });
  $('tracksList').addEventListener('click', async e => {
    const btn = e.target.closest('[data-track-action]'); if (!btn) return;
    if (state.recording || state.busy) return toast('Finalize a gravação antes de editar camadas.', true);
    const card = btn.closest('[data-track]'), track = state.tracks.find(t => t.id === card.dataset.track);
    if (!track) return;
    if (btn.dataset.trackAction === 'mute') {
      track.muted = !track.muted;
      engine.updateGain(track.id, track.volume, track.muted);
      queueTrackSave(track); renderTracks();
    } else if (btn.dataset.trackAction === 'delete' && confirm(`Excluir a camada "${track.name}"?`)) {
      stopPlayback();
      try {
        const timer = state.changes.get(track.id); if (timer) clearTimeout(timer); state.changes.delete(track.id);
        await storeRequest('tracks', 'delete', track.id);
        state.tracks = state.tracks.filter(t => t.id !== track.id); state.buffers.delete(track.id);
        await persistProject(); renderTracks(); refreshTransport(); toast('Camada excluída.');
      } catch (err) { toast(err.message, true); }
    }
  });
  $('tracksList').addEventListener('input', e => {
    const field = e.target.dataset.field;
    if (!['volume','offsetMs'].includes(field) || state.recording || state.busy) return;
    const card = e.target.closest('[data-track]'); const track = state.tracks.find(t => t.id === card?.dataset.track);
    if (!track) return;
    if (field === 'volume') {
      track.volume = Number(e.target.value) / 100;
      card.querySelector('[data-out="volume"]').textContent = Math.round(track.volume * 100) + '%';
      engine.updateGain(track.id, track.volume, track.muted);
    } else {
      track.offsetMs = Number(e.target.value);
      card.querySelector('[data-out="offset"]').textContent = formatOffset(track.offsetMs);
      if (state.playing) stopPlayback();
    }
    queueTrackSave(track);
  });
  $('tracksList').addEventListener('change', e => {
    if (e.target.dataset.field !== 'name') return;
    const track = state.tracks.find(t => t.id === e.target.closest('[data-track]')?.dataset.track);
    if (!track) return;
    track.name = e.target.value.trim().slice(0, 60) || 'Camada';
    e.target.value = track.name;
    queueTrackSave(track);
  });
  $('exportBtn').addEventListener('click', () => {
    if (state.recording || state.busy) return toast('Finalize a gravação antes de exportar.', true);
    if (!state.tracks.some(t => !t.muted && state.buffers.has(t.id))) return toast('Grave uma camada ou ative o áudio de alguma camada.');
    $('exportLoopsControl').classList.toggle('hidden', state.project.mode !== 'loop');
    $('exportDescription').textContent = state.project.mode === 'loop' ? `Seu loop tem ${loopLength(state.project).toFixed(2)} segundos. O arquivo final terá o número de repetições escolhido.` : 'A duração da mixagem seguirá a camada mais longa.';
    $('exportDialog').showModal();
  });
  $('exportConfirmBtn').addEventListener('click', downloadMix);
  $('backupBtn').addEventListener('click', backupProject);
  $('importBackupBtn').addEventListener('click', () => $('importInput').click());
  $('importInput').addEventListener('change', async e => { await importBackup(e.target.files[0]); e.target.value = ''; });
  document.addEventListener('visibilitychange', () => { if (document.hidden) { flushPendingChanges(); if (state.recording) console.warn('A gravação pode ser interrompida ao bloquear a tela ou mudar de aplicativo.'); } });
  window.addEventListener('beforeunload', e => { if (state.recording) { e.preventDefault(); e.returnValue = ''; } });
  window.addEventListener('resize', () => { if (!state.project) return; drawMaster(); for (const [i,t] of state.tracks.entries()) { const el = Array.from(document.querySelectorAll('[data-wave-id]')).find(n => n.dataset.waveId === t.id); drawWave(el, state.buffers.get(t.id), colors[i%colors.length]); } });
}

async function boot() {
  installUIEvents();
  state.frameTimer = setInterval(() => { updateTicker(); if (state.recording) refreshTransport(); }, 100);
  if ('serviceWorker' in navigator && location.protocol !== 'file:') navigator.serviceWorker.register('./sw.js').catch(e => console.warn('Modo offline indisponível:', e));
  try {
    state.db = await openDatabase();
    const last = localStorage.getItem('vozloop-last');
    if (last && await storeRequest('projects', 'get', last)) await openProject(last);
    else await renderHome();
  } catch (e) {
    console.error(e);
    toast('Não foi possível abrir o armazenamento. Habilite dados locais neste navegador.', true);
    $('projectsList').innerHTML = '<div class="empty-projects">O navegador bloqueou o armazenamento local. Desative o modo privado ou tente outro navegador.</div>';
    $('newProjectBtn').disabled = true;
  }
}
window.addEventListener('DOMContentLoaded', boot);
