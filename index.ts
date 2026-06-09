import 'dotenv/config';
import express from 'express';
import { routes } from 'virtual:api-routes';

const HTTP_METHODS = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS', 'HEAD'] as const;
type HttpMethod = typeof HTTP_METHODS[number];

const main = async () => {
    const app = express();
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
};

main().catch((error) => {
    console.error('Error starting the app:', error);
    process.exit(1);
});
