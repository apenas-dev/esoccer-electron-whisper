# E-Soccer Electron Whisper

Protótipo de transcrição de voz offline para E-Soccer Battle usando **Electron + React + Transformers.js (Whisper WASM)**.

## 🚀 Setup

```powershell
npm install
npm run dev
```

### Requisitos
- Node.js 22+
- Windows / macOS / Linux

**Primeiro uso:** O modelo Whisper (~40MB) é baixado automaticamente do HuggingFace. Depois funciona 100% offline.

## Stack
- **Electron** — Desktop wrapper
- **React + Vite** — Frontend
- **@huggingface/transformers** — Whisper via WASM (local, offline)
- **Web Audio API** — Captura do microfone

## Uso
1. Abra o app
2. Clique em **Iniciar Transcrição**
3. Fale no microfone — o texto aparece na tela em tempo real
4. Clique em **Parar** para encerrar
