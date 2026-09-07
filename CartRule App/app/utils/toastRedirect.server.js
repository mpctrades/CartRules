import { redirect } from "@remix-run/node";

// Server-side counterpart to useFlashToast.js — appends the toast message
// as a query param on the redirect target, since there's no other way to
// hand data to the next page across a Remix redirect.
export function redirectWithToast(path, message, { isError = false } = {}) {
  // toastId is a delivery nonce, not the display text — useFlashToast dedupes
  // on it instead of on `message`, so two genuinely separate redirects that
  // happen to render identical text (e.g. the same free-plan-limit message
  // for two different rules) each still show their own toast.
  const toastId = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  const params = new URLSearchParams({ toast: message, toastId });
  if (isError) params.set("toastError", "1");
  const separator = path.includes("?") ? "&" : "?";
  return redirect(`${path}${separator}${params.toString()}`);
}
