/** @type {import('next').NextConfig} */
const nextConfig = {
  // Static export — Express serves the resulting `out/` directory.
  // Calls to /api/* go to Express; everything else is a static page.
  output: 'export',
  trailingSlash: true,
  images: { unoptimized: true },
};
module.exports = nextConfig;
