/** @type {import('next').NextConfig} */
import webpack from "webpack";
import nextPWA from "next-pwa";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const withPWA = nextPWA({
  dest: "public",
  disable: process.env.NODE_ENV === "development",
  register: true,
  skipWaiting: true,
});

const nextConfig = {
  reactStrictMode: true,
  transpilePackages: [
    "@fatsolutions/tongo-sdk",
    "@atomiqlabs/sdk",
    "@atomiqlabs/chain-starknet",
  ],
  turbopack: {}, // silence Next.js 16 warning — we explicitly use --webpack
  logging: {
    incomingRequests: false,
  },
  images: {
    dangerouslyAllowSVG: true,
    remotePatterns: [
      {
        protocol: "https",
        hostname: "identicon.starknet.id",
        pathname: "/**",
      },
      {
        protocol: "https",
        hostname: "img.starkurabu.com",
        pathname: "/**",
      },
    ],
  },
  typescript: {
    ignoreBuildErrors: process.env.NEXT_PUBLIC_IGNORE_BUILD_ERROR === "true",
  },
  webpack: (config, { dev, isServer }) => {
    config.resolve.fallback = { fs: false, net: false, tls: false };
    config.resolve.extensionAlias = {
      ".js": [".js", ".ts", ".tsx"],
    };
    config.externals.push("pino-pretty", "lokijs", "encoding");

    config.plugins.push(
      new webpack.NormalModuleReplacementPlugin(/^node:(.*)$/, (resource) => {
        resource.request = resource.request.replace(/^node:/, "");
      }),
    );

    // Redirect `starknet` imports from within @atomiqlabs/chain-starknet to
    // starknet-v9 (starknet@9.x). Using module.rules with issuer so webpack
    // matches at the module-graph level (more reliable than NormalModuleReplacementPlugin).
    config.module.rules.push({
      test: /[\\/]node_modules[\\/]starknet[\\/]/,
      issuer: /[\\/]node_modules[\\/]@atomiqlabs[\\/]chain-starknet[\\/]/,
      resolve: {
        alias: {
          starknet: path.resolve(__dirname, "node_modules/starknet-v9"),
        },
      },
    });

    // Also add a global alias so direct requires of "starknet" inside
    // chain-starknet resolve to starknet-v9.
    if (!config.resolve.alias) config.resolve.alias = {};
    // We can't set a global alias (would break the whole app), so instead
    // we patch with NormalModuleReplacementPlugin using issuerPath regex.
    config.plugins.push(
      new webpack.NormalModuleReplacementPlugin(/^starknet$/, (resource) => {
        const issuer = resource.contextInfo?.issuer || resource.context || "";
        if (
          issuer.includes("@atomiqlabs") &&
          issuer.includes("chain-starknet")
        ) {
          resource.request = path.resolve(
            __dirname,
            "node_modules/starknet-v9/dist/index.js",
          );
        }
      }),
    );

    if (dev && !isServer) {
      config.infrastructureLogging = {
        level: "error",
      };
    }

    return config;
  },
};

export default withPWA(nextConfig);
