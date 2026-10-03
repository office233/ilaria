import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { OpenCodeControl, cliApi, normalizeDirectory, checkEditingDirectory } from 'file:///C:/Users/abel/.codex/integrations/opencode-control/control.mjs';
import { withRegistryLock } from 'file:///C:/Users/abel/.codex/integrations/opencode-control/state-lock.mjs';

const directory = 'E:\\nexus-worktrees\\ilaria-eurohpc-mn5-20261003';
const recordDirectory = 'E:/nexus/ramasite/agent-md/ilaria/handoff/eurohpc-mn5-opencode-2026-10-03';
const originalDirectory = 'E:/nexus/ramasite/agent-md/ilaria/handoff/eurohpc-mn5-2026-10-03';
const baselineRaw = await readFile(originalDirectory + '/BASELINE.json');
const promptRaw = await readFile(originalDirectory + '/OPENCODE_PROMPT.md');
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
if (hash(baselineRaw) !== 'b4fc10e87b804c22b628c528c1e14f8e0f756541b117cab662169ccca4af563f') throw new Error('Baseline record changed');
if (hash(promptRaw) !== '4d0bda5a9f9e6d69cd6f5fa6f308fc9fe3bec8679cf17c975a20aa57ffb39a29') throw new Error('Prompt record changed');
const baseline = JSON.parse(baselineRaw);
const pins = [];
for (const pin of baseline.files) {
  const actual = hash(await readFile(directory + '/' + pin.path));
  if (actual !== pin.sha256) throw new Error('Protected source mismatch: ' + pin.path);
  pins.push({ path: pin.path, sha256: actual, matches: true });
}
const normalized = await normalizeDirectory(directory);
const editKey = await checkEditingDirectory(normalized);
const active = (await cliApi('GET', '/api/session/active')).data;
if (!active || Array.isArray(active) || Object.keys(active).length !== 0) throw new Error('Actual OpenCode process has active jobs or unknown status');
const now = Date.now();
const stats = (await cliApi('GET', '/api/experimental/session/stats', { params: { from: '1790802000000', to: String(now), timezone: 'Europe/Bucharest', tools: 'none' } })).data;
if (!Number.isFinite(stats?.cost) || stats.cost < 0 || stats.cost >= 400) throw new Error('Fresh finite local cost unavailable or over limit');
// Already verified live during this preflight. Do not call endpoints that bundle private settings again.
const model = { id: 'gpt-6.1-sol', providerID: 'azure' };
const control = new OpenCodeControl();
const title = 'Nexus EuroHPC MN5: local canonical preparation adapter';
await mkdir(recordDirectory, { recursive: true });
const session = await withRegistryLock(control.statePath, async () => {
  await control.initialize();
  if (control.editingReservations.has(editKey)) throw new Error('Worktree already owned');
  const created = await cliApi('POST', '/api/session', { directory, body: { title, agent: 'build', model: { id: model.id, providerID: model.providerID }, location: { directory } } });
  const id = created?.data?.id;
  if (typeof id !== 'string' || !/^ses_[a-zA-Z0-9]+$/.test(id)) throw new Error('Session creation uncertain; inspect before any retry');
  const selected = created?.data?.model;
  if (selected?.id !== model.id || selected?.providerID !== model.providerID) throw new Error('Created session model selection is not confirmed; inspect before any retry');
  const entry = { id, title, directory, agent: 'build', readOnly: false, createdAt: new Date().toISOString(), lastPromptAt: 0, editKey, editing: true };
  control.sessions.set(id, entry);
  control.editingReservations.set(editKey, id);
  await control.save();
  return entry;
});
const receipt = { format: 'eurohpc-opencode-idle-admission-v1', observedAtUTC: new Date().toISOString(), session, model, actualActiveJobsBeforeCreation: 0, baselineUSD: stats.cost, costSource: 'OpenCode local monthly stats, not provider invoice', monthFrom: 1790802000000, pins, promptSHA256: hash(promptRaw), baselineSHA256: hash(baselineRaw), noPromptSubmitted: true };
await writeFile(recordDirectory + '/idle-admission.json', JSON.stringify(receipt, null, 2));
const budget = { authorisedMonthlyUSD: 500, monthStopUSD: 400, batchCapUSD: 30, maxConcurrentModelJobs: 1, monthFrom: 1790802000000, baselineUSD: stats.cost, ids: [session.id], pendingLaunchSessionID: session.id, stopAtUTC: new Date(Date.now() + 30 * 60 * 1000).toISOString(), guardReady: false, costSource: receipt.costSource, model, directory, ownership: 'exclusive nine approved HPC files and this coordination directory; timeout does not release ownership' };
await writeFile(recordDirectory + '/guardian-state.json', JSON.stringify(budget, null, 2));
console.log(JSON.stringify({ sessionID: session.id, directory, model, costUSD: stats.cost, stopAtUTC: budget.stopAtUTC, noPromptSubmitted: true, pinsMatched: pins.length }));
