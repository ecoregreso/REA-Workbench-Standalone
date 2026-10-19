import React, { useEffect, useState } from 'react';
import type { ReaTool } from '../shared/types';
import { resolveSchema } from './result-model';

export function ToolForm({ tool, seed, disabled, onRun, onChooseInput }: { tool: ReaTool; seed: Record<string, any>; disabled: boolean; onRun: (tool: ReaTool, args: Record<string, any>) => Promise<unknown>; onChooseInput?: (key: string, kind: 'file' | 'directory') => Promise<string | null> }) {
  const [values, setValues] = useState<Record<string, any>>(seed);
  const [error, setError] = useState('');
  const [mode, setMode] = useState<'fields' | 'json'>('fields');
  const [json, setJson] = useState(JSON.stringify(seed, null, 2));
  const seedKey = JSON.stringify(seed);
  useEffect(() => { setValues(seed); setJson(JSON.stringify(seed, null, 2)); setError(''); }, [tool.name, seedKey]);
  const rootSchema = resolveSchema(tool.inputSchema, tool.inputSchema);
  const properties: Record<string, any> = Object.fromEntries(Object.entries(rootSchema.properties || {}).map(([key, schema]) => [key, resolveSchema(schema, tool.inputSchema)]));
  const required: string[] = rootSchema.required || [];
  function update(key: string, value: any) { setValues(previous => ({ ...previous, [key]: value })); }
  async function submit(event: React.FormEvent) {
    event.preventDefault(); setError('');
    try {
      const args = mode === 'json' ? JSON.parse(json) : Object.fromEntries(Object.entries(values).filter(([, value]) => value !== '' && value !== undefined).map(([key, value]) => {
        const schema = properties[key];
        if ((['object', 'array'].includes(schema?.type) || (!schema?.type && (schema?.oneOf || schema?.anyOf || schema?.properties))) && typeof value === 'string') return [key, JSON.parse(value)];
        if (['integer','number'].includes(schema?.type)) { const number = Number(value); if (!Number.isFinite(number)) throw new Error(`${key} must be a number.`); return [key, number]; }
        return [key, value];
      }));
      if (!args || Array.isArray(args) || typeof args !== 'object') throw new Error('Arguments must be a JSON object.');
      const missing = required.filter(key => args[key] === undefined || args[key] === '');
      if (missing.length) throw new Error(`Required: ${missing.join(', ')}.`);
      await onRun(tool, args);
    } catch (issue) { setError(issue instanceof Error ? issue.message : String(issue)); }
  }
  return <form className="rea-tool-form" onSubmit={submit}>
    <div className="rea-tool-intro"><code>{tool.name}</code><p>{tool.description || 'This tool is advertised by the connected engine.'}</p></div>
    {tool.available === false && <p className="rea-inline-error">{tool.reason || 'The engine reports this tool is unavailable.'}</p>}
    <div className="rea-form-modes" role="group" aria-label="Argument editor"><button type="button" className={mode === 'fields' ? 'active' : ''} onClick={() => setMode('fields')}>Fields</button><button type="button" className={mode === 'json' ? 'active' : ''} onClick={() => { setJson(JSON.stringify(values, null, 2)); setMode('json'); }}>JSON</button></div>
    {mode === 'json' ? <label className="rea-field">Arguments<textarea className="rea-json-input" spellCheck={false} value={json} onChange={event => setJson(event.target.value)} rows={12} /></label> : Object.entries(properties).map(([key, raw]) => {
      const schema = raw as any;
      const isRequired = required.includes(key);
      const value = values[key] ?? '';
      const display = typeof value === 'object' ? JSON.stringify(value, null, 2) : value;
      const structured = ['object','array'].includes(schema.type) || (!schema.type && (schema.oneOf || schema.anyOf || schema.properties));
      const label = <span>{key}{isRequired && <span className="rea-required"> *</span>}</span>;
      return <label className="rea-field" key={key}>{label}
        {schema.enum ? <select value={String(value)} onChange={event => update(key, schema.enum.find((option: any) => String(option) === event.target.value) ?? event.target.value)}><option value="">Select a value</option>{schema.enum.map((option: any) => <option key={String(option)} value={String(option)}>{String(option)}</option>)}</select> : schema.type === 'boolean' ? <select value={value === '' ? '' : String(value)} onChange={event => update(key, event.target.value === '' ? undefined : event.target.value === 'true')}><option value="">Engine default</option><option value="true">True</option><option value="false">False</option></select> : structured ? <textarea spellCheck={false} rows={4} value={display} onChange={event => update(key, event.target.value)} placeholder={`${schema.type || 'Structured value'} as JSON`} /> : <input type={['number','integer'].includes(schema.type) ? 'number' : 'text'} step={schema.type === 'integer' ? '1' : 'any'} min={schema.minimum} max={schema.maximum} value={display} onChange={event => update(key, event.target.value)} placeholder={schema.description || schema.type || 'Value'} />}
        {onChooseInput && /^(?:path|input_path|reference_path|left_path|right_path|binary_path|core_path|manifest_path|capture_path|snapshot_path|application_path|executable_path|working_directory|local_path|apk_path|application_root|left_module_path|right_module_path|left_bundle_path|right_bundle_path|executable)$/.test(key) && !(key === 'path' && tool.name === 'export_evidence_bundle') && !(key === 'snapshot_path' && tool.name === 'close_binary') && <span className="rea-path-actions"><button type="button" disabled={disabled} onClick={async () => { try { const path = await onChooseInput(key, 'file'); if (path) update(key, path); } catch (issue) { setError(String(issue)); } }}>Choose file</button><button type="button" disabled={disabled} onClick={async () => { try { const path = await onChooseInput(key, 'directory'); if (path) update(key, path); } catch (issue) { setError(String(issue)); } }}>Choose folder</button></span>}
        {schema.description && <small>{schema.description}</small>}
      </label>;
    })}
    {mode === 'fields' && !Object.keys(properties).length && <p className="rea-muted">This tool has no advertised fields. Use JSON for complex or open schemas.</p>}
    {error && <p role="alert" className="rea-inline-error">{error}</p>}
    <button className="rea-primary rea-full" disabled={disabled || tool.available === false} type="submit">Run tool <span aria-hidden="true">↗</span></button>
    <details className="rea-schema"><summary>Advertised input schema</summary><pre role="region" aria-label="Advertised input schema" tabIndex={0}>{JSON.stringify(tool.inputSchema, null, 2)}</pre></details>
  </form>;
}
