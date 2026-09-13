import { useEffect, useState } from "react";
import { Download, FileText } from "lucide-react";
import { useSearchParams } from "react-router-dom";
import type { ApprovedFileContent } from "@app/contracts";
import { useBrowser } from "../browser-context";
import { apiMessage } from "../workspace-api";
import { downloadText } from "../lib/download";
import { EmptyState } from "../components/EmptyState";
import { BackLink, PageHeading } from "../components/PageHeading";
import { Badge } from "../components/ui/badge";
import { Button } from "../components/ui/button";
import { ErrorText, Path, Skeleton } from "../components/ui/misc";

/** A stable, linkable screen for reading one approved file. */
export function ApprovedFile({ workspaceId }: { workspaceId: string }) {
  const { api } = useBrowser();
  const [params] = useSearchParams();
  const path = params.get("path") ?? "";
  const [file, setFile] = useState<ApprovedFileContent | null>(null);
  const [failure, setFailure] = useState<string | null>(null);
  const [nonce, setNonce] = useState(0);

  useEffect(() => {
    if (!path) return;
    const controller = new AbortController();
    setFailure(null);
    void api.readApprovedFile(workspaceId, path, controller.signal)
      .then((result) => { if (!controller.signal.aborted) setFile(result); })
      .catch((error: unknown) => { if (!controller.signal.aborted) setFailure(apiMessage(error)); });
    return () => controller.abort();
  }, [api, workspaceId, path, nonce]);

  if (!path) return (
    <EmptyState title="Choose a file to view" icon={FileText}>
      Open an approved file from the Files page.
    </EmptyState>
  );

  return (
    <>
      <BackLink to={`/w/${workspaceId}/files`}>All files</BackLink>
      <PageHeading eyebrow="Approved file" title={<Path>{path}</Path>} />
      {failure ? (
        <div className="space-y-3">
          <ErrorText role="alert">{failure}</ErrorText>
          <Button onClick={() => setNonce((value) => value + 1)}>Try again</Button>
        </div>
      ) : !file ? (
        <div aria-label="Loading file" className="space-y-3">
          <Skeleton className="h-8 w-40" />
          <Skeleton className="h-80" />
        </div>
      ) : (
        <article className="overflow-hidden rounded-xl border border-border bg-card shadow-xs">
          <header className="flex flex-wrap items-center gap-2 border-b border-border px-5 py-3">
            <Path>{file.path}</Path>
            <Badge size="sm" className="ml-auto font-mono">{file.mainSha.slice(0, 8)}</Badge>
            {file.text !== null && (
              <Button size="sm" onClick={() => downloadText(file.path, file.text!)}>
                <Download aria-hidden="true" />
                Download
              </Button>
            )}
          </header>
          {/*
            The file scrolls inside its own box, not by making the page taller.

            `overflow-auto` with no height does nothing: the element grows to
            its content, so a long file turned the whole page into one enormous
            scroll with the card's border thousands of pixels down. Capped to
            the viewport, so the heading and the Download button stay put and
            the scrollbar belongs to the thing being scrolled.
          */}
          <pre className="max-h-[70vh] min-h-72 overflow-auto p-5 font-mono text-[12.5px] leading-relaxed whitespace-pre-wrap">
            {file.text ?? "This file is no longer present in the approved version."}
          </pre>
        </article>
      )}
    </>
  );
}
