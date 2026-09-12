import type { NextConfig } from 'next';

const nextConfig: NextConfig = {
  // The engine, the importer and the persistence sink ship as workspace
  // packages. Transpiling them here means the console and the route handlers
  // run the exact same source, rather than a copy that is meant to stay in
  // step.
  //
  // This does not remove the need for the packages to be compiled first. Each
  // one's package.json points at dist/, and the resolver checks that the file
  // exists before any transpilation happens; on a fresh checkout it does not.
  // The first deploy after adding @kreaton/ingest and @kreaton/sheets failed
  // on exactly that, because the deployment's build command runs inside
  // apps/web and never compiled them. The `build` script in this package now
  // compiles the workspace packages before `next build`, so the same command
  // works from a clean clone, in CI and on Vercel.
  transpilePackages: ['@kreaton/core', '@kreaton/ingest', '@kreaton/sheets'],
  typedRoutes: true,
  // The dev server otherwise writes assistant instruction files into the
  // package on every start. Nothing in this repository is authored that way.
  agentRules: false,
};

export default nextConfig;
