/** Build libpq environment variables without putting database credentials in process arguments. */
export function pgEnvFromUrl(connectionString: string): NodeJS.ProcessEnv {
  const url = new URL(connectionString);
  if (!['postgres:', 'postgresql:'].includes(url.protocol)) {
    throw new Error('DATABASE_URL must use the postgres:// or postgresql:// scheme.');
  }
  const env: NodeJS.ProcessEnv = { ...process.env };
  env.PGHOST = url.hostname;
  if (url.port) env.PGPORT = url.port;
  if (url.username) env.PGUSER = decodeURIComponent(url.username);
  if (url.password) env.PGPASSWORD = decodeURIComponent(url.password);
  env.PGDATABASE = decodeURIComponent(url.pathname.replace(/^\//, ''));
  env.PGSSLMODE = url.searchParams.get('sslmode') ?? (process.env.PGSSLMODE || 'prefer');
  return env;
}
