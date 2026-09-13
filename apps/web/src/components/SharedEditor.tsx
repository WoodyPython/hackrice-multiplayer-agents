import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import * as monaco from "monaco-editor";
import EditorWorker from "monaco-editor/editor/editor.worker.js?worker";
import JsonWorker from "monaco-editor/languages/features/json/json.worker.js?worker";
import CssWorker from "monaco-editor/languages/features/css/css.worker.js?worker";
import HtmlWorker from "monaco-editor/languages/features/html/html.worker.js?worker";
import TsWorker from "monaco-editor/languages/features/typescript/ts.worker.js?worker";
import { MonacoBinding } from "y-monaco";
import Markdown from "react-markdown";
import {
  LIVE_TEXT_NAME,
  type DraftFile,
  type LiveRoomId,
} from "@app/contracts";
import { Download, Eye } from "lucide-react";
import { LiveDocument } from "../live-document";
import { bindGuestAwareness } from "../session";
import { downloadText } from "../lib/download";
import { useBrowser } from "../browser-context";
import { cn } from "../lib/utils";
import { Button } from "./ui/button";
import { Dot } from "./ui/badge";
import { Label, Textarea } from "./ui/field";

self.MonacoEnvironment = {
  getWorker: (_id, label) => {
    if (label === "json") return new JsonWorker();
    if (["css", "scss", "less"].includes(label)) return new CssWorker();
    if (["html", "handlebars", "razor"].includes(label))
      return new HtmlWorker();
    if (["typescript", "javascript"].includes(label)) return new TsWorker();
    return new EditorWorker();
  },
};

/**
 * Monaco ships its own colours; these two keep it inside the CoFlow palette.
 * Defined at module scope so the definition happens once, not per mount.
 */
monaco.editor.defineTheme("coflow-light", {
  base: "vs",
  inherit: true,
  rules: [],
  colors: {
    "editor.background": "#ffffff",
    "editor.foreground": "#1d2331",
    "editorLineNumber.foreground": "#c3cad6",
    "editorLineNumber.activeForeground": "#566175",
    "editor.lineHighlightBackground": "#f6f7f9",
    "editorCursor.foreground": "#24375c",
    "editor.selectionBackground": "#dfe6f1",
    "editorIndentGuide.background1": "#eceef2",
  },
});
monaco.editor.defineTheme("coflow-dark", {
  base: "vs-dark",
  inherit: true,
  rules: [],
  colors: {
    "editor.background": "#191e2a",
    "editor.foreground": "#e8ecf3",
    "editorLineNumber.foreground": "#434c5e",
    "editorLineNumber.activeForeground": "#96a1b3",
    "editor.lineHighlightBackground": "#1f2532",
    "editorCursor.foreground": "#97b0d3",
    "editor.selectionBackground": "#2c4270",
    "editorIndentGuide.background1": "#2a3140",
  },
});

/** Tone for the save-state dot, so "offline" and "saved" are not the same colour. */
const stateTone = {
  connecting: "info",
  saving: "info",
  saved: "done",
  offline: "warn",
  closed: "warn",
  rejected: "danger",
} as const;

const labels = {
  connecting: "Connecting to shared draft…",
  saving: "Saving…",
  saved: "Saved",
  offline: "Offline — reconnecting. Keep this tab open to save your edits.",
  closed:
    "This draft has closed. Copy your text before opening the current draft.",
  rejected: "Changes could not be accepted. Copy your text before reloading.",
};
function language(path: string) {
  const extension = path.split(".").pop()?.toLowerCase();
  return (
    (
      {
        md: "markdown",
        markdown: "markdown",
        js: "javascript",
        jsx: "javascript",
        ts: "typescript",
        tsx: "typescript",
        py: "python",
        css: "css",
        html: "html",
        json: "json",
        sql: "sql",
        yaml: "yaml",
        yml: "yaml",
      } as Record<string, string>
    )[extension ?? ""] ?? "plaintext"
  );
}

