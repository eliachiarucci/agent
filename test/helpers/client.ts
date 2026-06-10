import { TEST_APP_ORIGIN } from "../config";

export type JsonResponse<T = any> = { status: number; body: T };

// fetch with a cookie jar — what a browser does, minus the browser. Each
// TestClient is an independent "device", so multi-user scenarios just use
// several clients.
export class TestClient {
  private cookies = new Map<string, string>();

  constructor(
    readonly baseUrl: string,
    /** Sent as the Origin header; defaults to the trusted SPA origin. */
    private origin: string = TEST_APP_ORIGIN
  ) {}

  async request(path: string, init: RequestInit = {}): Promise<Response> {
    const headers = new Headers(init.headers);
    if (init.body !== undefined && !headers.has("content-type")) {
      headers.set("content-type", "application/json");
    }
    if (!headers.has("origin")) headers.set("origin", this.origin);
    if (this.cookies.size > 0) {
      headers.set(
        "cookie",
        [...this.cookies.entries()].map(([name, value]) => `${name}=${value}`).join("; ")
      );
    }

    const res = await fetch(this.baseUrl + path, { ...init, headers });

    for (const raw of res.headers.getSetCookie()) {
      const [pair] = raw.split(";");
      const eq = pair.indexOf("=");
      const name = pair.slice(0, eq).trim();
      const value = pair.slice(eq + 1);
      const expired = value === "" || /max-age=0|expires=thu, 01 jan 1970/i.test(raw);
      if (expired) this.cookies.delete(name);
      else this.cookies.set(name, value);
    }

    return res;
  }

  private async json<T>(path: string, init: RequestInit = {}): Promise<JsonResponse<T>> {
    const res = await this.request(path, init);
    const text = await res.text();
    return { status: res.status, body: text ? (JSON.parse(text) as T) : (undefined as T) };
  }

  get<T = any>(path: string, headers?: HeadersInit) {
    return this.json<T>(path, { headers });
  }

  post<T = any>(path: string, body?: unknown, headers?: HeadersInit) {
    return this.json<T>(path, { method: "POST", body: JSON.stringify(body ?? {}), headers });
  }

  patch<T = any>(path: string, body?: unknown) {
    return this.json<T>(path, { method: "PATCH", body: JSON.stringify(body ?? {}) });
  }

  delete<T = any>(path: string) {
    return this.json<T>(path, { method: "DELETE" });
  }
}
