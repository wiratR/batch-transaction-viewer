// Main process (CommonJS)
const { app, BrowserWindow, dialog, ipcMain } = require('electron');
const path = require('path');
const fs = require('fs/promises');
const fsSync = require('fs');
const { spawn } = require('child_process');

// ------------------------------
// Globals
// ------------------------------
let win;

const CONFIG_NAME = 'config.json';
const DEFAULT_FALLBACK = {
  window: { fullscreen: false, width: 1200, height: 800, kiosk: false },
  api: { baseUrl: '' },
  auth: { enabled: true, username: '', password: '', realm: '' }
};

const authState = {
  token: null,
  tokenType: 'Bearer',
  expiresAt: 0,
  raw: null,
  _refreshTimer: null,
};

// ------------------------------
// Helpers: Paths (dev vs packaged)
// ------------------------------
function getAppBase() {
  // When packaged with asarUnpack, unpacked files live here:
  return app.isPackaged
    ? path.join(process.resourcesPath, 'app.asar.unpacked')
    : __dirname;
}

function getPythonDir() {
  return path.join(getAppBase(), 'python');
}

function getScriptPath() {
  return path.join(getPythonDir(), 'denylist_reader.py');
}

// ------------------------------
// Config: resolve + seed + load
// ------------------------------
function resolveDefaultConfigPath() {
  const candidates = [
    path.join(__dirname, 'config', 'default.json'),             // dev
    path.join(__dirname, 'config', 'config.json'),
    app.isPackaged ? path.join(process.resourcesPath, 'config.json') : null, // from extraResources
  ].filter(Boolean);
  for (const p of candidates) {
    if (fsSync.existsSync(p)) return p;
  }
  return null;
}

function getUserConfigPath() {
  return path.join(app.getPath('userData'), CONFIG_NAME);
}

async function ensureUserConfig() {
  const userPath = getUserConfigPath();
  try {
    await fs.access(userPath); // exists
    return userPath;
  } catch {
    try {
      const defPath = resolveDefaultConfigPath();
      const payload = defPath
        ? await fs.readFile(defPath)
        : Buffer.from(JSON.stringify(DEFAULT_FALLBACK, null, 2), 'utf8');
      await fs.mkdir(path.dirname(userPath), { recursive: true });
      await fs.writeFile(userPath, payload);
      return userPath;
    } catch (e) {
      console.warn('ensureUserConfig():', e?.message || e);
      await fs.mkdir(path.dirname(userPath), { recursive: true }).catch(() => {});
      await fs.writeFile(userPath, JSON.stringify(DEFAULT_FALLBACK, null, 2), 'utf8').catch(() => {});
      return userPath;
    }
  }
}

async function loadConfig() {
  try {
    const userPath = await ensureUserConfig();
    const txt = await fs.readFile(userPath, 'utf8');
    const cfg = JSON.parse(txt);
    return {
      ...DEFAULT_FALLBACK,
      ...cfg,
      window: { ...DEFAULT_FALLBACK.window, ...(cfg.window || {}) },
      api: { ...DEFAULT_FALLBACK.api, ...(cfg.api || {}) },
      auth: { ...DEFAULT_FALLBACK.auth, ...(cfg.auth || {}) },
    };
  } catch (e) {
    console.warn('loadConfig(): using fallback –', e?.message || e);
    return DEFAULT_FALLBACK;
  }
}

// ------------------------------
// Auth / Login
// ------------------------------
function normalizeTokenType(t) {
  if (!t) return 'Bearer';
  const low = String(t).toLowerCase();
  return low === 'bearer' ? 'Bearer' : t;
}

function scheduleRefresh(ms, cfg, loginFn) {
  if (authState._refreshTimer) clearTimeout(authState._refreshTimer);
  if (!ms || ms <= 0) return;
  const skew = 60_000; // refresh 60s before expiry
  const delay = Math.max(5_000, ms - skew);
  authState._refreshTimer = setTimeout(() => {
    loginFn(cfg).catch(err => {
      console.warn('[auth] auto refresh failed:', err?.message || err);
    });
  }, delay);
}

function clearAuth() {
  if (authState._refreshTimer) clearTimeout(authState._refreshTimer);
  authState.token = null;
  authState.tokenType = 'Bearer';
  authState.expiresAt = 0;
  authState.raw = null;
  authState._refreshTimer = null;
}

async function acmLogin(cfg) {
  const base = (cfg.api?.baseUrl || '').replace(/\/+$/, '');
  const u = cfg.auth?.username, p = cfg.auth?.password, realm = cfg.auth?.realm;
  if (!base || !u || !p || !realm) throw new Error('Missing api.baseUrl / auth.username / auth.password / auth.realm');

  const res = await fetch(`${base}/acm/login`, {
    method: 'POST',
    headers: {
      'Authorization': 'Basic ' + Buffer.from(`${u}:${p}`, 'utf8').toString('base64'),
      'Content-Type': 'application/x-www-form-urlencoded',
      'Accept': 'application/resource.oauthaccesstokenexchange+hal+json; charset=UTF-8',
    },
    body: new URLSearchParams({ realm, grant_type: 'password' }),
  });

  if (!res.ok) {
    const text = await res.text().catch(()=>'');
    throw new Error(`Login failed ${res.status} ${res.statusText}: ${text.slice(0, 400)}`);
  }

  // Expect: { access_token, token_type: "bearer", expires_in: 3600 }
  const data = await res.json();
  const accessToken = data.access_token;
  if (!accessToken) throw new Error('No access_token in response');

  const tokenType = normalizeTokenType(data.token_type || 'Bearer');
  const expiresIn = Number(data.expires_in || 0);   // seconds
  const expiresAt = expiresIn ? Date.now() + expiresIn * 1000 : 0;

  authState.token = accessToken;
  authState.tokenType = tokenType;
  authState.expiresAt = expiresAt;
  authState.raw = data;

  if (expiresIn > 0) scheduleRefresh(expiresIn * 1000, cfg, acmLogin);

  win?.webContents.send('auth:login-ok', { tokenType, accessToken, expiresAt });
  return data;
}

