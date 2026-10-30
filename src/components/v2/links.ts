// Links into the v2 audit screens, in a module of their own so the app shell can import them without the screens.

/** The page inspector for one URL of the audit, optionally on a tab. */
export const inspectHref = (auditBase: string, url: string, tab?: string) => `${auditBase}/inspect?url=${encodeURIComponent(url)}${tab && tab !== "overview" ? `&tab=${tab}` : ""}`;
