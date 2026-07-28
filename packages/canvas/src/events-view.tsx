// THE EVENTS VIEW — the design's message vocabulary, as a place rather than a
// side effect.
//
// Until now an event could only be born by drawing a wire and typing a name
// into the connect form, and could only be inspected by chasing a link to the
// generated header. That made the vocabulary invisible: you could not answer
// "what messages exist, what do they carry, and who moves them" without
// reading C++. Now that a packet's width is what a router charges its
// bandwidth budget, that question has a performance answer too, so the
// vocabulary has to be somewhere you can look at and edit.
//
// Editing is honest about what the model allows: an event in use cannot be
// deleted (the reducer refuses, and so does the button, with the users named),
// and hand-written events are read-only because their header is not ours to
// rewrite.

import { useState } from 'react';

import { eventBits, formatBits } from '@iss/contracts/bits';
import type { Graph, GraphEvent } from '@iss/contracts/graph';
import type { AuthoredField, EditIntent } from '@iss/contracts/model';
import { availableTypes, type SpecDocument } from '@iss/contracts/spec';

import type { Authored, UndoEntry } from './useDesignSession';

const IDENT = /^[A-Za-z_][A-Za-z0-9_]*$/;

interface Props {
  graph: Graph;
  authored: Authored;
  spec: SpecDocument | null;
  onEdit(intent: EditIntent, undo?: UndoEntry): void;
  /** Open the event's declaration in the host's editor. */
  onReveal(id: string): void;
  /** Select the component that emits or consumes it, on the canvas. */
  onPickComponent(id: string): void;
}

/** Who sends and who receives one message — the answer the C++ hides. */
function usersOf(graph: Graph, id: string) {
  const emits = graph.components.filter((c) => c.outPorts.some((p) => p.message === id));
  const consumes = graph.components.filter((c) => c.consumes.includes(id));
  const rules = graph.components.filter((c) => (c.rules ?? []).some((r) => r.message === id));
  return { emits, consumes, rules };
}

function toFields(event: GraphEvent): AuthoredField[] {
  return event.fields.map((f) => {
    const idx = f.indexOf(':');
    return { name: f.slice(0, idx), type: f.slice(idx + 1) };
  });
}

