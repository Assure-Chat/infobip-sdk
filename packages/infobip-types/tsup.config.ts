import { defineConfig } from 'tsup';

export default defineConfig({
  entry: ['src/index.ts', 'src/openapi.ts'],
  format: ['esm', 'cjs'],
  dts: true,
  sourcemap: true,
  clean: true,
  target: 'es2022',
  outExtension: ({ format }) => ({ js: format === 'cjs' ? '.cjs' : '.js' }),
});
