import { useState, type FormEvent } from 'react';
import { useNavigate } from 'react-router-dom';
import { post, tokens, type ApiError } from '../api';

export function Home({ onSignedIn }: { onSignedIn: () => void }) {
  const navigate = useNavigate();
  const [minutes, setMinutes] = useState(5);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function startDemo() {
    setBusy(true);
    setError(null);
    try {
      const r = await post<{ hackathonId: string; teamId: string; participantToken: string; organizerToken: string }>('/api/demo', { minutes });
      tokens.participant.set(r.participantToken);
      tokens.organizer.set(r.organizerToken);
      tokens.active.set('participant');
      onSignedIn();
      navigate(`/team/${r.teamId}`);
    } catch (e) {
      setError((e as ApiError).message);
    } finally {
      setBusy(false);
    }
  }

  async function login(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const f = new FormData(e.currentTarget);
    setBusy(true);
    setError(null);
    try {
      const r = await post<{ token: string }>('/api/auth/login', { email: f.get('email'), password: f.get('password') });
      tokens.participant.set(r.token);
      tokens.organizer.set(null);
      tokens.active.set(null);
      onSignedIn();
    } catch (e) {
      setError((e as ApiError).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="wrap home">
      <h1 tabIndex={-1}>Submissions that survive the last ten minutes.</h1>
      <p className="lede">
        Files go straight to storage in resumable parts. The deadline is the server's clock, with a written grace policy. Every file is checked in the
        background, exactly once, and you watch it happen live.
      </p>

      <div className="card demo">
        <h2>Try it in your own private hackathon</h2>
        <p>
          We create a hackathon whose deadline is a few minutes away, a team for you, and an organizer view of it. Upload, watch the deadline pass,
          then try to sneak in a late change.
        </p>
        <div className="row">
          <label htmlFor="mins">Deadline in</label>
          <select id="mins" value={minutes} onChange={(e) => setMinutes(Number(e.target.value))}>
            {[2, 5, 10, 30].map((m) => (
              <option key={m} value={m}>
                {m} minutes
              </option>
            ))}
          </select>
          <button className="btn" onClick={startDemo} disabled={busy}>
            {busy ? 'Creating…' : 'Start a demo'}
          </button>
        </div>
      </div>

      <details className="card">
        <summary>Sign in with an account</summary>
        <form onSubmit={login} className="stack">
          <label>
            Email
            <input name="email" type="email" autoComplete="username" required />
          </label>
          <label>
            Password
            <input name="password" type="password" autoComplete="current-password" required minLength={8} />
          </label>
          <button className="btn" disabled={busy}>Sign in</button>
        </form>
      </details>
      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
    </section>
  );
}
