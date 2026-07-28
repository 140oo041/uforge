// The desktop host: one window, one open project, a native menu.
//
// Deliberately a native frame rather than custom chrome. This is an Operate
// surface, the OS already draws a title bar better than we would, and the
// window title is where a desktop user looks for "which project am I in".
// Inventing a title strip would cost a row of canvas and buy nothing.

import * as fs from 'fs';
import * as path from 'path';
import { BrowserWindow, Menu, app, dialog, ipcMain, shell } from 'electron';

import type { HostMsg, ViewMsg } from '@iss/contracts/messaging';

import {
  detectEditor,
  openFolderInEditor,
  openInEditor,
  type EditorTarget,
} from '@iss/host';

import { Session } from './session';
import { Terminal } from './terminal';
import { loadSettings, rememberProject, saveSettings, type Settings } from './settings';

const IS_DEV = !app.isPackaged;

let window: BrowserWindow | null = null;
let session: Session | null = null;
let settings: Settings = { recents: [] };
/** Resolved once at startup — the user's real editor, if they have one. */
let editor: EditorTarget | null = null;
let terminal: Terminal | null = null;

// ---- where things are -------------------------------------------------------

/**
 * A directory is a design project when it has the two things the parser and the
 * build both need. Checking up front means "Open" can refuse clearly instead of
 * opening an empty canvas and letting the user wonder.
 */
function isProject(dir: string): boolean {
  return fs.existsSync(path.join(dir, 'src')) || fs.existsSync(path.join(dir, 'inc'));
}

/** The engine ships beside the app in this repo; a project may also sit next to it. */
function resolveEnginePath(projectRoot: string): string {
  const candidates = [
    process.env.ISS_ENGINE_PATH,
    path.resolve(app.getAppPath(), '..', 'engine'),
    path.resolve(app.getAppPath(), '..', '..', 'engine'),
    path.resolve(projectRoot, '..', 'engine'),
  ].filter((c): c is string => Boolean(c));
  for (const c of candidates) if (fs.existsSync(path.join(c, 'include'))) return c;
  return candidates[candidates.length - 1];
}

function resolveXverify(projectRoot: string): string {
  const candidates = [
    process.env.ISS_XVERIFY_PATH,
    path.resolve(projectRoot, '..', 'xverify', 'xverify'),
    path.resolve(projectRoot, '..', 'micro_arch_IDE', 'xverify', 'xverify'),
    path.resolve(projectRoot, '..', '..', 'micro_arch_IDE', 'xverify', 'xverify'),
  ].filter((c): c is string => Boolean(c));
  return candidates.find((c) => fs.existsSync(c)) ?? '';
}

// ---- the window -------------------------------------------------------------

function send(msg: HostMsg): void {
  window?.webContents.send('iss:host', msg);
}

function setTitle(): void {
  if (!window) return;
  window.setTitle(session ? `${path.basename(session.projectRoot)} — ISS` : 'ISS');
}

function createWindow(): void {
  window = new BrowserWindow({
    width: 1600,
    height: 1000,
    minWidth: 940,
    minHeight: 600,
    title: 'ISS',
    // The ribbon is drawn by the renderer, so the OS frame goes away. Electron
    // keeps native resize edges with 'hidden', unlike frame:false — the window
    // stays fully resizable without us reimplementing hit-testing.
    titleBarStyle: 'hidden',
    // Match the canvas ground so the first paint is not a white flash into a
    // dark surface — the app should never look like it blinked.
    backgroundColor: '#f2e8d6',
    show: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });

  window.once('ready-to-show', () => window?.show());
  void window.loadFile(path.join(__dirname, '..', 'renderer', 'index.html'));
  window.on('closed', () => {
    window = null;
  });
}

// ---- opening a project ------------------------------------------------------

function openProject(dir: string): void {
  if (!isProject(dir)) {
    send({
      type: 'editError',
      message: `${path.basename(dir)} has no src/ or inc/ — pick the project root, not a file inside it`,
    });
    return;
  }

  session?.dispose();
  terminal?.dispose();
  terminal = null;
  session = new Session({
    projectRoot: dir,
    enginePath: resolveEnginePath(dir),
    xverifyPath: resolveXverify(dir),
    sailCommitrecPath: process.env.ISS_SAIL_COMMITREC ?? '',
    refModel: process.env.ISS_SAIL_COMMITREC ? 'sail' : 'stub',
    post: send,
    openSource: (at) => {
      // No editor of our own, by the same standing decision the extension
      // made: the canvas is never a text editor. Hand the file to the real one,
      // at the exact line the architect clicked.
      if (editor) {
        openInEditor(editor, at);
        return;
      }
      // Nothing found: fall back to the OS association, and say so rather than
      // letting a double-click appear to do nothing in particular.
      void shell.openPath(at.file);
      send({
        type: 'editError',
        message:
          'No VS Code CLI on PATH — opened with the system default instead. ' +
          'Install the `code` command (VS Code ▸ Shell Command: Install ‘code’ in PATH) ' +
          'or set ISS_EDITOR to your editor.',
      });
    },
  });

  settings = rememberProject(settings, dir);
  saveSettings(settings);
  setTitle();
  buildMenu();
  window?.webContents.send('iss:project', {
    root: dir,
    recents: settings.recents,
    editor: editor?.label ?? null,
  });
}

async function promptForProject(): Promise<void> {
  if (!window) return;
  const result = await dialog.showOpenDialog(window, {
    title: 'Open design project',
    properties: ['openDirectory'],
    buttonLabel: 'Open project',
  });
  if (result.canceled || result.filePaths.length === 0) return;
  openProject(result.filePaths[0]);
}

