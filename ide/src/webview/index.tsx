// The extension's webview entry: mount @iss/canvas over a VS Code transport.
//
// This file is the entire VS Code-specific part of the view. Everything the
// architect actually looks at is @iss/canvas, byte-identical to what the
// desktop app renders — which is the point of the split.

import { createRoot } from 'react-dom/client';

import { CanvasApp, windowMessageTransport, type HostTransport } from '@iss/canvas';
import '@iss/canvas/styles.css';

interface VsCodeApi {
  postMessage(msg: unknown): void;
  getState(): unknown;
  setState(state: unknown): void;
}

declare function acquireVsCodeApi(): VsCodeApi;

/**
 * VS Code hands the webview a one-shot `acquireVsCodeApi()`. Outside a webview
 * (the browser preview harness) it is absent, so sends go nowhere and the
 * canvas renders as a static schematic rather than crashing on load.
 */
const api: VsCodeApi =
  typeof acquireVsCodeApi === 'function'
    ? acquireVsCodeApi()
    : { postMessage: () => {}, getState: () => undefined, setState: () => {} };

const transport: HostTransport = windowMessageTransport((msg) => api.postMessage(msg));

const root = document.getElementById('root')!;
createRoot(root).render(<CanvasApp transport={transport} />);
