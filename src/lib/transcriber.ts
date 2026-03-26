/**
 * Transcriber module — IPC-based (whisper.cpp sidecar)
 *
 * Captures audio from the mic via Web Audio API (16kHz mono PCM Float32),
 * sends chunks to the Electron main process via IPC, which forwards them
 * to the whisper-cli sidecar process.
 */

type TranscriptionCallback = (text: string) => void;
type ErrorCallback = (error: string) => void;
type StatusCallback = (status: string) => void;

let audioContext: AudioContext | null = null;
let mediaStream: MediaStream | null = null;
let processor: ScriptProcessorNode | null = null;
let sourceNode: MediaStreamAudioSourceNode | null = null;
let isRecording = false;

declare global {
  interface Window {
    electronAPI?: {
      platform: string;
      startTranscription: () => Promise<{ success: boolean; error?: string }>;
      stopTranscription: () => Promise<{ success: boolean }>;
      checkSidecar: () => Promise<{
        binaryExists: boolean;
        modelExists: boolean;
        platform: string;
      }>;
      onTranscription: (cb: (text: string) => void) => () => void;
      onWhisperError: (cb: (error: string) => void) => () => void;
      sendAudioChunk: (buffer: ArrayBuffer) => void;
    };
  }
}

/**
 * Check if whisper.cpp sidecar is available (binary + model downloaded).
 */
export async function checkSidecar(): Promise<{
  ready: boolean;
  binaryExists: boolean;
  modelExists: boolean;
}> {
  if (!window.electronAPI) {
    return { ready: false, binaryExists: false, modelExists: false };
  }
  const { binaryExists, modelExists } = await window.electronAPI.checkSidecar();
  return { ready: binaryExists && modelExists, binaryExists, modelExists };
}

/**
 * No model loading needed — whisper.cpp loads the model on startup.
 * This is kept as a no-op for API compatibility.
 */
export async function loadModel(onStatus?: StatusCallback): Promise<void> {
  onStatus?.('Verificando sidecar...');

  const { ready, binaryExists, modelExists } = await checkSidecar();

  if (!ready) {
    const missing: string[] = [];
    if (!binaryExists) missing.push('binário whisper-cli');
    if (!modelExists) missing.push('modelo ggml-tiny.bin');
    throw new Error(
      `Sidecar não está pronto. Falta: ${missing.join(', ')}. Execute "npm run postinstall".`
    );
  }

  onStatus?.('Sidecar pronto ✅');
}

/**
 * Start capturing audio and sending chunks to the whisper.cpp sidecar.
 */
export async function startRecording(
  onTranscription: TranscriptionCallback,
  onError?: ErrorCallback,
  onStatus?: StatusCallback
): Promise<void> {
  if (isRecording) return;

  if (!window.electronAPI) {
    throw new Error('Electron API não disponível. Execute pelo Electron.');
  }

  isRecording = true;
  onStatus?.('Iniciando transcrição...');

  // Start the whisper sidecar
  const result = await window.electronAPI.startTranscription();
  if (!result.success) {
    isRecording = false;
    const msg = result.error ?? 'Erro desconhecido ao iniciar sidecar';
    onError?.(msg);
    throw new Error(msg);
  }

  // Listen for transcriptions
  const unsubTranscription = window.electronAPI.onTranscription((text) => {
    onTranscription(text);
  });

  const unsubError = window.electronAPI.onWhisperError((error) => {
    onError?.(error);
  });

  // Capture audio from mic
  try {
    audioContext = new AudioContext({ sampleRate: 16000 });
    mediaStream = await navigator.mediaDevices.getUserMedia({
      audio: {
        sampleRate: 16000,
        channelCount: 1,
        echoCancellation: true,
        noiseSuppression: true,
      },
    });

    sourceNode = audioContext.createMediaStreamSource(mediaStream);
    processor = audioContext.createScriptProcessor(4096, 1, 1);

    processor.onaudioprocess = (e) => {
      if (!isRecording) return;

      const data = e.inputBuffer.getChannelData(0);
      // Convert Float32Array → ArrayBuffer (PCM Float32, little-endian)
      // Float32Array.buffer gives us the underlying ArrayBuffer
      const buffer = data.buffer.slice(
        data.byteOffset,
        data.byteOffset + data.byteLength
      );
      window.electronAPI!.sendAudioChunk(buffer);
    };

    sourceNode.connect(processor);
    processor.connect(audioContext.destination);
    onStatus?.('Escutando...');
  } catch (err) {
    isRecording = false;
    await window.electronAPI.stopTranscription();
    unsubTranscription();
    unsubError();

    const msg = err instanceof Error ? err.message : String(err);
    if (msg.includes('Permission') || msg.includes('NotAllowed')) {
      onError?.('Microfone negado. Permita o acesso ao microfone nas configurações.');
    } else if (msg.includes('NotFound')) {
      onError?.('Nenhum microfone encontrado.');
    } else {
      onError?.(`Erro ao capturar áudio: ${msg}`);
    }
    throw err;
  }

  // Store cleanup references
  (startRecording as any)._cleanup = () => {
    unsubTranscription();
    unsubError();
  };
}

/**
 * Stop recording and shut down the whisper sidecar.
 */
export function stopRecording(): void {
  isRecording = false;

  // Cleanup audio
  if (processor) {
    processor.disconnect();
    processor = null;
  }
  if (sourceNode) {
    sourceNode.disconnect();
    sourceNode = null;
  }
  if (mediaStream) {
    mediaStream.getTracks().forEach((t) => t.stop());
    mediaStream = null;
  }
  if (audioContext) {
    audioContext.close();
    audioContext = null;
  }

  // Stop sidecar
  if (window.electronAPI) {
    window.electronAPI.stopTranscription();
  }

  // Cleanup IPC listeners
  const cleanup = (startRecording as any)._cleanup;
  if (typeof cleanup === 'function') {
    cleanup();
  }
}

/**
 * Always returns true — no model pre-loading needed with whisper.cpp.
 */
export function isModelLoaded(): boolean {
  return true;
}
