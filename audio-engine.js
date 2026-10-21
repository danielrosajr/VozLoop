'use strict';

// Áudio sempre local. Nenhuma biblioteca de terceiros, servidor ou upload.
class VozAudioEngine {
  constructor() {
    this.ctx = null;
    this.workletReady = false;
    this.workletTried = false;
    this.activeSources = [];
    this.capture = null;
  }

  async init() {
    if (!this.ctx) {
      const AC = window.AudioContext || window.webkitAudioContext;
      if (!AC) throw new Error('Este navegador não oferece Web Audio API.');
      this.ctx = new AC({ latencyHint: 'interactive' });
    }
    if (this.ctx.state !== 'running') await this.ctx.resume();
    if (!this.workletTried) {
      this.workletTried = true;
      try {
        if (!this.ctx.audioWorklet) throw new Error('AudioWorklet indisponível');
        await this.ctx.audioWorklet.addModule('./recorder-worklet.js');
        this.workletReady = true;
      } catch (err) {
        console.warn('AudioWorklet indisponível; usando ScriptProcessor de compatibilidade.', err);
        this.workletReady = false;
      }
    }
    return this.ctx;
  }

  async decode(blob) {
    const ctx = await this.init();
    return await ctx.decodeAudioData(await blob.arrayBuffer());
  }

  stopSources() {
    for (const item of this.activeSources) {
      try { item.source.stop(); } catch { /* já terminou */ }
      try { item.source.disconnect(); item.gain.disconnect(); } catch { /* desconectado */ }
    }
    this.activeSources = [];
  }

  scheduleBacking(tracks, buffers, startTime, isLoop, loopSeconds) {
    this.stopSources();
    const ctx = this.ctx;
    for (const track of tracks) {
      if (track.muted) continue;
      const buffer = buffers.get(track.id);
      if (!buffer || buffer.length === 0) continue;
      const shift = (Number(track.offsetMs) || 0) / 1000;
      if (!isLoop && -shift >= buffer.duration) continue;
      const source = ctx.createBufferSource();
      const gain = ctx.createGain();
      source.buffer = buffer;
      gain.gain.value = Number(track.volume) ?? 1;
      if (isLoop) {
        source.loop = true;
        source.loopStart = 0;
        source.loopEnd = Math.min(loopSeconds, buffer.duration);
      }
      source.connect(gain);
      gain.connect(ctx.destination);
      try {
        source.start(startTime + Math.max(0, shift), Math.max(0, -shift));
        this.activeSources.push({ source, gain, trackId: track.id });
      } catch (e) {
        try { source.disconnect(); gain.disconnect(); } catch {}
        console.warn('Camada não agendada:', e);
      }
    }
  }

  updateGain(trackId, volume, muted) {
    if (!this.ctx) return;
    for (const entry of this.activeSources) {
      if (entry.trackId === trackId) {
        entry.gain.gain.setTargetAtTime(muted ? 0 : volume, this.ctx.currentTime, 0.01);
      }
    }
  }

  playClicks(startTime, beats, interval) {
    const ctx = this.ctx;
    for (let i = 0; i < beats; i++) {
      const at = startTime + i * interval;
      const osc = ctx.createOscillator(), gain = ctx.createGain();
      osc.type = 'sine';
      osc.frequency.value = i === 0 ? 1000 : 690;
      gain.gain.setValueAtTime(0.0001, at);
      gain.gain.exponentialRampToValueAtTime(0.13, at + 0.003);
      gain.gain.exponentialRampToValueAtTime(0.0001, at + 0.065);
      osc.connect(gain).connect(ctx.destination);
      osc.start(at); osc.stop(at + 0.08);
      osc.onended = () => { try { osc.disconnect(); gain.disconnect(); } catch {} };
    }
  }

  async requestMicrophone() {
    if (!navigator.mediaDevices?.getUserMedia) throw new Error('Microfone indisponível. Use HTTPS ou localhost.');
    try {
      return await navigator.mediaDevices.getUserMedia({
        audio: { channelCount: 1, echoCancellation: false, autoGainControl: false, noiseSuppression: false },
        video: false
      });
    } catch (err) {
      if (err.name === 'NotAllowedError' || err.name === 'PermissionDeniedError') throw new Error('Permita o acesso ao microfone nas configurações do navegador.');
      if (err.name === 'NotFoundError') throw new Error('Nenhum microfone foi encontrado no aparelho.');
      throw new Error('Não foi possível abrir o microfone: ' + err.message);
    }
  }