function closeProject(): void {
  session?.dispose();
  session = null;
  setTitle();
  buildMenu();
  window?.webContents.send('iss:project', {
    root: null,
    recents: settings.recents,
    editor: editor?.label ?? null,
  });
}

// ---- menu -------------------------------------------------------------------

function buildMenu(): void {
  const hasProject = session !== null;
  const recents = settings.recents.filter((r) => fs.existsSync(r));

  const template: Electron.MenuItemConstructorOptions[] = [
    ...(process.platform === 'darwin'
      ? [{ role: 'appMenu' as const }]
      : []),
    {
      label: 'File',
      submenu: [
        { label: 'Open Project…', accelerator: 'CmdOrCtrl+O', click: () => void promptForProject() },
        {
          label: 'Open Recent',
          enabled: recents.length > 0,
          submenu: recents.length
            ? recents.map((r) => ({ label: r, click: () => openProject(r) }))
            : [{ label: 'No recent projects', enabled: false }],
        },
        { type: 'separator' },
        { label: 'Close Project', enabled: hasProject, click: closeProject },
        { type: 'separator' },
        process.platform === 'darwin' ? { role: 'close' as const } : { role: 'quit' as const },
      ],
    },
    {
      label: 'Design',
      submenu: [
        {
          label: 'Run',
          accelerator: 'CmdOrCtrl+R',
          enabled: hasProject,
          click: () => void session?.simulate(),
        },
        {
          label: 'Verify',
          accelerator: 'CmdOrCtrl+Shift+R',
          enabled: hasProject,
          click: () => void session?.verify(),
        },
        { type: 'separator' },
        {
          label: editor ? `Open Project in ${editor.label}` : 'Open Project in Editor…',
          accelerator: 'CmdOrCtrl+Shift+E',
          enabled: hasProject && editor !== null,
          click: () => {
            if (session && editor) openFolderInEditor(editor, session.projectRoot);
          },
        },
        {
          label: 'Reveal Project in File Manager',
          enabled: hasProject,
          click: () => session && shell.showItemInFolder(session.projectRoot),
        },
      ],
    },
    {
      label: 'View',
      submenu: [
        { role: 'reload' },
        { role: 'toggleDevTools' },
        { type: 'separator' },
        { role: 'resetZoom' },
        { role: 'zoomIn' },
        { role: 'zoomOut' },
        { type: 'separator' },
        { role: 'togglefullscreen' },
      ],
    },
  ];

  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

// ---- lifecycle --------------------------------------------------------------

void app.whenReady().then(() => {
  settings = loadSettings();
  // Probed once: spawning `which` on every double-click would be wasteful, and
  // an editor appearing mid-session is not a case worth complicating this for.
  editor = detectEditor();
  buildMenu();
  createWindow();

  // The renderer speaks the same ViewMsg the webview always has.
  ipcMain.on('iss:view', (_e, msg: ViewMsg) => {
    if (!session) return;
    void session.handle(msg);
  });

  // Renderer-only requests that have no place in the design protocol.
  ipcMain.handle('iss:openProject', () => promptForProject());
  ipcMain.handle('iss:openRecent', (_e, dir: string) => openProject(dir));
  ipcMain.handle('iss:state', () => ({
    root: session?.projectRoot ?? null,
    recents: settings.recents,
    editor: editor?.label ?? null,
  }));

  // A window reload lands on a live session — re-send everything.
  ipcMain.on('iss:rendererReady', () => session?.refresh());

  // The integrated shell, rooted at the open project.
  ipcMain.on('iss:term', (_e, data: string) => {
    if (!session) return;
    if (!terminal) {
      terminal = new Terminal(session.projectRoot, {
        onData: (chunk) => window?.webContents.send('iss:termData', chunk),
        onExit: (code) =>
          window?.webContents.send('iss:termData', `\n[shell exited ${code ?? 0}]\n`),
      });
      terminal.start();
    }
    if (data) terminal.write(data);
  });

  // Window controls, since the ribbon replaces the OS title bar.
  ipcMain.on('iss:window', (_e, action: 'minimize' | 'maximize' | 'close') => {
    if (!window) return;
    if (action === 'minimize') window.minimize();
    else if (action === 'close') window.close();
    else if (window.isMaximized()) window.unmaximize();
    else window.maximize();
  });

  // Menu actions the ribbon's own menu bar dispatches.
  ipcMain.on('iss:menu', (_e, action: string) => {
    switch (action) {
      case 'openProject': void promptForProject(); break;
      case 'closeProject': closeProject(); break;
      case 'run': void session?.simulate(); break;
      case 'verify': void session?.verify(); break;
      case 'openInEditor':
        if (session && editor) openFolderInEditor(editor, session.projectRoot);
        break;
      case 'revealInFiles':
        if (session) shell.showItemInFolder(session.projectRoot);
        break;
      case 'reload': window?.webContents.reload(); break;
      case 'devtools': window?.webContents.toggleDevTools(); break;
      case 'quit': app.quit(); break;
    }
  });

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });

  // `iss <dir>` opens straight into a project. Relative paths resolve against
  // the shell's cwd, which is what someone typing a path expects; a path that
  // is not there is said out loud rather than dropping silently to the welcome
  // screen, which would read as the app ignoring the argument.
  const fromArgv = process.argv.slice(IS_DEV ? 2 : 1).find((a) => !a.startsWith('-'));
  if (fromArgv) {
    const dir = path.resolve(process.cwd(), fromArgv);
    window?.webContents.once('did-finish-load', () => {
      if (fs.existsSync(dir)) openProject(dir);
      else send({ type: 'editError', message: `no such directory: ${dir}` });
    });
  }
});

app.on('window-all-closed', () => {
  terminal?.dispose();
  session?.dispose();
  session = null;
  if (process.platform !== 'darwin') app.quit();
});
