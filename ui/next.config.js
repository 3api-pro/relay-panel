/** @type {import('next').NextConfig} */
const nextConfig = {
  output: 'standalone',
  async rewrites() {
    // In dev: proxy /api/* to backend on 3199. In prod: same-origin.
    if (process.env.NODE_ENV === 'development') {
      return [
        { source: '/api/:path*', destination: 'http://localhost:3199/:path*' },
      ];
    }
    return [];
  },
};
module.exports = nextConfig;
