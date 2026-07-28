// The seam between the canvas and whatever is hosting it.
//
// The canvas never knows who it is talking to. It sends ViewMsg and receives
// HostMsg, and that is the entire contract — the same one the extension has
// always used, now named and injected instead of reaching for a global.
//
// This is what makes the canvas mountable twice: the VS Code webview supplies a
// transport over `acquireVsCodeApi()` and `window.onmessage`; the Electron
// renderer supplies one over a preload bridge. Neither leaks into this package,
// and a test can supply a third that just collects messages in an array.

import { createContext, useContext, type ReactNode } from 'react';

import type { HostMsg, ViewMsg } from '@iss/contracts/messaging';

export interface HostTransport {
  /** Send one message to the host. Fire-and-forget by design. */
  post(msg: ViewMsg): void;
  /** Receive host messages. Returns an unsubscribe function. */
  subscribe(listener: (msg: HostMsg) => void): () => void;
}

/**
 * A transport that drops everything on the floor. Used when the canvas renders
 * with no host at all (a static preview, a DOM test) — the surface stays
 * interactive and simply never hears back, which is the honest behavior.
 */
export const NULL_TRANSPORT: HostTransport = {
  post: () => {},
  subscribe: () => () => {},
};

const TransportContext = createContext<HostTransport>(NULL_TRANSPORT);

export function TransportProvider(props: { transport: HostTransport; children: ReactNode }) {
  return (
    <TransportContext.Provider value={props.transport}>{props.children}</TransportContext.Provider>
  );
}

export function useTransport(): HostTransport {
  return useContext(TransportContext);
}

/**
 * The receiving half for any host that delivers messages as `window.postMessage`
 * events — which is how VS Code webviews work, and how the browser preview
 * harness fakes them. Pair it with whatever `post` that host provides.
 */
export function windowMessageTransport(post: (msg: ViewMsg) => void): HostTransport {
  return {
    post,
    subscribe(listener) {
      const onMessage = (e: MessageEvent<HostMsg>) => listener(e.data);
      window.addEventListener('message', onMessage);
      return () => window.removeEventListener('message', onMessage);
    },
  };
}