export function EventsView(props: Props) {
  const { graph, authored, spec, onEdit, onReveal, onPickComponent } = props;
  const [open, setOpen] = useState<string | null>(null);
  const [name, setName] = useState('');
  const [filter, setFilter] = useState('');

  const events = [...graph.events]
    .filter((e) => e.id.toLowerCase().includes(filter.trim().toLowerCase()))
    .sort((a, b) => a.id.localeCompare(b.id));

  const taken = (id: string) =>
    graph.events.some((e) => e.id === id) || graph.components.some((c) => c.id === id);
  const canAdd = IDENT.test(name) && !taken(name);

  const add = () => {
    if (!canAdd) return;
    onEdit(
      { kind: 'addEvent', id: name, fields: [] },
      {
        undo: () => onEdit({ kind: 'removeEvent', id: name }),
        redo: () => onEdit({ kind: 'addEvent', id: name, fields: [] }),
      },
    );
    setOpen(name);
    setName('');
  };

  return (
    <div className="events-view">
      <div className="ev-add">
        <input
          className="ev-filter"
          placeholder="Filter messages"
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
        />
      </div>
      <div className="ev-list">
        {events.length === 0 && (
          <p className="ev-empty">
            {graph.events.length === 0
              ? 'No messages yet. Add one below, or draw a wire and name the message it carries.'
              : 'No message matches that filter.'}
          </p>
        )}
        {events.map((event) => {
          const editable = authored.events.has(event.id);
          const { emits, consumes, rules } = usersOf(graph, event.id);
          const users = [...emits, ...consumes, ...rules];
          const bits = event.bits ?? eventBits({ fields: event.fields });
          const isOpen = open === event.id;
          return (
            <div key={event.id} className={`ev-row${isOpen ? ' on' : ''}`}>
              <div className="ev-head">
                <button
                  className="ev-twist"
                  title={isOpen ? 'Collapse' : 'Expand'}
                  onClick={() => setOpen(isOpen ? null : event.id)}
                >
                  {isOpen ? '▾' : '▸'}
                </button>
                <span className="ev-name" title={event.id} onClick={() => setOpen(isOpen ? null : event.id)}>
                  {event.id}
                </span>
                <span
                  className="ev-bits"
                  title={
                    event.bitsOverridden
                      ? `${bits} bits — authored override, not derived from the fields`
                      : `${bits} bits — the sum of this message's field widths. Routers charge this against their bandwidth.`
                  }
                >
                  {formatBits(bits)}
                  {event.bitsOverridden && <b title="authored override">*</b>}
                </span>
                <span className="ev-use" title={`${emits.length} emit · ${consumes.length} consume`}>
                  {emits.length}↑ {consumes.length}↓
                </span>
                {!editable && (
                  <span className="badge badge-hand" title="declared in a hand-written header">
                    hand
                  </span>
                )}
                <button className="ev-icon" title="Open declaration" onClick={() => onReveal(event.id)}>
                  ⧉
                </button>
                <button
                  className="ev-icon danger"
                  disabled={!editable || users.length > 0}
                  title={
                    !editable
                      ? 'hand-written events are not ours to delete'
                      : users.length > 0
                        ? `in use by ${users.map((c) => c.id).join(', ')} — disconnect first`
                        : `delete ${event.id}`
                  }
                  onClick={() => {
                    const fields = toFields(event);
                    onEdit(
                      { kind: 'removeEvent', id: event.id },
                      {
                        undo: () => onEdit({ kind: 'addEvent', id: event.id, fields }),
                        redo: () => onEdit({ kind: 'removeEvent', id: event.id }),
                      },
                    );
                  }}
                >
                  🗑
                </button>
              </div>
              {isOpen && (
                <EventDetail
                  event={event}
                  editable={editable}
                  spec={spec}
                  emits={emits.map((c) => c.id)}
                  consumes={consumes.map((c) => c.id)}
                  onEdit={onEdit}
                  onPickComponent={onPickComponent}
                />
              )}
            </div>
          );
        })}
      </div>
      <div className="ev-add ev-new">
        <input
          placeholder="New message (e.g. FillEvent)"
          value={name}
          title="a C++ class name — must not collide with a block or an existing message"
          onChange={(e) => setName(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && add()}
        />
        <button
          disabled={!canAdd}
          title={
            name === ''
              ? 'name the message first'
              : !IDENT.test(name)
                ? 'not a valid C++ identifier'
                : taken(name)
                  ? `'${name}' already exists`
                  : `add ${name}`
          }
          onClick={add}
        >
          ＋
        </button>
      </div>
    </div>
  );
}

/** The payload editor, plus the width the payload implies. */
function EventDetail(props: {
  event: GraphEvent;
  editable: boolean;
  spec: SpecDocument | null;
  emits: string[];
  consumes: string[];
  onEdit(intent: EditIntent, undo?: UndoEntry): void;
  onPickComponent(id: string): void;
}) {
  const { event, editable, spec, emits, consumes, onEdit, onPickComponent } = props;
  const [fieldName, setFieldName] = useState('');
  const [fieldType, setFieldType] = useState('uint32_t');
  const fields = toFields(event);
  const derived = eventBits({ fields }, spec);

  const commit = (next: AuthoredField[]) => {
    onEdit(
      { kind: 'editEventFields', id: event.id, fields: next },
      {
        undo: () => onEdit({ kind: 'editEventFields', id: event.id, fields }),
        redo: () => onEdit({ kind: 'editEventFields', id: event.id, fields: next }),
      },
    );
  };

  const addField = () => {
    if (!IDENT.test(fieldName) || fields.some((f) => f.name === fieldName)) return;
    commit([...fields, { name: fieldName, type: fieldType.trim() || 'uint32_t' }]);
    setFieldName('');
  };

  return (
    <div className="ev-detail">
      {fields.length === 0 && <p className="ev-empty">no payload — carries only its type</p>}
      {fields.map((f) => (
        <div key={f.name} className="ev-field">
          <span className="ins-var">{f.name}</span>
          <span className="ins-vartype">{f.type}</span>
          <span className="ev-fieldbits">{formatBits(eventBits({ fields: [f] }, spec))}</span>
          {editable && (
            <button
              className="ev-icon danger"
              title={`remove ${f.name}`}
              onClick={() => commit(fields.filter((x) => x.name !== f.name))}
            >
              ✕
            </button>
          )}
        </div>
      ))}
      {editable && (
        <div className="ev-add">
          <input
            placeholder="field"
            value={fieldName}
            onChange={(e) => setFieldName(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && addField()}
          />
          <input
            className="ins-typein"
            placeholder="type"
            value={fieldType}
            list="iss2-event-types"
            onChange={(e) => setFieldType(e.target.value)}
          />
          <datalist id="iss2-event-types">
            {availableTypes(spec).map((t) => (
              <option key={t} value={t} />
            ))}
          </datalist>
          <button disabled={!IDENT.test(fieldName)} onClick={addField}>
            ＋
          </button>
        </div>
      )}

      <div className="ev-width">
        <span
          className="ev-k"
          title="What this packet costs a router: bandwidth is metered in bits, so a wide message occupies its output port for more cycles than a narrow one."
        >
          width
        </span>
        <input
          key={`${event.id}:${event.bits ?? 'derived'}`}
          type="number"
          min={1}
          className="ev-bitsin"
          placeholder={String(derived)}
          defaultValue={event.bitsOverridden ? (event.bits ?? derived) : ''}
          disabled={!editable}
          title={`empty = derived from the fields (${derived} bits); a number overrides it`}
          onBlur={(e) => {
            const raw = e.target.value.trim();
            const previous = event.bitsOverridden ? (event.bits ?? null) : null;
            const next = raw === '' ? null : Math.max(1, Math.floor(Number(raw) || 1));
            if (next === previous) return;
            onEdit(
              { kind: 'setEventBits', id: event.id, bits: next },
              {
                undo: () => onEdit({ kind: 'setEventBits', id: event.id, bits: previous }),
                redo: () => onEdit({ kind: 'setEventBits', id: event.id, bits: next }),
              },
            );
          }}
        />
        <span className="ev-unit">bits {event.bitsOverridden ? '(override)' : `(derived)`}</span>
      </div>

      <div className="ev-users">
        <span className="ev-k">emitted by</span>
        <span>
          {emits.length === 0 ? (
            <i className="ev-none">nobody</i>
          ) : (
            emits.map((id, i) => (
              <span key={id}>
                {i > 0 && ', '}
                <a className="message-link" onClick={() => onPickComponent(id)}>
                  {id}
                </a>
              </span>
            ))
          )}
        </span>
      </div>
      <div className="ev-users">
        <span className="ev-k">consumed by</span>
        <span>
          {consumes.length === 0 ? (
            <i className="ev-none">nobody</i>
          ) : (
            consumes.map((id, i) => (
              <span key={id}>
                {i > 0 && ', '}
                <a className="message-link" onClick={() => onPickComponent(id)}>
                  {id}
                </a>
              </span>
            ))
          )}
        </span>
      </div>
    </div>
  );
}
