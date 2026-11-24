// One write to To, start to finish: read To again, write only what the user confirmed, then read
// To once more to see what landed. Kept apart from the page so the tests can run it on fakes.

import { type AddonEntry, type ChangeSet, SCOPES, type Snapshot } from '../model.ts';
import { type ApplyReport, type Logger, type Provider, emptyReport } from '../providers/types.ts';
import { addonDiff, addonDiffSize, selectedChanges, withinConfirmed } from './compare.ts';
import { countChanges, plan } from './plan.ts';

export const NO_CHANGES: ChangeSet = { library: [], watched: [], progress: [], addons: [] };

export interface WriteInput {
  /** From's snapshot. Without one, only the add-on list can be saved. */
  from?: Snapshot;
  /** The To app. */
  to: Provider;
  /** "Stremio (me@example.com)", for messages. */
  toLabel: string;
  /** What the confirmation showed. Nothing outside it is written. */
  confirmed: ChangeSet;
  /** Titles the user un-ticked, as selectionKey()s. */
  excluded: ReadonlySet<string>;
  /** The add-on list to save on To, when the user changed it; undefined leaves add-ons alone. */
  addons?: AddonEntry[];
  /** To's add-ons when the page loaded them, so changes made elsewhere since aren't overwritten. */
  loadedAddons: AddonEntry[];
  /** Reads To after writing (the page also shows that read). */
  readAfter: () => Promise<Snapshot>;
  log: Logger;
  /** Pause before checking, so the apps have saved what they were sent. */
  settleMs?: number;
}

export interface WriteOutcome {
  report: ApplyReport;
  /** Confirmed changes still missing on To after the write. */
  left: number;
  /** Add-on list differences still there after the write. */
  addonsLeft: number;
}

export async function runWrite(o: WriteInput): Promise<WriteOutcome> {
  const { to, toLabel, log } = o;
  const rules = to.unsupported?.bind(to);
  // Planned on To's state at that moment, but limited to what the confirmation showed.
  const changesFor = (target: Snapshot) => (o.from ? withinConfirmed(selectedChanges(plan(o.from, target, SCOPES, rules), o.excluded), o.confirmed) : NO_CHANGES);

  // Read again right before writing: the write builds on To's current state, and providers
  // build on their last read (e.g. Trakt uses it to avoid adding plays twice).
  log.info(`Reading ${toLabel} again…`);
  const fresh = await to.read(SCOPES, log);
  const changes = changesFor(fresh);

  // The add-on list replaces To's whole list, so if To's add-ons changed since they were loaded
  // (e.g. one installed on a phone), saving would undo that unseen. Don't.
  let addons = o.addons;
  if (addons && addonDiffSize(addonDiff(o.loadedAddons, fresh.addons)) > 0) {
    addons = undefined;
    log.warn(`${toLabel}'s add-ons changed since the page loaded them, so the add-on list wasn't saved. Check the Add-ons tab and write again.`);
  }

  const report = emptyReport();
  const merge = (r: ApplyReport) => {
    for (const s of SCOPES) report.written[s] += r.written[s];
    report.skipped.push(...r.skipped);
  };
  if (countChanges(changes)) {
    log.info(`Writing to ${toLabel}…`);
    merge(await to.apply(changes, log));
  }
  if (addons) {
    log.info(`Saving ${toLabel}'s add-ons…`);
    merge(await to.saveAddons(addons, log));
  }

  log.info('Checking the result…');
  if (o.settleMs !== 0) await new Promise((r) => setTimeout(r, o.settleMs ?? 2000));
  const after = await o.readAfter();
  const left = countChanges(changesFor(after));
  // Apps that can't switch add-ons off don't install switched-off ones.
  const expected = addons && (to.canDisableAddons ? addons : addons.filter((a) => a.enabled !== false));
  const addonsLeft = expected ? addonDiffSize(addonDiff(after.addons, expected)) : 0;
  return { report, left, addonsLeft };
}
