/**
 * Regression tests for lib/skill-extract.mjs — mostly the false-positive
 * cases found via live-corpus spot-checking while building the taxonomy
 * (see docs/skill-taxonomy.md). Protects against a future taxonomy edit
 * silently reintroducing one of these.
 */
import { extractSkills } from '../lib/skill-extract.mjs';

const cases = [
  // False positives that must NOT be extracted
  { name: 'Go: common verb, sentence-initial', text: 'Go beyond execution to build lasting partnerships with clients.', mustNotHave: ['Go'] },
  { name: 'Go: go-live business phrase', text: 'Coordinate Go-Live activities with Ops and Client teams.', mustNotHave: ['Go'] },
  { name: 'Go: encouragement boilerplate', text: "Don't tick every box? Go ahead, apply anyway.", mustNotHave: ['Go'] },
  { name: 'Spark: VC firm name', text: 'Backed by top investors including Spark Capital, Sequoia, and Index Ventures.', mustNotHave: ['Apache Spark'] },
  { name: 'Spark: motivational verb', text: 'We want people whose work will spark curiosity and creativity.', mustNotHave: ['Apache Spark'] },
  { name: 'Excel: verb form', text: 'Everyone here has the opportunity to excel.', mustNotHave: ['Excel'] },
  { name: 'Airflow: HVAC ductwork', text: 'Perform heat load calculations, airflow modeling, and capacity planning.', mustNotHave: ['Airflow'] },
  { name: 'R: R&D (HTML-entity encoded)', text: 'Lead the R&amp;D-to-production transition for our core platform.', mustNotHave: ['R'] },
  { name: 'R: DVP&R acronym', text: 'Define and maintain the Design Verification Plan &amp; Report (DVP&amp;R).', mustNotHave: ['R'] },
  { name: 'R: Terran R product name', text: 'Our Terran R vehicle will deliver customer payloads to orbit.', mustNotHave: ['R'] },
  { name: 'C: D.C. abbreviation', text: 'Headquartered in Washington, D.C. with offices nationwide.', mustNotHave: ['C'] },
  { name: 'C: C-suite title', text: 'Experience engaging with the C-suite and C-level executives.', mustNotHave: ['C'] },
  { name: 'HTTP: URL boilerplate', text: 'Please visit https://rewards.okta.com/us for benefits details.', mustNotHave: ['HTTP'] },
  { name: 'TypeScript: TS/SCI clearance', text: 'Active TS/SCI with polygraph level clearance required.', mustNotHave: ['TypeScript'] },

  // True positives that must survive alongside the above (case++exclude precision, not just recall)
  { name: 'Go: real mention, capitalized', text: 'Proficiency in Go, Rust, and Java required.', mustHave: ['Go'] },
  { name: 'Spark: qualified phrase', text: 'We use Apache Spark for our data pipeline.', mustHave: ['Apache Spark'] },
  { name: 'Excel: capitalized product', text: 'Proficient in Microsoft Office Products (Outlook, Word, Excel, PowerPoint).', mustHave: ['Excel'] },
  { name: 'Airflow: capitalized tool', text: 'Experience with orchestrators tools (Airflow, Prefect, Temporal, Dagster).', mustHave: ['Airflow'] },
  { name: 'R: real mention', text: 'Strong programming skills in R and Python for statistical modeling.', mustHave: ['R'] },
  { name: 'C++: punctuation-ending alias', text: 'C++ developer needed for this role.', mustHave: ['C++'] },
  { name: 'C#: punctuation-ending alias', text: 'C# development experience required.', mustHave: ['C#'] },
  { name: 'HTTP: real protocol mention', text: 'Required: strong understanding of HTTP and HTTPS protocols, REST APIs.', mustHave: ['HTTP', 'REST'] },
  { name: 'Java not matched inside JavaScript', text: 'We use JavaScript extensively on the frontend.', mustNotHave: ['Java'], mustHave: ['JavaScript'] },
  { name: 'Go not matched inside Google', text: 'We are a Google Cloud Platform shop.', mustNotHave: ['Go'], mustHave: ['GCP'] },
];

let failures = 0;
for (const c of cases) {
  const found = extractSkills(c.text).map(s => s.canonicalName);
  let casePassed = true;
  for (const skill of c.mustHave || []) {
    if (!found.includes(skill)) {
      casePassed = false;
      console.log(`FAIL  ${c.name}: expected "${skill}" to be extracted, got [${found.join(', ')}]`);
    }
  }
  for (const skill of c.mustNotHave || []) {
    if (found.includes(skill)) {
      casePassed = false;
      console.log(`FAIL  ${c.name}: expected "${skill}" NOT to be extracted, got [${found.join(', ')}]`);
    }
  }
  if (casePassed) {
    console.log(`PASS  ${c.name}`);
  } else {
    failures++;
  }
}

console.log(`\n${cases.length - failures}/${cases.length} checks passed`);
if (failures > 0) process.exit(1);
