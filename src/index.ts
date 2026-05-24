import { createApp } from './server.ts';
import { createSqliteStore } from './store.ts';

const port = Number(process.env.PORT ?? 3100);
const host = process.env.HOST ?? '0.0.0.0';
const store = createSqliteStore();
const server = createApp({ store });

server.listen(port, host, () => {
  console.log(`mimo-pool listening on http://${host}:${port}`);
});

function shutdown(): void {
  server.close(() => {
    store.close?.();
    process.exit(0);
  });
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
