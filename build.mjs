// Build script: bundles the app (and optionally unit tests) with esbuild.
//
//   node build.mjs            development build into dist/ (readable)
//   node build.mjs --production  minified build (used by the Pages action)
//   node build.mjs --watch    rebuild on change
//   node build.mjs --serve    also start the express dev server
//   node build.mjs --tests    bundle test/unit/*.test.ts into out/tests/
import * as esbuild from 'esbuild';
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';

const args = new Set(process.argv.slice(2));
const watch = args.has('--watch');
const serve = args.has('--serve');
const tests = args.has('--tests');
const production = args.has('--production');

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
  entryPoints: [
    'src/main.ts',
    'src/car-preview.ts',
    'src/audio-render.ts',
    'src/city-worker.ts',
  ],
  bundle: true,
  format: 'esm',
  target: 'es2023',
  outdir: 'dist',
  sourcemap: production ? 'external' : true,
  minify: production,
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
    reportGzip();
  }
}

/** Prints the gzipped size of what a visitor downloads to run the app. */
function reportGzip() {
  const files = ['index.html', 'main.js', 'audio-render.js', 'city-worker.js'];
  let sum = 0;
  const rows = [];
  for (const f of files) {
    const p = path.join('dist', f);
    if (!fs.existsSync(p)) continue;
    const raw = fs.readFileSync(p);
    const gz = zlib.gzipSync(raw, {level: 9}).length;
    sum += gz;
    rows.push(`  ${f.padEnd(18)} ${kb(raw.length).padStart(9)}  gzip ${kb(gz).padStart(8)}`);
  }
  console.log(`\n${production ? 'production' : 'development'} build, gzipped:`);
  console.log(rows.join('\n'));
  console.log(`  ${'total'.padEnd(18)} ${''.padStart(9)}  gzip ${kb(sum).padStart(8)}\n`);
}

function kb(n) {
  return `${(n / 1024).toFixed(1)} kB`;
}
