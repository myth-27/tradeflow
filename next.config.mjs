/** @type {import('next').NextConfig} */
const isVercel = !!process.env.VERCEL;

const nextConfig = {
  // standalone is needed for Railway (Docker). Vercel handles its own bundling.
  output: isVercel ? undefined : 'standalone',
  experimental: {
    serverComponentsExternalPackages: ['@prisma/client', 'prisma', 'pg', 'ws', 'uuid'],
    instrumentationHook: true,
  },
  typescript: {
    ignoreBuildErrors: false,
  },
  webpack: (config, { isServer }) => {
    if (isServer) {
      // pg and ws depend on Node built-ins (fs, net, tls) — keep them external
      const nodeExternals = ['pg', 'pg-native', 'pg-connection-string', 'ws'];
      if (Array.isArray(config.externals)) {
        config.externals.push(...nodeExternals);
      }
    }
    return config;
  },
}

export default nextConfig;
