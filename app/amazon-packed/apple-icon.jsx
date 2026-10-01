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
          backgroundColor: '#232f3e',
          color: '#ff9900',
          fontSize: 90,
          fontWeight: 'bold',
          fontFamily: 'sans-serif',
        }}
      >
        AP
      </div>
    ),
    { ...size }
  );
}
