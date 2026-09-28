/** @type {import('next').NextConfig} */
const nextConfig = {
  // The marketplace logos drawn on alert photos (lib/photoBadge.js) are read
  // from disk at run time — ship them with every API route.
  outputFileTracingIncludes: {
    '/api/**': ['./lib/assets/*.png'],
  },
};

export default nextConfig;
