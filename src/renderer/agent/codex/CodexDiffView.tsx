import DiffViewer from "../shared/DiffViewer";

export default function CodexDiffView({ diff }: { diff: string }) {
  return <DiffViewer diff={diff} defaultViewMode="side-by-side" showFileList={true} showMetaLines={false} />;
}
