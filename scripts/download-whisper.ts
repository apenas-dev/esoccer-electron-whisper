/**
 * Postinstall script: downloads whisper.cpp binary + ggml-tiny model.
 *
 * Platform support:
 *   Windows → download pre-built zip from GitHub releases
 *   Linux   → download pre-built tarball from GitHub releases
 *   macOS   → download pre-built tarball from GitHub releases (or build from source)
 */

import { execSync } from 'node:child_process';
import {
  createReadStream,
  createWriteStream,
  mkdirSync,
  chmodSync,
  existsSync,
  copyFileSync,
  renameSync,
  rmSync,
} from 'node:fs';
import { get } from 'node:https';
import { join, resolve } from 'node:path';
import { pipeline } from 'node:stream/promises';
import { fileURLToPath } from 'node:url';
import { dirname } from 'node:path';
import { cpus } from 'node:os';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const ROOT = resolve(__dirname, '..');

const BIN_DIR = join(ROOT, 'binaries');
const MODEL_DIR = join(ROOT, 'models');

const VERSION = 'v1.7.6';
const BASE_URL = `https://github.com/ggerganov/whisper.cpp/releases/download/${VERSION}`;
const MODEL_URL =
  'https://huggingface.co/ggerganov/whisper/resolve/main/ggml-tiny.bin';

mkdirSync(BIN_DIR, { recursive: true });
mkdirSync(MODEL_DIR, { recursive: true });

// ── Helpers ──────────────────────────────────────────────────────────

function log(msg: string) {
  console.log(`[download-whisper] ${msg}`);
}

function followRedirect(
  url: string
): Promise<{ res: import('http').IncomingMessage; finalUrl: string }> {
  return new Promise((resolve, reject) => {
    get(url, (res) => {
      if (
        (res.statusCode === 301 || res.statusCode === 302) &&
        res.headers.location
      ) {
        followRedirect(res.headers.location).then(resolve, reject);
        return;
      }
      if (res.statusCode !== 200) {
        reject(new Error(`HTTP ${res.statusCode} for ${url}`));
        return;
      }
      resolve({ res, finalUrl: url });
    }).on('error', reject);
  });
}

async function download(url: string, dest: string): Promise<void> {
  log(`Downloading: ${url}`);
  const { res } = await followRedirect(url);

  const file = createWriteStream(dest);
  const total = Number(res.headers['content-length'] ?? 0);
  let downloaded = 0;

  res.on('data', (chunk: Buffer) => {
    downloaded += chunk.length;
    if (total > 0) {
      const pct = Math.round((downloaded / total) * 100);
      process.stdout.write(`\r  Progress: ${pct}%`);
    }
  });
  res.on('end', () => {
    if (total > 0) process.stdout.write('\r  Complete! 100%\n');
    else console.log('  Done.');
  });

  await pipeline(res, file);
}

async function extractZip(zipPath: string, destDir: string): Promise<void> {
  try {
    // Try adm-zip if installed
    const { createRequire } = await import('node:module');
    const require = createRequire(import.meta.url);
    const AdmZip = require('adm-zip');
    const zip = new AdmZip(zipPath);
    zip.extractAllTo(destDir, true);
  } catch {
    // Fall back to system unzip
    try {
      execSync(`unzip -o "${zipPath}" -d "${destDir}"`, { stdio: 'inherit' });
    } catch {
      try {
        execSync(
          `powershell -Command "Expand-Archive -Path '${zipPath}' -DestinationPath '${destDir}' -Force"`,
          { stdio: 'inherit' }
        );
      } catch {
        throw new Error(
          'Failed to extract zip. Install unzip or adm-zip (npm i -g adm-zip).'
        );
      }
    }
  }
}

// ── Platform detection ───────────────────────────────────────────────

const platform = process.platform;
const arch = process.arch;

