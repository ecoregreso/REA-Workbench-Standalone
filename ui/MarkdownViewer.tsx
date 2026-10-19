import React, { useEffect, useMemo, useState } from 'react';

function inline(text: string): React.ReactNode[] {
  const expression = /(`[^`]+`|\*\*[^*]+\*\*|\[[^\]]+\]\([^)]*\)|\*[^*\n]+\*)/g;
  const nodes: React.ReactNode[] = [];
  let cursor = 0;
  for (const match of text.matchAll(expression)) {
    const index = match.index || 0;
    if (index > cursor) nodes.push(text.slice(cursor, index));
    const token = match[0];
    const key = `inline-${index}`;
    if (token.startsWith('`')) nodes.push(<code key={key}>{token.slice(1, -1)}</code>);
    else if (token.startsWith('**')) nodes.push(<strong key={key}>{token.slice(2, -2)}</strong>);
    else if (token.startsWith('*')) nodes.push(<em key={key}>{token.slice(1, -1)}</em>);
    else {
      const link = /^\[([^\]]+)\]\(([^)]*)\)$/.exec(token);
      // Evidence destinations stay visible text. No remote requests or shell actions.
      nodes.push(<span className="rea-report-link" key={key}>{link?.[1] === link?.[2] ? <code>{link?.[2]}</code> : <>{link?.[1]} <code>({link?.[2]})</code></>}</span>);
    }
    cursor = index + token.length;
  }
  if (cursor < text.length) nodes.push(text.slice(cursor));
  return nodes;
}

function blocks(markdown: string): React.ReactNode[] {
  const lines = markdown.replace(/\r\n?/g, '\n').split('\n');
  const output: React.ReactNode[] = [];
  const cells = (row: string) => row.trim().replace(/^\|/, '').replace(/\|$/, '').split('|').map(cell => cell.trim());
  let cursor = 0;
  while (cursor < lines.length) {
    const line = lines[cursor];
    const key = `block-${cursor}`;
    if (!line.trim()) { cursor++; continue; }
    if (/^\s*```/.test(line)) {
      const language = line.replace(/^\s*```/, '').trim();
      const code: string[] = []; cursor++;
      while (cursor < lines.length && !/^\s*```/.test(lines[cursor])) code.push(lines[cursor++]);
      if (cursor < lines.length) cursor++;
      output.push(<div className="rea-report-code" key={key}>{language && <span>{language}</span>}<pre role="region" aria-label="Report code block" tabIndex={0}><code>{code.join('\n')}</code></pre></div>); continue;
    }
    const heading = /^(#{1,6})\s+(.+)$/.exec(line);
    if (heading) {
      const tag = `h${heading[1].length}` as keyof React.JSX.IntrinsicElements;
      output.push(React.createElement(tag, { key }, inline(heading[2]))); cursor++; continue;
    }
    if (/^\s*(?:---+|\*\*\*+)\s*$/.test(line)) { output.push(<hr key={key}/>); cursor++; continue; }
    if (line.includes('|') && /^\s*\|?\s*:?-{3,}/.test(lines[cursor + 1] || '')) {
      const headers = cells(line); cursor += 2; const rows: string[][] = [];
      while (cursor < lines.length && lines[cursor].includes('|') && lines[cursor].trim()) rows.push(cells(lines[cursor++]));
      output.push(<div className="rea-report-table-wrap" key={key}><table><thead><tr>{headers.map((header, index) => <th key={index}>{inline(header)}</th>)}</tr></thead><tbody>{rows.map((row, rowIndex) => <tr key={rowIndex}>{headers.map((_, cellIndex) => <td key={cellIndex}>{inline(row[cellIndex] || '')}</td>)}</tr>)}</tbody></table></div>); continue;
    }
    if (/^\s*(?:[-*+]\s|\d+[.)]\s)/.test(line)) {
      const ordered = /^\s*\d+[.)]\s/.test(line); const items: string[] = [];
      const pattern = ordered ? /^\s*\d+[.)]\s+(.+)$/ : /^\s*[-*+]\s+(.+)$/;
      while (cursor < lines.length) { const item = pattern.exec(lines[cursor]); if (!item) break; items.push(item[1]); cursor++; }
      const content = items.map((item, index) => <li key={index}>{inline(item)}</li>);
      output.push(ordered ? <ol key={key}>{content}</ol> : <ul key={key}>{content}</ul>); continue;
    }
    if (/^>\s?/.test(line)) {
      const quotes: string[] = []; while (cursor < lines.length && /^>\s?/.test(lines[cursor])) quotes.push(lines[cursor++].replace(/^>\s?/, ''));
      output.push(<blockquote key={key}>{inline(quotes.join('\n'))}</blockquote>); continue;
    }
    const paragraph = [line]; cursor++;
    while (cursor < lines.length && lines[cursor].trim() && !/^(#{1,6}\s|\s*```|\s*[-*+]\s|\s*\d+[.)]\s|>\s?)/.test(lines[cursor])) {
      if (lines[cursor].includes('|') && /^\s*\|?\s*:?-{3,}/.test(lines[cursor + 1] || '')) break;
      paragraph.push(lines[cursor++]);
    }
    output.push(<p key={key}>{inline(paragraph.join('\n'))}</p>);
  }
  return output;
}

export function MarkdownViewer({ markdown }: { markdown: string }) {
  const [raw, setRaw] = useState(false);
  const content = useMemo(() => blocks(markdown), [markdown]);
  useEffect(() => { setRaw(false); }, [markdown]);
  return <div className="rea-markdown-viewer"><div className="rea-report-toolbar" role="group" aria-label="Dossier view"><button className={!raw ? 'active' : ''} aria-pressed={!raw} onClick={() => setRaw(false)}>Rendered report</button><button className={raw ? 'active' : ''} aria-pressed={raw} onClick={() => setRaw(true)}>Raw Markdown</button><span>Evidence links are displayed as text</span></div>{raw ? <pre className="rea-dialog-content rea-report-raw" role="region" aria-label="Raw Markdown report" tabIndex={0}>{markdown}</pre> : <article className="rea-rendered-report" aria-label="Analysis dossier" tabIndex={0}>{content}</article>}</div>;
}
