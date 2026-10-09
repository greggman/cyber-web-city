// Static express server for dist/ (local dev and puppeteer tests).
import express from 'express';
import path from 'node:path';
import url from 'node:url';

const root = path.join(path.dirname(url.fileURLToPath(import.meta.url)), 'dist');

/**
 * Starts serving dist/. Pass port 0 for a random free port.
 * @returns {Promise<{port: number, close: () => Promise<void>}>}
 */
export function startServer(port = 8080) {
  const app = express();
  app.use(
    express.static(root, {
      setHeaders: res => res.setHeader('Cache-Control', 'no-store'),
    }),
  );
  return new Promise(resolve => {
    const server = app.listen(port, () => {
      const actual = server.address().port;
      console.log(`serving ${root} at http://localhost:${actual}/`);
      resolve({
        port: actual,
        close: () => new Promise(r => server.close(() => r())),
      });
    });
  });
}

if (import.meta.url === url.pathToFileURL(process.argv[1]).href) {
  await startServer(Number(process.env.PORT ?? 8080));
}
