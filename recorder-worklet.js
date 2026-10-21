/* Captura PCM sem monitorar o microfone nos alto-falantes.
 * Agendamento em frames do AudioContext reduz deriva entre camadas.
 */
class VoiceLoopRecorder extends AudioWorkletProcessor {
  constructor() {
    super();
    this.startFrame = Infinity;
    this.endFrame = Infinity;
    this.started = false;
    this.finished = false;
    this.samples = new Float32Array(4096);
    this.used = 0;
    this.port.onmessage = ({ data }) => {
      if (data.type === 'arm') {
        this.startFrame = data.startFrame;
        this.endFrame = data.endFrame ?? Infinity;
      } else if (data.type === 'stop') {
        // Processar a interrupção no próximo bloco de áudio.
        this.endFrame = Math.min(this.endFrame, currentFrame);
      } else if (data.type === 'cancel') {
        this.finished = true;
        this.used = 0;
        this.port.postMessage({ type: 'cancelled' });
      }
    };
  }

  flush() {
    if (!this.used) return;
    const out = this.samples.slice(0, this.used);
    this.port.postMessage({ type: 'data', samples: out }, [out.buffer]);
    this.used = 0;
  }

  process(inputs, outputs) {
    for (const channel of (outputs[0] || [])) channel.fill(0);
    if (this.finished) return true;
    const ch = inputs[0]?.[0];
    const blockSize = ch?.length ?? outputs[0]?.[0]?.length ?? 128;
    const blockStart = currentFrame;
    const blockEnd = blockStart + blockSize;
    if (blockEnd <= this.startFrame) return true;
    if (blockStart >= this.endFrame) {
      this.finish();
      return true;
    }
    const from = Math.max(0, Math.ceil(this.startFrame - blockStart));
    const to = Math.min(blockSize, Math.ceil(this.endFrame - blockStart));
    if (to > from) {
      this.started = true;
      for (let i = from; i < to; i++) {
        this.samples[this.used++] = ch?.[i] ?? 0;
        if (this.used === this.samples.length) this.flush();
      }
    }
    if (blockEnd >= this.endFrame) this.finish();
    return true;
  }

  finish() {
    if (this.finished) return;
    this.finished = true;
    this.flush();
    this.port.postMessage({ type: 'done' });
  }
}
registerProcessor('vozloop-recorder', VoiceLoopRecorder);