function BoundEditor({
  live,
  draft,
  onSaved,
  onClosed,
}: {
  live: LiveDocument;
  draft: DraftFile;
  onSaved: (saved: boolean) => void;
  onClosed?: () => void;
}) {
  const { session } = useBrowser();
  const host = useRef<HTMLDivElement>(null);
  const editorRef = useRef<monaco.editor.IStandaloneCodeEditor | null>(null);
  const state = useSyncExternalStore(live.subscribe, live.getSnapshot);
  const [text, setText] = useState("");
  const [preview, setPreview] = useState(false);
  useEffect(() => {
    const ytext = live.doc.getText(LIVE_TEXT_NAME);
    const model = monaco.editor.createModel("", language(draft.path));
    const editor = monaco.editor.create(host.current!, {
      model,
      automaticLayout: true,
      minimap: { enabled: false },
      wordWrap: "on",
      ariaLabel: `Shared draft: ${draft.path}`,
      readOnly: true,
      scrollBeyondLastLine: false,
      theme:
        document.documentElement.dataset.theme === "dark"
          ? "coflow-dark"
          : "coflow-light",
      fontFamily: "var(--font-mono)",
      fontSize: 13,
      lineHeight: 22,
      padding: { top: 14, bottom: 14 },
      renderLineHighlight: "line",
      smoothScrolling: true,
      cursorBlinking: "smooth",
    });
    editorRef.current = editor;
    const binding = new MonacoBinding(
      ytext,
      model,
      new Set([editor]),
      live.awareness,
    );
    const unbindGuest = bindGuestAwareness(live.awareness, session);
    const changed = () => setText(ytext.toString());
    ytext.observe(changed);
    changed();
    // Use textContent for unverified labels, and validate CSS color values.
    const style = document.createElement("style");
    document.head.append(style);
    const cursors = () => {
      style.textContent = [...live.awareness.getStates()]
        .filter(([id]) => id !== live.doc.clientID)
        .map(([id, value]) => {
          const color = /^#[0-9a-f]{6}$/i.test(value.user?.color ?? "")
            ? value.user.color
            : "#356a9c";
          const name = JSON.stringify(
            String(value.user?.name ?? "Guest").slice(0, 80),
          ).replace(/</g, "\\3c ");
          return `.yRemoteSelection-${id}{background:${color}33}.yRemoteSelectionHead-${id}{border-left:2px solid ${color};position:absolute;height:100%}.yRemoteSelectionHead-${id}::after{content:${name};position:absolute;top:-18px;left:0;background:${color};color:white;font:11px sans-serif;padding:2px 4px;white-space:nowrap;}`;
        })
        .join("\n");
    };
    live.awareness.on("change", cursors);
    cursors();
    // The theme is a root attribute, so the editor follows it by observation
    // rather than by every theme control knowing Monaco exists.
    const themes = new MutationObserver(() =>
      monaco.editor.setTheme(
        document.documentElement.dataset.theme === "dark"
          ? "coflow-dark"
          : "coflow-light",
      ),
    );
    themes.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ["data-theme"],
    });
    return () => {
      themes.disconnect();
      live.awareness.off("change", cursors);
      style.remove();
      unbindGuest();
      ytext.unobserve(changed);
      binding.destroy();
      editor.dispose();
      model.dispose();
      editorRef.current = null;
    };
  }, [live, draft.path, session]);
  useEffect(() => {
    onSaved(state === "saved");
    if (state === "closed") onClosed?.();
    editorRef.current?.updateOptions({
      readOnly:
        state === "connecting" || state === "closed" || state === "rejected",
    });
    const warn = (event: BeforeUnloadEvent) => {
      if (state !== "saved") {
        event.preventDefault();
        event.returnValue = "";
      }
    };
    window.addEventListener("beforeunload", warn);
    const navigate = (event: MouseEvent) => {
      if (
        state !== "saved" &&
        event.target instanceof Element &&
        event.target.closest("a[href]") &&
        !window.confirm(
          "This draft has unsaved changes. Leave and discard those changes?",
        )
      ) {
        event.preventDefault();
        event.stopPropagation();
      }
    };
    document.addEventListener("click", navigate, true);
    return () => {
      window.removeEventListener("beforeunload", warn);
      document.removeEventListener("click", navigate, true);
    };
  }, [state, onSaved, onClosed]);
  const tone = stateTone[state];
  return (
    <section className="overflow-hidden rounded-xl border border-border bg-card shadow-xs">
      <div className="flex flex-wrap items-center gap-3 border-b border-border px-4 py-3">
        <h2 className="min-w-0 flex-1 truncate font-mono text-[13px] font-semibold">
          {draft.path}
        </h2>
        <span
          role="status"
          className="flex items-center gap-1.5 text-[12px] text-muted-foreground"
        >
          <Dot
            tone={tone}
            live={state === "connecting" || state === "saving"}
          />
          {labels[state]}
        </span>
        {/*
          The live text, straight out of the shared document. Not the persisted
          snapshot: what a person means by "download this" is what they can see,
          including the words someone typed a second ago.
        */}
        <Button
          size="sm"
          onClick={() => downloadText(draft.path, live.doc.getText(LIVE_TEXT_NAME).toString())}
        >
          <Download aria-hidden="true" />
          Download
        </Button>
        {language(draft.path) === "markdown" && (
          <Button
            size="sm"
            variant={preview ? "subtle" : "secondary"}
            aria-pressed={preview}
            onClick={() => setPreview(!preview)}
          >
            <Eye aria-hidden="true" />
            Markdown preview
          </Button>
        )}
      </div>

      <div className={cn("grid min-w-0", preview && "lg:grid-cols-2")}>
        <div className="h-[60vh] min-h-80 min-w-0" ref={host} />
        {preview && (
          <article
            aria-label="Markdown preview"
            className="cf-prose h-[60vh] min-w-0 overflow-auto border-t border-border p-5 text-[13.5px] lg:border-t-0 lg:border-l"
          >
            <Markdown
              skipHtml
              components={{ img: ({ alt }) => <span>{alt || "Image"}</span> }}
            >
              {text}
            </Markdown>
          </article>
        )}
      </div>

      {(state === "closed" || state === "rejected") && (
        <div className="space-y-1.5 border-t border-border bg-muted/30 p-4">
          <Label htmlFor="recover-text">Text to recover</Label>
          <Textarea
            id="recover-text"
            readOnly
            rows={6}
            value={text}
            onFocus={(event) => event.target.select()}
            className="font-mono text-[12px]"
          />
        </div>
      )}
    </section>
  );
}

export function SharedEditor({
  room,
  draft,
  onSaved,
  onClosed,
}: {
  room: LiveRoomId;
  draft: DraftFile;
  onSaved: (saved: boolean) => void;
  /** Fires when this epoch closes, so the page can offer the current draft (§4.7). */
  onClosed?: () => void;
}) {
  const [live, setLive] = useState<LiveDocument | null>(null);
  useEffect(() => {
    const document = new LiveDocument(room);
    setLive(document);
    return () => document.destroy();
  }, [room.workspaceId, room.taskId, room.draftFileId, room.epoch]);
  return live ? (
    <BoundEditor
      live={live}
      draft={draft}
      onSaved={onSaved}
      onClosed={onClosed}
    />
  ) : (
    <p role="status">Opening editor…</p>
  );
}
