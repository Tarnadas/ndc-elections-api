import { build } from 'esbuild';

const isProd = process.env.NODE_ENV === 'production';

build({
  entryPoints: ['src/index.ts'],
  bundle: true,
  outfile: 'dist/index.mjs',
  format: 'esm',
  minify: isProd,
  logLevel: 'info',
  sourcemap: !isProd
});