  async beginCapture(startTime, endTime = Infinity, existingStream = null) {
    if (this.capture) throw new Error('Já existe uma gravação em andamento.');
    const ctx = await this.init();
    const stream = existingStream || await this.requestMicrophone();
    try {
      if (ctx.state !== 'running') await ctx.resume();
      const source = ctx.createMediaStreamSource(stream);
      const chunks = [];
      let totalFrames = 0;
      let resolved = false;
      let resolvePromise;
      const promise = new Promise(resolve => { resolvePromise = resolve; });
      let node;
      const session = {
        startTime, endTime, promise,
        stop: () => {}, cancel: () => {},
        get frameCount() { return totalFrames; }
      };
      const add = arr => { if (!resolved && arr.length) { chunks.push(arr); totalFrames += arr.length; } };
      const done = cancelled => {
        if (resolved) return;
        resolved = true;
        try { source.disconnect(); node.disconnect(); } catch {}
        for (const t of stream.getTracks()) t.stop();
        if (this.capture === session) this.capture = null;
        resolvePromise(cancelled ? null : { blob: pcmToWav(chunks, ctx.sampleRate, totalFrames), duration: totalFrames / ctx.sampleRate, frames: totalFrames });
      };
      if (this.workletReady) {
        node = new AudioWorkletNode(ctx, 'vozloop-recorder', { numberOfInputs: 1, numberOfOutputs: 1, outputChannelCount: [1] });
        node.port.onmessage = ({ data }) => {
          if (data.type === 'data') add(data.samples);
          else if (data.type === 'done') done(false);
          else if (data.type === 'cancelled') done(true);
        };
        source.connect(node);
        node.connect(ctx.destination); // worklet devolve apenas silêncio: evita feedback
        session.stop = () => { if (!resolved) node.port.postMessage({ type: 'stop' }); };
        session.cancel = () => { if (!resolved) { node.port.postMessage({ type: 'cancel' }); done(true); } };
        node.port.postMessage({
          type: 'arm',
          startFrame: Math.round(startTime * ctx.sampleRate),
          endFrame: Number.isFinite(endTime) ? Math.round(endTime * ctx.sampleRate) : Infinity
        });
      } else {
        node = ctx.createScriptProcessor(2048, 1, 1);
        node.onaudioprocess = e => {
          e.outputBuffer.getChannelData(0).fill(0);
          if (resolved) return;
          const input = e.inputBuffer.getChannelData(0);
          const blockStart = Math.round(e.playbackTime * ctx.sampleRate);
          const from = Math.max(0, Math.ceil(startTime * ctx.sampleRate - blockStart));
          const to = Math.min(input.length, Math.ceil(endTime * ctx.sampleRate - blockStart));
          if (to > from) add(input.slice(from, to));
          if (Number.isFinite(endTime) && blockStart + input.length >= Math.round(endTime * ctx.sampleRate)) done(false);
        };
        source.connect(node);
        node.connect(ctx.destination);
        session.stop = () => { if (!resolved) done(false); };
        session.cancel = () => done(true);
      }
      this.capture = session;
      return session;
    } catch (e) {
      stream.getTracks().forEach(t => t.stop());
      throw e;
    }
  }

  async renderMix(tracks, buffers, mode, loopSeconds, loopCount) {
    const active = tracks.filter(t => !t.muted && buffers.has(t.id));
    if (!active.length) throw new Error('Não existem camadas audíveis para exportar.');
    const sr = this.ctx?.sampleRate || 44100;
    const duration = mode === 'loop'
      ? loopSeconds * loopCount
      : Math.max(...active.map(t => Math.max(0, buffers.get(t.id).duration + (Number(t.offsetMs) || 0) / 1000)));
    if (!Number.isFinite(duration) || duration <= 0) throw new Error('Sem áudio para exportar.');
    const frameCount = Math.ceil(duration * sr);
    if (frameCount > sr * 60 * 30) throw new Error('O arquivo é grande demais para exportar de uma vez (limite de 30 minutos).');
    const offline = new (window.OfflineAudioContext || window.webkitOfflineAudioContext)(1, frameCount, sr);
    for (const track of active) {
      const buffer = buffers.get(track.id);
      const src = offline.createBufferSource(), gain = offline.createGain();
      src.buffer = buffer;
      const shift = (Number(track.offsetMs) || 0) / 1000;
      if (mode === 'loop') {
        src.loop = true;
        src.loopStart = 0;
        src.loopEnd = Math.min(loopSeconds, buffer.duration);
      } else if (-shift >= buffer.duration) continue;
      gain.gain.value = Number(track.volume) || 0;
      src.connect(gain).connect(offline.destination);
      src.start(Math.max(0, shift), Math.max(0, -shift));
    }
    const rendered = await offline.startRendering();
    const data = rendered.getChannelData(0);
    let peak = 0;
    for (let i = 0; i < data.length; i++) peak = Math.max(peak, Math.abs(data[i]));
    const multiplier = peak > 0.98 ? 0.98 / peak : 1;
    return pcmToWav([data], sr, data.length, multiplier);
  }
}

// WAV PCM mono 16 bit, suportado por tocadores, editores e mensageiros.
function pcmToWav(chunks, sampleRate, frames, factor = 1) {
  const bytes = new ArrayBuffer(44 + frames * 2), view = new DataView(bytes);
  const put = (offset, value) => { for (let i = 0; i < value.length; i++) view.setUint8(offset + i, value.charCodeAt(i)); };
  put(0, 'RIFF'); view.setUint32(4, 36 + frames * 2, true); put(8, 'WAVE'); put(12, 'fmt ');
  view.setUint32(16, 16, true); view.setUint16(20, 1, true); view.setUint16(22, 1, true);
  view.setUint32(24, sampleRate, true); view.setUint32(28, sampleRate * 2, true);
  view.setUint16(32, 2, true); view.setUint16(34, 16, true); put(36, 'data'); view.setUint32(40, frames * 2, true);
  let index = 44;
  for (const chunk of chunks) {
    for (let i = 0; i < chunk.length; i++) {
      const v = Math.max(-1, Math.min(1, chunk[i] * factor));
      view.setInt16(index, v < 0 ? Math.round(v * 32768) : Math.round(v * 32767), true);
      index += 2;
    }
  }
  return new Blob([bytes], { type: 'audio/wav' });
}
