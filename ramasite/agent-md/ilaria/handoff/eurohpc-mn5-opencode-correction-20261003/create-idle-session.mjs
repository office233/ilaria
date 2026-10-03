import { readFile, writeFile, access } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { OpenCodeControl, cliApi, normalizeDirectory, checkEditingDirectory } from 'file:///C:/Users/abel/.codex/integrations/opencode-control/control.mjs';
import { withRegistryLock } from 'file:///C:/Users/abel/.codex/integrations/opencode-control/state-lock.mjs';

const record = 'E:/nexus/ramasite/agent-md/ilaria/handoff/eurohpc-mn5-opencode-correction-20261003';
const directory = 'E:\\nexus-worktrees\\ilaria-eurohpc-mn5-correction-20261003';
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
const raw = await readFile(record + '/BASELINE.json');
if (digest(raw) !== '0b5ec2b7a3bc6f632f428aed5b9dcef0bb15c5327ca9ceab02921728d392dd75') throw new Error('Correction baseline record changed');
if (digest(await readFile(record + '/OPENCODE_PROMPT.md')) !== '86608cd96cf1dfbbaf1b440c91b299113e2de5e4e64821e5662e21c870e26e3b') throw new Error('Correction prompt changed');
if (digest(await readFile(record + '/history/independent-review/independent-review.receipt.json')) !== '61368a3e7d9d79c7006aa60e908c33c653da54c0bd672e5beeebb795639cc658') throw new Error('Independent final review changed');
const baseline = JSON.parse(raw);
const claims = JSON.parse(await readFile(record + '/CLAIMS.json'));
for (const pin of baseline.canonicalFiles) {
  if (digest(await readFile(directory + '/' + pin.path)) !== pin.sha256 || digest(await readFile('E:/nexus/' + pin.path)) !== pin.sha256) throw new Error('Current canonical source mismatch: ' + pin.path);
}
for (const pin of baseline.copiedClaimFiles) {
  if (digest(await readFile(directory + '/' + pin.path)) !== pin.sha256) throw new Error('Copied candidate changed: ' + pin.path);
}
for (const claim of claims.allInitialReservations) {
  try { await access('E:/nexus/' + claim); throw new Error('Main claim collision: ' + claim); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
}
const normalized = await normalizeDirectory(directory);
const editKey = await checkEditingDirectory(normalized);
const priorID = 'ses_eff1d50daffeZIZF9K8o6UiRmi';
const responses = await Promise.all([
  cliApi('GET', '/api/session/active'),
  cliApi('GET', '/api/experimental/session/stats', { params: { from: '1790802000000', to: String(Date.now()), timezone: 'Europe/Bucharest', tools: 'none' } }),
  cliApi('GET', '/api/session/' + priorID),
]);
const active = responses[0].data;
if (!active || typeof active !== 'object' || Array.isArray(active) || Object.keys(active).length !== 0) throw new Error('Prior actual API status is not zero active jobs');
const cost = responses[1].data?.cost;
if (!Number.isFinite(cost) || cost < 0 || cost >= 400) throw new Error('Fresh finite local cost unavailable/over threshold');
const prior = responses[2].data;
if (prior?.outcome !== 'succeeded' || prior?.model?.id !== 'gpt-6.1-sol' || prior?.model?.providerID !== 'azure') throw new Error('Recent existing Azure GPT6.1 job metadata unavailable');
const model = { id: 'gpt-6.1-sol', providerID: 'azure' };
const title = 'Nexus EuroHPC MN5: current-trainer compatibility correction';
const control = new OpenCodeControl();
const session = await withRegistryLock(control.statePath, async () => {
  await control.initialize();
  if (control.editingReservations.has(editKey)) throw new Error('Correction worktree already owned');
  const created = await cliApi('POST', '/api/session', { directory, body: { title, agent: 'build', model, location: { directory } } });
  const info = created?.data;
  if (typeof info?.id !== 'string' || !/^ses_[a-zA-Z0-9]+$/.test(info.id)) throw new Error('Idle session creation uncertain; inspect, never blindly retry');
  if (info.model?.id !== model.id || info.model?.providerID !== model.providerID) throw new Error('Created session model readback differs; inspect before any retry');
  const entry = { id: info.id, title, directory, agent: 'build', readOnly: false, createdAt: new Date().toISOString(), lastPromptAt: 0, editKey, editing: true };
  control.sessions.set(info.id, entry);
  control.editingReservations.set(editKey, info.id);
  await control.save();
  return entry;
});
const receipt = { format: 'eurohpc-correction-idle-admission-v1', observedAtUTC: new Date().toISOString(), session, model, priorOwnedSucceededSession: priorID, actualActiveJobsBeforeCreation: 0, currentPinsVerified: baseline.canonicalFiles.length, copiedPinsVerified: baseline.copiedClaimFiles.length, editableClaims: claims.editable, frozenClaims: claims.frozen, baselineCommit: baseline.gitCommit, baselineUSD: cost, noModelPromptSubmitted: true, modelEvidence: 'current idle session selection readback plus recent succeeded existing Azure GPT6.1 session; no settings/provider/key endpoints accessed' };
await writeFile(record + '/idle-admission.json', JSON.stringify(receipt, null, 2));
const state = { authorisedMonthlyUSD: 500, monthStopUSD: 400, batchCapUSD: 30, maxConcurrentModelJobs: 1, monthFrom: 1790802000000, baselineUSD: cost, ids: [session.id], pendingLaunchSessionID: session.id, stopAtUTC: new Date(Date.now() + 30 * 60 * 1000).toISOString(), guardReady: false, model, directory, baselineCommit: baseline.gitCommit, costSource: 'OpenCode local monthly stats, provider invoice separate/unavailable', ownership: 'exclusive four correction files; three candidate files frozen; timeout/STOP does not release claims' };
await writeFile(record + '/guardian-state.json', JSON.stringify(state, null, 2));
console.log(JSON.stringify({ sessionID: session.id, directory, model, currentPinsVerified: baseline.canonicalFiles.length, copiedPinsVerified: baseline.copiedClaimFiles.length, costUSD: cost, stopAtUTC: state.stopAtUTC, noPromptSubmitted: true }));
