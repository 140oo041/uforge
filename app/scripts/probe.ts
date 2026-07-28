// Throwaway diagnostic: open the library and report what the browser actually
// computed for it. Faster and more reliable than reasoning about stacking from
// a screenshot.

import * as path from 'path';
import { BrowserWindow, app, ipcMain } from 'electron';

import type { HostMsg, ViewMsg } from '@iss/contracts/messaging';

import { Session } from '../electron/session';

const projectRoot = process.argv.slice(2).filter((a) => !a.startsWith('-'))[0];
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

void app.whenReady().then(async () => {
  let session: Session | null = null;
  let state = { root: null as string | null, recents: [] as string[] };

  const win = new BrowserWindow({
    width: 1600,
    height: 1000,
    show: false,
    webPreferences: {
      preload: path.join(__dirname, '..', 'electron', 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });
  const send = (m: HostMsg) => win.webContents.send('iss:host', m);

  ipcMain.handle('iss:state', () => state);
  ipcMain.handle('iss:openProject', () => {});
  ipcMain.handle('iss:openRecent', () => {});
  ipcMain.on('iss:rendererReady', () => session?.refresh());
  ipcMain.on('iss:view', (_e, m: ViewMsg) => void session?.handle(m));

  await win.loadFile(path.join(__dirname, '..', 'renderer', 'index.html'));
  session = new Session({
    projectRoot,
    enginePath: '',
    xverifyPath: '',
    sailCommitrecPath: '',
    refModel: 'stub',
    post: send,
    openSource: () => {},
  });
  state = { root: projectRoot, recents: [] };
  win.webContents.send('iss:project', state);
  await wait(1500);

  await win.webContents.executeJavaScript(
    `window.dispatchEvent(new KeyboardEvent('keydown',{key:'k',ctrlKey:true,bubbles:true}))`,
  );
  await wait(600);

  const report = await win.webContents.executeJavaScript(`(() => {
    const scrim = document.querySelector('.lib-scrim');
    const lib = document.querySelector('.lib');
    if (!scrim || !lib) return { found: false };
    const cs = getComputedStyle(scrim), cl = getComputedStyle(lib);
    const r = lib.getBoundingClientRect();
    // What actually paints at the centre of the panel?
    const hit = document.elementFromPoint(r.left + r.width/2, r.top + 40);
    return {
      found: true,
      scrim: { position: cs.position, zIndex: cs.zIndex, opacity: cs.opacity, bg: cs.backgroundColor },
      lib:   { opacity: cl.opacity, bg: cl.backgroundColor, filter: cl.filter, mixBlend: cl.mixBlendMode },
      topElementAtPanel: hit ? hit.className + '|' + hit.tagName : null,
      libRect: { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width) },
    };
  })()`);

  console.log(JSON.stringify(report, null, 2));
  app.quit();
});
