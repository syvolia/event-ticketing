// Full-screen feedback. The overlay is intentionally large and colored — the
// staff member is glancing at it out of the corner of their eye while the
// phone is pointed at the next attendee.
import { useEffect } from 'react';

export type OverlayState =
  | { kind: 'idle' }
  | { kind: 'accepted'; title: string; detail?: string }
  | { kind: 'duplicate'; title: string; detail?: string }
  | { kind: 'void'; title: string; detail?: string }
  | { kind: 'wrong_event'; title: string; detail?: string }
  | { kind: 'not_found'; title: string; detail?: string }
  | { kind: 'invalid'; title: string; detail?: string };

interface Props {
  state: OverlayState;
  onDone: () => void;
}

const AUTO_DISMISS_MS = 1_400;

export function ResultOverlay({ state, onDone }: Props): JSX.Element | null {
  useEffect(() => {
    if (state.kind === 'idle') return;
    const id = window.setTimeout(onDone, AUTO_DISMISS_MS);
    return () => window.clearTimeout(id);
  }, [state, onDone]);

  if (state.kind === 'idle') return null;

  const tone = state.kind === 'accepted' ? 'green' : state.kind === 'duplicate' ? 'amber' : 'red';

  return (
    <div className={`overlay overlay-${tone}`} role="alert" onClick={onDone}>
      <div className="overlay-title">{state.title}</div>
      {state.detail ? <div className="overlay-detail">{state.detail}</div> : null}
      {tone === 'green' ? <div className="overlay-vibrate">✓</div> : null}
      {tone === 'amber' ? <div className="overlay-vibrate">⚠</div> : null}
      {tone === 'red' ? <div className="overlay-vibrate">✕</div> : null}
    </div>
  );
}
