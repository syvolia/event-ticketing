// Thin wrapper around @yudiel/react-qr-scanner. The library handles camera
// permissions, torch, and frame decoding; we only wire the result callback.
import { Scanner as QRScanner } from '@yudiel/react-qr-scanner';

interface Props {
  onScan: (token: string) => void;
  enabled: boolean;
}

export function Scanner({ onScan, enabled }: Props): JSX.Element {
  if (!enabled) {
    return (
      <div className="scanner-disabled">
        <p>Paused</p>
      </div>
    );
  }
  return (
    <QRScanner
      onScan={(codes) => {
        const first = codes[0];
        if (first?.rawValue) onScan(first.rawValue);
      }}
      onError={() => {
        /* handled by the browser banner; nothing to do */
      }}
      styles={{ container: { width: '100%', height: '100%' } }}
      components={{ finder: true, torch: true, zoom: true }}
      scanDelay={300}
    />
  );
}
