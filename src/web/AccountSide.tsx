import type { ComponentChildren } from 'preact';
import { useState } from 'preact/hooks';
import { type Account, APP_NAME, type Side } from '../auth.ts';
import { SignIn } from './SignIn.tsx';


export function AccountSide(props: {
  title: string;
  side: Side | undefined;
  /** What the other side uses. Picking its account here swaps the sides (or, for a Nuvio account with several profiles, picks another profile). */
  other?: Side;
  otherTitle: string;
  accounts: Account[];
  disabled?: boolean;
  /** What's loaded for the selected account (counts, loading, error). */
  status?: ComponentChildren;
  /** Shown at the start of the bottom row (e.g. when it was loaded). */
  meta?: ComponentChildren;
  /** Extra buttons next to "Change account" (e.g. Reload). */
  actions?: ComponentChildren;
  onChange: (side: Side | undefined) => void;
  onSignedIn: (a: Account) => void;
  onForget: (a: Account) => void;
}) {
  const { side, accounts } = props;
  const account = side && accounts.find((a) => a.id === side.accountId);
  const [adding, setAdding] = useState(false);
  const [choosing, setChoosing] = useState(false);
  const multiProfile = (a: Account) => a.app === 'nuvio' && a.profiles.length > 1;
  /** Used by the other side, so picking it here swaps the sides. */
  const onOther = (a: Account) => a.id === props.other?.accountId && !multiProfile(a);
  const free = accounts.filter((a) => !onOther(a));

  const pick = (a: Account) => {
    let profileIndex: number | undefined;
    if (a.app === 'nuvio') {
      // Same account as the other side: start on a different profile.
      const taken = a.id === props.other?.accountId ? props.other.profileIndex : undefined;
      profileIndex = (a.profiles.find((p) => p.index !== taken) ?? a.profiles[0])?.index ?? 1;
    }
    props.onChange({ accountId: a.id, profileIndex });
    setChoosing(false);
    setAdding(false);
  };

  const accountButton = (a: Account) => (
    <button type="button" class="account-option" aria-current={a.id === side?.accountId} disabled={props.disabled} onClick={() => pick(a)}>
      <span class={`badge badge-${a.app}`}>{APP_NAME[a.app]}</span>
      <span class="who">{a.who}</span>
      {onOther(a) && (
        <span class="tag" title={`Picking it here swaps From and To`}>
          On {props.otherTitle}
        </span>
      )}
    </button>
  );

  let body;
  if (account && !choosing && !adding) {
    body = (
      <div class="account">
        <div class="account-head">
          <span class={`badge badge-${account.app}`}>{APP_NAME[account.app]}</span>
          <span class="who" title={account.who}>
            {account.who}
          </span>
        </div>
        {account.app === 'nuvio' && account.profiles.length > 1 && (
          <label class="field field-inline">
            <span>Profile</span>
            <select
              value={String(side!.profileIndex ?? 1)}
              disabled={props.disabled}
              onChange={(e) => props.onChange({ accountId: account.id, profileIndex: Number(e.currentTarget.value) })}
            >
              {account.profiles.map((p) => (
                <option value={String(p.index)}>
                  {p.name}
                  {p.pin ? ' (PIN)' : ''}
                </option>
              ))}
            </select>
          </label>
        )}
        {props.status}
        <div class="account-foot">
          <div class="account-meta">{props.meta}</div>
          <div class="account-actions">
            {props.actions}
            <button type="button" class="btn btn-small" disabled={props.disabled} onClick={() => setChoosing(true)}>
              Change account
            </button>
          </div>
        </div>
      </div>
    );
  } else if (adding || !free.length) {
    // Accounts the other side uses are offered too, but signing in to a new one comes first.
    const reuse = !adding ? accounts.filter(onOther) : [];
    body = (
      <div class="stack">
        {reuse.length > 0 && (
          <div class="reuse">
            <p class="muted">Use the {props.otherTitle} account here (swaps the sides):</p>
            <ul class="account-list">
              {reuse.map((a) => (
                <li>{accountButton(a)}</li>
              ))}
            </ul>
            <p class="muted">Or sign in to another account:</p>
          </div>
        )}
        <SignIn
          onSignedIn={(a) => {
            props.onSignedIn(a);
            pick(a);
          }}
          onCancel={adding && accounts.length ? () => setAdding(false) : account ? () => setChoosing(false) : undefined}
        />
      </div>
    );
  } else {
    body = (
      <div class="stack">
        <ul class="account-list">
          {accounts.map((a) => (
            <li>
              {accountButton(a)}
              <button
                type="button"
                class="btn btn-quiet btn-small"
                disabled={props.disabled}
                aria-label={`Sign out of ${a.who}`}
                title="Sign out and forget"
                onClick={() => {
                  if (confirm(`Sign out of ${APP_NAME[a.app]} (${a.who}) and forget it here?`)) props.onForget(a);
                }}
              >
                Sign out
              </button>
            </li>
          ))}
        </ul>
        <button type="button" class="btn" disabled={props.disabled} onClick={() => setAdding(true)}>
          + Sign in to another account
        </button>
        {account && (
          <button type="button" class="btn" onClick={() => setChoosing(false)}>
            Back
          </button>
        )}
      </div>
    );
  }

  return (
    <section class="card side" aria-label={props.title}>
      <h2>{props.title}</h2>
      {body}
    </section>
  );
}
