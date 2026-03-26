import { contextBridge, ipcRenderer } from 'electron';

contextBridge.exposeInMainWorld('electronAPI', {
  platform: process.platform,

  startTranscription: () => ipcRenderer.invoke('start-transcription'),
  stopTranscription: () => ipcRenderer.invoke('stop-transcription'),
  checkSidecar: () => ipcRenderer.invoke('check-sidecar'),

  onTranscription: (callback: (text: string) => void) => {
    const handler = (_event: Electron.IpcRendererEvent, text: string) => callback(text);
    ipcRenderer.on('transcription', handler);
    return () => ipcRenderer.removeListener('transcription', handler);
  },

  onWhisperError: (callback: (error: string) => void) => {
    const handler = (_event: Electron.IpcRendererEvent, error: string) => callback(error);
    ipcRenderer.on('whisper-error', handler);
    return () => ipcRenderer.removeListener('whisper-error', handler);
  },

  sendAudioChunk: (pcmBuffer: ArrayBuffer) => {
    ipcRenderer.send('audio-chunk', pcmBuffer);
  },
});
