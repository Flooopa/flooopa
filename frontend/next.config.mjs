/** @type {import('next').NextConfig} */
const nextConfig = {
  async rewrites() {
    const gateway = process.env.AI_GATEWAY_URL || process.env.REACT_APP_AI_GATEWAY_URL || 'http://localhost:3001';
    return [
      {
        source: '/api/:path*',
        destination: `${gateway}/api/:path*`,
      },
    ];
  },
};

export default nextConfig;
