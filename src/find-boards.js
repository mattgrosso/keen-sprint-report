// List all Jira boards visible to you, with their IDs and the project they belong to.
// Run with: node src/find-boards.js

import { jiraFetch } from './jira.js';

async function main() {
  console.log('Fetching boards from Jira...\n');

  // The Agile API uses pagination. For most accounts there are well under 50,
  // but we'll loop just in case.
  let startAt = 0;
  const pageSize = 50;
  const boards = [];

  while (true) {
    const data = await jiraFetch(
      `/rest/agile/1.0/board?startAt=${startAt}&maxResults=${pageSize}`,
    );
    boards.push(...data.values);
    if (data.isLast || data.values.length < pageSize) break;
    startAt += pageSize;
  }

  console.log(`Found ${boards.length} boards:\n`);

  // Filter to anything mentioning KEEN, but show all if there are few
  const keenBoards = boards.filter(
    (b) =>
      b.name.toLowerCase().includes('keen') ||
      b.location?.projectKey === 'KEEN',
  );

  if (keenBoards.length) {
    console.log('=== KEEN boards ===');
    for (const b of keenBoards) {
      console.log(
        `  id=${b.id}  type=${b.type}  name="${b.name}"  project=${b.location?.projectKey || '?'}`,
      );
    }
    console.log();
  }

  console.log('=== All boards ===');
  for (const b of boards) {
    console.log(
      `  id=${b.id}  type=${b.type}  name="${b.name}"  project=${b.location?.projectKey || '?'}`,
    );
  }
}

main().catch((err) => {
  console.error('Failed:', err.message);
  process.exit(1);
});
