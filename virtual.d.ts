declare module 'virtual:api-routes' {
    const routes: Array<{ routePath: string; mod: Record<string, any> }>;
    export { routes };
}
