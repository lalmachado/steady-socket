import type { NextConfig } from 'next';

const config: NextConfig = {
  // `tsconfig.json` points `steady-socket` at the package's source so linting and type-checking
  // work without a build. The app itself should run the built package, like any user would, so
  // Next gets a config without that alias.
  typescript: { tsconfigPath: 'tsconfig.next.json' },
};

export default config;
