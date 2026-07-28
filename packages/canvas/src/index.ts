// @iss/canvas — the schematic, and nothing that knows where it is running.
//
// Two ways to consume it:
//
//   <CanvasApp transport={…} />   the IDE shell — rails and a dock, the
//                                 arrangement that belongs inside VS Code.
//
//   useDesignSession() + the      compose your own shell. The desktop app does
//   pieces below                  this to put the bench full-bleed and summon
//                                 tools on demand instead of parking them.
//
// Both paths share every line of behaviour, because behaviour lives in the
// session hook rather than in either shell.

export { App, CanvasApp } from './app';
export { useDesignSession } from './useDesignSession';
export type { Authored, UndoEntry, DesignSession } from './useDesignSession';

// The pieces a custom shell arranges.
export { Canvas, type Selection } from './canvas';
export { Palette } from './palette';
export { TEMPLATES, type BlockTemplate } from './templates';
export { Inspector } from './inspector';
export { EventsView } from './events-view';
export { SpecDesigner } from './spec-designer';
export { BottomPanel } from './bottom-panel';
export { RunConfigPanel } from './run-config';
export { ActivityBar, StatusBar, TabBar, type EditorTab } from './shell';

export {
  NULL_TRANSPORT,
  TransportProvider,
  useTransport,
  windowMessageTransport,
  type HostTransport,
} from './transport';
