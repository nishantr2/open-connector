import { afterEach, describe, expect, it, vi } from "vitest";
import { firecrawlActionHandlers } from "./executors.ts";

function createContext(fetcher: typeof fetch) {
  return {
    apiKey: "fc-test-key",
    fetcher,
  };
}

function jsonFetcher(payload: Record<string, unknown> = { success: true }): typeof fetch {
  return vi.fn(async () => Response.json(payload)) as typeof fetch;
}

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("Firecrawl local-first routing", () => {
  it("defaults to self-hosted Firecrawl and does not send the cloud API key", async () => {
    vi.stubEnv("FIRECRAWL_API_URL", "");
    vi.stubEnv("FIRECRAWL_ALLOW_CLOUD", "");
    const fetcher = jsonFetcher({ success: true, data: { markdown: "ok" } });

    await firecrawlActionHandlers.scrape(
      { url: "https://example.com", formats: ["markdown"] },
      createContext(fetcher),
    );

    const [url, init] = vi.mocked(fetcher).mock.calls[0]!;
    expect(String(url)).toBe("http://127.0.0.1:3002/v2/scrape");
    const headers = new Headers(init?.headers);
    expect(headers.has("authorization")).toBe(false);
  });

  it("supports the Docker Desktop host bridge for the self-hosted endpoint", async () => {
    vi.stubEnv("FIRECRAWL_API_URL", "http://host.docker.internal:3002");
    vi.stubEnv("FIRECRAWL_ALLOW_CLOUD", "false");
    const fetcher = jsonFetcher({ success: true, data: [] });

    await firecrawlActionHandlers.search(
      { query: "eTribe workflow", limit: 5 },
      createContext(fetcher),
    );

    const [url, init] = vi.mocked(fetcher).mock.calls[0]!;
    expect(String(url)).toBe("http://host.docker.internal:3002/v2/search");
    expect(new Headers(init?.headers).has("authorization")).toBe(false);
  });

  it("fails closed if Firecrawl Cloud is configured without explicit approval", async () => {
    vi.stubEnv("FIRECRAWL_API_URL", "https://api.firecrawl.dev");
    vi.stubEnv("FIRECRAWL_ALLOW_CLOUD", "false");
    const fetcher = jsonFetcher();

    await expect(
      firecrawlActionHandlers.scrape(
        { url: "https://example.com" },
        createContext(fetcher),
      ),
    ).rejects.toMatchObject({
      status: 503,
    });
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("uses the cloud key only when cloud execution is explicitly approved", async () => {
    vi.stubEnv("FIRECRAWL_API_URL", "https://api.firecrawl.dev");
    vi.stubEnv("FIRECRAWL_ALLOW_CLOUD", "true");
    const fetcher = jsonFetcher({ success: true, data: { markdown: "cloud" } });

    await firecrawlActionHandlers.scrape(
      { url: "https://example.com" },
      createContext(fetcher),
    );

    const [url, init] = vi.mocked(fetcher).mock.calls[0]!;
    expect(String(url)).toBe("https://api.firecrawl.dev/v2/scrape");
    expect(new Headers(init?.headers).get("authorization")).toBe("Bearer fc-test-key");
  });
});
