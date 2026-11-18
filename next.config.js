/** @type {import('next').NextConfig} */
const nextConfig = {
  output: 'export',
  // Static exports have no server runtime. ImgBB uploads therefore happen in
  // the browser and the upload key must be embedded at build time.
  // basePath must start with '/' or be undefined.
  ...(process.env.NEXT_PUBLIC_BASE_PATH ? { basePath: process.env.NEXT_PUBLIC_BASE_PATH } : {}),
  trailingSlash: true,
  images: {
    unoptimized: true,
  }
};

module.exports = nextConfig;
