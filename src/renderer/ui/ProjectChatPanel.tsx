import ChatPanel from "./ChatPanel";
import type { SlotUiState } from "./appTypes";

type Props = {
  slot: number;
  projectRootPath?: string;

  isVisible: boolean;
  width?: number;
  onClose: () => void;

  terminalScrollback: number;
  onOpenUrl: (url: string) => void;
  onOpenImage: (absPathOrUrl: string) => void;
  onOpenFile: (relPath: string, line?: number, column?: number) => void;

  allowedAgentViews: Array<SlotUiState["agentView"]>;
  agentView: SlotUiState["agentView"];
  setAgentView: (next: SlotUiState["agentView"]) => void;
  agentCli: SlotUiState["agentCli"];
  updateAgentCli: (updater: (prev: SlotUiState["agentCli"]) => SlotUiState["agentCli"]) => void;

  aiConfig: { apiBase: string; apiKey: string; model: string };
  setAiConfig: (next: { apiBase: string; apiKey: string; model: string }) => void;
  autoApplyAll: boolean;
  setAutoApplyAll: (next: boolean) => void;

  chatInput: string;
  setChatInput: (next: string) => void;
  chatMessages: SlotUiState["chatMessages"];
  activeRequestId: string | null;
  onSend: () => void;
  onStop: () => void;

  stagedFiles: string[];
  onOpenDiff: (path: string) => void;
  onApplyAll: () => void;
  onRevertLast: () => void;
};

export default function ProjectChatPanel(props: Props) {
  return (
    <ChatPanel
      slot={props.slot}
      isVisible={props.isVisible}
      width={props.width}
      onClose={props.onClose}
      projectRootPath={props.projectRootPath}
      terminalScrollback={props.terminalScrollback}
      onOpenUrl={props.onOpenUrl}
      onOpenImage={props.onOpenImage}
      onOpenFile={props.onOpenFile}
      allowedAgentViews={props.allowedAgentViews}
      agentView={props.agentView}
      setAgentView={props.setAgentView}
      agentCli={props.agentCli}
      updateAgentCli={props.updateAgentCli}
      aiConfig={props.aiConfig}
      setAiConfig={props.setAiConfig}
      autoApplyAll={props.autoApplyAll}
      setAutoApplyAll={props.setAutoApplyAll}
      chatInput={props.chatInput}
      setChatInput={props.setChatInput}
      chatMessages={props.chatMessages}
      activeRequestId={props.activeRequestId}
      onSend={props.onSend}
      onStop={props.onStop}
      stagedFiles={props.stagedFiles}
      onOpenDiff={props.onOpenDiff}
      onApplyAll={props.onApplyAll}
      onRevertLast={props.onRevertLast}
    />
  );
}
