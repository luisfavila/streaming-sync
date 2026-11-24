import { render } from 'preact';
import { relayTraktCallback } from '../auth.ts';
import { App } from './App.tsx';
import './styles.css';

const root = document.getElementById('app')!;
const params = new URLSearchParams(location.search);

if (relayTraktCallback(params)) {
  // This is the Trakt sign-in window, sent back here: the page that opened it takes over.
  history.replaceState(null, '', location.pathname);
  const declined = params.has('error');
  render(
    <main class="page callback">
      <h1>{declined ? 'Trakt sign-in cancelled' : 'Signed in to Trakt'}</h1>
      <p class="muted">You can close this window and go back to Streaming Sync.</p>
    </main>,
    root,
  );
  window.close();
} else {
  render(<App />, root);
}
