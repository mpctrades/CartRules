import { useEffect } from "react";
import { showToast } from "./toast";

// For same-page fetcher-driven mutations (toggle/delete/duplicate a rule,
// Settings save) — the action returns { toast, toastError? } and this fires
// it once per completed submission. fetcher.data is a fresh object
// reference on every response, so the effect only re-runs on a genuinely
// new result, not on unrelated re-renders.
export function useActionToast(fetcher) {
  useEffect(() => {
    if (fetcher.state === "idle" && fetcher.data?.toast) {
      showToast(fetcher.data.toast, { isError: fetcher.data.toastError });
    }
  }, [fetcher.data, fetcher.state]);
}