async function downloadBinary(): Promise<string> {
  const binaryName = platform === 'win32' ? 'whisper-cli.exe' : 'whisper-cli';
  const binaryPath = join(BIN_DIR, binaryName);

  if (existsSync(binaryPath)) {
    log(`Binary already exists: ${binaryPath}`);
    return binaryPath;
  }

  if (platform === 'win32' && arch === 'x64') {
    // ── Windows: pre-built zip ──────────────────────────────────
    const zipUrl = `${BASE_URL}/whisper-bin-x64.zip`;
    const zipPath = join(BIN_DIR, 'whisper-bin.zip');
    log('Downloading whisper.cpp binary for Windows x64...');
    await download(zipUrl, zipPath);
    extractZip(zipPath, BIN_DIR);

    // Move from Release/whisper-cli.exe → binaries/whisper-cli.exe
    const srcExe = join(BIN_DIR, 'Release', 'whisper-cli.exe');
    if (existsSync(srcExe)) {
      if (existsSync(binaryPath)) rmSync(binaryPath);
      renameSync(srcExe, binaryPath);
    }

    // Cleanup
    rmSync(zipPath, { force: true });
    rmSync(join(BIN_DIR, 'Release'), { recursive: true, force: true });
    log(`Binary installed: ${binaryPath}`);
    return binaryPath;
  }

  // ── macOS: pre-built or build from source ─────────────────────
  if (platform === 'darwin') {
    // Try pre-built binary for macOS
    const macArch = arch === 'arm64' ? 'arm64' : 'x64';
    const tarUrl = `${BASE_URL}/whisper-bin-mac-${macArch}.tar.gz`;
    const tarPath = join(BIN_DIR, 'whisper-bin.tar.gz');

    try {
      log(`Downloading whisper.cpp binary for macOS ${macArch}...`);
      await download(tarUrl, tarPath);
      execSync(`tar xzf "${tarPath}" -C "${BIN_DIR}"`, { stdio: 'inherit' });

      // Find and move the binary
      const srcCli = join(BIN_DIR, 'whisper-cli');
      if (existsSync(srcCli)) {
        chmodSync(srcCli, 0o755);
      }
      rmSync(tarPath, { force: true });
      log(`Binary installed: ${binaryPath}`);
      return binaryPath;
    } catch {
      log('Pre-built binary not available, building from source...');
      return buildFromSource(binaryPath);
    }
  }

  // ── Linux: pre-built tarball or build from source ─────────────
  if (platform === 'linux') {
    const linuxArch = arch === 'arm64' ? 'aarch64' : 'x64';
    const tarUrl = `${BASE_URL}/whisper-bin-linux-${linuxArch}.tar.gz`;
    const tarPath = join(BIN_DIR, 'whisper-bin.tar.gz');

    try {
      log(`Downloading whisper.cpp binary for Linux ${linuxArch}...`);
      await download(tarUrl, tarPath);
      execSync(`tar xzf "${tarPath}" -C "${BIN_DIR}"`, { stdio: 'inherit' });

      const srcCli = join(BIN_DIR, 'whisper-cli');
      if (existsSync(srcCli)) {
        chmodSync(srcCli, 0o755);
      }
      rmSync(tarPath, { force: true });
      log(`Binary installed: ${binaryPath}`);
      return binaryPath;
    } catch {
      log('Pre-built binary not available, building from source...');
      return buildFromSource(binaryPath);
    }
  }

  throw new Error(`Unsupported platform: ${platform} ${arch}`);
}

async function buildFromSource(binaryPath: string): Promise<string> {
  log('Building whisper.cpp from source...');
  const srcDir = join(BIN_DIR, 'whisper.cpp-src');

  if (!existsSync(join(srcDir, 'CMakeLists.txt'))) {
    log(`Cloning whisper.cpp ${VERSION}...`);
    execSync(
      `git clone --depth 1 --branch ${VERSION} https://github.com/ggerganov/whisper.cpp.git "${srcDir}"`,
      { stdio: 'inherit' }
    );
  }

  const buildDir = join(srcDir, 'build');
  mkdirSync(buildDir, { recursive: true });

  log('Configuring with CMake...');
  execSync('cmake .. -DCMAKE_BUILD_TYPE=Release', {
    cwd: buildDir,
    stdio: 'inherit',
  });

  const jobs = cpus().length;
  log(`Building whisper-cli (using ${jobs} threads)...`);
  execSync(`cmake --build . --config Release -j ${jobs}`, {
    cwd: buildDir,
    stdio: 'inherit',
  });

  // Find the built binary
  const candidates = [
    join(buildDir, 'bin', 'whisper-cli'),
    join(buildDir, 'bin', 'main'),
    join(buildDir, 'whisper-cli'),
    join(buildDir, 'main'),
  ];

  for (const p of candidates) {
    if (existsSync(p)) {
      copyFileSync(p, binaryPath);
      chmodSync(binaryPath, 0o755);
      log(`Binary built and installed: ${binaryPath}`);
      return binaryPath;
    }
  }

  throw new Error(
    `whisper-cli not found after build. Looked in: ${candidates.join(', ')}`
  );
}

async function downloadModel(): Promise<string> {
  const modelPath = join(MODEL_DIR, 'ggml-tiny.bin');

  if (existsSync(modelPath)) {
    log(`Model already exists: ${modelPath}`);
    return modelPath;
  }

  log('Downloading ggml-tiny.bin model (~75 MB)...');
  await download(MODEL_URL, modelPath);
  log(`Model installed: ${modelPath}`);
  return modelPath;
}

// ── Main ─────────────────────────────────────────────────────────────

async function main() {
  log('Setting up whisper.cpp sidecar...');
  log(`Platform: ${platform} ${arch}`);
  log('');

  try {
    const binary = await downloadBinary();
    const model = await downloadModel();
    log('');
    log('✅ Setup complete!');
    log(`   Binary: ${binary}`);
    log(`   Model:  ${model}`);
    log('');
    log('Run "npm run dev:electron" to start the app.');
  } catch (err) {
    log(``);
    log(`❌ Setup failed: ${err}`);
    log('');
    log('Troubleshooting:');
    log('  • Ensure you have internet access');
    if (platform !== 'win32') {
      log('  • Ensure cmake and a C++ compiler are installed');
      log('  • macOS: xcode-select --install');
      log('  • Ubuntu/Debian: sudo apt install cmake g++ make');
    }
    process.exit(1);
  }
}

main();
