// Screenshot harness: boots the real renderer against a real project and
// writes PNGs, so the desktop surface can be inspected without a human at the
// window. Used during development and by the design review; not shipped.
//
//   npx electron dist/scripts/shoot.cjs <outDir> [projectRoot]

import * as path from 'path';
import * as fs from 'fs';
import { BrowserWindow, app, ipcMain } from 'electron';

import type { HostMsg, ViewMsg } from '@iss/contracts/messaging';

import { detectEditor } from '@iss/host';

import { Session } from '../electron/session';

const [outDir, projectRoot] = process.argv.slice(2).filter((a) => !a.startsWith('-'));

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function shoot(win: BrowserWindow, name: string): Promise<void> {
  const image = await win.capturePage();
  fs.mkdirSync(outDir, { recursive: true });
  fs.writeFileSync(path.join(outDir, `${name}.png`), image.toPNG());
  console.log(`wrote ${name}.png`);
}

void app.whenReady().then(async () => {
  let session: Session | null = null;
  let state: { root: string | null; recents: string[]; editor: string | null } = {
    editor: detectEditor()?.label ?? null,
    root: null,
    recents: ['/home/aarush/ISS/micro_arch_ide2/sample', '/home/aarush/ISS/micro_arch_ide2/robot_soc'],
  };

  const win = new BrowserWindow({
    width: 1600,
    height: 1000,
    show: false,
    backgroundColor: '#1e1e1e',
    webPreferences: {
      preload: path.join(__dirname, '..', 'electron', 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });

  const send = (msg: HostMsg) => win.webContents.send('iss:host', msg);

  ipcMain.handle('iss:state', () => state);
  ipcMain.handle('iss:openProject', () => {});
  ipcMain.handle('iss:openRecent', () => {});
  ipcMain.on('iss:rendererReady', () => session?.refresh());
  ipcMain.on('iss:view', (_e, msg: ViewMsg) => void session?.handle(msg));

  const skin = (process.argv.find((a) => a.startsWith('--skin=')) ?? '').slice('--skin='.length);
  await win.loadFile(path.join(__dirname, '..', 'renderer', 'index.html'));
  if (skin)
    await win.webContents.executeJavaScript(
      `localStorage.setItem('iss.skin', ${JSON.stringify(skin)}); document.documentElement.setAttribute('data-skin', ${JSON.stringify(skin)});`,
    );
  // The window must actually be on screen: Chromium suspends CSS animations and
  // rAF in a hidden window, so a screenshot taken without showing it captures
  // entrance animations frozen at their first frame — which is a lie about what
  // the user sees.
  win.showInactive();
  await wait(1200);
  await shoot(win, 'welcome');

  if (projectRoot) {
    session = new Session({
      projectRoot,
      enginePath: path.resolve(__dirname, '..', '..', '..', 'engine'),
      xverifyPath: '',
      sailCommitrecPath: '',
      refModel: 'stub',
      post: send,
      openSource: () => {},
    });
    state = { ...state, root: projectRoot };
    win.webContents.send('iss:project', state);
    await wait(1800);
    await shoot(win, 'canvas');

    // The inspector is summoned by selection, so a screenshot has to select.
    const target = process.argv.find((a) => a.startsWith('--select='));
    if (target) {
      send({ type: 'selection', id: target.slice('--select='.length) });
      await wait(700);
      await shoot(win, 'inspector');
    }

    // The Messages tab: the design's packet vocabulary, with widths.
    const openedEvents = await win.webContents.executeJavaScript(`
      (() => {
        const tab = [...document.querySelectorAll('.pane-list .seg button')]
          .find((b) => b.textContent.trim().startsWith('Messages'));
        if (!tab) return false;
        tab.click();
        return true;
      })()
    `);
    if (openedEvents) {
      await wait(400);
      await win.webContents.executeJavaScript(
        `(() => { const t = document.querySelector('.ev-twist'); if (t) t.click(); })()`,
      );
      await wait(400);
      await shoot(win, 'messages');
    }

    // Pane order is read from localStorage at mount, so proving a moved pane
    // takes a reload — which is also the proof that the order survives one.
    const orderArg = process.argv.find((a) => a.startsWith('--pane-order='));
    if (orderArg) {
      const order = orderArg.slice('--pane-order='.length).split(',');
      await win.webContents.executeJavaScript(
        `localStorage.setItem('iss.paneOrder', ${JSON.stringify(JSON.stringify(order))})`,
      );
      win.webContents.reload();
      await wait(1500);
      win.webContents.send('iss:project', state);
      await wait(1500);
      if (target) {
        send({ type: 'selection', id: target.slice('--select='.length) });
        await wait(700);
      }
      await shoot(win, 'reordered');
    }

    // …and the library by ⌘K.
    await win.webContents.executeJavaScript(
      `window.dispatchEvent(new KeyboardEvent('keydown',{key:'k',ctrlKey:true,bubbles:true}))`,
    );
    await wait(500);
    await shoot(win, 'library');
  }

  app.quit();
});
