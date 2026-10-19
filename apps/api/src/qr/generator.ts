// QR image generation. Server-side so the payload never has to leave the
// process to be rendered — the QR PNG/SVG we hand back is exactly the bytes
// that will be scanned at the door.
import QRCode from 'qrcode';

const COMMON = {
  // Level M tolerates ~15% of the code being obscured, which is the right
  // balance for a phone screen under venue lighting. Level H is 30% but
  // inflates the code size unnecessarily for our payload length.
  errorCorrectionLevel: 'M' as const,
  margin: 1,
  width: 512,
};

export async function generatePng(text: string): Promise<Buffer> {
  return QRCode.toBuffer(text, { ...COMMON, type: 'png' });
}

export async function generateSvg(text: string): Promise<string> {
  return QRCode.toString(text, { ...COMMON, type: 'svg' });
}

export async function generateDataUrl(text: string): Promise<string> {
  return QRCode.toDataURL(text, { ...COMMON });
}