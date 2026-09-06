/** @type {import('next').NextConfig} */
const isVercel = !!process.env.VERCEL;

// Packages that use Node built-ins (fs/net/tls) and must never be bundled by webpack.
// Also include built-in Node modules used directly (tls, net) so webpack leaves them alone.
const NODE_ONLY = ['pg', 'pg-native', 'pg-pool', 'pg-connection-string', 'pgpass', 'ws', 'uuid'];

const nextConfig = {
  output: isVercel ? undefined : 'standalone',
  experimental: {
    serverComponentsExternalPackages: NODE_ONLY,
    instrumentationHook: true,
  },
  typescript: {
    ignoreBuildErrors: false,
  },
  webpack: (config, { isServer }) => {
    if (isServer) {
      // Preserve existing externals (may be array or function) then append ours
      const prev = config.externals;
      config.externals = [
        ...(Array.isArray(prev) ? prev : prev ? [prev] : []),
        ...NODE_ONLY,
      ];
    }
    return config;
  },
}

export default nextConfig;
