import { useEffect, useRef } from "react";
import { useSearchParams } from "@remix-run/react";
import { showToast } from "./toast";

// For actions that redirect to a different route (create rule, update rule
// — see toastRedirect.server.js), the toast can't fire from the action
// itself since the page navigates away before anything renders. Instead the
// redirect carries the message as a `?toast=` query param, and the
// destination page calls this hook once on mount to show it and strip the
// param back out of the URL (so refreshing/back-button doesn't re-fire it).
export function useFlashToast() {
  const [searchParams, setSearchParams] = useSearchParams();
  const toast = searchParams.get("toast");
  const toastId = searchParams.get("toastId");
  // Dedupe by the delivery nonce (toastId), not the message text — React
  // StrictMode double-invokes mount effects in dev (shopify app dev runs
  // the dev build), and this ref makes that idempotent. Keying on the text
  // instead would also wrongly suppress a later, genuinely different
  // delivery that happens to render identical text.
  const shownRef = useRef(null);

  useEffect(() => {
    if (!toast) return;
    const key = toastId ?? toast;
    if (shownRef.current === key) return;
    shownRef.current = key;
    showToast(toast, { isError: searchParams.get("toastError") === "1" });
    const next = new URLSearchParams(searchParams);
    next.delete("toast");
    next.delete("toastId");
    next.delete("toastError");
    setSearchParams(next, { replace: true });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [toast, toastId]);
}
