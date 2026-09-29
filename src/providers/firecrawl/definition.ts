import type { ProviderDefinition } from "../../core/types.ts";

import { firecrawlActions } from "./actions.ts";

const service = "firecrawl";

/**
 * Firecrawl provider. eTribe defaults execution to its self-hosted Firecrawl endpoint; cloud use is an explicit paid fallback.
 */
export const provider: ProviderDefinition = {
  service,
  displayName: "Firecrawl",
  categories: ["Data", "Developer Tools"],
  authTypes: ["api_key"],
  auth: [
    {
      type: "api_key",
      label: "API Key (cloud fallback only)",
      placeholder: "fc-... (not sent to self-hosted Firecrawl)",
      description:
        "Retained for explicit Firecrawl Cloud use only. Self-hosted requests do not send this key. Cloud execution also requires FIRECRAWL_ALLOW_CLOUD=true.",
    },
  ],
  homepageUrl: "https://www.firecrawl.dev",
  actions: firecrawlActions,
};
