// Block library: drag a template onto the canvas (or double-click to drop it
// at a default spot). Templates are id prefixes — the app assigns Stage1,
// Stage2, … automatically. The "custom" form creates a block with an exact
// name of your choosing.

import { useState } from 'react';

import type { ComponentKind, IoDirection } from '@iss/contracts/model';
import { TEMPLATES } from './templates';


export function Palette(props: {
  onAdd(
    prefix: string,
    x: number,
    y: number,
    kind?: ComponentKind,
    io?: IoDirection,
    role?: 'trafficgen',
  ): void;
  onAddNamed(id: string, kind: ComponentKind): void;
}) {
  const [name, setName] = useState('');
  const [kind, setKind] = useState<ComponentKind>('leaf');
  const valid = /^[A-Za-z_][A-Za-z0-9_]*$/.test(name);

  const addNamed = () => {
    if (!valid) return;
    props.onAddNamed(name, kind);
    setName('');
  };

  return (
    <div className="palette">
      <h3>Library</h3>
      {TEMPLATES.map((t) => (
        <div
          key={t.prefix}
          className="palette-item"
          draggable
          onDragStart={(e) => {
            e.dataTransfer.setData('application/x-iss-block', t.prefix);
            e.dataTransfer.setData('application/x-iss-kind', t.kind);
            if (t.io) e.dataTransfer.setData('application/x-iss-io', t.io);
            if (t.role) e.dataTransfer.setData('application/x-iss-role', t.role);
            e.dataTransfer.effectAllowed = 'copy';
          }}
          onDoubleClick={() =>
            props.onAdd(
              t.prefix,
              80 + Math.random() * 120,
              80 + Math.random() * 120,
              t.kind,
              t.io,
              t.role,
            )
          }
          title={`${t.hint} — drag onto the canvas`}
        >
          <span className="palette-glyph">{t.glyph}</span>
          <span>
            <strong>{t.label}</strong>
            <small>{t.hint}</small>
          </span>
        </div>
      ))}
      <div className="palette-custom">
        <input
          placeholder="custom block name…"
          value={name}
          onChange={(e) => setName(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && addNamed()}
        />
        <select
          value={kind}
          onChange={(e) => setKind(e.target.value as ComponentKind)}
          title="leaf block or composite container"
        >
          <option value="leaf">leaf</option>
          <option value="composite">composite</option>
        </select>
        <button disabled={!valid} onClick={addNamed} title="Add a block with this exact class name">
          ＋
        </button>
      </div>
      <p className="palette-help">
        Drag a block in, then drag from its <b>＋</b> handle to another block to wire them. The C++
        is generated as you go — double-click a leaf to open its source, a composite to drill in
        (Escape drills out). Right-drag pans the canvas.
      </p>
    </div>
  );
}
