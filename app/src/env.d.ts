// The renderer's view of the preload bridge.
//
// Typed off the preload's own export, so the two halves cannot drift: adding a
// method there without exposing it, or calling one here that was never bridged,
// is a compile error rather than an undefined at runtime.

import type { IssApi } from '../electron/preload';

declare global {
  interface Window {
    iss: IssApi;
  }
}

export {};
