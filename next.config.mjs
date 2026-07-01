/** @type {import('next').NextConfig} */
const nextConfig = {
  output: 'standalone',
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
      // so webpack doesn't try to bundle them for the browser
      const nodeExternals = ['pg', 'pg-native', 'pg-connection-string', 'ws'];
      if (Array.isArray(config.externals)) {
        config.externals.push(...nodeExternals);
      }
    }
    return config;
  },
}

export default nextConfig;
