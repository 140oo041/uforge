// The renderer: a theme, a transport, and one decision — is a project open?
//
// @iss/canvas is consumed unmodified; the desktop app supplies the two things
// VS Code used to supply (a palette, and a way to talk to a host) and then
// arranges the pieces its own way — see bench.tsx.

// STYLESHEET ORDER IS LOAD-BEARING, and must stay above the component imports:
// a component's own `import './x.css'` is emitted where the component is
// imported, so pulling Bench in first would place bench.css *before* the canvas
// stylesheet and let canvas rules win over the shell's.
//
// A skin overrides the layer below by BOTH specificity and order, so every
// stylesheet is imported here, in one place, in the order the cascade needs.
// Component files deliberately do not import their own CSS: doing so emits it
// wherever the component happens to be imported, which silently put bench.css
// after glass.css and let the record skin win ties inside the glass one.
import './theme.css';           // record-skin tokens
import '@iss/canvas/styles.css'; // the schematic's own structure
import './bench.css';            // the shell's structure
import './welcome.css';          // the no-project surface
import './provenance.css';       // record skin
import './glass.css';            // ─┐
import './blueprint.css';        //  │ the other skins — each scoped to
import './terminal.css';         //  │ [data-skin='…'], order among them
import './floorplan.css';
import './paperlite.css';        // ─┘ is irrelevant

import { useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';

import type { HostTransport } from '@iss/canvas';
import type { HostMsg } from '@iss/contracts/messaging';

import { Bench } from './bench';
import { initSkin } from './skin';
import { Welcome, type ProjectState } from './welcome';

/**
 * The Electron half of the transport. Same contract the VS Code webview
 * satisfies — the canvas cannot tell which one it got.
 */
const transport: HostTransport = {
  post: (msg) => window.iss.post(msg),
  subscribe: (listener: (msg: HostMsg) => void) => window.iss.onHostMessage(listener),
};

function Root() {
  const [project, setProject] = useState<ProjectState | null>(null);

  useEffect(() => {
    // A window reload lands on a live session, so ask what is open rather than
    // assuming nothing is.
    void window.iss.state().then(setProject);
    const off = window.iss.onProjectChange(setProject);
    window.iss.ready();
    return off;
  }, []);

  // Hold the first paint until the answer arrives. One frame of the welcome
  // screen flashing before a project loads would read as a failed open.
  if (project === null) return <div className="boot" />;

  // Remounting on project change is deliberate: a new project is a new design,
  // and carrying the previous one's selection, drill path, playhead or undo
  // stack into it would be exactly the kind of stale view this product exists
  // to not have.
  // The bench, not the IDE shell: standing alone there is no editor to belong
  // to, so the design gets the window. See bench.tsx.
  return project.root ? <Bench key={project.root} transport={transport} /> : <Welcome />;
}

// Set the skin attribute before the first paint, so the window never flashes
// one cosmetic mode on its way to the other.
initSkin();

const root = document.getElementById('root')!;
createRoot(root).render(<Root />);
