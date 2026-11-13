import { useEffect, useState } from 'react';
import { Link, Navigate, Route, Routes, useLocation, useNavigate } from 'react-router-dom';
import { currentToken, get, signOut, tokens, type Me } from './api';
import { Home } from './pages/home';
import { OrganizerPage } from './pages/organizer';
import { TeamPage } from './pages/team';

export function App() {
  const [me, setMe] = useState<Me | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [rev, setRev] = useState(0);
  const location = useLocation();
  const navigate = useNavigate();

  useEffect(() => {
    if (!currentToken()) {
      setMe(null);
      setLoaded(true);
      return;
    }
    get<Me>('/api/me')
      .then(setMe)
      .catch(() => {
        signOut();
        setMe(null);
      })
      .finally(() => setLoaded(true));
  }, [rev]);

  // Move focus to the page heading on navigation, for keyboard and screen reader users.
  useEffect(() => {
    document.querySelector<HTMLElement>('main h1')?.focus();
  }, [location.pathname]);

  const both = !!tokens.participant.get() && !!tokens.organizer.get();
  const active = tokens.active.get() ?? (me?.user.role === 'organizer' ? 'organizer' : 'participant');
  const switchTo = (which: 'participant' | 'organizer') => {
    tokens.active.set(which);
    // Reload "me" before routing, so the landing redirect uses the new identity.
    setLoaded(false);
    setMe(null);
    setRev((r) => r + 1);
    navigate('/');
  };

  return (
    <>
      <a className="skip" href="#main">Skip to content</a>
      <header className="top">
        <Link to="/" className="brand" aria-label="Deadline Crush home">
          <span className="brand-dot" aria-hidden="true" />
          Deadline Crush
        </Link>
        {me && (
          <div className="top-right">
            {both && (
              <div className="switch" role="group" aria-label="View as">
                <button aria-pressed={active === 'participant'} onClick={() => switchTo('participant')}>Team</button>
                <button aria-pressed={active === 'organizer'} onClick={() => switchTo('organizer')}>Organizer</button>
              </div>
            )}
            <span className="muted small who">{me.user.name}</span>
            <button
              className="link"
              onClick={() => {
                signOut();
                setRev((r) => r + 1);
                navigate('/');
              }}
            >
              Sign out
            </button>
          </div>
        )}
      </header>
      <main id="main">
        {!loaded ? (
          <p className="pad muted" role="status">Loading…</p>
        ) : (
          <Routes>
            <Route path="/" element={me ? <Landing me={me} /> : <Home onSignedIn={() => setRev((r) => r + 1)} />} />
            <Route path="/team/:id" element={me ? <TeamPage /> : <Navigate to="/" replace />} />
            <Route path="/organizer/:id" element={me ? <OrganizerPage /> : <Navigate to="/" replace />} />
            <Route path="*" element={<Navigate to="/" replace />} />
          </Routes>
        )}
      </main>
    </>
  );
}

/** Sends a signed-in user to the right place. */
function Landing({ me }: { me: Me }) {
  if (me.user.role === 'organizer' && me.hackathons.length === 1) return <Navigate to={`/organizer/${me.hackathons[0]!.id}`} replace />;
  if (me.user.role !== 'organizer' && me.teams.length === 1) return <Navigate to={`/team/${me.teams[0]!.id}`} replace />;
  return (
    <section className="wrap">
      <h1 tabIndex={-1}>Hello, {me.user.name}</h1>
      {me.teams.length > 0 && (
        <>
          <h2>Your teams</h2>
          <ul className="plain">
            {me.teams.map((t) => (
              <li key={t.id}>
                <Link to={`/team/${t.id}`}>{t.name}</Link> <span className="muted">· {t.hackathon_name}</span>
              </li>
            ))}
          </ul>
        </>
      )}
      {me.hackathons.length > 0 && (
        <>
          <h2>Hackathons you organize</h2>
          <ul className="plain">
            {me.hackathons.map((h) => (
              <li key={h.id}>
                <Link to={`/organizer/${h.id}`}>{h.name}</Link>
              </li>
            ))}
          </ul>
        </>
      )}
      {me.teams.length === 0 && me.hackathons.length === 0 && <p className="muted">You are not on a team yet.</p>}
    </section>
  );
}