// ------------------------------
// Create BrowserWindow
// ------------------------------
async function createWin() {
  const cfg = await loadConfig();

  win = new BrowserWindow({
    width: cfg.window?.width ?? 1200,
    height: cfg.window?.height ?? 800,
    fullscreen: !!cfg.window?.fullscreen,
    kiosk: !!cfg.window?.kiosk,
    title: 'Batch Transaction Viewer',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: false
    }
  });

  // auto login (non-blocking) only if enabled
  if (cfg.auth?.enabled) {
    acmLogin(cfg).catch(err => {
      console.warn('[login] failed:', err?.message || err);
      win?.webContents.send('auth:login-error', { message: String(err?.message || err) });
    });
  } else {
    clearAuth();
    win?.webContents.send('auth:login-disabled');
  }

  win.loadFile(path.join(__dirname, 'renderer', 'index.html'));
}

app.whenReady().then(createWin);
app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });
app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWin(); });

// ------------------------------
// IPC: auth
// ------------------------------
ipcMain.handle('auth:getToken', async () => {
  if (authState?.token) {
    return {
      ok: true,
      token: authState.token,
      type: authState.tokenType,
      expiresAt: authState.expiresAt,
      header: `${authState.tokenType} ${authState.token}`,
    };
  }
  return { ok: false, error: 'No token' };
});

ipcMain.handle('auth:login', async () => {
  try {
    const cfg = await loadConfig();
    const data = await acmLogin(cfg);
    return { ok: true, data };
  } catch (e) {
    return { ok: false, error: String(e?.message || e) };
  }
});

ipcMain.handle('auth:logout', async () => {
  clearAuth();
  return { ok: true };
});

// Reload config on demand (optional)
ipcMain.handle('app:reload-config', async () => {
  const cfg = await loadConfig();

  // Window updates
  if (win) {
    win.setFullScreen(!!cfg.window?.fullscreen);
    if (!cfg.window?.fullscreen && cfg.window?.width && cfg.window?.height) {
      win.setSize(cfg.window.width, cfg.window.height);
    }
    if ('kiosk' in (cfg.window || {})) win.setKiosk(!!cfg.window.kiosk);
  }

  // Auth toggle
  if (cfg.auth?.enabled) {
    if (!authState.token) {
      acmLogin(cfg).catch(err => {
        console.warn('[login] failed (reload):', err?.message || err);
        win?.webContents.send('auth:login-error', { message: String(err?.message || err) });
      });
    }
  } else {
    if (authState.token) {
      clearAuth();
      win?.webContents.send('auth:login-disabled');
    }
  }

  return cfg;
});

// ------------------------------
// IPC: File open / read
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
function isBareCommand(cmd) {
  // No path separators => a bare command like "python3"
  return cmd && !cmd.includes(path.sep) && !cmd.includes('/');
}

function detectPythonExe() {
  const pyDir = getPythonDir();
  const base = getAppBase();
  const list = [];

  // local venv: ./python/.venv
  list.push(
    process.platform === 'win32'
      ? path.join(pyDir, '.venv', 'Scripts', 'python.exe')
      : path.join(pyDir, '.venv', 'bin', 'python3')
  );

  // project root venv: ./.venv
  list.push(
    process.platform === 'win32'
      ? path.join(base, '.venv', 'Scripts', 'python.exe')
      : path.join(base, '.venv', 'bin', 'python3')
  );

  // env override
  if (process.env.PYTHON_EXEC) list.unshift(process.env.PYTHON_EXEC);

  // PATH fallbacks
  list.push(...(process.platform === 'win32' ? ['python', 'python3', 'py'] : ['python3', 'python']));

  // keep existing absolute paths OR bare commands
  return list.filter(p => p && (isBareCommand(p) ? true : fsSync.existsSync(p)));
}

function runPythonOnce(exe, args, opts) {
  return new Promise((resolve, reject) => {
    const p = spawn(exe, args, opts);
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
}

ipcMain.handle('deny:parse', async (_evt, filePath, opts = { suppressIdWarn: true }) => {
  const scriptPath = getScriptPath();
  const cwd = getPythonDir();
  const exes = detectPythonExe();

  let lastErr = null;

  for (const exe of exes) {
    try {
      const env = {
        ...process.env,
        PYTHONPATH: [cwd, process.env.PYTHONPATH || ''].filter(Boolean).join(path.delimiter),
      };

      // Try #1: --json-stdout
      const args1 = [scriptPath, filePath, '--json-stdout'];
      if (opts?.suppressIdWarn) args1.push('--suppress-id-warn');

      try {
        const out = await runPythonOnce(exe, args1, { cwd, env });
        const data = JSON.parse(out.stdout);
        return { ok: true, data, log: out.stderr };
      } catch (e1) {
        // Try #2: --export-json -
        const args2 = [scriptPath, filePath, '--export-json', '-'];
        if (opts?.suppressIdWarn) args2.push('--suppress-id-warn');

        const out2 = await runPythonOnce(exe, args2, { cwd, env });
        const data = JSON.parse(out2.stdout);
        return { ok: true, data, log: out2.stderr };
      }
    } catch (e) {
      lastErr = e;
    }
  }

  return { ok: false, error: String(lastErr || 'Python not found / parse failed') };
});
