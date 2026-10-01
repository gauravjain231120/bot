import { ImageResponse } from 'next/og';

export const runtime = 'edge';
export const size = { width: 180, height: 180 };
export const contentType = 'image/png';

export default function Icon() {
  return new ImageResponse(
    (
      <div
        style={{
          width: '100%',
          height: '100%',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          backgroundColor: '#ff9900',
          color: '#232f3e',
          fontSize: 90,
          fontWeight: 'bold',
          fontFamily: 'sans-serif',
        }}
      >
        AR
      </div>
    ),
    { ...size }
  );
}
