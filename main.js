// CommonJS for best Electron compatibility
const { app, BrowserWindow, dialog, ipcMain } = require('electron');
const path = require('path');
const fs = require('fs/promises');

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
      // Remove sandbox for simplicity; can re-enable later with proper setup
      sandbox: false
    }
  });
  win.loadFile(path.join(__dirname, 'renderer', 'index.html'));
}

app.whenReady().then(createWin);
app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });
app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWin(); });

ipcMain.handle('file:openDialog', async () => {
  const { canceled, filePaths } = await dialog.showOpenDialog(win, {
    title: 'Open XML',
    filters: [{ name: 'XML', extensions: ['xml'] }],
    properties: ['openFile']
  });
  if (canceled || !filePaths?.length) return null;
  const filePath = filePaths[0];
  const xml = await fs.readFile(filePath, 'utf8');
  return { filePath, xml };
});

ipcMain.handle('file:readDrop', async (_evt, filePath) => {
  const xml = await fs.readFile(filePath, 'utf8');
  return { filePath, xml };
});
