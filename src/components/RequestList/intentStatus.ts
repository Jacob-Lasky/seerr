/** Safe finite state only; never render producer payloads or responses. */
export function bookIntentStatus(
  state?: string,
  available = false
): string | undefined {
  if (available) return undefined;
  switch (state) {
    case 'prepared':
      return 'Queued for the next Readarr scan';
    case 'sending':
      return 'Submitting once; do not retry';
    case 'accepted_pending':
      return 'Accepted by Chaptarr; waiting for the exact book';
    case 'unknown':
      return 'Submission uncertain. Run Readarr Scan to reconcile; do not resubmit.';
    case 'refused':
      return 'Request held. Review its target or ambiguity; do not resubmit.';
    case 'native_linked':
      return 'Linked in Chaptarr; waiting for files';
    default:
      return undefined;
  }
}
