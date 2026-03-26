import { pipeline, env } from '@huggingface/transformers';

// Allow local model caching
env.allowLocalModels = false;

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let transcriber: any = null;
let audioContext: AudioContext | null = null;
let mediaStream: MediaStream | null = null;
let processor: ScriptProcessorNode | null = null;
let isRecording = false;

type TranscriptionCallback = (text: string) => void;
type ProgressCallback = (progress: string) => void;

export async function loadModel(onProgress?: ProgressCallback) {
  if (transcriber) return;

  onProgress?.('Baixando modelo Whisper (tiny)...');
  transcriber = await pipeline(
    'automatic-speech-recognition',
    'onnx-community/whisper-tiny',
    {
      dtype: 'fp32',
      progress_callback: (progress: { status: string; progress?: number; file?: string }) => {
        if (progress.status === 'progress' && progress.progress !== undefined) {
          const pct = Math.round(progress.progress);
          const fileName = progress.file?.split('/').pop() ?? '';
          onProgress?.(`Baixando ${fileName}: ${pct}%`);
        }
      },
    }
  );
  onProgress?.('Modelo carregado! ✅');
}

export async function startRecording(onTranscription: TranscriptionCallback): Promise<void> {
  if (isRecording) return;
  isRecording = true;

  audioContext = new AudioContext({ sampleRate: 16000 });
  mediaStream = await navigator.mediaDevices.getUserMedia({
    audio: { sampleRate: 16000, channelCount: 1, echoCancellation: true },
  });

  const source = audioContext.createMediaStreamSource(mediaStream);
  processor = audioContext.createScriptProcessor(4096, 1, 1);

  const chunks: Float32Array[] = [];
  const CHUNK_DURATION_MS = 3000;
  const sampleRate = audioContext.sampleRate;
  const samplesPerChunk = (sampleRate * CHUNK_DURATION_MS) / 1000;

  processor.onaudioprocess = (e) => {
    if (!isRecording) return;
    const data = e.inputBuffer.getChannelData(0);
    chunks.push(new Float32Array(data));

    const totalSamples = chunks.reduce((sum, c) => sum + c.length, 0);
    if (totalSamples >= samplesPerChunk && transcriber) {
      const merged = new Float32Array(totalSamples);
      let offset = 0;
      for (const chunk of chunks) {
        merged.set(chunk, offset);
        offset += chunk.length;
      }
      chunks.length = 0;

      // Pass Float32Array directly — Transformers.js handles resampling internally
      const audioInput = new Float32Array(merged);
      transcriber!(audioInput, {
        chunk_length_s: 30,
        stride_length_s: 5,
        language: 'portuguese',
        task: 'transcribe',
        sampling_rate: sampleRate,
        return_timestamps: false,
      }).then((result: { text?: string }) => {
        if (result.text?.trim()) {
          onTranscription(result.text.trim());
        }
      });
    }
  };

  source.connect(processor);
  processor.connect(audioContext.destination);
}

export function stopRecording(): void {
  isRecording = false;
  if (processor) {
    processor.disconnect();
    processor = null;
  }
  if (mediaStream) {
    mediaStream.getTracks().forEach((t) => t.stop());
    mediaStream = null;
  }
  if (audioContext) {
    audioContext.close();
    audioContext = null;
  }
}

export function isModelLoaded(): boolean {
  return transcriber !== null;
}
