// Production build of the web app. Caps the bundler's native thread pool so the build also
// succeeds while memory-hungry apps (Premiere, After Effects, games) are open.
process.env.RAYON_NUM_THREADS ??= '2';
process.env.TOKIO_WORKER_THREADS ??= '2';

const { build } = await import('vite');
await build();
