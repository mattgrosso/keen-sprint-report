// Find which custom field holds Story Points by inspecting one issue
// we know has points. Run: node src/find-points-field.js

import { jiraFetch } from './jira.js';

const issueKey = 'KEEN-1090'; // we know this one has 3 points

const issue = await jiraFetch(`/rest/api/3/issue/${issueKey}`);

console.log(`Inspecting ${issueKey}\n`);
console.log('All custom fields with a numeric value:');
for (const [k, v] of Object.entries(issue.fields)) {
  if (k.startsWith('customfield_') && typeof v === 'number') {
    console.log(`  ${k} = ${v}`);
  }
}

console.log('\nAll fields containing "point" or "story" in the name:');
// Also fetch field metadata to map customfield IDs to names
const fields = await jiraFetch('/rest/api/3/field');
const interesting = fields.filter((f) =>
  /point|story/i.test(f.name)
);
for (const f of interesting) {
  const v = issue.fields[f.id];
  console.log(`  ${f.id}  "${f.name}"  value on ${issueKey}: ${JSON.stringify(v)}`);
}