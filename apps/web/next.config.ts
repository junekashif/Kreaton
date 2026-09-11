import type { NextConfig } from 'next';

const nextConfig: NextConfig = {
  // The engine ships as a workspace package. Transpiling it here means the
  // console and the authorisation endpoint run the exact same source, rather
  // than a copy that is meant to stay in step.
  transpilePackages: ['@kreaton/core'],
  typedRoutes: true,
  // The dev server otherwise writes assistant instruction files into the
  // package on every start. Nothing in this repository is authored that way.
  agentRules: false,
};

export default nextConfig;
