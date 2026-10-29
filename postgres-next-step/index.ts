import path from 'node:path';
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync } from 'node:fs';
import express from 'express';
import { loadConfig, ROOT } from './config.ts';
import { Db } from './db/db.ts';
import { migrate } from './db/migrations.ts';
import { createContext } from './context.ts';
import { createMailer } from './services/mailer.ts';
import { createApp } from './app.ts';
import { startScheduler } from './services/automations.ts';

const config = loadConfig();
if (config.dbPath !== ':memory:') mkdirSync(path.dirname(config.dbPath), { recursive: true });
const db = new Db(config.dbPath);
const applied = migrate(db);
const ctx = createContext({ db, config, mailer: createMailer(config.smtp) });
const app = createApp(ctx);

if (config.isDev) {
  const { createServer } = await import('vite');
  const vite = await createServer({ root: ROOT, server: { middlewareMode: true }, appType: 'spa' });
  app.use(vite.middlewares);
} else {
  const dist = path.join(ROOT, 'dist');
  const indexHtml = path.join(dist, 'index.html');
  if (existsSync(indexHtml)) {
    app.use('/assets', express.static(path.join(dist, 'assets'), { maxAge: '1y', immutable: true, fallthrough: false }));
    app.use(express.static(dist, { index: false, maxAge: '1h' }));
    app.get('/{*path}', (_req, res) => {
      res.setHeader('Cache-Control', 'no-cache');
      res.sendFile(indexHtml);
    });
  } else {
    app.get('/{*path}', (_req, res) => {
      res.status(503).type('text/plain').send('The web app has not been built yet. Run "npm run build" once, then "npm start".');
    });
  }
}

const url = `http://${config.host === '0.0.0.0' ? 'localhost' : config.host}:${config.port}`;
const openOnStart = process.argv.includes('--open');

/** Opens the app in the default browser (used by the Windows launcher). */
function openBrowser() {
  const [cmd, args] = process.platform === 'win32' ? ['cmd', ['/c', 'start', '', url]] : process.platform === 'darwin' ? ['open', [url]] : ['xdg-open', [url]];
  spawn(cmd, args, { detached: true, stdio: 'ignore', windowsHide: true })
    .on('error', () => console.log(`  Open ${url} in your browser.`))
    .unref();
}

// Express 5 also calls this on a listen error; the 'error' handler below deals with that case.
const server = app.listen(config.port, config.host, (err?: Error) => {
  if (err) return;
  console.log('');
  console.log('  YuvrajFX Agency OS');
  console.log(`  ➜ ${url}${config.isDev ? '  (development, hot reload)' : ''}`);
  console.log(`  ➜ database: ${config.dbPath}${applied.length ? `  (migrations applied: ${applied.join(', ')})` : ''}`);
  console.log(`  ➜ email: ${ctx.mailer.description}`);
  console.log('');
  if (openOnStart) openBrowser();
});

server.on('error', async (err: NodeJS.ErrnoException) => {
  if (err.code === 'EADDRINUSE') {
    // Started twice from the launcher: just bring up the copy that is already running.
    const running = await fetch(`${url}/api/health`, { signal: AbortSignal.timeout(1500) }).then((r) => r.ok, () => false);
    stopScheduler();
    db.close();
    if (running) {
      console.log(`YuvrajFX Agency OS is already running at ${url}${openOnStart ? '. Opening it in your browser.' : '.'}`);
      if (openOnStart) openBrowser();
      process.exit(openOnStart ? 0 : 1);
    }
    console.error(`Port ${config.port} is already in use by another program. Set PORT in .env to a different number.`);
    process.exit(1);
  }
  throw err;
});

const stopScheduler = startScheduler(ctx);

function shutdown() {
  stopScheduler();
  server.close(() => {
    db.close();
    process.exit(0);
  });
  setTimeout(() => process.exit(0), 3000).unref();
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
