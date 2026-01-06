import { useEffect, useRef } from "react";
import type { Store } from "../panel/types";

type RefLike<T> = { current: T };

type Args = {
  storeRef: RefLike<Store>;
  bump: () => void;
  setStatusState: (state: Store["status"]["state"]) => void;
  handleNotification: (method: string, params: any) => void;
  scheduledRafRef: RefLike<number | null>;
};

export function useCodexBridge({ storeRef, bump, setStatusState, handleNotification, scheduledRafRef }: Args) {
  const handleNotificationRef = useRef(handleNotification);
  useEffect(() => {
    handleNotificationRef.current = handleNotification;
  }, [handleNotification]);

  useEffect(() => {
    const offEvent = window.xcoding.codex.onEvent((event: any) => {
      if (!event || typeof event !== "object") return;
      const store = storeRef.current;

      if (event.kind === "status") {
        store.status = { state: event.status, error: typeof event.error === "string" ? event.error : undefined };
        setStatusState(store.status.state);
        bump();
        return;
      }

      if (event.kind === "stderr") {
        store.lastStderr = String(event.text ?? "");
        // stderr can be very chatty during startup; avoid repainting the whole panel on every chunk once we're already ready.
        if (store.status.state !== "ready") bump();
        return;
      }

      if (event.kind !== "notification") return;
      const method = String(event.method ?? "");
      const params = event.params ?? {};
      handleNotificationRef.current(method, params);
    });

    const offRequest = window.xcoding.codex.onRequest((req: any) => {
      if (!req || typeof req !== "object") return;
      if (req.kind !== "request") return;
      const method = String(req.method ?? "");
      const rpcId = Number(req.id);
      const params = req.params ?? {};

      if (method === "item/commandExecution/requestApproval" || method === "item/fileChange/requestApproval") {
        const itemId = String((params as any)?.itemId ?? "");
        if (!itemId) return;
        storeRef.current.approvalsByItemId[itemId] = { rpcId, method, params } as any;
        bump();
        return;
      }

      // Unknown server-initiated request: stash it for display as a generic approval on the turn.
      const fallbackItemId = String((params as any)?.itemId ?? `rpc:${rpcId}`);
      storeRef.current.approvalsByItemId[fallbackItemId] = { rpcId, method, params } as any;
      bump();
    });

    return () => {
      offEvent();
      offRequest();
      if (scheduledRafRef.current != null) window.cancelAnimationFrame(scheduledRafRef.current);
    };
  }, [bump, scheduledRafRef, setStatusState, storeRef]);
}
