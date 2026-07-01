/** @type {import('next').NextConfig} */
const nextConfig = {
  output: 'standalone',
  experimental: {
    serverComponentsExternalPackages: ['@prisma/client', 'prisma'],
    instrumentationHook: true,
  },
  typescript: {
    ignoreBuildErrors: false,
  },
}

export default nextConfig;
