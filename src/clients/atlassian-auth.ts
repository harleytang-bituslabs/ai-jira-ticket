/**
 * Shared Atlassian Cloud credentials.
 *
 * Jira and Confluence live on the same site and accept the same
 * email + API token via Basic auth, so both clients read from here.
 *
 * Reads ATLASSIAN_BASE_URL / ATLASSIAN_EMAIL / ATLASSIAN_API_TOKEN, falling
 * back to the CONFLUENCE_* names so an .env from the game-pipeline project
 * works unchanged. Tokens are minted at
 * https://id.atlassian.com/manage-profile/security/api-tokens
 * for personal use, or via a service account for production.
 */

export function getAtlassianBaseUrl(): string {
  const v = process.env.ATLASSIAN_BASE_URL || process.env.CONFLUENCE_BASE_URL;
  if (!v) {
    throw new Error(
      "ATLASSIAN_BASE_URL is not configured — set it in .env (e.g. https://your-site.atlassian.net)",
    );
  }
  return v.replace(/\/+$/, ""); // strip trailing slash for clean concatenation
}

export function getAtlassianAuthHeader(): string {
  const email = process.env.ATLASSIAN_EMAIL || process.env.CONFLUENCE_EMAIL;
  const token = process.env.ATLASSIAN_API_TOKEN || process.env.CONFLUENCE_API_TOKEN;
  if (!email || !token) {
    throw new Error(
      "ATLASSIAN_EMAIL / ATLASSIAN_API_TOKEN are not configured. Generate a token at id.atlassian.com/manage-profile/security/api-tokens and set both in .env",
    );
  }
  return "Basic " + Buffer.from(`${email}:${token}`).toString("base64");
}
