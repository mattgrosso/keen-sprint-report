// Shared Jira API client.
// Reads credentials from .env and provides a single `jiraFetch` helper
// that handles auth, JSON parsing, and errors consistently.

import 'dotenv/config';

const {
  JIRA_BASE_URL,
  JIRA_EMAIL,
  JIRA_API_TOKEN,
} = process.env;

if (!JIRA_BASE_URL || !JIRA_EMAIL || !JIRA_API_TOKEN) {
  console.error('Missing required env vars. Check your .env file.');
  console.error('Need: JIRA_BASE_URL, JIRA_EMAIL, JIRA_API_TOKEN');
  process.exit(1);
}

// Atlassian uses HTTP Basic auth: email:token, base64-encoded.
const authHeader =
  'Basic ' + Buffer.from(`${JIRA_EMAIL}:${JIRA_API_TOKEN}`).toString('base64');

/**
 * Fetch a Jira API endpoint. Pass a path like "/rest/api/3/myself"
 * or "/rest/agile/1.0/board". Returns parsed JSON.
 */
export async function jiraFetch(path, options = {}) {
  const url = path.startsWith('http') ? path : `${JIRA_BASE_URL}${path}`;
  const res = await fetch(url, {
    ...options,
    headers: {
      Authorization: authHeader,
      Accept: 'application/json',
      'Content-Type': 'application/json',
      ...(options.headers || {}),
    },
  });

  if (!res.ok) {
    const body = await res.text();
    throw new Error(
      `Jira API ${res.status} ${res.statusText} for ${path}\n${body.slice(0, 500)}`,
    );
  }

  return res.json();
}

export { JIRA_BASE_URL };
