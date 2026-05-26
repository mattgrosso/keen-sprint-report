// One-shot bulk fetch of every KEEN ticket's current Sprint field.
//
// Returns a Map<issueKey, string[]> where the value is the list of sprint
// names the ticket is currently associated with. Used as a fallback in
// changelog replay for tickets that have zero Sprint change events
// (typically tickets created directly into a sprint).

import { jiraFetch } from './jira.js';

const SPRINT_FIELD = 'customfield_10019';

export async function fetchCurrentSprintMemberships(projectKey = 'KEEN') {
  const map = new Map();
  let nextPageToken = undefined;
  while (true) {
    const body = {
      jql: `project=${projectKey}`,
      fields: [SPRINT_FIELD],
      maxResults: 100,
    };
    if (nextPageToken) body.nextPageToken = nextPageToken;
    const data = await jiraFetch('/rest/api/3/search/jql', {
      method: 'POST',
      body: JSON.stringify(body),
    });
    for (const issue of data.issues || []) {
      const sprints = issue.fields?.[SPRINT_FIELD];
      const names = Array.isArray(sprints)
        ? sprints.map((s) => s?.name).filter(Boolean)
        : [];
      map.set(issue.key, names);
    }
    if (data.isLast || !data.nextPageToken) break;
    nextPageToken = data.nextPageToken;
  }
  return map;
}
