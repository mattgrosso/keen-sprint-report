// Quick auth check: who does Jira think we are?
// Run with: node src/whoami.js

import { jiraFetch } from './jira.js';

const me = await jiraFetch('/rest/api/3/myself');
console.log(`Authenticated as: ${me.displayName} <${me.emailAddress}>`);
console.log(`Account ID: ${me.accountId}`);
console.log(`Timezone: ${me.timeZone}`);
