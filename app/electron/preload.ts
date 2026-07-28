// The only surface the renderer can see.
//
// Narrow on purpose. The view gets exactly the design protocol it already
// speaks, plus three requests that are about the *app* rather than the design
// (open a project, open a recent one, ask what is currently open). No fs, no
// child_process, no ipcRenderer — a design's own C++ can never reach the disk
// through this.

import { contextBridge, ipcRenderer } from 'electron';

import type { HostMsg, ViewMsg } from '@iss/contracts/messaging';

export interface ProjectState {
  root: string | null;
  recents: string[];
  /** Human label of the editor source files open in, or null if none was found. */
  editor: string | null;
}

const api = {
  /** Send one message to the host — the same ViewMsg the webview posts. */
  post(msg: ViewMsg): void {
    ipcRenderer.send('iss:view', msg);
  },

  /** Subscribe to host messages. Returns an unsubscribe function. */
  onHostMessage(listener: (msg: HostMsg) => void): () => void {
    const handler = (_e: unknown, msg: HostMsg) => listener(msg);
    ipcRenderer.on('iss:host', handler);
    return () => void ipcRenderer.off('iss:host', handler);
  },

  /** Subscribe to project open/close. Returns an unsubscribe function. */
  onProjectChange(listener: (state: ProjectState) => void): () => void {
    const handler = (_e: unknown, state: ProjectState) => listener(state);
    ipcRenderer.on('iss:project', handler);
    return () => void ipcRenderer.off('iss:project', handler);
  },

  /** Native directory picker. */
  openProject(): Promise<void> {
    return ipcRenderer.invoke('iss:openProject');
  },

  openRecent(dir: string): Promise<void> {
    return ipcRenderer.invoke('iss:openRecent', dir);
  },

  /** What is open right now — asked once on load, since a reload loses state. */
  state(): Promise<ProjectState> {
    return ipcRenderer.invoke('iss:state');
  },

  /** Tell the host the view is mounted, so a reload gets the graph re-sent. */
  ready(): void {
    ipcRenderer.send('iss:rendererReady');
  },

  /** Integrated shell: send input (empty string just starts it). */
  term(data: string): void {
    ipcRenderer.send('iss:term', data);
  },

  /** Shell output. Returns an unsubscribe function. */
  onTermData(listener: (chunk: string) => void): () => void {
    const handler = (_e: unknown, chunk: string) => listener(chunk);
    ipcRenderer.on('iss:termData', handler);
    return () => void ipcRenderer.off('iss:termData', handler);
  },

  /** Window controls — the ribbon draws them, the main process performs them. */
  window(action: 'minimize' | 'maximize' | 'close'): void {
    ipcRenderer.send('iss:window', action);
  },

  /** Menu-bar actions. Named, not arbitrary — the main process switches on a
   *  closed set rather than executing anything the renderer sends. */
  menu(action: string): void {
    ipcRenderer.send('iss:menu', action);
  },
};

export type IssApi = typeof api;

contextBridge.exposeInMainWorld('iss', api);
