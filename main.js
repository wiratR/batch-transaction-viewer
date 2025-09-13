// Main process (CommonJS)
const { app, BrowserWindow, dialog, ipcMain } = require('electron');
const path = require('path');
const fs = require('fs/promises');
const fsSync = require('fs');
const { spawn } = require('child_process');

let win;

function createWin() {
  win = new BrowserWindow({
    width: 1200,
    height: 800,
    title: 'Batch Transaction Viewer',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: false,
    },
  });

  win.loadFile(path.join(__dirname, 'renderer', 'index.html'));

  // เปิด DevTools อัตโนมัติเมื่อรันแบบ dev
  if (!app.isPackaged) {
    win.webContents.once('dom-ready', () => {
      // win.webContents.openDevTools({ mode: 'detach' });
    });
  }
}

app.whenReady().then(createWin);
app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });
app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWin(); });

// ------------------------------
// File open / read
// ------------------------------
ipcMain.handle('file:openDialog', async () => {
  const bw = BrowserWindow.getFocusedWindow() || win;
  const { canceled, filePaths } = await dialog.showOpenDialog(bw, {
    title: 'Open File',
    filters: [
      { name: 'XML / DenyList', extensions: ['xml', 'bin', 'zip'] },
      { name: 'All', extensions: ['*'] },
    ],
    properties: ['openFile'],
  });
  if (canceled || !filePaths?.length) return null;

  const filePath = filePaths[0];
  let xml = null;
  if (filePath.toLowerCase().endsWith('.xml')) {
    xml = await fs.readFile(filePath, 'utf8');
  }
  return { filePath, xml };
});

ipcMain.handle('file:readDrop', async (_evt, filePath) => {
  const xml = await fs.readFile(filePath, 'utf8');
  return { filePath, xml };
});

// ------------------------------
// Python integration (DenyList)
// ------------------------------
function detectPythonExe() {
  const candidates = [];

  // project root venv: ./.venv
  candidates.push(
    process.platform === 'win32'
      ? path.join(__dirname, '.venv', 'Scripts', 'python.exe')
      : path.join(__dirname, '.venv', 'bin', 'python3')
  );

  // python subdir venv: ./python/.venv
  candidates.push(
    process.platform === 'win32'
      ? path.join(__dirname, 'python', '.venv', 'Scripts', 'python.exe')
      : path.join(__dirname, 'python', '.venv', 'bin', 'python3')
  );

  // env override
  if (process.env.PYTHON_EXEC) candidates.unshift(process.env.PYTHON_EXEC);

  // fallbacks to PATH
  candidates.push(...(process.platform === 'win32' ? ['python', 'python3', 'py'] : ['python3', 'python']));

  // keep those that exist or are bare commands
  return candidates.filter(p => p && (p.includes('python') ? true : fsSync.existsSync(p)));
}

ipcMain.handle('deny:parse', async (_evt, filePath, opts = { suppressIdWarn: true }) => {
  const scriptPath = path.join(__dirname, 'python', 'denylist_reader.py');
  const cwd = path.join(__dirname, 'python');
  const exes = detectPythonExe();

  let lastErr = null;

  for (const exe of exes) {
    try {
      const args = [scriptPath, filePath, '--json-stdout'];
      if (opts?.suppressIdWarn) args.push('--suppress-id-warn');

      const env = {
        ...process.env,
        // ให้ Python มองเห็นโมดูลที่อยู่ใน ./python (TransCity/* หรือไฟล์ .py อื่นๆ)
        PYTHONPATH: [cwd, process.env.PYTHONPATH || ''].filter(Boolean).join(path.delimiter),
      };

      const out = await new Promise((resolve, reject) => {
        const p = spawn(exe, args, { cwd, env });
        let stdout = '';
        let stderr = '';

        p.stdout.on('data', d => (stdout += d.toString()));
        p.stderr.on('data', d => (stderr += d.toString()));
        p.on('error', reject);
        p.on('close', code => {
          if (code === 0) resolve({ stdout, stderr });
          else reject(new Error(`python exit ${code}: ${stderr || stdout}`));
        });
      });

      // คาดหวัง JSON บน stdout (จาก --json-stdout)
      const data = JSON.parse(out.stdout);
      return { ok: true, data, log: out.stderr };
    } catch (e) {
      lastErr = e;
    }
  }

  return { ok: false, error: String(lastErr || 'Python not found / parse failed') };
});
