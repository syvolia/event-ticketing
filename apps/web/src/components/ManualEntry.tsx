import { useState, type FormEvent } from 'react';
import type { CachedManifest } from '../lib/idb.js';

interface Props {
  manifest: CachedManifest | null;
  onClose: () => void;
  onSubmit: (shortCode: string) => void;
}

export function ManualEntry({ onClose, onSubmit }: Props): JSX.Element {
  const [code, setCode] = useState('');

  function formatInput(v: string): string {
    const cleaned = v
      .toUpperCase()
      .replace(/[^A-Z0-9]/g, '')
      .slice(0, 8);
    return cleaned.length > 4 ? `${cleaned.slice(0, 4)}-${cleaned.slice(4)}` : cleaned;
  }

  function submit(e: FormEvent): void {
    e.preventDefault();
    onSubmit(code);
  }

  return (
    <div className="manual-entry" role="dialog">
      <div className="manual-card">
        <h2>Enter code</h2>
        <form onSubmit={submit}>
          <input
            autoFocus
            value={code}
            onChange={(e) => setCode(formatInput(e.target.value))}
            placeholder="ABCD-1234"
            inputMode="text"
            autoCapitalize="characters"
            autoCorrect="off"
            spellCheck={false}
          />
          <div className="manual-actions">
            <button type="button" onClick={onClose}>
              Cancel
            </button>
            <button type="submit" disabled={code.length !== 9}>
              Check in
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
