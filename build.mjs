// Build script: bundles the app (and optionally unit tests) with esbuild.
//
//   node build.mjs            production build into dist/
//   node build.mjs --watch    rebuild on change
//   node build.mjs --serve    also start the express dev server
//   node build.mjs --tests    bundle test/unit/*.test.ts into out/tests/
import * as esbuild from 'esbuild';
import fs from 'node:fs';
import path from 'node:path';

const args = new Set(process.argv.slice(2));
const watch = args.has('--watch');
const serve = args.has('--serve');
const tests = args.has('--tests');

// Loads .wgsl files as strings, resolving `#include "relative/path.wgsl"` lines.
const wgslPlugin = {
  name: 'wgsl',
  setup(build) {
    build.onLoad({filter: /\.wgsl$/}, async args => {
      const watchFiles = [];
      const load = (file, stack) => {
        if (stack.includes(file)) {
          throw new Error(`circular #include: ${[...stack, file].join(' -> ')}`);
        }
        watchFiles.push(file);
        const src = fs.readFileSync(file, 'utf8');
        return src.replace(/^\s*#include\s+"([^"]+)"\s*$/gm, (_, rel) =>
          load(path.resolve(path.dirname(file), rel), [...stack, file]),
        );
      };
      const contents = load(args.path, []);
      return {
        contents: `export default ${JSON.stringify(contents)};`,
        loader: 'js',
        watchFiles,
      };
    });
  },
};

function copyStatic() {
  fs.mkdirSync('dist', {recursive: true});
  fs.copyFileSync('index.html', 'dist/index.html');
}

const appOptions = {
  entryPoints: ['src/main.ts', 'src/car-preview.ts', 'src/audio-render.ts'],
  bundle: true,
  format: 'esm',
  target: 'es2023',
  outdir: 'dist',
  sourcemap: true,
  minify: !watch,
  plugins: [wgslPlugin],
  logLevel: 'info',
  define: {__DEV__: watch ? 'true' : 'false'},
};

if (tests) {
  const entryPoints = fs
    .readdirSync('test/unit')
    .filter(f => f.endsWith('.test.ts'))
    .map(f => `test/unit/${f}`);
  fs.rmSync('out/tests', {recursive: true, force: true});
  await esbuild.build({
    entryPoints,
    bundle: true,
    platform: 'node',
    format: 'esm',
    target: 'node22',
    outdir: 'out/tests',
    outExtension: {'.js': '.mjs'},
    plugins: [wgslPlugin],
    define: {__DEV__: 'true'},
    logLevel: 'warning',
  });
} else {
  copyStatic();
  if (fs.existsSync('car-preview.html')) {
    fs.copyFileSync('car-preview.html', 'dist/car-preview.html');
  }
  if (watch) {
    const ctx = await esbuild.context(appOptions);
    await ctx.watch();
    fs.watch('.', (_, f) => {
      if (f && f.endsWith('.html')) {
        copyStatic();
      }
    });
    if (serve) {
      const {startServer} = await import('./server.mjs');
      await startServer(Number(process.env.PORT ?? 8080));
    }
  } else {
    await esbuild.build(appOptions);
  }
}
