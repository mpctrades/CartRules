import { useEffect, useRef } from "react";
import { useAppBridge } from "@shopify/app-bridge-react";

/**
 * Asks Shopify to show its App Store review modal once, at the end of a
 * successful workflow (a rule just saved/activated) for a shop whose rules
 * have already stopped real shoppers. Shopify decides whether it actually
 * shows (60-day cooldown, 3 per year, not within 24h of install, …); we only
 * record that we asked, so we don't ask again for 60 days.
 *
 * Never tied to a button (rate limits could make it look broken) and never
 * linked to features or rewards (App Store requirement 1.3).
 */
export function useReviewPrompt({ eligible, trigger, onRequested }) {
  const shopify = useAppBridge();
  const asked = useRef(false);
  // Kept in a ref so a new callback identity doesn't restart (and cancel) the timer.
  const onRequestedRef = useRef(onRequested);
  onRequestedRef.current = onRequested;

  useEffect(() => {
    if (!eligible || !trigger || asked.current) return;
    if (typeof shopify?.reviews?.request !== "function") return;
    // Let the success toast land first so the modal doesn't cut the task off.
    // Mark as asked only when it fires: if the effect re-runs before then
    // (re-render, React dev double-invoke) the cleanup cancels this timer and
    // the next run schedules it again.
    const timer = setTimeout(async () => {
      if (asked.current) return;
      asked.current = true;
      try {
        const result = await shopify.reviews.request();
        if (!result?.success)
          console.info(`Review modal not shown: ${result?.code}`);
      } catch (error) {
        console.error("Review request failed", error);
      }
      onRequestedRef.current?.();
    }, 1500);
    return () => clearTimeout(timer);
  }, [eligible, trigger, shopify]);
}
