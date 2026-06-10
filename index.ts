import 'dotenv/config';
import express from 'express';
import { toNodeHandler } from 'better-auth/node';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { routes } from 'virtual:api-routes';
import { preloadEmbedder } from './lib/global/ai';
import { auth } from './lib/global/auth';
import { db } from './lib/global/db';

const HTTP_METHODS = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS', 'HEAD'] as const;
type HttpMethod = typeof HTTP_METHODS[number];

const main = async () => {
    // Containerized deployments set MIGRATE=on (committed migrations in
    // drizzle/). Dev and test DBs are managed with `drizzle-kit push` instead,
    // where migrate() would fail on already-existing tables — never set it there.
    if (process.env.MIGRATE === 'on') {
        await migrate(db, { migrationsFolder: 'drizzle' });
        console.log('Database migrations are up to date');
    }

    const app = express();
    // Better Auth handles its own body parsing; mounting it before express.json()
    // keeps the raw stream intact for its routes.
    app.all('/agent/auth/*splat', toNodeHandler(auth));
    app.use(express.json());
    const PORT = process.env.PORT || 3001;

    app.get('/', (_req, res) => { res.send('Welcome to the API server!'); });

    for (const { routePath, mod } of routes) {
        const timeout: number | undefined = mod.config?.timeout;
        for (const method of HTTP_METHODS) {
            if (typeof mod[method] === 'function') {
                const handler: express.RequestHandler = timeout
                    ? (req, res, next) => { req.setTimeout(timeout); return mod[method](req, res, next); }
                    : mod[method];
                app[method.toLowerCase() as Lowercase<HttpMethod>](routePath, handler);
            }
        }
    }

    app.listen(PORT, () => {
        console.log(`Server is running on port ${PORT}`);
    });

    // Warm up the in-process embedding model so the first turn isn't slow.
    preloadEmbedder();
};

main().catch((error) => {
    console.error('Error starting the app:', error);
    process.exit(1);
});
