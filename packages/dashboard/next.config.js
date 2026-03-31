/** @type {import('next').NextConfig} */
const nextConfig = {
  transpilePackages: ["@chaos/shared-types"],
  output: "standalone",
};

module.exports = nextConfig;
