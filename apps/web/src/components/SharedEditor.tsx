import { useEffect, useRef, useState, useSyncExternalStore } from 'react';
import * as monaco from 'monaco-editor';
import EditorWorker from 'monaco-editor/editor/editor.worker.js?worker';
import JsonWorker from 'monaco-editor/languages/features/json/json.worker.js?worker';
import CssWorker from 'monaco-editor/languages/features/css/css.worker.js?worker';
import HtmlWorker from 'monaco-editor/languages/features/html/html.worker.js?worker';
import TsWorker from 'monaco-editor/languages/features/typescript/ts.worker.js?worker';
import { MonacoBinding } from 'y-monaco';
import Markdown from 'react-markdown';
import { LIVE_TEXT_NAME, type DraftFile, type LiveRoomId } from '@app/contracts';
import { LiveDocument } from '../live-document';
import { bindGuestAwareness } from '../session';
import { useBrowser } from '../browser-context';

self.MonacoEnvironment = { getWorker: (_id, label) => {
  if (label === 'json') return new JsonWorker();
  if (['css', 'scss', 'less'].includes(label)) return new CssWorker();
  if (['html', 'handlebars', 'razor'].includes(label)) return new HtmlWorker();
  if (['typescript', 'javascript'].includes(label)) return new TsWorker();
  return new EditorWorker();
} };

const labels = {
  connecting: 'Connecting to shared draft…', saving: 'Saving…', saved: 'Saved',
  offline: 'Offline — reconnecting. Keep this tab open to save your edits.',
  closed: 'This draft has closed. Copy your text before opening the current draft.',
  rejected: 'Changes could not be accepted. Copy your text before reloading.',
};
function language(path: string) {
  const extension = path.split('.').pop()?.toLowerCase();
  return ({ md: 'markdown', markdown: 'markdown', js: 'javascript', jsx: 'javascript',
    ts: 'typescript', tsx: 'typescript', py: 'python', css: 'css', html: 'html',
    json: 'json', sql: 'sql', yaml: 'yaml', yml: 'yaml' } as Record<string, string>)[extension ?? ''] ?? 'plaintext';
}

function BoundEditor({ live, draft, onSaved }: { live: LiveDocument; draft: DraftFile; onSaved: (saved: boolean) => void }) {
  const { session } = useBrowser();
  const host = useRef<HTMLDivElement>(null);
  const editorRef = useRef<monaco.editor.IStandaloneCodeEditor | null>(null);
  const state = useSyncExternalStore(live.subscribe, live.getSnapshot);
  const [text, setText] = useState('');
  const [preview, setPreview] = useState(false);
  useEffect(() => {
    const ytext = live.doc.getText(LIVE_TEXT_NAME);
    const model = monaco.editor.createModel('', language(draft.path));
    const editor = monaco.editor.create(host.current!, {
      model, automaticLayout: true, minimap: { enabled: false }, wordWrap: 'on',
      ariaLabel: `Shared draft: ${draft.path}`, readOnly: true, scrollBeyondLastLine: false,
    });
    editorRef.current = editor;
    const binding = new MonacoBinding(ytext, model, new Set([editor]), live.awareness);
    const unbindGuest = bindGuestAwareness(live.awareness, session);
    const changed = () => setText(ytext.toString());
    ytext.observe(changed);
    changed();
    // Use textContent for unverified labels, and validate CSS color values.
    const style = document.createElement('style');
    document.head.append(style);
    const cursors = () => {
      style.textContent = [...live.awareness.getStates()].filter(([id]) => id !== live.doc.clientID)
        .map(([id, value]) => {
          const color = /^#[0-9a-f]{6}$/i.test(value.user?.color ?? '') ? value.user.color : '#356a9c';
          const name = JSON.stringify(String(value.user?.name ?? 'Guest').slice(0, 80)).replace(/</g, '\\3c ');
          return `.yRemoteSelection-${id}{background:${color}33}.yRemoteSelectionHead-${id}{border-left:2px solid ${color};position:absolute;height:100%}.yRemoteSelectionHead-${id}::after{content:${name};position:absolute;top:-18px;left:0;background:${color};color:white;font:11px sans-serif;padding:2px 4px;white-space:nowrap;}`;
        }).join('\n');
    };
    live.awareness.on('change', cursors);
    cursors();
    return () => {
      live.awareness.off('change', cursors); style.remove(); unbindGuest();
      ytext.unobserve(changed); binding.destroy(); editor.dispose(); model.dispose();
      editorRef.current = null;
    };
  }, [live, draft.path, session]);
  useEffect(() => {
    onSaved(state === 'saved');
    editorRef.current?.updateOptions({ readOnly: state === 'connecting' || state === 'closed' || state === 'rejected' });
    const warn = (event: BeforeUnloadEvent) => {
      if (state !== 'saved') { event.preventDefault(); event.returnValue = ''; }
    };
    window.addEventListener('beforeunload', warn);
    const navigate = (event: MouseEvent) => {
      if (state !== 'saved' && event.target instanceof Element && event.target.closest('a[href]') &&
          !window.confirm('This draft has unsaved changes. Leave and discard those changes?')) {
        event.preventDefault(); event.stopPropagation();
      }
    };
    document.addEventListener('click', navigate, true);
    return () => { window.removeEventListener('beforeunload', warn); document.removeEventListener('click', navigate, true); };
  }, [state, onSaved]);
  return <section className="shared-editor panel">
    <div className="editor-toolbar"><h2>{draft.path}</h2><span role="status">{labels[state]}</span>
      {language(draft.path) === 'markdown' && <button aria-pressed={preview} onClick={() => setPreview(!preview)}>Markdown preview</button>}
    </div>
    <div className={preview ? 'editor-panes with-preview' : 'editor-panes'}>
      <div className="monaco-host" ref={host} />
      {preview && <article className="markdown-preview" aria-label="Markdown preview"><Markdown skipHtml components={{ img: ({ alt }) => <span>{alt || 'Image'}</span> }}>{text}</Markdown></article>}
    </div>
    {(state === 'closed' || state === 'rejected') && <label>Text to recover<textarea readOnly value={text} onFocus={(event) => event.target.select()} /></label>}
  </section>;
}

export function SharedEditor({ room, draft, onSaved }: { room: LiveRoomId; draft: DraftFile; onSaved: (saved: boolean) => void }) {
  const [live, setLive] = useState<LiveDocument | null>(null);
  useEffect(() => {
    const document = new LiveDocument(room);
    setLive(document);
    return () => document.destroy();
  }, [room.workspaceId, room.taskId, room.draftFileId, room.epoch]);
  return live ? <BoundEditor live={live} draft={draft} onSaved={onSaved} /> : <p role="status">Opening editor…</p>;
}
