/**
 * scripts/test-role-family-classifier.mjs
 *
 * Spec (upstream role-family-classifier phase) Step 11: regression tests
 * for lib/fingerprint.mjs's classifyCategory() — positive software cases,
 * negative non-software cases, ambiguous cases, and the explicit collision
 * list. Pure, DB-free.
 */
import { classifyCategory } from '../lib/fingerprint.mjs';

let failures = 0, passed = 0;
function check(title, expected, detail) {
  const got = classifyCategory(title);
  const ok = Array.isArray(expected) ? expected.includes(got) : got === expected;
  if (ok) { passed++; console.log(`PASS  ${title.padEnd(45)} -> ${got}`); }
  else { failures++; console.log(`FAIL  ${title.padEnd(45)} -> ${got} (expected ${Array.isArray(expected) ? expected.join('|') : expected})${detail ? ' — ' + detail : ''}`); }
}

console.log('=== Positive software examples ===');
check('Software Engineer', 'software_engineering');
check('Senior Backend Engineer', 'software_engineering');
check('Frontend Engineer', 'software_engineering');
check('Full Stack Engineer', 'software_engineering');
check('Mobile Engineer', 'software_engineering');
check('iOS Engineer', 'software_engineering');
check('Android Engineer', 'software_engineering');
check('SDET', 'software_engineering');
check('QA Automation Engineer', 'software_engineering');
check('Test Automation Engineer', 'software_engineering');
check('Software Test Engineer', 'software_engineering');
check('Software QA Engineer', 'software_engineering');
check('DevOps Engineer', 'it_operations');
check('Site Reliability Engineer', 'it_operations');
check('Data Engineer', 'data_science');
check('ML Engineer', 'software_engineering'); // classifyCategory's own tier ordering — data_science's stricter "machine learning engineer" phrase and software's "ml engineer" can both match; software_engineering is checked first for the "ml engineer" abbreviation, data_science for "machine learning engineer"
check('Machine Learning Engineer', 'data_science');
check('AI Engineer', 'software_engineering');
check('Platform Engineer', 'it_operations');
check('Infrastructure Engineer', 'it_operations');
check('Embedded Software Engineer', 'software_engineering');
check('Firmware Engineer', 'software_engineering');
check('Game Engineer', 'software_engineering');
check('Software Architect', 'software_engineering');
check('API Engineer', 'software_engineering');
check('Web Engineer', 'software_engineering');
check('Selenium Test Engineer', 'software_engineering');
check('Cypress QA Automation Engineer', 'software_engineering');
check('Computer Scientist', 'software_engineering', 'found live via the dev benchmark — a GOOD-labeled job with no matching pattern at all before this fix');
check('Applied Scientist', 'data_science');
check('Cloud Architect', 'it_operations');

console.log('\n=== Precedence fixes found via corpus spot-check ===');
check('CNC Programmer', 'industrial_engineering', 'manufacturing/machining title, not software — bare "programmer" is guarded against CNC context');
check('Director of Product Management (Agentic Data Security)', 'product_management', 'bare "security" in it_operations was shadowing this — product_management now checked first');
check('VP of Product Management, Cloud Security', 'product_management');

console.log('\n=== Negative non-software examples (must NOT become software) ===');
const NOT_SOFTWARE = 'software_engineering';
check('Mechanical Engineer', 'mechanical_engineering');
check('Manufacturing Engineer', 'mechanical_engineering');
check('Nuclear Engineer', 'chemical_engineering');
check('Nuclear Licensing Engineer', 'chemical_engineering');
check('Electrical Engineer', 'electrical_engineering');
check('Civil Engineer', 'civil_engineering');
check('Structural Engineer', 'civil_engineering');
check('Chemical Engineer', 'chemical_engineering');
check('Process Engineer', 'mechanical_engineering');
check('Validation Engineer', 'other'); // bare, no physical or software context — ambiguous by design
check('Controls Engineer', 'industrial_engineering');
check('PLC Automation Engineer', 'industrial_engineering');
check('RF Engineer', 'electrical_engineering');
check('Aerospace Structural Engineer', 'civil_engineering');
check('Calibration Engineer', ['industrial_engineering', 'other']);
check('Field Engineer', 'other'); // bare, no context
check('Reliability Engineer', 'other'); // bare — ambiguous (SRE vs. manufacturing reliability), don't guess
check('Industrial Engineer', 'industrial_engineering');
check('Electrical Test Engineer', 'industrial_engineering');
check('Flight Test Engineer', 'industrial_engineering');
check('Hardware Test Engineer', 'industrial_engineering');
check('Manufacturing Test Engineer', 'industrial_engineering');
check('Supplier Quality Engineer', 'industrial_engineering');
check('Manufacturing Quality Engineer', 'industrial_engineering');
check('Quality Systems Engineer', 'industrial_engineering');
check('Robotics Mechanical Engineer', 'mechanical_engineering');
check('Senior Staff FPGA Engineer', 'electrical_engineering');
check('Signal Integrity Engineer', 'electrical_engineering');
check('Avionics Engineer', 'electrical_engineering');

