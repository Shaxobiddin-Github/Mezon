import qrcode from 'qrcode-generator';
import React, { useMemo } from 'react';

/** A QR picture as one SVG path (no HTML injection, works offline). */
export const QrSvg: React.FC<{
  readonly text: string;
  readonly size?: number;
  readonly label: string;
}> = ({ text, size = 168, label }) => {
  const { d, n } = useMemo(() => {
    const qr = qrcode(0, 'M');
    qr.addData(text);
    qr.make();
    const count = qr.getModuleCount();
    let path = '';
    for (let r = 0; r < count; r += 1) {
      for (let c = 0; c < count; c += 1) {
        if (qr.isDark(r, c)) path += `M${String(c)} ${String(r)}h1v1h-1z`;
      }
    }
    return { d: path, n: count };
  }, [text]);
  return (
    <svg
      width={size}
      height={size}
      viewBox={`-2 -2 ${String(n + 4)} ${String(n + 4)}`}
      shapeRendering="crispEdges"
      role="img"
      aria-label={label}
      className="rounded-xl border border-slate-200 bg-white"
    >
      <rect x={-2} y={-2} width={n + 4} height={n + 4} fill="#fff" />
      <path d={d} fill="#0f172a" />
    </svg>
  );
};
