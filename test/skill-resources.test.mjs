import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ownerSkills } from '../lib/skill-resources.mjs';

const content = '---\nname: fixture\ndescription: Skill fixture.\n---\nSkill body.\n';
test('global skill aliases cannot traverse the writable project into controller data', async () => {
  const root = mkdtempSync(join(tmpdir(), 'mina-skill-alias-'));
  const agentDir = join(root, 'agent'), writable = join(root, 'project'), skills = join(root, 'skills'), privateDir = join(root, 'private');
  for (const p of [agentDir, writable, skills, privateDir]) mkdirSync(p);
  writeFileSync(join(privateDir, 'SKILL.md'), content);
  symlinkSync(privateDir, join(writable, 'alias')); symlinkSync(join(writable, 'alias'), join(skills, 'fixture'));
  writeFileSync(join(agentDir, 'settings.json'), JSON.stringify({ skills: [skills] }));
  try { await assert.rejects(ownerSkills({ agentDir, home: root, writable: [writable] }), /traverses a writable root/); }
  finally { rmSync(root, { recursive: true, force: true }); }
});

test('a loose home-directory skill cannot expose the entire controller home as its helper root', async () => {
  const root = mkdtempSync(join(tmpdir(), 'mina-skill-home-'));
  const agentDir = join(root, '.pi', 'agent'); mkdirSync(agentDir, { recursive: true });
  const writable = join(root, 'project'); mkdirSync(writable);
  writeFileSync(join(root, 'SKILL.md'), content);
  writeFileSync(join(agentDir, 'settings.json'), JSON.stringify({ skills: [join(root, 'SKILL.md')] }));
  try { await assert.rejects(ownerSkills({ agentDir, home: root, writable: [writable] }), /helper directory contains private controller state/); }
  finally { rmSync(root, { recursive: true, force: true }); }
});
