import { app, BrowserWindow, ipcMain, dialog } from 'electron';
import path from 'path';
import { spawn, ChildProcess } from 'child_process';
import fs from 'fs';

// ── Globals ──────────────────────────────────────────────────────────

let mainWindow: BrowserWindow | null = null;
let whisperProcess: ChildProcess | null = null;

const BIN_DIR = path.join(__dirname, '..', 'binaries');
const MODEL_DIR = path.join(__dirname, '..', 'models');

function getBinaryPath(): string {
  return process.platform === 'win32'
    ? path.join(BIN_DIR, 'whisper-cli.exe')
    : path.join(BIN_DIR, 'whisper-cli');
}

function getModelPath(): string {
  return path.join(MODEL_DIR, 'ggml-tiny.bin');
}

// ── Window ───────────────────────────────────────────────────────────

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 800,
    height: 600,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  if (process.env.VITE_DEV_SERVER_URL) {
    mainWindow.loadURL(process.env.VITE_DEV_SERVER_URL);
  } else {
    mainWindow.loadFile(path.join(__dirname, '../dist/index.html'));
  }

  mainWindow.on('closed', () => {
    mainWindow = null;
    stopWhisper();
  });
}

// ── Whisper sidecar management ───────────────────────────────────────

function startWhisper(): string | null {
  if (whisperProcess) return null; // already running

  const binaryPath = getBinaryPath();
  const modelPath = getModelPath();

  if (!fs.existsSync(binaryPath)) {
    return `Binary not found: ${binaryPath}. Run "npm run postinstall" first.`;
  }
  if (!fs.existsSync(modelPath)) {
    return `Model not found: ${modelPath}. Run "npm run postinstall" first.`;
  }

  const args = [
    '-m', modelPath,
    '-f', '-',           // read from stdin
    '-l', 'pt',
    '--no-timestamps',
    '-t', '4',
  ];

  try {
    whisperProcess = spawn(binaryPath, args, {
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    // Collect stderr for error reporting
    let stderrBuffer = '';
    if (whisperProcess.stderr) {
      whisperProcess.stderr.on('data', (chunk: Buffer) => {
        stderrBuffer += chunk.toString();
      });
    }

    // Read transcriptions from stdout
    if (whisperProcess.stdout) {
      let lineBuffer = '';
      whisperProcess.stdout.on('data', (chunk: Buffer) => {
        lineBuffer += chunk.toString();
        const lines = lineBuffer.split('\n');
        lineBuffer = lines.pop() ?? ''; // keep incomplete line

        for (const line of lines) {
          const trimmed = line.trim();
          if (trimmed) {
            mainWindow?.webContents.send('transcription', trimmed);
          }
        }
      });
    }

    whisperProcess.on('error', (err) => {
      console.error('[whisper] Process error:', err);
      mainWindow?.webContents.send('whisper-error', err.message);
      whisperProcess = null;
    });

    whisperProcess.on('close', (code) => {
      if (code !== 0 && code !== null) {
        console.error(`[whisper] Exited with code ${code}`);
        const errMsg = stderrBuffer.trim() || `whisper-cli exited with code ${code}`;
        mainWindow?.webContents.send('whisper-error', errMsg);
      }
      whisperProcess = null;
    });

    console.log(`[whisper] Started sidecar (PID: ${whisperProcess.pid})`);

    // Start periodic flush timer
    flushTimer = setInterval(flushAudio, FLUSH_INTERVAL_MS);

    return null;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return `Failed to start whisper-cli: ${msg}`;
  }
}

function stopWhisper(): void {
  if (flushTimer) {
    clearInterval(flushTimer);
    flushTimer = null;
  }

  // Flush any remaining audio before closing
  if (whisperProcess?.stdin?.writable && audioBytesWritten > 0) {
    flushAudio();
  }

  audioBuffer = [];
  audioBytesWritten = 0;

  if (whisperProcess) {
    console.log('[whisper] Stopping sidecar...');
    whisperProcess.stdin?.end();
    const proc = whisperProcess;
    whisperProcess = null;
    setTimeout(() => {
      if (!proc.killed) {
        proc.kill('SIGTERM');
      }
    }, 1000);
  }
}

// ── WAV helpers ───────────────────────────────────────────────────────

function writeWavHeader(sampleRate: number, numChannels: number, bitsPerSample: number, dataLength: number): Buffer {
  const header = Buffer.alloc(44);
  const byteRate = sampleRate * numChannels * (bitsPerSample / 8);
  const blockAlign = numChannels * (bitsPerSample / 8);

  header.write('RIFF', 0);
  header.writeUInt32LE(36 + dataLength, 4);
  header.write('WAVE', 8);
  header.write('fmt ', 12);
  header.writeUInt32LE(16, 16);           // fmt chunk size
  header.writeUInt16LE(3, 20);            // PCM format: 3 = IEEE Float
  header.writeUInt16LE(numChannels, 22);
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(byteRate, 28);
  header.writeUInt16LE(blockAlign, 32);
  header.writeUInt16LE(bitsPerSample, 34);
  header.write('data', 36);
  header.writeUInt32LE(dataLength, 40);

  return header;
}

// Buffer audio chunks and periodically flush as WAV to whisper stdin
let audioBuffer: Buffer[] = [];
let audioBytesWritten = 0;
const FLUSH_INTERVAL_MS = 3000; // flush every 3 seconds
let flushTimer: ReturnType<typeof setInterval> | null = null;

const SAMPLE_RATE = 16000;
const NUM_CHANNELS = 1;
const BITS_PER_SAMPLE = 32;

function flushAudio(): void {
  if (!whisperProcess?.stdin?.writable || audioBytesWritten === 0) return;

  const totalLength = audioBytesWritten;
  const header = writeWavHeader(SAMPLE_RATE, NUM_CHANNELS, BITS_PER_SAMPLE, totalLength);
  whisperProcess.stdin.write(header);

  for (const chunk of audioBuffer) {
    whisperProcess.stdin.write(chunk);
  }

  audioBuffer = [];
  audioBytesWritten = 0;
}

function writeAudioChunk(pcmData: Buffer): void {
  audioBuffer.push(pcmData);
  audioBytesWritten += pcmData.length;

  // Flush if buffer is large enough (~3 seconds of audio)
  const bytesPerSecond = SAMPLE_RATE * NUM_CHANNELS * (BITS_PER_SAMPLE / 8);
  if (audioBytesWritten >= bytesPerSecond * FLUSH_INTERVAL_MS / 1000) {
    flushAudio();
  }
}

// ── IPC handlers ─────────────────────────────────────────────────────

ipcMain.handle('start-transcription', () => {
  const error = startWhisper();
  if (error) {
    return { success: false, error };
  }
  return { success: true };
});

ipcMain.handle('stop-transcription', () => {
  stopWhisper();
  return { success: true };
});

ipcMain.handle('check-sidecar', () => {
  const binaryExists = fs.existsSync(getBinaryPath());
  const modelExists = fs.existsSync(getModelPath());
  return { binaryExists, modelExists, platform: process.platform };
});

ipcMain.on('audio-chunk', (_event, buffer: ArrayBuffer) => {
  writeAudioChunk(Buffer.from(buffer));
});

// ── App lifecycle ────────────────────────────────────────────────────

app.whenReady().then(createWindow);

app.on('window-all-closed', () => {
  stopWhisper();
  if (process.platform !== 'darwin') app.quit();
});

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) createWindow();
});

app.on('before-quit', () => {
  stopWhisper();
});