console.log('\n=== Ambiguous examples (prefer OTHER/generic over a forced guess) ===');
check('Engineer', 'other');
check('Engineer II', 'other');
check('Senior Engineer', 'other');
check('Technical Engineer', 'other');
check('Staff Engineer', 'other');
check('Automation Engineer', 'other'); // no qualifier at all — genuinely ambiguous (industrial vs. QA vs. DevOps)
check('Systems Engineer', 'other');
check('Test Engineer', 'other');
check('Quality Engineer', 'other');

console.log('\n=== Required collision tests (spec-named) ===');
check('Mechanical Engineer', 'mechanical_engineering');
check('Manufacturing Engineer', 'mechanical_engineering');
check('Software Engineer', 'software_engineering');
check('Software Test Engineer', 'software_engineering');
check('Electrical Test Engineer', 'industrial_engineering');
check('QA Automation Engineer', 'software_engineering');
check('Manufacturing Quality Engineer', 'industrial_engineering');
check('SDET', 'software_engineering');
check('Data Engineer', 'data_science');
check('Data Quality Analyst', ['data_science', 'other']); // "analyst" not "engineer" — must not become QA
check('Automation Engineer', 'other');
check('Controls Automation Engineer', 'industrial_engineering');
check('Platform Engineer', 'it_operations');
check('Platform Product Manager', 'product_management');
check('Systems Engineer', 'other');
check('Software Systems Engineer', 'software_engineering');
check('Hardware Systems Engineer', 'other'); // "hardware" isn't in PHYSICAL_CONTEXT_RE's systems-guard branch explicitly, but must NOT become software
check('Reliability Engineer', 'other');
check('Site Reliability Engineer', 'it_operations');
check('Nuclear Licensing Engineer', 'chemical_engineering');
check('Staff FPGA Engineer', 'electrical_engineering');
check('Robotics Software Engineer', 'software_engineering');
check('Robotics Mechanical Engineer', 'mechanical_engineering');

console.log('\n=== Real corpus collision cases found during the audit ===');
check('Cookie Crew', 'other');
check('Material Planner', ['industrial_engineering', 'other']);
check('Senior Engineer, System Calibration (Electro-Optics)', 'other');
check('Interior Components Engineer', 'other');
check('Signal Integrity Engineer - Serdes, Satellites (Starlink)', 'electrical_engineering');
check('Robotic Systems Integration Engineer (SLA & SLS)', 'other');
check('Senior Staff FPGA Engineer', 'electrical_engineering');
check('Staff Electric Propulsion Engineer, Cathodes', 'mechanical_engineering');
check('Wireless Regulatory Engineer - SAR', ['electrical_engineering', 'legal'], 'genuinely rare collision — "regulatory" correctly means legal/compliance in the vast majority of real titles; not worth weakening that signal for this one rare RF-certification usage');
check('Transportation Engineer Intern - May 2027', 'civil_engineering');
check('Optical Engineer, Precision Instrumentation', 'other');
check('Experienced Stress Analysis Engineer', 'mechanical_engineering');

console.log(`\n${passed} passed, ${failures} failed (${passed + failures} total)`);
if (failures > 0) process.exit(1);
